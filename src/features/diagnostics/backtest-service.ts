import {
  CartContextResultSchema,
  RawPurchaseReceiptSchema,
  type SilpoGateway,
} from "@/features/shared/contracts";
import { normalizePurchases } from "@/features/purchases/normalize";
import { DAY_MS } from "@/features/prediction/features";
import {
  runRollingBacktest,
  type BacktestReport,
} from "@/features/prediction/backtest";
import { err, ok, type AppError, type Result } from "@/lib/result";

const messages = {
  needs_slot: "Оберіть доступний слот для демонстраційного контексту.",
  invalid_external_data: "Не вдалося перевірити демонстраційні дані.",
  unexpected: "Не вдалося побудувати звіт. Спробуйте ще раз.",
} as const;

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

export async function loadDemoBacktest(
  gateway: SilpoGateway,
  correlationId: string,
): Promise<Result<BacktestReport, AppError>> {
  try {
    const parsedContext = CartContextResultSchema.safeParse(
      await gateway.loadCartContext(),
    );
    if (!parsedContext.success) {
      return err({
        code: "invalid_external_data",
        message: messages.invalid_external_data,
        correlationId,
        retryAfterMs: null,
      });
    }

    const contextResult = parsedContext.data;
    if (contextResult.status === "needs_slot") {
      return err({
        code: "needs_slot",
        message: messages.needs_slot,
        correlationId,
        retryAfterMs: null,
      });
    }

    const context = contextResult.context;
    if (!context.city) {
      return err({
        code: "invalid_external_data",
        message: messages.invalid_external_data,
        correlationId,
        retryAfterMs: null,
      });
    }

    const activeCity = context.city;
    const rawHistory = await gateway.loadPurchaseHistory(context);

    if (!Array.isArray(rawHistory)) {
      return err({
        code: "invalid_external_data",
        message: messages.invalid_external_data,
        correlationId,
        retryAfterMs: null,
      });
    }

    const seenSourceIds = new Set<string>();
    for (const receipt of rawHistory) {
      const parsed = RawPurchaseReceiptSchema.safeParse(receipt);
      if (!parsed.success) {
        return err({
          code: "invalid_external_data",
          message: messages.invalid_external_data,
          correlationId,
          retryAfterMs: null,
        });
      }
      if (seenSourceIds.has(parsed.data.sourceId)) {
        return err({
          code: "invalid_external_data",
          message: messages.invalid_external_data,
          correlationId,
          retryAfterMs: null,
        });
      }
      seenSourceIds.add(parsed.data.sourceId);
    }

    if (rawHistory.length === 0) {
      const report = runRollingBacktest([], { activeCity });
      return ok(report);
    }

    const sorted = [...rawHistory].sort(
      (a, b) => Date.parse(a.purchasedAt) - Date.parse(b.purchasedAt),
    );

    const minTs = Date.parse(sorted[0].purchasedAt);
    const maxTs = Date.parse(sorted[sorted.length - 1].purchasedAt);

    // Precondition 1: span <= 180 days
    if (maxTs - minTs > 180 * DAY_MS) {
      return err({
        code: "invalid_external_data",
        message: messages.invalid_external_data,
        correlationId,
        retryAfterMs: null,
      });
    }

    // Precondition 2: adjacent receipts > 4 hours apart
    for (let i = 0; i < sorted.length - 1; i++) {
      const gap =
        Date.parse(sorted[i + 1].purchasedAt) - Date.parse(sorted[i].purchasedAt);
      if (gap <= FOUR_HOURS_MS) {
        return err({
          code: "invalid_external_data",
          message: messages.invalid_external_data,
          correlationId,
          retryAfterMs: null,
        });
      }
    }

    const cutoff = new Date(maxTs).toISOString();
    const normalized = normalizePurchases(sorted, activeCity, cutoff);
    const report = runRollingBacktest(normalized, { activeCity });

    return ok(report);
  } catch {
    return err({
      code: "unexpected",
      message: messages.unexpected,
      correlationId,
      retryAfterMs: null,
    });
  }
}
