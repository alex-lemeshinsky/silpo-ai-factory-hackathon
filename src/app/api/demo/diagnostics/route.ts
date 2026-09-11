import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { getDbClient } from "@/db/client";
import { buildDiagnostics } from "@/features/diagnostics/service";
import { createPostgresDecisionRepository } from "@/features/diagnostics/decision-repository";
import { createPostgresToolTraceRepository } from "@/features/diagnostics/trace-repository";
import { DEMO_SESSION_COOKIE, demoUserIdFor, isDemoHandle } from "@/features/drafts/demo-user";
import { getServerEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import type { AppError } from "@/lib/result";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const UNEXPECTED_COPY = "Не вдалося побудувати звіт. Спробуйте ще раз.";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();

  try {
    // Live mode has no diagnostics surface at all, exactly as /api/backtest.
    if (getServerEnv().DATA_MODE === "live") {
      return NextResponse.json({ error: "not_found" }, { status: 404, headers: HEADERS });
    }

    // Read-only: the handle is honoured if present and never issued. A GET
    // that shows a report must not create a `users` row as a side effect.
    const cookieValue = request.cookies.get(DEMO_SESSION_COOKIE)?.value ?? null;
    const userId = isDemoHandle(cookieValue) ? demoUserIdFor(cookieValue) : null;

    const { createDemoSilpoGateway } = await import("@/features/silpo/demo/demo-gateway");
    const db = getDbClient();
    const traces = createPostgresToolTraceRepository(db);

    const report = await buildDiagnostics(userId, {
      gateway: createDemoSilpoGateway(),
      decisions: createPostgresDecisionRepository(db),
      traces,
      logger: createLogger({ sink: traces }),
      correlationId,
    });

    return NextResponse.json({ mode: "demo", report }, { status: 200, headers: HEADERS });
  } catch {
    // Environment, database and wiring faults. The cause is never echoed.
    const error: AppError = {
      code: "unexpected",
      message: UNEXPECTED_COPY,
      correlationId,
      retryAfterMs: null,
    };
    return NextResponse.json({ error }, { status: 500, headers: HEADERS });
  }
}
