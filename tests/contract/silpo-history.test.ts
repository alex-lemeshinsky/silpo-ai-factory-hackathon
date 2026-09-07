import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { RawPurchaseReceiptSchema, type CartContext } from "@/features/shared/contracts";
import { createLiveHistoryGateway } from "@/features/silpo/live/history";
import { UnadvertisedToolError, type McpSession } from "@/features/silpo/live/session";

const NOW = new Date("2026-09-08T09:00:00Z");

const HISTORY_TOOLS = [
  "silpo_get_my_online_orders",
  "silpo_get_my_offline_orders",
  "silpo_get_my_family",
  "silpo_get_my_food_restrictions",
  "silpo_get_loyalty_info",
];

function createFakeSession(
  tools: string[],
  handlers: Record<string, (args: Record<string, unknown>) => unknown>,
): McpSession & { calls: { tool: string; args: Record<string, unknown> }[] } {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const advertisedTools = new Set(tools);

  return {
    calls,
    advertisedTools,
    retryEnabled: true,
    async callTool<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
      if (!advertisedTools.has(name)) throw new UnadvertisedToolError(name);
      calls.push({ tool: name, args });
      const handler = handlers[name];
      if (!handler) throw new Error(`unexpected tool ${name}`);
      return schema.parse(handler(args));
    },
    async close() {},
  };
}

const context: CartContext = {
  cartId: "cart-1",
  deliveryType: "delivery",
  city: "Київ",
  branchId: "branch-7",
  slot: {
    id: "slot-1",
    startsAt: "2026-09-08T10:00:00Z",
    endsAt: "2026-09-08T12:00:00Z",
    available: true,
  },
};

const onlineOrders = {
  orders: [
    {
      id: "online-1",
      createdAt: "2026-09-01T08:30:00Z",
      city: "Київ",
      total: 240.5,
      items: [
        { id: "oi-1", lagerId: 40123, name: "Молоко 2.5%", quantity: 2, unit: "шт", price: 45.25 },
        { id: "oi-2", lagerId: 40124, name: "Пакет фасувальний", quantity: 1, unit: "шт", price: 2 },
      ],
    },
  ],
};

const offlineOrders = {
  orders: [
    {
      id: "offline-1",
      createdAt: "2026-08-20T17:05:00Z",
      city: "Львів",
      total: 88,
      items: [{ id: "fi-1", lagerId: 50999, name: "Хліб житній", quantity: 1, unit: "шт", price: 32 }],
    },
  ],
};

