import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import { createLiveCartGateway, mapCartValidationSeverity } from "@/features/silpo/live/cart";
import { UnadvertisedToolError, type McpSession } from "@/features/silpo/live/session";

const READ_TOOLS = ["silpo_get_shopping_cart_by_id"];
const WRITE_TOOLS = ["silpo_add_or_update_cart_products"];

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

const baseCart = {
  id: "cart-1",
  branchId: "branch-7",
  deliveryType: "DeliveryHome",
  timeslot: { id: "slot-1", start: "2026-09-09T10:00:00Z", end: "2026-09-09T12:00:00Z" },
  address: null,
  shipments: [],
  total: 49.8,
  validations: [],
  products: [{ productId: "p-1", quantity: 2, price: 24.9, specialPrice: null, available: true }],
  checkout: { webUrl: "https://silpo.ua/cart/cart-1", mobileUrl: "https://silpo.ua/app/cart/cart-1" },
};

describe("createLiveCartGateway.setAbsoluteCartQuantities", () => {
  it("sends absolute quantities with the cart's branch and addQuantity false", async () => {
    const readSession = createFakeSession(READ_TOOLS, {
      silpo_get_shopping_cart_by_id: () => ({ structuredContent: baseCart }),
    });
    const writeSession = createFakeSession(WRITE_TOOLS, {
      silpo_add_or_update_cart_products: () => ({ structuredContent: { ok: true } }),
    }, false);
    const gateway = createLiveCartGateway({ readSession, writeSession });

    await gateway.setAbsoluteCartQuantities({
      cartId: "cart-1",
      items: [{ productId: "p-1", quantity: 3 }],
      addQuantity: false,
    });

    expect(writeSession.calls).toHaveLength(1);
    expect(writeSession.calls[0].args).toEqual({
      cartId: "cart-1",
      branchId: "branch-7",
      products: [{ productId: "p-1", quantity: 3 }],
      addQuantity: false,
    });
  });

  it("never sends companyId, because the server supplies it", async () => {
    const readSession = createFakeSession(READ_TOOLS, {
      silpo_get_shopping_cart_by_id: () => ({ structuredContent: baseCart }),
    });
    const writeSession = createFakeSession(WRITE_TOOLS, {
      silpo_add_or_update_cart_products: () => ({ structuredContent: { ok: true } }),
    }, false);
    const gateway = createLiveCartGateway({ readSession, writeSession });

    await gateway.setAbsoluteCartQuantities({
      cartId: "cart-1",
      items: [{ productId: "p-1", quantity: 3 }],
      addQuantity: false,
    });

    expect(Object.keys(writeSession.calls[0].args)).not.toContain("companyId");
  });

  it("uses the write session for the write and the read session for the branch lookup", async () => {
    const readSession = createFakeSession(READ_TOOLS, {
      silpo_get_shopping_cart_by_id: () => ({ structuredContent: baseCart }),
    });
    const writeSession = createFakeSession(WRITE_TOOLS, {
      silpo_add_or_update_cart_products: () => ({ structuredContent: { ok: true } }),
    }, false);
    const gateway = createLiveCartGateway({ readSession, writeSession });

    await gateway.setAbsoluteCartQuantities({
      cartId: "cart-1",
      items: [{ productId: "p-1", quantity: 3 }],
      addQuantity: false,
    });

    expect(readSession.calls.map((call) => call.name)).toEqual(["silpo_get_shopping_cart_by_id"]);
    expect(writeSession.calls.map((call) => call.name)).toEqual(["silpo_add_or_update_cart_products"]);
    expect(writeSession.retryEnabled).toBe(false);
  });

  it("does not retry a failed write", async () => {
    const readSession = createFakeSession(READ_TOOLS, {
      silpo_get_shopping_cart_by_id: () => ({ structuredContent: baseCart }),
    });
    const write = vi.fn(() => { throw new Error("boom"); });
    const writeSession = createFakeSession(WRITE_TOOLS, { silpo_add_or_update_cart_products: write }, false);
    const gateway = createLiveCartGateway({ readSession, writeSession });

    await expect(gateway.setAbsoluteCartQuantities({
      cartId: "cart-1",
      items: [{ productId: "p-1", quantity: 3 }],
      addQuantity: false,
    })).rejects.toThrow("boom");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("rejects an input that does not carry addQuantity false", async () => {
    const readSession = createFakeSession(READ_TOOLS, {
      silpo_get_shopping_cart_by_id: () => ({ structuredContent: baseCart }),
    });
    const writeSession = createFakeSession(WRITE_TOOLS, {
      silpo_add_or_update_cart_products: () => ({ structuredContent: { ok: true } }),
    }, false);
    const gateway = createLiveCartGateway({ readSession, writeSession });

    await expect(gateway.setAbsoluteCartQuantities({
      cartId: "cart-1",
      items: [{ productId: "p-1", quantity: 3 }],
      addQuantity: true as unknown as false,
    })).rejects.toThrow();
    expect(writeSession.calls).toHaveLength(0);
  });
});

describe("createLiveCartGateway.readCart", () => {
  it("maps lines, total, and HTTPS checkout links for a clean cart", async () => {
    const readSession = createFakeSession(READ_TOOLS, {
      silpo_get_shopping_cart_by_id: () => ({ structuredContent: baseCart }),
    });
    const writeSession = createFakeSession(WRITE_TOOLS, {}, false);
    const gateway = createLiveCartGateway({ readSession, writeSession });

    const cart = await gateway.readCart("cart-1");
    expect(cart).toEqual({
      cartId: "cart-1",
      status: "verified",
      items: [{ productId: "p-1", quantity: 2, unitPrice: 24.9, available: true }],
      total: 49.8,
      validations: [],
      checkoutLinks: {
        web: "https://silpo.ua/cart/cart-1",
        mobile: "https://silpo.ua/app/cart/cart-1",
      },
    });
  });

  it("prefers a special price as the effective unit price", async () => {
    const specialCart = {
      ...baseCart,
      products: [{ productId: "p-1", quantity: 2, price: 24.9, specialPrice: 19.9, available: true }],
    };
    const readSession = createFakeSession(READ_TOOLS, {
      silpo_get_shopping_cart_by_id: () => ({ structuredContent: specialCart }),
    });
    const writeSession = createFakeSession(WRITE_TOOLS, {}, false);
    const gateway = createLiveCartGateway({ readSession, writeSession });

    expect((await gateway.readCart("cart-1")).items[0].unitPrice).toBe(19.9);
  });

  it("drops a zero-quantity line rather than failing the whole readback", async () => {
    const zeroQuantityCart = {
      ...baseCart,
      products: [{ productId: "p-1", quantity: 0, price: 24.9, specialPrice: null, available: true }],
    };
    const readSession = createFakeSession(READ_TOOLS, {
      silpo_get_shopping_cart_by_id: () => ({ structuredContent: zeroQuantityCart }),
    });
    const writeSession = createFakeSession(WRITE_TOOLS, {}, false);
    const gateway = createLiveCartGateway({ readSession, writeSession });

    expect((await gateway.readCart("cart-1")).items).toEqual([]);
  });

  it("blocks the cart and hides checkout when an error validation is present", async () => {
    const errorCart = {
      ...baseCart,
      validations: [{ severity: "error", code: "out_of_stock", message: "Немає в наявності", productId: "p-1" }],
    };
    const readSession = createFakeSession(READ_TOOLS, {
      silpo_get_shopping_cart_by_id: () => ({ structuredContent: errorCart }),
    });
    const writeSession = createFakeSession(WRITE_TOOLS, {}, false);
    const gateway = createLiveCartGateway({ readSession, writeSession });

    const cart = await gateway.readCart("cart-1");
    expect(cart.status).toBe("blocked");
    expect(cart.checkoutLinks).toBeNull();
  });

  it("keeps a warning non-blocking", async () => {
    const warningCart = {
      ...baseCart,
      validations: [{ severity: "warning", code: "slot_soon", message: "Слот скоро завершиться", productId: null }],
    };
    const readSession = createFakeSession(READ_TOOLS, {
      silpo_get_shopping_cart_by_id: () => ({ structuredContent: warningCart }),
    });
    const writeSession = createFakeSession(WRITE_TOOLS, {}, false);
    const gateway = createLiveCartGateway({ readSession, writeSession });

    const cart = await gateway.readCart("cart-1");
    expect(cart.status).toBe("verified");
    expect(cart.validations[0].severity).toBe("warning");
  });

  it("treats an unknown severity as an error", async () => {
    const unknownSeverityCart = {
      ...baseCart,
      validations: [{ severity: "notice", code: "unknown_thing", message: "?", productId: null }],
    };
    const readSession = createFakeSession(READ_TOOLS, {
      silpo_get_shopping_cart_by_id: () => ({ structuredContent: unknownSeverityCart }),
    });
    const writeSession = createFakeSession(WRITE_TOOLS, {}, false);
    const gateway = createLiveCartGateway({ readSession, writeSession });

    expect((await gateway.readCart("cart-1")).status).toBe("blocked");
  });

  it("falls back to the validation code when Silpo sends an empty message", async () => {
    const emptyMessageCart = {
      ...baseCart,
      validations: [{ severity: "warning", code: "slot_soon", message: "", productId: null }],
    };
    const readSession = createFakeSession(READ_TOOLS, {
      silpo_get_shopping_cart_by_id: () => ({ structuredContent: emptyMessageCart }),
    });
    const writeSession = createFakeSession(WRITE_TOOLS, {}, false);
    const gateway = createLiveCartGateway({ readSession, writeSession });

    expect((await gateway.readCart("cart-1")).validations[0].message).toBe("slot_soon");
  });

  it("drops non-HTTPS or incomplete checkout links", async () => {
    const insecureCheckoutCart = {
      ...baseCart,
      checkout: { webUrl: "http://silpo.ua/cart/cart-1", mobileUrl: "https://silpo.ua/app/cart/cart-1" },
    };
    const readSession = createFakeSession(READ_TOOLS, {
      silpo_get_shopping_cart_by_id: () => ({ structuredContent: insecureCheckoutCart }),
    });
    const writeSession = createFakeSession(WRITE_TOOLS, {}, false);
    const gateway = createLiveCartGateway({ readSession, writeSession });

    expect((await gateway.readCart("cart-1")).checkoutLinks).toBeNull();
  });
});

describe("mapCartValidationSeverity", () => {
  it.each([
    ["warning", "warning"],
    ["WARNING", "warning"],
    ["error", "error"],
    ["notice", "error"],
    ["", "error"],
  ])("maps %s to %s", (raw, expected) => {
    expect(mapCartValidationSeverity(raw)).toBe(expected);
  });
});
