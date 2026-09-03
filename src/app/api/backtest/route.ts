import { getServerEnv } from "@/lib/env";
import { loadDemoBacktest } from "@/features/diagnostics/backtest-service";
import type { AppError } from "@/lib/result";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const headers = { "Cache-Control": "no-store" };

export async function GET(): Promise<Response> {
  const correlationId = crypto.randomUUID();

  try {
    const env = getServerEnv();

    if (env.DATA_MODE === "live") {
      return Response.json({ error: "not_found" }, { status: 404, headers });
    }

    const { createDemoSilpoGateway } = await import(
      "@/features/silpo/demo/demo-gateway"
    );
    const gateway = createDemoSilpoGateway();
    const result = await loadDemoBacktest(gateway, correlationId);

    if (result.ok) {
      return Response.json(
        { mode: "demo", report: result.value },
        { status: 200, headers },
      );
    }

    const status = result.error.code === "needs_slot" ? 409 : 500;
    return Response.json({ error: result.error }, { status, headers });
  } catch {
    const safeError: AppError = {
      code: "unexpected",
      message: "Не вдалося побудувати звіт. Спробуйте ще раз.",
      correlationId,
      retryAfterMs: null,
    };
    return Response.json({ error: safeError }, { status: 500, headers });
  }
}
