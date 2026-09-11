import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { DraftGeneration } from "@/features/agent/draft-agent";
import type { DraftAgentInput } from "@/features/agent/draft-output";
import { buildFallbackProposal } from "@/features/agent/fallback";
import { createInMemoryDraftRepository } from "@/features/drafts/repository";
import type { RawPurchaseReceipt, SilpoGateway } from "@/features/shared/contracts";
import { createDemoSilpoGateway } from "@/features/silpo/demo/demo-gateway";
import type { SilpoGatewayHandle } from "@/features/silpo/gateway";
import { NoSavedAddressError } from "@/features/silpo/live/cart-context";
import { McpCallError } from "@/features/silpo/live/session";
import { InvalidExternalDataError } from "@/features/silpo/schemas/common";

import { sanitizeTrace, type Logger, type ToolTrace } from "@/lib/logger";

import { createDraftForUser, resolveActiveCity, UNKNOWN_CITY, type CreateDraftDeps } from "./service";

const RUN_AT = new Date("2026-09-08T09:00:00.000Z");

function recording(base: SilpoGateway, calls: string[]): SilpoGateway {
  return {
    async listTools() { calls.push("listTools"); return base.listTools(); },
    async loadCustomerContext() { calls.push("loadCustomerContext"); return base.loadCustomerContext(); },
    async loadCartContext() { calls.push("loadCartContext"); return base.loadCartContext(); },
    async updateCartContext(input) { calls.push("updateCartContext"); return base.updateCartContext(input); },
    async loadPurchaseHistory(context) { calls.push("loadPurchaseHistory"); return base.loadPurchaseHistory(context); },
    async findProducts(context, queries) { calls.push("findProducts"); return base.findProducts(context, queries); },
    async getPromotions(context) { calls.push("getPromotions"); return base.getPromotions(context); },
    async getProductDetails(context, slug) { calls.push("getProductDetails"); return base.getProductDetails(context, slug); },
    async getSimilarProducts(context, slug) { calls.push("getSimilarProducts"); return base.getSimilarProducts(context, slug); },
    async getReplacements(context, slug) { calls.push("getReplacements"); return base.getReplacements(context, slug); },
    async getTimeSlots(context) { calls.push("getTimeSlots"); return base.getTimeSlots(context); },
    async setAbsoluteCartQuantities(input) { calls.push("setAbsoluteCartQuantities"); return base.setAbsoluteCartQuantities(input); },
    async readCart(cartId) { calls.push("readCart"); return base.readCart(cartId); },
  };
}

function deterministicGeneration(input: DraftAgentInput): DraftGeneration {
  return {
    proposal: buildFallbackProposal(input),
    source: "fallback",
    attempts: 0,
    normalizations: [],
  };
}

function makeDeps(overrides: Partial<CreateDraftDeps> = {}) {
  const calls: string[] = [];
  const closed = { count: 0 };
  const gateway = recording(createDemoSilpoGateway(), calls);
  const handle: SilpoGatewayHandle = {
    gateway,
    async close() { closed.count += 1; },
  };
  const deps: CreateDraftDeps = {
    openGateway: async () => handle,
    generateDraft: async (input) => deterministicGeneration(input),
    repository: createInMemoryDraftRepository(),
    now: () => RUN_AT,
    newDraftId: () => "00000000-0000-4000-8000-000000000abc",
    ...overrides,
  };
  return { deps, calls, closed, handle };
}

const RUN = { userId: "user-1", mode: "demo" as const, correlationId: "corr-1" };

