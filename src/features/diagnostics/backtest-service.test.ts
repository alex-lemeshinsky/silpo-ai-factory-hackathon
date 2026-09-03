// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDemoSilpoGateway } from "@/features/silpo/demo/demo-gateway";
import type {
  CartContext,
  CartContextResult,
  RawPurchaseReceipt,
} from "@/features/shared/contracts";
import { loadDemoBacktest } from "./backtest-service";

describe("backtest-service", () => {
  it("B6-09 evaluates the actual synthetic fixture using only allowed reads", async () => {
    const gateway = createDemoSilpoGateway();
    const contextRead = vi.spyOn(gateway, "loadCartContext");
    const historyRead = vi.spyOn(gateway, "loadPurchaseHistory");
    const writes = [
      vi.spyOn(gateway, "updateCartContext"),
      vi.spyOn(gateway, "setAbsoluteCartQuantities"),
    ];
    const otherReads = [
      vi.spyOn(gateway, "listTools"),
      vi.spyOn(gateway, "loadCustomerContext"),
      vi.spyOn(gateway, "findProducts"),
      vi.spyOn(gateway, "getPromotions"),
      vi.spyOn(gateway, "getProductDetails"),
      vi.spyOn(gateway, "getSimilarProducts"),
      vi.spyOn(gateway, "getTimeSlots"),
      vi.spyOn(gateway, "readCart"),
    ];

    const result = await loadDemoBacktest(gateway, "synthetic-correlation");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected a successful synthetic report");
    expect(result.value.inputReceiptCount).toBe(30);
    expect(contextRead).toHaveBeenCalledTimes(1);
    expect(historyRead).toHaveBeenCalledTimes(1);
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    for (const read of otherReads) expect(read).not.toHaveBeenCalled();

    expect(
      await loadDemoBacktest(createDemoSilpoGateway(), "another-correlation"),
    ).toEqual(result);
  });

  it("handles needs_slot without loading history", async () => {
    const gateway = createDemoSilpoGateway();
    const slotMock: CartContextResult = {
      status: "needs_slot",
      availableSlots: [],
    };
    vi.spyOn(gateway, "loadCartContext").mockResolvedValue(slotMock);
    const historyRead = vi.spyOn(gateway, "loadPurchaseHistory");

    const result = await loadDemoBacktest(gateway, "corr-slot");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toEqual({
      code: "needs_slot",
      message: "Оберіть доступний слот для демонстраційного контексту.",
      correlationId: "corr-slot",
      retryAfterMs: null,
    });
    expect(historyRead).not.toHaveBeenCalled();
  });

  it("rejects null or blank city in cart context", async () => {
    const gateway = createDemoSilpoGateway();
    const baseContext = (await gateway.loadCartContext()) as {
      status: "ready";
      context: CartContext;
    };
    const badContext: CartContextResult = {
      status: "ready",
      context: { ...baseContext.context, city: null as unknown as string },
    };
    vi.spyOn(gateway, "loadCartContext").mockResolvedValue(badContext);

    const result = await loadDemoBacktest(gateway, "corr-city");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error.code).toBe("invalid_external_data");
    expect(result.error.message).toBe("Не вдалося перевірити демонстраційні дані.");
    expect(result.error.correlationId).toBe("corr-city");
  });

  it("evaluates empty history without deriving an invalid cutoff", async () => {
    const gateway = createDemoSilpoGateway();
    vi.spyOn(gateway, "loadPurchaseHistory").mockResolvedValue([]);

    const result = await loadDemoBacktest(gateway, "corr-empty");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected success");
    expect(result.value.inputReceiptCount).toBe(0);
    expect(result.value.evaluatedReceiptCount).toBe(0);
  });

  it("rejects schema-invalid purchase history", async () => {
    const gateway = createDemoSilpoGateway();
    vi.spyOn(gateway, "loadPurchaseHistory").mockResolvedValue([
      { invalid: true } as unknown as RawPurchaseReceipt,
    ]);

    const result = await loadDemoBacktest(gateway, "corr-invalid-schema");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error.code).toBe("invalid_external_data");
    expect(result.error.message).toBe("Не вдалося перевірити демонстраційні дані.");
  });

  it("rejects duplicate sourceIds in purchase history", async () => {
    const gateway = createDemoSilpoGateway();
    const contextResult = await gateway.loadCartContext();
    if (contextResult.status !== "ready") throw new Error("Expected ready context");
    const history = await gateway.loadPurchaseHistory(contextResult.context);
    const duplicatedHistory = [
      ...history,
      { ...history[0], purchasedAt: "2026-08-30T10:00:00.000Z" },
    ];
    vi.spyOn(gateway, "loadPurchaseHistory").mockResolvedValue(duplicatedHistory);

    const result = await loadDemoBacktest(gateway, "corr-dup");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error.code).toBe("invalid_external_data");
  });

  it("rejects a corpus spanning over 180 days", async () => {
    const gateway = createDemoSilpoGateway();
    const contextResult = await gateway.loadCartContext();
    if (contextResult.status !== "ready") throw new Error("Expected ready context");
    const history = await gateway.loadPurchaseHistory(contextResult.context);
    // Add a receipt 181 days before the last receipt
    const lastTime = Date.parse(history[history.length - 1].purchasedAt);
    const oldReceipt: RawPurchaseReceipt = {
      ...history[0],
      sourceId: "source-very-old",
      purchasedAt: new Date(lastTime - 181 * 86_400_000).toISOString(),
    };
    vi.spyOn(gateway, "loadPurchaseHistory").mockResolvedValue([
      oldReceipt,
      ...history,
    ]);

    const result = await loadDemoBacktest(gateway, "corr-span");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error.code).toBe("invalid_external_data");
  });

  it("rejects adjacent receipts within four hours", async () => {
    const gateway = createDemoSilpoGateway();
    const contextResult = await gateway.loadCartContext();
    if (contextResult.status !== "ready") throw new Error("Expected ready context");
    const history = await gateway.loadPurchaseHistory(contextResult.context);
    // Add a receipt 2 hours after the first receipt
    const firstTime = Date.parse(history[0].purchasedAt);
    const closeReceipt: RawPurchaseReceipt = {
      ...history[0],
      sourceId: "source-too-close",
      purchasedAt: new Date(firstTime + 2 * 3600 * 1000).toISOString(),
    };
    vi.spyOn(gateway, "loadPurchaseHistory").mockResolvedValue([
      ...history,
      closeReceipt,
    ]);

    const result = await loadDemoBacktest(gateway, "corr-close");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error.code).toBe("invalid_external_data");
  });

  it("masks secrets when gateway throws an unexpected error", async () => {
    const gateway = createDemoSilpoGateway();
    const sentinel = "SECRET_SENTINEL_TOKEN_12345";
    vi.spyOn(gateway, "loadCartContext").mockRejectedValue(
      new Error(`Failed with secret: ${sentinel}`),
    );

    const result = await loadDemoBacktest(gateway, "corr-sentinel");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error.code).toBe("unexpected");
    expect(result.error.message).toBe(
      "Не вдалося побудувати звіт. Спробуйте ще раз.",
    );
    expect(JSON.stringify(result.error)).not.toContain(sentinel);
  });

  it("evaluates snapshot consistently regardless of system date", async () => {
    const gateway = createDemoSilpoGateway();
    const result1 = await loadDemoBacktest(gateway, "corr-date-1");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const result2 = await loadDemoBacktest(gateway, "corr-date-2");
    vi.useRealTimers();

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (result1.ok && result2.ok) {
      expect(result2.value).toEqual(result1.value);
    }
  });
});
