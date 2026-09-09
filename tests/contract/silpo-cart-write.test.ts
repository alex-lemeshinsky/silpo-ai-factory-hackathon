import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { createLiveCartGateway } from "@/features/silpo/live/cart";
import { UnadvertisedToolError, type McpSession } from "@/features/silpo/live/session";

function createFakeSession(
  tools: string[],
  handlers: Record<string, (args: Record<string, unknown>) => unknown>,
  retryEnabled = true,
): McpSession & { calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const advertisedTools = new Set(tools);
  return {
    calls,
    advertisedTools,
    retryEnabled,
    async callTool<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
      if (!advertisedTools.has(name)) throw new UnadvertisedToolError(name);
      calls.push({ name, args });
      const handler = handlers[name];
      if (!handler) throw new Error(`unexpected tool ${name}`);
      const raw = handler(args);
      const content =
        raw && typeof raw === "object" && "structuredContent" in raw
          ? (raw as { structuredContent: unknown }).structuredContent
          : raw;
      return schema.parse(content);
    },
    async close() {},
  };
}

describe("silpo-cart-write contract", () => {
  it("maps a realistic Silpo cart readback into the domain contract", async () => {
    const readSession = createFakeSession(["silpo_get_shopping_cart_by_id"], {
      silpo_get_shopping_cart_by_id: () => ({
        structuredContent: {
          id: "cart-42",
          branchId: "branch-7",
          deliveryType: "DeliveryHome",
          timeslot: { id: "slot-9", start: "2026-09-09T10:00:00Z", end: "2026-09-09T12:00:00Z" },
          address: { city: "Київ", street: "Хрещатик", house: "1", district: null, latitude: 50.45, longitude: 30.52, addressType: "house" },
          shipments: [],
          total: 118.7,
          validations: [
            { severity: "warning", code: "slot_soon", message: "Слот скоро завершиться", productId: null },
          ],
          products: [
            { productId: "p-water", quantity: 3, price: 24.9, specialPrice: 19.9, available: true },
            { productId: "p-bag", quantity: 1, price: 5.0, available: true },
          ],
          checkout: { webUrl: "https://silpo.ua/cart/cart-42", mobileUrl: "https://silpo.ua/app/cart/cart-42" },
        },
      }),
    });

    const cart = await createLiveCartGateway({ readSession, writeSession: readSession }).readCart("cart-42");

    expect(cart.status).toBe("verified");
    expect(cart.items).toEqual([
      { productId: "p-water", quantity: 3, unitPrice: 19.9, available: true },
      { productId: "p-bag", quantity: 1, unitPrice: 5.0, available: true },
    ]);
    expect(cart.checkoutLinks?.web).toBe("https://silpo.ua/cart/cart-42");
  });

  it("rejects a readback whose required field is missing instead of guessing a shape", async () => {
    const readSession = createFakeSession(["silpo_get_shopping_cart_by_id"], {
      silpo_get_shopping_cart_by_id: () => ({ structuredContent: { branchId: "branch-7", total: 1 } }),
    });
    await expect(
      createLiveCartGateway({ readSession, writeSession: readSession }).readCart("cart-42"),
    ).rejects.toThrow();
  });
});