describe("createDraftForUser", () => {
  it("runs the documented order and never touches a cart write", async () => {
    const { deps, calls } = makeDeps();

    const result = await createDraftForUser(RUN, deps);

    expect(result.ok).toBe(true);
    expect(calls.slice(0, 4)).toEqual([
      "listTools",
      "loadCartContext",
      "loadCustomerContext",
      "loadPurchaseHistory",
    ]);
    expect(calls.indexOf("findProducts")).toBeGreaterThan(3);
    // Discounts come from the product's own fields, so calling
    // `getPromotions` would be a defect, not merely waste.
    for (const forbidden of ["getPromotions", "updateCartContext", "setAbsoluteCartQuantities", "readCart"]) {
      expect(calls).not.toContain(forbidden);
    }
  });

  it("assembles and persists the demo fixture's draft", async () => {
    const { deps } = makeDeps();

    const result = await createDraftForUser(RUN, deps);

    if (!result.ok) throw new Error("expected a draft");
    const { draft } = result.value;
    expect(draft.items.map((item) => item.productId)).toEqual([
      "demo-water-still-15l",
      "demo-milk-25-900g",
      "demo-oatmeal-500g",
    ]);
    expect(draft.total).toBe(115.7);
    expect(draft.status).toBe("ready");
    expect(draft.mode).toBe("demo");
    expect(draft.algorithmVersion).toBe("prediction-v1");
    expect(draft.trainingCutoff).toBe(RUN_AT.toISOString());
    expect(draft.items[0].reasonCodes).toContain("category_repeat");
    expect(draft.items[2].specialPrice).toBe(42.9);

    await expect(deps.repository.get(draft.id, "user-1")).resolves.toEqual(draft);
  });

  it("returns the cart context and loyalty figure the dashboard needs", async () => {
    const { deps } = makeDeps();

    const result = await createDraftForUser(RUN, deps);

    if (!result.ok) throw new Error("expected a draft");
    expect(result.value.cartContext.cartId).toBe("demo-cart-ready");
    expect(result.value.loyaltyBonusAvailable).toBe(84.5);
    expect(result.value.generation.source).toBe("fallback");
  });

  it("stops before generation when the cart has no usable slot", async () => {
    const generateDraft = vi.fn();
    const base = createDemoSilpoGateway();
    const { deps } = makeDeps({
      generateDraft,
      openGateway: async () => ({
        gateway: {
          ...base,
          async loadCartContext() {
            return {
              status: "needs_slot" as const,
              availableSlots: [{
                id: "slot-1",
                startsAt: "2026-09-09T09:00:00.000Z",
                endsAt: "2026-09-09T11:00:00.000Z",
                available: true,
              }],
            };
          },
        },
        async close() {},
      }),
    });

    const result = await createDraftForUser(RUN, deps);

    if (result.ok) throw new Error("expected needs_slot");
    expect(result.error.error.code).toBe("needs_slot");
    expect(result.error.availableSlots).toHaveLength(1);
    expect(generateDraft).not.toHaveBeenCalled();
  });

  it("reports an injected generation fault as `unexpected`, never as a model error", async () => {
    const { deps } = makeDeps({
      generateDraft: async () => { throw new Error("provider exploded"); },
    });

    const result = await createDraftForUser(RUN, deps);

    // `generateDraftWithModel` absorbs model and provider faults itself and
    // returns a deterministic draft, so a generation function that throws is
    // a wiring fault. It must never surface as `model_invalid_output`.
    if (result.ok) throw new Error("expected a failure");
    expect(result.error.error.code).toBe("unexpected");
    expect(result.error.error.message).not.toContain("provider exploded");
  });

  it("carries the deterministic fallback through to a saved draft", async () => {
    const { deps } = makeDeps({
      generateDraft: async (input) => ({
        proposal: buildFallbackProposal(input),
        source: "fallback",
        attempts: 2,
        normalizations: ["model_unavailable"],
      }),
    });

    const result = await createDraftForUser(RUN, deps);

    if (!result.ok) throw new Error("expected a draft");
    expect(result.value.generation).toEqual({
      source: "fallback",
      attempts: 2,
      normalizations: ["model_unavailable"],
    });
    expect(result.value.draft.items).toHaveLength(3);
  });

  it("closes the gateway on success and on failure", async () => {
    const success = makeDeps();
    await createDraftForUser(RUN, success.deps);
    expect(success.closed.count).toBe(1);

    const failureClosed = { count: 0 };
    const failure = makeDeps({
      openGateway: async () => ({
        gateway: {
          ...createDemoSilpoGateway(),
          async listTools() { throw new McpCallError("tools/list", 401, null); },
        },
        async close() { failureClosed.count += 1; },
      }),
    });
    const result = await createDraftForUser(RUN, failure.deps);
    expect(result.ok).toBe(false);
    expect(failureClosed.count).toBe(1);
  });

  it("maps every boundary failure to a safe typed error", async () => {
    const cases: Array<[unknown, string]> = [
      [new McpCallError("silpo_get_my_shopping_cart", 401, null), "unauthorized"],
      [new McpCallError("silpo_get_my_shopping_cart", 429, "3"), "rate_limited"],
      [new InvalidExternalDataError("silpo_get_my_shopping_cart"), "invalid_external_data"],
      [new NoSavedAddressError(), "cart_validation_error"],
      [new Error("something else"), "unexpected"],
    ];

    for (const [thrown, code] of cases) {
      const { deps } = makeDeps({
        openGateway: async () => ({
          gateway: {
            ...createDemoSilpoGateway(),
            async listTools() { throw thrown; },
          },
          async close() {},
        }),
      });

      const result = await createDraftForUser(RUN, deps);

      if (result.ok) throw new Error(`expected ${code}`);
      expect(result.error.error.code).toBe(code);
      expect(result.error.error.correlationId).toBe("corr-1");
      expect(result.error.error.message).not.toMatch(/silpo_get_my_shopping_cart|Error:/);
    }
  });

  it("reports rate limiting with the server's own retry hint", async () => {
    const { deps } = makeDeps({
      openGateway: async () => ({
        gateway: {
          ...createDemoSilpoGateway(),
          async listTools() { throw new McpCallError("t", 429, "3"); },
        },
        async close() {},
      }),
    });

    const result = await createDraftForUser(RUN, deps);

    if (result.ok) throw new Error("expected rate_limited");
    expect(result.error.error.retryAfterMs).toBe(3000);
  });

  it("rejects an empty advertised tool surface as invalid external data", async () => {
    const { deps } = makeDeps({
      openGateway: async () => ({
        gateway: { ...createDemoSilpoGateway(), async listTools() { return []; } },
        async close() {},
      }),
    });

    const result = await createDraftForUser(RUN, deps);

    if (result.ok) throw new Error("expected invalid_external_data");
    expect(result.error.error.code).toBe("invalid_external_data");
  });

  it("does not import the AI SDK", () => {
    const source = readFileSync(join(process.cwd(), "src/features/drafts/service.ts"), "utf8");
    expect(source).not.toMatch(/from "ai"|@ai-sdk\/|google-model/);
  });
});

