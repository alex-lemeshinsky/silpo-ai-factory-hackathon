import { describe, expect, it } from "vitest";

import { reconcileCommit } from "@/features/cart/reconcile";
import type { VerifiedCart } from "@/features/shared/contracts";

const links = {
  web: "https://silpo.ua/cart/cart-1",
  mobile: "https://silpo.ua/app/cart/cart-1",
};

function readback(overrides: Partial<VerifiedCart> = {}): VerifiedCart {
  return {
    cartId: "cart-1",
    status: "verified",
    items: [{ productId: "p-1", quantity: 3, unitPrice: 24.9, available: true }],
    total: 74.7,
    validations: [],
    checkoutLinks: links,
    ...overrides,
  };
}

describe("reconcileCommit", () => {
  it("verifies a cart that met every target with no adjustment", () => {
    const result = reconcileCommit({ targets: { "p-1": 3 }, adjustments: [], readback: readback() });
    expect(result.status).toBe("verified");
    expect(result.checkoutLinks).toEqual(links);
  });

  it("blocks and hides checkout when an error validation is present", () => {
    const result = reconcileCommit({
      targets: { "p-1": 3 },
      adjustments: [],
      readback: readback({
        status: "blocked",
        checkoutLinks: null,
        validations: [{ severity: "error", code: "out_of_stock", message: "Немає в наявності", productId: "p-1" }],
      }),
    });
    expect(result.status).toBe("blocked");
    expect(result.checkoutLinks).toBeNull();
  });

  it("blocks when nothing could be targeted at all", () => {
    const result = reconcileCommit({
      targets: {},
      adjustments: [{ productId: "p-1", code: "unavailable_product", message: "Товар зараз недоступний, тому його не додано." }],
      readback: readback({ items: [], total: 0 }),
    });
    expect(result.status).toBe("blocked");
    expect(result.checkoutLinks).toBeNull();
  });

  it("reports partially committed when a target is missing from the cart", () => {
    const result = reconcileCommit({
      targets: { "p-1": 3, "p-2": 1 },
      adjustments: [],
      readback: readback(),
    });
    expect(result.status).toBe("partially_committed");
    expect(result.checkoutLinks).toBeNull();
  });

  it("reports partially committed when a line landed short of its target", () => {
    const result = reconcileCommit({
      targets: { "p-1": 5 },
      adjustments: [],
      readback: readback(),
    });
    expect(result.status).toBe("partially_committed");
  });

  it("reports partially committed when an adjustment was applied, even with a clean cart", () => {
    const result = reconcileCommit({
      targets: { "p-1": 3 },
      adjustments: [{ productId: "p-1", code: "stock_capped", message: "Доступно менше, ніж потрібно: кількість зменшено." }],
      readback: readback(),
    });
    expect(result.status).toBe("partially_committed");
    expect(result.checkoutLinks).toBeNull();
  });

  it("appends each adjustment as a warning carrying its product ID", () => {
    const result = reconcileCommit({
      targets: { "p-1": 3 },
      adjustments: [{ productId: "p-1", code: "price_changed", message: "Ціна змінилася після створення чернетки." }],
      readback: readback({
        validations: [{ severity: "warning", code: "slot_soon", message: "Слот скоро завершиться", productId: null }],
      }),
    });
    expect(result.validations).toEqual([
      { severity: "warning", code: "slot_soon", message: "Слот скоро завершиться", productId: null },
      { severity: "warning", code: "price_changed", message: "Ціна змінилася після створення чернетки.", productId: "p-1" },
    ]);
  });

  it("keeps a cart verified when the only validation is a warning", () => {
    const result = reconcileCommit({
      targets: { "p-1": 3 },
      adjustments: [],
      readback: readback({
        validations: [{ severity: "warning", code: "demo_data", message: "Кошик використовує демонстраційні дані", productId: null }],
      }),
    });
    expect(result.status).toBe("verified");
    expect(result.checkoutLinks).toEqual(links);
  });

  it("reports the server's total without recomputing it", () => {
    const result = reconcileCommit({ targets: { "p-1": 3 }, adjustments: [], readback: readback({ total: 71.2 }) });
    expect(result.total).toBe(71.2);
  });

  it("does not treat floating-point noise as a short line", () => {
    const result = reconcileCommit({
      targets: { "p-1": 0.3 },
      adjustments: [],
      readback: readback({ items: [{ productId: "p-1", quantity: 0.1 + 0.2, unitPrice: 24.9, available: true }] }),
    });
    expect(result.status).toBe("verified");
  });
});
