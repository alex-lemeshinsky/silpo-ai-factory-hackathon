import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { getDbClient } from "@/db/client";
import { generateDraft } from "@/features/agent/google-model";
import {
  DEMO_SESSION_COOKIE,
  DEMO_SESSION_MAX_AGE_SECONDS,
  ensureDemoUser,
  type DemoIdentity,
} from "@/features/drafts/demo-user";
import { createPostgresDraftRepository, type DraftRepository } from "@/features/drafts/repository";
import { createDraftForUser, type CreateDraftDeps } from "@/features/drafts/service";
import { createPostgresToolTraceRepository } from "@/features/diagnostics/trace-repository";
import { createSilpoGateway } from "@/features/silpo/gateway";
import { resolveSilpoSession } from "@/features/silpo/oauth/service";
import { getServerEnv, type ServerEnv } from "@/lib/env";
import { createLogger, type Logger } from "@/lib/logger";
import type { AppError, AppErrorCode, Result } from "@/lib/result";

const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

const MSG_UNAUTHORIZED = "Не вдалося підтвердити вхід. Увійдіть у «Сільпо» ще раз.";
const MSG_UNEXPECTED = "Не вдалося зібрати чернетку. Спробуйте ще раз.";

/** The only place an HTTP status is decided. */
const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  needs_slot: 409,
  cart_validation_error: 409,
  unauthorized: 401,
  rate_limited: 429,
  invalid_external_data: 502,
  unavailable_product: 409,
  partial_commit: 409,
  model_invalid_output: 502,
  unexpected: 500,
};

/**
 * Every dependency is a field with a production default, because the
 * integration test runs without a database, without a network and without
 * an API key. `repository` and `resolveDemoIdentity` are thunks so the
 * database client is built at call time rather than at module load, and
 * every default reads the environment through `getEnv` so overriding it
 * cannot leave one dependency talking to the real one.
 */
export interface DraftsHandlerDeps {
  getEnv: () => ServerEnv;
  resolveSession: (handle: string | null) => Promise<Result<{ userId: string }, AppError>>;
  resolveDemoIdentity: (cookieValue: string | null) => Promise<DemoIdentity>;
  repository: () => DraftRepository;
  logger: () => Logger;
  openGateway: CreateDraftDeps["openGateway"];
  generateDraft: CreateDraftDeps["generateDraft"];
}

function fail(status: number, error: AppError, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error, ...extra }, { status, headers });
}

export function createDraftsPostHandler(overrides: Partial<DraftsHandlerDeps> = {}) {
  const getEnv = overrides.getEnv ?? (() => getServerEnv());
  const deps: DraftsHandlerDeps = {
    getEnv,
    resolveSession: (handle) => resolveSilpoSession(handle),
    resolveDemoIdentity: (cookieValue) => ensureDemoUser(getDbClient(), cookieValue),
    repository: () => createPostgresDraftRepository(getDbClient()),
    logger: () => createLogger({ sink: createPostgresToolTraceRepository(getDbClient()) }),
    openGateway: ({ mode, userId }) =>
      createSilpoGateway({ mode, userId, publicBaseUrl: getEnv().PUBLIC_BASE_URL }),
    generateDraft: (input) => {
      const env = getEnv();
      return generateDraft(input, {
        apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
        model: env.AGENT_MODEL,
      });
    },
    ...overrides,
  };

  return async function POST(request: NextRequest): Promise<NextResponse> {
    const correlationId = randomUUID();

    try {
      // The run takes no client input at all: no body is read, no query
      // parameter is consulted. Mode comes from the environment and the
      // identity from a server-side session or a server-issued demo handle.
      const env = deps.getEnv();
      const mode = env.DATA_MODE;

      let userId: string;
      let demoIdentity: DemoIdentity | null = null;
      if (mode === "demo") {
        demoIdentity = await deps.resolveDemoIdentity(
          request.cookies.get(DEMO_SESSION_COOKIE)?.value ?? null,
        );
        userId = demoIdentity.userId;
      } else {
        const handle = request.cookies.get("silpo_session")?.value ?? null;
        const session = await deps.resolveSession(handle);
        if (!session.ok) {
          return fail(401, {
            code: "unauthorized",
            message: MSG_UNAUTHORIZED,
            correlationId,
            retryAfterMs: null,
          });
        }
        userId = session.value.userId;
      }

      /**
       * Attached to whatever this request returns, success or failure, so a
       * visitor whose run failed is not handed a new identity — and a new
       * `users` row — on every retry.
       */
      const withDemoCookie = (response: NextResponse): NextResponse => {
        if (demoIdentity?.issued === true) {
          response.cookies.set(DEMO_SESSION_COOKIE, demoIdentity.handle, {
            httpOnly: true,
            sameSite: "lax",
            path: "/",
            secure: env.NODE_ENV === "production",
            maxAge: DEMO_SESSION_MAX_AGE_SECONDS,
          });
        }
        return response;
      };

      const result = await createDraftForUser(
        { userId, mode, correlationId },
        {
          openGateway: deps.openGateway,
          generateDraft: deps.generateDraft,
          repository: deps.repository(),
          logger: deps.logger(),
        },
      );

      if (!result.ok) {
        const { error, availableSlots } = result.error;
        return withDemoCookie(fail(
          STATUS_BY_CODE[error.code],
          error,
          availableSlots === null ? {} : { availableSlots },
        ));
      }

      const { draft, cartContext, loyaltyBonusAvailable } = result.value;
      return withDemoCookie(NextResponse.json(
        { mode, draft, cartContext, loyaltyBonusAvailable },
        { status: 200, headers },
      ));
    } catch {
      // Environment, database and wiring faults. The cause is never echoed.
      return fail(500, {
        code: "unexpected",
        message: MSG_UNEXPECTED,
        correlationId,
        retryAfterMs: null,
      });
    }
  };
}