describe("resolveActiveCity", () => {
  function receipt(sourceId: string, purchasedAt: string, city: string | null): RawPurchaseReceipt {
    return {
      sourceId,
      channel: "online",
      purchasedAt,
      city,
      total: 100,
      items: [{
        sourceId: `${sourceId}-i1`,
        externalProductId: 1,
        productId: "p-1",
        name: "Молоко",
        quantity: 1,
        unit: "шт",
        unitPrice: 100,
      }],
    };
  }

  const context = {
    cartId: "cart-1",
    deliveryType: "delivery" as const,
    city: null,
    branchId: null,
    slot: {
      id: "slot-1",
      startsAt: "2026-09-09T09:00:00.000Z",
      endsAt: "2026-09-09T11:00:00.000Z",
      available: true,
    },
  };

  it("prefers the cart's own city", () => {
    expect(resolveActiveCity({ ...context, city: "Київ" }, [])).toBe("Київ");
  });

  it("falls back to the most recent receipt that has one", () => {
    const receipts = [
      receipt("r-1", "2026-08-01T10:00:00.000Z", "Львів"),
      receipt("r-2", "2026-08-20T10:00:00.000Z", "Київ"),
      receipt("r-3", "2026-08-25T10:00:00.000Z", null),
    ];

    expect(resolveActiveCity(context, receipts)).toBe("Київ");
  });

  it("breaks a tie on sourceId so the rule is total", () => {
    const receipts = [
      receipt("r-b", "2026-08-20T10:00:00.000Z", "Львів"),
      receipt("r-a", "2026-08-20T10:00:00.000Z", "Київ"),
    ];

    expect(resolveActiveCity(context, receipts)).toBe("Київ");
  });

  it("uses a sentinel that matches nothing when no city is known", () => {
    expect(resolveActiveCity(context, [receipt("r-1", "2026-08-01T10:00:00.000Z", null)]))
      .toBe(UNKNOWN_CITY);
  });
});

