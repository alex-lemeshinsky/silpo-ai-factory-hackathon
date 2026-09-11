import { describe, expect, it, vi } from "vitest";

import type { SilpoGateway } from "@/features/shared/contracts";
import type { Logger, ToolTrace } from "@/lib/logger";
import { sanitizeTrace } from "@/lib/logger";

import { withTracedGateway } from "./traced-gateway";

function collectingLogger() {
  const traces: ToolTrace[] = [];
  const logger: Logger = {
    async toolCall(input) {
      traces.push(sanitizeTrace(input));
    },
  };
  return { logger, traces };
}

/**
 * Every method resolves. The decorator must not care what any of them
 * returns, so a single stub value is honest here.
 */
function stubGateway(): SilpoGateway {
  const resolve = async () => undefined as never;
  return {
    listTools: resolve,
    loadCustomerContext: resolve,
    loadCartContext: resolve,
    updateCartContext: resolve,
    loadPurchaseHistory: resolve,
    findProducts: resolve,
    getPromotions: resolve,
    getProductDetails: resolve,
    getSimilarProducts: resolve,
    getReplacements: resolve,
    getTimeSlots: resolve,
    setAbsoluteCartQuantities: resolve,
    readCart: resolve,
  };
}

describe("withTracedGateway", () => {
  it("A17-18 emits one trace for every gateway method, enumerated from the port", async () => {
    const { logger, traces } = collectingLogger();
    const base = stubGateway();
    const traced = withTracedGateway(base, { logger, correlationId: "corr-1", mode: "demo" });

    const methodNames = Object.keys(base) as Array<keyof SilpoGateway>;
    for (const name of methodNames) {
      await (traced[name] as (...args: never[]) => Promise<unknown>)();
    }

    expect(traces.map((entry) => entry.toolName).sort()).toEqual([...methodNames].sort());
    expect(traces.every((entry) => entry.status === "ok")).toBe(true);
    expect(traces.every((entry) => entry.mode === "demo")).toBe(true);
    expect(traces.every((entry) => entry.correlationId === "corr-1")).toBe(true);
  });

  it("A17-19 records elapsed time from the injected clock", async () => {
    const { logger, traces } = collectingLogger();
    let clock = 1000;
    const traced = withTracedGateway(
      { ...stubGateway(), readCart: async () => { clock += 250; return undefined as never; } },
      { logger, correlationId: "corr-1", mode: "live", now: () => clock },
    );

    await traced.readCart("cart-1");

    expect(traces[0].durationMs).toBe(250);
  });

  it("A17-20 records an error and rethrows the original error instance", async () => {
    class GatewayFailure extends Error {}
    const failure = new GatewayFailure("boom");
    const { logger, traces } = collectingLogger();
    const traced = withTracedGateway(
      { ...stubGateway(), readCart: async () => { throw failure; } },
      { logger, correlationId: "corr-1", mode: "live" },
    );

    // Identity, not shape: the services classify failures with `instanceof`.
    await expect(traced.readCart("cart-1")).rejects.toBe(failure);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ toolName: "readCart", status: "error" });
  });

  it("A17-21 lets the underlying call succeed even when the logger throws", async () => {
    const logger: Logger = { toolCall: vi.fn(async () => { throw new Error("logger down"); }) };
    const traced = withTracedGateway(
      { ...stubGateway(), listTools: async () => ["silpo_get_offline_orders"] },
      { logger, correlationId: "corr-1", mode: "demo" },
    );

    await expect(traced.listTools()).resolves.toEqual(["silpo_get_offline_orders"]);
  });

  it("A17-22 passes arguments through untouched", async () => {
    const findProducts = vi.fn(async () => [] as never);
    const { logger } = collectingLogger();
    const context = { cartId: "cart-1" } as never;
    const traced = withTracedGateway(
      { ...stubGateway(), findProducts },
      { logger, correlationId: "corr-1", mode: "demo" },
    );

    await traced.findProducts(context, ["вода", "хліб"]);

    expect(findProducts).toHaveBeenCalledWith(context, ["вода", "хліб"]);
  });

  it("A17-23 carries the caller's retry count onto every trace", async () => {
    const { logger, traces } = collectingLogger();
    const traced = withTracedGateway(stubGateway(), {
      logger,
      correlationId: "corr-1",
      mode: "live",
      retryCount: 1,
    });

    await traced.readCart("cart-1");

    expect(traces[0].retryCount).toBe(1);
  });
});
