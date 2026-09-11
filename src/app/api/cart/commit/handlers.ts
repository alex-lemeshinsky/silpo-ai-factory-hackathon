import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getDbClient } from "@/db/client";
import {
  commitApprovedDraft,
  type CartCommitFailureCode,
} from "@/features/cart/commit-service";
import {
  createPostgresCartCommitRepository,
  type CartCommitRepository,
} from "@/features/cart/repository";
import {
  DEMO_SESSION_COOKIE,
  DEMO_SESSION_MAX_AGE_SECONDS,
  ensureDemoUser,
  type DemoIdentity,
} from "@/features/drafts/demo-user";
import {
  createPostgresDraftRepository,
  type DraftRepository,
} from "@/features/drafts/repository";
import { createPostgresToolTraceRepository } from "@/features/diagnostics/trace-repository";
import type { DataMode } from "@/features/shared/contracts";
import { createSilpoGateway, type SilpoGatewayHandle } from "@/features/silpo/gateway";
import { resolveSilpoSession } from "@/features/silpo/oauth/service";
import { getServerEnv, type ServerEnv } from "@/lib/env";
import { createLogger, type Logger } from "@/lib/logger";
import type { AppError, Result } from "@/lib/result";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

const INVALID_REQUEST_COPY = "Некоректний запит.";
const UNAUTHORIZED_COPY = "Не вдалося підтвердити вхід. Увійдіть у «Сільпо» ще раз.";
const UNEXPECTED_COPY = "Не вдалося оновити кошик. Спробуйте ще раз.";

export interface CartCommitRequest {
  draftId: string;
  idempotencyKey: string;
}

export const CartCommitRequestSchema: z.ZodType<CartCommitRequest> = z.object({
  draftId: z.uuid(),
  idempotencyKey: z.uuid(),
}).strict();

export interface CartCommitHandlerDeps {
  getEnv: () => ServerEnv;
  resolveSession: (handle: string | null) => Promise<Result<{ userId: string }, AppError>>;
  resolveDemoIdentity: (cookieValue: string | null) => Promise<DemoIdentity>;
  drafts: () => DraftRepository;
  commits: () => CartCommitRepository;
  logger: () => Logger;
  openGateway: (options: { mode: DataMode; userId: string }) => Promise<SilpoGatewayHandle>;
  commit: typeof commitApprovedDraft;
}

const STATUS_BY_CODE: Record<CartCommitFailureCode, number> = {
  not_found: 404,
  approval_required: 409,
  needs_slot: 409,
  unauthorized: 401,
  cart_incomplete: 409,
  // The one retryable failure: the client repeats the request with the same
  // key and the service reuses the persisted absolute targets.
  commit_uncertain: 502,
  unexpected: 500,
};

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: RESPONSE_HEADERS });
}

function invalidRequest(correlationId: string): NextResponse {
  return json({ error: { code: "invalid_request", message: INVALID_REQUEST_COPY, correlationId } }, 400);
}

function unauthorized(correlationId: string): NextResponse {
  return json({ error: { code: "unauthorized", message: UNAUTHORIZED_COPY, correlationId } }, 401);
}

function unexpected(correlationId: string): NextResponse {
  return json({ error: { code: "unexpected", message: UNEXPECTED_COPY, correlationId } }, 500);
}

function setDemoCookie(response: NextResponse, identity: DemoIdentity, env: ServerEnv): void {
  response.cookies.set(DEMO_SESSION_COOKIE, identity.handle, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: env.NODE_ENV === "production",
    maxAge: DEMO_SESSION_MAX_AGE_SECONDS,
  });
}

export function createCartCommitPostHandler(overrides: Partial<CartCommitHandlerDeps> = {}) {
  const getEnv = overrides.getEnv ?? (() => getServerEnv());
  const deps: CartCommitHandlerDeps = {
    getEnv,
    resolveSession: (handle) => resolveSilpoSession(handle),
    resolveDemoIdentity: (cookie) => ensureDemoUser(getDbClient(), cookie),
    drafts: () => createPostgresDraftRepository(getDbClient()),
    commits: () => createPostgresCartCommitRepository(getDbClient()),
    logger: () => createLogger({ sink: createPostgresToolTraceRepository(getDbClient()) }),
    openGateway: ({ mode, userId }) =>
      createSilpoGateway({ mode, userId, publicBaseUrl: getEnv().PUBLIC_BASE_URL }),
    commit: commitApprovedDraft,
    ...overrides,
  };

  return async function POST(request: NextRequest) {
    const correlationId = randomUUID();

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return invalidRequest(correlationId);
    }
    const parsed = CartCommitRequestSchema.safeParse(body);
    if (!parsed.success) return invalidRequest(correlationId);

    let env: ServerEnv | null = null;
    let demoIdentity: DemoIdentity | null = null;
    try {
      env = deps.getEnv();
      let userId: string;
      if (env.DATA_MODE === "demo") {
        demoIdentity = await deps.resolveDemoIdentity(
          request.cookies.get(DEMO_SESSION_COOKIE)?.value ?? null,
        );
        userId = demoIdentity.userId;
      } else {
        const session = await deps.resolveSession(
          request.cookies.get("silpo_session")?.value ?? null,
        );
        if (!session.ok) return unauthorized(correlationId);
        userId = session.value.userId;
      }

      const mode = env.DATA_MODE;
      const result = await deps.commit(
        {
          draftId: parsed.data.draftId,
          userId,
          idempotencyKey: parsed.data.idempotencyKey,
          correlationId,
          mode,
        },
        {
          drafts: deps.drafts(),
          commits: deps.commits(),
          openGateway: () => deps.openGateway({ mode, userId }),
          logger: deps.logger(),
        },
      );

      const response = result.ok
        ? json(result.value, 200)
        : json({ error: result.error }, STATUS_BY_CODE[result.error.code]);
      if (demoIdentity?.issued) setDemoCookie(response, demoIdentity, env);
      return response;
    } catch {
      const response = unexpected(correlationId);
      if (demoIdentity?.issued && env) setDemoCookie(response, demoIdentity, env);
      return response;
    }
  };
}
