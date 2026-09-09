import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getDbClient } from "@/db/client";
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
import {
  approveDraftSelection,
  DraftApprovalInputSchema,
  type DraftApprovalFailureCode,
} from "@/features/drafts/approval-service";
import { resolveSilpoSession } from "@/features/silpo/oauth/service";
import { getServerEnv, type ServerEnv } from "@/lib/env";
import type { AppError, Result } from "@/lib/result";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

const INVALID_REQUEST_COPY = "Некоректний запит.";
const UNAUTHORIZED_COPY = "Не вдалося підтвердити вхід. Увійдіть у «Сільпо» ще раз.";
const UNEXPECTED_COPY = "Не вдалося підтвердити чернетку. Спробуйте ще раз.";

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: RESPONSE_HEADERS });
}

function invalidRequest(correlationId: string): NextResponse {
  return json({ error: { code: "invalid_selection", message: INVALID_REQUEST_COPY, correlationId } }, 400);
}

function unauthorized(correlationId: string): NextResponse {
  return json({ error: { code: "unauthorized", message: UNAUTHORIZED_COPY, correlationId } }, 401);
}

function unexpected(correlationId: string): NextResponse {
  return json({ error: { code: "unexpected", message: UNEXPECTED_COPY, correlationId } }, 500);
}

function setDemoCookie(
  response: NextResponse,
  identity: DemoIdentity,
  env: ServerEnv,
): void {
  response.cookies.set(DEMO_SESSION_COOKIE, identity.handle, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: env.NODE_ENV === "production",
    maxAge: DEMO_SESSION_MAX_AGE_SECONDS,
  });
}

export interface ApprovalHandlerDeps {
  getEnv: () => ServerEnv;
  resolveSession: (handle: string | null) => Promise<Result<{ userId: string }, AppError>>;
  resolveDemoIdentity: (cookieValue: string | null) => Promise<DemoIdentity>;
  repository: () => DraftRepository;
  approve: typeof approveDraftSelection;
  newIdempotencyKey: () => string;
}

export type ApprovalRouteContext = {
  params: Promise<{ draftId: string }>;
};

const STATUS_BY_CODE: Record<DraftApprovalFailureCode, number> = {
  not_found: 404,
  conflict: 409,
  invalid_selection: 422,
  unexpected: 500,
};

export function createApproveDraftPostHandler(overrides: Partial<ApprovalHandlerDeps> = {}) {
  const getEnv = overrides.getEnv ?? (() => getServerEnv());
  const deps: ApprovalHandlerDeps = {
    getEnv,
    resolveSession: (handle) => resolveSilpoSession(handle),
    resolveDemoIdentity: (cookie) => ensureDemoUser(getDbClient(), cookie),
    repository: () => createPostgresDraftRepository(getDbClient()),
    approve: approveDraftSelection,
    newIdempotencyKey: () => randomUUID(),
    ...overrides,
  };

  return async function POST(request: NextRequest, context: ApprovalRouteContext) {
    const correlationId = randomUUID();
    let parsedId;
    try {
      const { draftId } = await context.params;
      parsedId = z.uuid().safeParse(draftId);
    } catch {
      return invalidRequest(correlationId);
    }
    if (!parsedId.success) return invalidRequest(correlationId);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return invalidRequest(correlationId);
    }
    const selection = DraftApprovalInputSchema.safeParse(body);
    if (!selection.success) return invalidRequest(correlationId);

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

      const result = await deps.approve({
        draftId: parsedId.data,
        userId,
        selection: selection.data,
        correlationId,
      }, {
        repository: deps.repository(),
        newIdempotencyKey: deps.newIdempotencyKey,
      });

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
