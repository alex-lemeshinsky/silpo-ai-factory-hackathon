import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { getDbClient } from "@/db/client";
import { getServerEnv, type ServerEnv } from "@/lib/env";
import { err, ok, type AppError, type Result } from "@/lib/result";
import {
  createPostgresAuthRepository,
  type AuthRepository,
  type OAuthState,
} from "./auth-repository";
import {
  createSilpoOAuthProvider,
  type SilpoOAuthProvider,
} from "./provider";
import {
  createDefaultOAuthConnectionFactory,
  type OAuthConnectionFactory,
} from "./transport";

export interface OAuthCompletion {
  location: string;
  cookie: { value: string; expiresAt: Date; maxAge: number } | null;
}

export interface CallbackInput {
  handle: string | null;
  state: string;
  code?: string;
  issuer?: string;
  denied: boolean;
}

export interface OAuthFailure {
  status: number;
  error: AppError;
  clearCookie: boolean;
}

export interface SilpoOAuthService {
  start(handle: string | null, correlationId: string): Promise<Result<OAuthCompletion, OAuthFailure>>;
  callback(input: CallbackInput, correlationId: string): Promise<Result<OAuthCompletion, OAuthFailure>>;
  resolveSession(handle: string | null, correlationId: string): Promise<Result<{ userId: string; expiresAt: Date }, AppError>>;
}

export interface CreateSilpoOAuthServiceOptions {
  repository?: AuthRepository;
  createProvider?: (userId: string, claimedState?: OAuthState) => Promise<SilpoOAuthProvider>;
  connect?: OAuthConnectionFactory;
  env?: ServerEnv;
  now?: () => Date;
  randomHandle?: () => string;
}

const MSG_UNAUTHORIZED = "Не вдалося підтвердити вхід. Увійдіть у «Сільпо» ще раз.";
const MSG_PROCESSING = "Вхід уже обробляється. Дочекайтеся завершення або почніть знову після завершення строку дії.";
const MSG_INVALID_EXTERNAL = "«Сільпо» повернуло некоректну відповідь. Спробуйте увійти ще раз.";
const MSG_RATE_LIMITED = "Забагато запитів. Спробуйте увійти трохи пізніше.";
const MSG_TIMEOUT = "Час очікування входу минув. Спробуйте ще раз.";
const MSG_UNEXPECTED = "Не вдалося завершити вхід. Спробуйте ще раз.";

function mapErrorToFailure(error: unknown, correlationId: string, clearCookie: boolean): Result<never, OAuthFailure> {
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  if (msg.includes("rate_limited") || msg.includes("429")) {
    return err({
      status: 429,
      error: {
        code: "rate_limited",
        message: MSG_RATE_LIMITED,
        correlationId,
        retryAfterMs: null,
      },
      clearCookie,
    });
  }

  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("abort")) {
    return err({
      status: 504,
      error: {
        code: "unexpected",
        message: MSG_TIMEOUT,
        correlationId,
        retryAfterMs: null,
      },
      clearCookie,
    });
  }

  if (
    msg.includes("unauthorized") ||
    msg.includes("reauthorization_required") ||
    msg.includes("401") ||
    msg.includes("invalid_grant")
  ) {
    return err({
      status: 401,
      error: {
        code: "unauthorized",
        message: MSG_UNAUTHORIZED,
        correlationId,
        retryAfterMs: null,
      },
      clearCookie,
    });
  }

  if (msg.includes("invalid_external") || msg.includes("invalid_provider")) {
    return err({
      status: 502,
      error: {
        code: "invalid_external_data",
        message: MSG_INVALID_EXTERNAL,
        correlationId,
        retryAfterMs: null,
      },
      clearCookie,
    });
  }

  return err({
    status: 500,
    error: {
      code: "unexpected",
      message: MSG_UNEXPECTED,
      correlationId,
      retryAfterMs: null,
    },
    clearCookie,
  });
}

