import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { getDbClient } from "@/db/client";
import { generateDraft } from "@/features/agent/google-model";
import { ensureDemoUser } from "@/features/drafts/demo-user";
import { createPostgresDraftRepository, type DraftRepository } from "@/features/drafts/repository";
import { createDraftForUser, type CreateDraftDeps } from "@/features/drafts/service";
import { createSilpoGateway } from "@/features/silpo/gateway";
import { resolveSilpoSession } from "@/features/silpo/oauth/service";
import { getServerEnv, type ServerEnv } from "@/lib/env";
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
 * an API key. `repository` and `resolveDemoUserId` are thunks so the
 * database client is built at call time rather than at module load.
 */
export interface DraftsHandlerDeps {
  getEnv: () => ServerEnv;
  resolveSession: (handle: string | null) => Promise<Result<{ userId: string }, AppError>>;
  resolveDemoUserId: () => Promise<string>;
  repository: () => DraftRepository;
  openGateway: CreateDraftDeps["openGateway"];
  generateDraft: CreateDraftDeps["generateDraft"];
}

const productionDeps: DraftsHandlerDeps = {
  getEnv: () => getServerEnv(),
  resolveSession: (handle) => resolveSilpoSession(handle),
  resolveDemoUserId: () => ensureDemoUser(getDbClient()),
  repository: () => createPostgresDraftRepository(getDbClient()),
  openGateway: ({ mode, userId }) =>
    createSilpoGateway({ mode, userId, publicBaseUrl: getServerEnv().PUBLIC_BASE_URL }),
  generateDraft: (input) => {
    const env = getServerEnv();
    return generateDraft(input, {
      apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
      model: env.AGENT_MODEL,
    });
  },
};

function fail(status: number, error: AppError, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error, ...extra }, { status, headers });
}

export function createDraftsPostHandler(overrides: Partial<DraftsHandlerDeps> = {}) {
  const deps: DraftsHandlerDeps = { ...productionDeps, ...overrides };

  return async function POST(request: NextRequest): Promise<Response> {
    const correlationId = randomUUID();

    try {
      // The run takes no client input at all: no body is read, no query
      // parameter is consulted. Mode comes from the environment and the
      // identity from the server-side session.
      const env = deps.getEnv();
      const mode = env.DATA_MODE;

      let userId: string;
      if (mode === "demo") {
        userId = await deps.resolveDemoUserId();
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

      const result = await createDraftForUser(
        { userId, mode, correlationId },
        {
          openGateway: deps.openGateway,
          generateDraft: deps.generateDraft,
          repository: deps.repository(),
        },
      );

      if (!result.ok) {
        const { error, availableSlots } = result.error;
        return fail(
          STATUS_BY_CODE[error.code],
          error,
          availableSlots === null ? {} : { availableSlots },
        );
      }

      const { draft, cartContext, loyaltyBonusAvailable } = result.value;
      return Response.json(
        { mode, draft, cartContext, loyaltyBonusAvailable },
        { status: 200, headers },
      );
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