function collectingLogger() {
  const traces: ToolTrace[] = [];
  const logger: Logger = {
    async toolCall(input) {
      traces.push(sanitizeTrace(input));
    },
  };
  return { logger, traces };
}

describe("createDraftForUser tracing", () => {
  it("A17-24 traces every gateway call the run makes, including catalog calls", async () => {
    const { logger, traces } = collectingLogger();
    const { deps } = makeDeps({ logger });

    const result = await createDraftForUser(RUN, deps);

    expect(result.ok).toBe(true);
    const toolNames = new Set(traces.map((entry) => entry.toolName));
    expect(toolNames.has("listTools")).toBe(true);
    expect(toolNames.has("loadPurchaseHistory")).toBe(true);
    // resolveProducts issues this one; a span written by hand in the service
    // would never see it.
    expect(toolNames.has("findProducts")).toBe(true);
  });

  it("A17-25 emits exactly one run trace carrying item count and prediction version", async () => {
    const { logger, traces } = collectingLogger();
    const { deps } = makeDeps({ logger });

    const result = await createDraftForUser(RUN, deps);
    if (!result.ok) throw new Error("expected a draft");

    const runTraces = traces.filter((entry) => entry.toolName === "draft_run");
    expect(runTraces).toHaveLength(1);
    expect(runTraces[0]).toMatchObject({
      mode: "demo",
      status: "ok",
      correlationId: "corr-1",
      predictionVersion: "prediction-v1",
      metadata: { itemCount: result.value.draft.items.length },
    });
  });

  it("A17-26 marks the run trace as an error when the run fails", async () => {
    const { logger, traces } = collectingLogger();
    const { deps } = makeDeps({
      logger,
      openGateway: async () => { throw new McpCallError("silpo_get_offline_orders", 401, null); },
    });

    const result = await createDraftForUser(RUN, deps);

    expect(result.ok).toBe(false);
    const runTraces = traces.filter((entry) => entry.toolName === "draft_run");
    expect(runTraces).toHaveLength(1);
    expect(runTraces[0].status).toBe("error");
  });

  it("A17-68 does not respond until every per-call trace has finished", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const finished: string[] = [];
    const logger: Logger = {
      async toolCall(input) {
        const { toolName } = input as { toolName: string };
        if (toolName !== "draft_run") await gate;
        finished.push(toolName);
      },
    };
    const { deps, closed } = makeDeps({ logger });

    let responded = false;
    const run = createDraftForUser(RUN, deps).then((result) => {
      responded = true;
      return result;
    });
    await vi.waitFor(() => expect(closed.count).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The gateway is closed and the run would respond now, but the per-call
    // trace inserts it started are still in flight.
    expect(responded).toBe(false);

    release();
    await expect(run).resolves.toMatchObject({ ok: true });
    expect(finished).toContain("listTools");
    expect(finished[finished.length - 1]).toBe("draft_run");
  });

  it("A17-27 never lets a logger fault fail the run", async () => {
    const { deps } = makeDeps({
      logger: { toolCall: async () => { throw new Error("logger down"); } },
    });

    await expect(createDraftForUser(RUN, deps)).resolves.toMatchObject({ ok: true });
  });
});

