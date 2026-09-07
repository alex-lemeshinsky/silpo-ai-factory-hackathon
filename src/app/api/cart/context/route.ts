import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { UpdateCartContextInputSchema } from "@/features/shared/contracts";
import { createLiveCartContextGateway, SlotUnavailableError } from "@/features/silpo/live/cart-context";
import {
  McpCallError,
  openReadSession,
  openWriteSession,
  type McpSession,
} from "@/features/silpo/live/session";
import { InvalidExternalDataError } from "@/features/silpo/schemas/common";
import { resolveSilpoSession } from "@/features/silpo/oauth/service";
import { getServerEnv } from "@/lib/env";
import type { AppError } from "@/lib/result";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

const MSG_UNAUTHORIZED = "Не вдалося підтвердити вхід. Увійдіть у «Сільпо» ще раз.";
const MSG_MALFORMED = "Некоректний запит. Оновіть сторінку та спробуйте ще раз.";
const MSG_NEEDS_SLOT = "Оберіть доступний слот доставки.";
const MSG_RATE_LIMITED = "Забагато запитів. Спробуйте трохи пізніше.";
const MSG_INVALID_EXTERNAL = "«Сільпо» повернуло некоректну відповідь. Спробуйте ще раз.";
const MSG_UNEXPECTED = "Не вдалося оновити контекст кошика. Спробуйте ще раз.";

function fail(
  status: number,
  code: AppError["code"],
  message: string,
  correlationId: string,
  retryAfterMs: number | null = null,
) {
  const error: AppError = { code, message, correlationId, retryAfterMs };
  return Response.json({ error }, { status, headers });
}

function parseRetryAfterMs(header: string | null): number | null {
  if (header === null || header.trim().length === 0) {
    return null;
  }
  const seconds = Number.parseInt(header.trim(), 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = randomUUID();

  try {
    const env = getServerEnv();

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return fail(400, "unexpected", MSG_MALFORMED, correlationId);
    }

    const parsed = UpdateCartContextInputSchema.safeParse(payload);
    if (!parsed.success) {
      return fail(400, "unexpected", MSG_MALFORMED, correlationId);
    }

    // Demo mode drives the same call through the demo gateway so live and
    // demo return the same shape and the demo label is preserved.
    if (env.DATA_MODE === "demo") {
      const { createDemoSilpoGateway } = await import("@/features/silpo/demo/demo-gateway");
      const context = await createDemoSilpoGateway().updateCartContext(parsed.data);
      return Response.json({ mode: "demo", context }, { status: 200, headers });
    }

    const handle = request.cookies.get("silpo_session")?.value ?? null;
    const session = await resolveSilpoSession(handle);
    if (!session.ok) {
      return fail(401, "unauthorized", MSG_UNAUTHORIZED, correlationId);
    }

    const { createSilpoOAuthProvider } = await import("@/features/silpo/oauth/provider");
    const provider = await createSilpoOAuthProvider(session.value.userId, {
      publicBaseUrl: env.PUBLIC_BASE_URL,
    });

    let readSession: McpSession | undefined;
    let writeSession: McpSession | undefined;
    try {
      readSession = await openReadSession({ provider });
      writeSession = await openWriteSession({ provider });
      const gateway = createLiveCartContextGateway({ readSession, writeSession });
      const context = await gateway.updateCartContext(parsed.data);
      return Response.json({ mode: "live", context }, { status: 200, headers });
    } finally {
      await readSession?.close().catch(() => {});
      await writeSession?.close().catch(() => {});
    }
  } catch (error) {
    if (error instanceof SlotUnavailableError) {
      return fail(409, "needs_slot", MSG_NEEDS_SLOT, correlationId);
    }
    if (error instanceof McpCallError && error.status === 429) {
      return fail(
        429,
        "rate_limited",
        MSG_RATE_LIMITED,
        correlationId,
        parseRetryAfterMs(error.retryAfterHeader),
      );
    }
    if (error instanceof InvalidExternalDataError) {
      return fail(502, "invalid_external_data", MSG_INVALID_EXTERNAL, correlationId);
    }
    // Every other failure is reported as a safe message. Provider text, URLs
    // and headers never reach the client.
    return fail(500, "unexpected", MSG_UNEXPECTED, correlationId);
  }
}