describe("loadPurchaseHistory", () => {
  const handlers = {
    silpo_get_my_online_orders: () => onlineOrders,
    silpo_get_my_offline_orders: () => offlineOrders,
  };

  it("returns online and offline receipts as valid contract objects", async () => {
    const session = createFakeSession(HISTORY_TOOLS, handlers);
    const gateway = createLiveHistoryGateway({ readSession: session, now: () => NOW });

    const receipts = await gateway.loadPurchaseHistory(context);

    expect(receipts).toHaveLength(2);
    expect(() => RawPurchaseReceiptSchema.array().parse(receipts)).not.toThrow();
    expect(receipts.map((receipt) => receipt.channel).sort()).toEqual(["offline", "online"]);
  });

  it("maps lagerId to externalProductId", async () => {
    const session = createFakeSession(HISTORY_TOOLS, handlers);
    const gateway = createLiveHistoryGateway({ readSession: session, now: () => NOW });

    const receipts = await gateway.loadPurchaseHistory(context);
    const online = receipts.find((receipt) => receipt.channel === "online");

    expect(online?.items.map((item) => item.externalProductId)).toEqual([40123, 40124]);
  });

  it("keeps service rows for normalizePurchases to filter", async () => {
    const session = createFakeSession(HISTORY_TOOLS, handlers);
    const gateway = createLiveHistoryGateway({ readSession: session, now: () => NOW });

    const receipts = await gateway.loadPurchaseHistory(context);
    const online = receipts.find((receipt) => receipt.channel === "online");

    expect(online?.items.map((item) => item.name)).toContain("Пакет фасувальний");
  });

  it("preserves ISO UTC timestamps", async () => {
    const session = createFakeSession(HISTORY_TOOLS, handlers);
    const gateway = createLiveHistoryGateway({ readSession: session, now: () => NOW });

    const receipts = await gateway.loadPurchaseHistory(context);

    for (const receipt of receipts) {
      expect(receipt.purchasedAt).toMatch(/Z$/);
    }
  });

  it("bounds the request to roughly 180 days instead of filtering locally", async () => {
    const session = createFakeSession(HISTORY_TOOLS, handlers);
    const gateway = createLiveHistoryGateway({ readSession: session, now: () => NOW });

    await gateway.loadPurchaseHistory(context);

    const online = session.calls.find((call) => call.tool === "silpo_get_my_online_orders");
    expect(String(online?.args.dateFrom)).toBe("2026-03-12T09:00:00.000Z");
  });

  it("passes the verified branch context to offline orders", async () => {
    const session = createFakeSession(HISTORY_TOOLS, handlers);
    const gateway = createLiveHistoryGateway({ readSession: session, now: () => NOW });

    await gateway.loadPurchaseHistory(context);

    const offline = session.calls.find((call) => call.tool === "silpo_get_my_offline_orders");
    expect(offline?.args.branchId).toBe("branch-7");
  });

  it("drops a receipt whose items cannot be mapped", async () => {
    const session = createFakeSession(HISTORY_TOOLS, {
      silpo_get_my_online_orders: () => ({
        orders: [{ id: "online-2", createdAt: "2026-09-01T08:30:00Z", city: "Київ", total: 0, items: [] }],
      }),
      silpo_get_my_offline_orders: () => ({ orders: [] }),
    });
    const gateway = createLiveHistoryGateway({ readSession: session, now: () => NOW });

    expect(await gateway.loadPurchaseHistory(context)).toEqual([]);
  });
});

describe("loadCustomerContext", () => {
  it("returns only family size, restriction keys and loyalty bonus", async () => {
    const session = createFakeSession(HISTORY_TOOLS, {
      silpo_get_my_family: () => ({
        members: [
          { id: "m-1", name: "Олена", relation: "child", birthDate: "2018-04-02" },
          { id: "m-2", name: "Барсик", relation: "pet" },
        ],
      }),
      silpo_get_my_food_restrictions: () => ({
        restrictions: [{ key: "lactose_free", title: "Без лактози" }],
      }),
      silpo_get_loyalty_info: () => ({
        loyalty: { cardNumber: "1234567890123", barcode: "9998887776665", bonusAvailable: 42.5, isEnabled: true },
      }),
    });
    const gateway = createLiveHistoryGateway({ readSession: session, now: () => NOW });

    const customer = await gateway.loadCustomerContext();

    // Family size counts the guest plus their listed members.
    expect(customer.familySize).toBe(3);
    expect(customer.restrictionKeys).toEqual(["lactose_free"]);
    expect(customer.loyaltyBonusAvailable).toBe(42.5);
    expect(Object.keys(customer).sort()).toEqual([
      "familySize",
      "loyaltyBonusAvailable",
      "restrictionKeys",
    ]);
  });

  it("carries no personal field into the returned value", async () => {
    const session = createFakeSession(HISTORY_TOOLS, {
      silpo_get_my_family: () => ({
        members: [{ id: "m-1", name: "Олена", relation: "child", birthDate: "2018-04-02" }],
      }),
      silpo_get_my_food_restrictions: () => ({ restrictions: [] }),
      silpo_get_loyalty_info: () => ({
        loyalty: { cardNumber: "1234567890123", barcode: "9998887776665", bonusAvailable: 0, isEnabled: true },
      }),
    });
    const gateway = createLiveHistoryGateway({ readSession: session, now: () => NOW });

    const serialized = JSON.stringify(await gateway.loadCustomerContext());

    for (const secret of ["Олена", "2018-04-02", "1234567890123", "9998887776665", "m-1"]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