export function createSilpoOAuthService(options: CreateSilpoOAuthServiceOptions = {}): SilpoOAuthService {
  let env = options.env;
  const getEnv = () => {
    if (!env) {
      env = getServerEnv();
    }
    return env;
  };

  let repository = options.repository;
  const getRepository = () => {
    if (!repository) {
      repository = createPostgresAuthRepository({
        db: getDbClient(),
        encryptionKey: Buffer.from(getEnv().TOKEN_ENCRYPTION_KEY, "base64"),
      });
    }
    return repository;
  };

  const now = options.now ?? (() => new Date());
  const randomHandle = options.randomHandle ?? (() => randomBytes(32).toString("base64url"));

  let connect = options.connect;
  const getConnect = () => {
    if (!connect) {
      connect = createDefaultOAuthConnectionFactory();
    }
    return connect;
  };

  let createProvider = options.createProvider;
  const getCreateProvider = () => {
    if (!createProvider) {
      createProvider = (userId: string, claimedState?: OAuthState) =>
        createSilpoOAuthProvider(userId, {
          repository: getRepository(),
          publicBaseUrl: getEnv().PUBLIC_BASE_URL,
          claimedState,
        });
    }
    return createProvider;
  };

  return {
    async start(handle: string | null, correlationId: string): Promise<Result<OAuthCompletion, OAuthFailure>> {
      try {
        const currentEnv = getEnv();
        if (currentEnv.DATA_MODE === "demo") {
          return err({
            status: 404,
            error: {
              code: "unexpected",
              message: "Not found",
              correlationId,
              retryAfterMs: null,
            },
            clearCookie: false,
          });
        }

        const repo = getRepository();
        const currentDate = now();

        let existingUserId: string | undefined;

        // 1. Check existing session for unexpired processing flow
        if (handle && handle.trim().length > 0) {
          const handleHash = createHash("sha256").update(handle.trim()).digest("hex");
          const existing = await repo.findSession(handleHash, currentDate);
          if (existing && existing.status !== "revoked" && existing.expiresAt.getTime() > currentDate.getTime()) {
            if (existing.status === "authenticated") {
              existingUserId = existing.userId;
            }
            const existingState = await repo.readState(existing.userId);
            if (
              existingState &&
              existingState.phase === "processing" &&
              existingState.flowExpiresAt &&
              existingState.flowExpiresAt.getTime() > currentDate.getTime()
            ) {
              return err({
                status: 409,
                error: {
                  code: "unauthorized",
                  message: MSG_PROCESSING,
                  correlationId,
                  retryAfterMs: null,
                },
                clearCookie: false,
              });
            }
          }
        }

        // 2. Allocate fresh pending session with full 10-minute expiry (eliminates expiry skew)
        const newPendingHandle = randomHandle();
        const newPendingHash = createHash("sha256").update(newPendingHandle).digest("hex");
        const sessionExpiresAt = new Date(currentDate.getTime() + 10 * 60 * 1000); // 10 min
        const session = await repo.createPendingSession({
          handleHash: newPendingHash,
          now: currentDate,
          expiresAt: sessionExpiresAt,
          userId: existingUserId,
        });
        const pendingCookie: OAuthCompletion["cookie"] = {
          value: newPendingHandle,
          expiresAt: sessionExpiresAt,
          maxAge: 600,
        };

        // 3. Begin flow
        const flowId = randomUUID();
        const flowStateSecret = randomBytes(32).toString("hex");
        const flowExpiresAt = new Date(currentDate.getTime() + 10 * 60 * 1000);

        try {
          await repo.beginFlow({
            userId: session.userId,
            bindingHash: session.handleHash,
            flowId,
            state: flowStateSecret,
            now: currentDate,
            expiresAt: flowExpiresAt,
          });
        } catch (error: unknown) {
          if (
            error instanceof Error &&
            (error.message === "flow_processing" || error.message === "flow_conflict")
          ) {
            return err({
              status: 409,
              error: {
                code: "unauthorized",
                message: MSG_PROCESSING,
                correlationId,
                retryAfterMs: null,
              },
              clearCookie: false,
            });
          }
          throw error;
        }

        // 4. Build provider and connection
        const provider = await getCreateProvider()(session.userId);
        const connection = getConnect()(provider);

        try {
          const beginResult = await connection.begin();

          if (beginResult === "redirect") {
            const authUrl = provider.authorizationUrl();
            if (!authUrl) {
              return err({
                status: 500,
                error: {
                  code: "unexpected",
                  message: MSG_UNEXPECTED,
                  correlationId,
                  retryAfterMs: null,
                },
                clearCookie: false,
              });
            }
            return ok({ location: authUrl.toString(), cookie: pendingCookie });
          }

          // Already authorized
          await connection.probeTools();

          const claimed = await repo.claimFlow({
            userId: session.userId,
            bindingHash: session.handleHash,
            expectedVersion: provider.currentState().version,
            now: currentDate,
          });

          if (!claimed) {
            return err({
              status: 500,
              error: {
                code: "unexpected",
                message: MSG_UNEXPECTED,
                correlationId,
                retryAfterMs: null,
              },
              clearCookie: false,
            });
          }

          const newHandle = randomHandle();
          const newHandleHash = createHash("sha256").update(newHandle).digest("hex");
          const authExpiresAt = new Date(currentDate.getTime() + 7 * 24 * 3600 * 1000); // 7 days

          await repo.activateSession({
            oldHandleHash: session.handleHash,
            newHandleHash,
            userId: session.userId,
            expectedFlowVersion: claimed.version,
            now: currentDate,
            expiresAt: authExpiresAt,
          });

          return ok({
            location: "/",
            cookie: {
              value: newHandle,
              expiresAt: authExpiresAt,
              maxAge: 7 * 24 * 3600,
            },
          });
        } catch (error) {
          return mapErrorToFailure(error, correlationId, false);
        } finally {
          await connection.close().catch(() => {});
        }
      } catch (error) {
        return mapErrorToFailure(error, correlationId, false);
      }
    },

    async callback(input: CallbackInput, correlationId: string): Promise<Result<OAuthCompletion, OAuthFailure>> {
      try {
        if (getEnv().DATA_MODE === "demo") {
        return err({
          status: 404,
          error: {
            code: "unexpected",
            message: "Not found",
            correlationId,
            retryAfterMs: null,
          },
          clearCookie: false,
        });
      }

      const currentDate = now();

      // Input validation
      if (!input.state || input.state.length > 256) {
        return err({
          status: 400,
          error: {
            code: "unauthorized",
            message: MSG_UNAUTHORIZED,
            correlationId,
            retryAfterMs: null,
          },
          clearCookie: false,
        });
      }

      if ((input.denied && input.code) || (!input.denied && !input.code)) {
        return err({
          status: 400,
          error: {
            code: "unauthorized",
            message: MSG_UNAUTHORIZED,
            correlationId,
            retryAfterMs: null,
          },
          clearCookie: false,
        });
      }

      if (input.code && input.code.length > 4096) {
        return err({
          status: 400,
          error: {
            code: "unauthorized",
            message: MSG_UNAUTHORIZED,
            correlationId,
            retryAfterMs: null,
          },
          clearCookie: false,
        });
      }

      // Resolve cookie handle
      if (!input.handle || input.handle.trim().length === 0) {
        return err({
          status: 401,
          error: {
            code: "unauthorized",
            message: MSG_UNAUTHORIZED,
            correlationId,
            retryAfterMs: null,
          },
          clearCookie: true,
        });
      }

      const repo = getRepository();
      const handleHash = createHash("sha256").update(input.handle.trim()).digest("hex");
      const session = await repo.findSession(handleHash, currentDate);
      if (!session) {
        return err({
          status: 401,
          error: {
            code: "unauthorized",
            message: MSG_UNAUTHORIZED,
            correlationId,
            retryAfterMs: null,
          },
          clearCookie: true,
        });
      }

      // Read flow
      const flowState = await repo.readState(session.userId);
      if (!flowState || flowState.phase !== "pending" || flowState.bindingHash !== handleHash) {
        return err({
          status: 401,
          error: {
            code: "unauthorized",
            message: MSG_UNAUTHORIZED,
            correlationId,
            retryAfterMs: null,
          },
          clearCookie: false,
        });
      }

      // Timing-safe state comparison
      const expectedState = flowState.payload.state;
      if (!expectedState || Buffer.byteLength(input.state) !== Buffer.byteLength(expectedState)) {
        return err({
          status: 400,
          error: {
            code: "unauthorized",
            message: MSG_UNAUTHORIZED,
            correlationId,
            retryAfterMs: null,
          },
          clearCookie: false,
        });
      }

      const stateMatches = timingSafeEqual(Buffer.from(input.state), Buffer.from(expectedState));
      if (!stateMatches) {
        return err({
          status: 400,
          error: {
            code: "unauthorized",
            message: MSG_UNAUTHORIZED,
            correlationId,
            retryAfterMs: null,
          },
          clearCookie: false,
        });
      }

      // Expiry check
      if (flowState.flowExpiresAt && flowState.flowExpiresAt.getTime() <= currentDate.getTime()) {
        return err({
          status: 401,
          error: {
            code: "unauthorized",
            message: MSG_UNAUTHORIZED,
            correlationId,
            retryAfterMs: null,
          },
          clearCookie: true,
        });
      }

      // Denial handling
      if (input.denied) {
        await repo.finishFlow({
          userId: session.userId,
          expectedVersion: flowState.version,
        });
        return err({
          status: 401,
          error: {
            code: "unauthorized",
            message: MSG_UNAUTHORIZED,
            correlationId,
            retryAfterMs: null,
          },
          clearCookie: true,
        });
      }

      // Discovered response issuer verification
      if (flowState.payload.discovery?.responseIssuerRequired) {
        if (!input.issuer || input.issuer !== flowState.payload.discovery.issuer) {
          return err({
            status: 400,
            error: {
              code: "unauthorized",
              message: MSG_UNAUTHORIZED,
              correlationId,
              retryAfterMs: null,
            },
            clearCookie: false,
          });
        }
      }

      // Atomic claim
      const claimedState = await repo.claimFlow({
        userId: session.userId,
        bindingHash: handleHash,
        expectedVersion: flowState.version,
        now: currentDate,
      });

      if (!claimedState) {
        return err({
          status: 401,
          error: {
            code: "unauthorized",
            message: MSG_UNAUTHORIZED,
            correlationId,
            retryAfterMs: null,
          },
          clearCookie: false,
        });
      }

      // Exchange code and activate session
      const provider = await getCreateProvider()(session.userId, claimedState);
      const connection = getConnect()(provider);

      try {
        await connection.finishAuth(input.code!, input.issuer);
        await connection.probeTools();

        const newHandle = randomHandle();
        const newHandleHash = createHash("sha256").update(newHandle).digest("hex");
        const authExpiresAt = new Date(currentDate.getTime() + 7 * 24 * 3600 * 1000); // 7 days

        await repo.activateSession({
          oldHandleHash: handleHash,
          newHandleHash,
          userId: session.userId,
          expectedFlowVersion: claimedState.version,
          now: currentDate,
          expiresAt: authExpiresAt,
        });

        return ok({
          location: "/",
          cookie: {
            value: newHandle,
            expiresAt: authExpiresAt,
            maxAge: 7 * 24 * 3600,
          },
        });
      } catch (error) {
        return mapErrorToFailure(error, correlationId, true);
      } finally {
        await connection.close().catch(() => {});
      }
    } catch (error) {
      return mapErrorToFailure(error, correlationId, false);
    }
  },

    async resolveSession(handle: string | null, correlationId: string): Promise<Result<{ userId: string; expiresAt: Date }, AppError>> {
      if (!handle || handle.trim().length === 0) {
        return err({
          code: "unauthorized",
          message: MSG_UNAUTHORIZED,
          correlationId,
          retryAfterMs: null,
        });
      }

      const repo = getRepository();
      const currentDate = now();
      const handleHash = createHash("sha256").update(handle.trim()).digest("hex");
      const session = await repo.findSession(handleHash, currentDate);

      if (!session || session.status !== "authenticated" || session.expiresAt.getTime() <= currentDate.getTime()) {
        return err({
          code: "unauthorized",
          message: MSG_UNAUTHORIZED,
          correlationId,
          retryAfterMs: null,
        });
      }

      return ok({
        userId: session.userId,
        expiresAt: session.expiresAt,
      });
    },
  };
}

export async function resolveSilpoSession(
  handle: string | null,
  options?: CreateSilpoOAuthServiceOptions,
): Promise<Result<{ userId: string; expiresAt: Date }, AppError>> {
  const correlationId = randomUUID();
  const service = createSilpoOAuthService(options);
  return service.resolveSession(handle, correlationId);
}
