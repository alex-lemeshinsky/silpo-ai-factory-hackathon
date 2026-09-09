import { describe, expect, it } from "vitest";

import { planCommit } from "@/features/cart/plan";
import type { DraftItem, ProductCandidate } from "@/features/shared/contracts";

function item(overrides: Partial<DraftItem> = {}): DraftItem {
  return {
    productId: "p-1",
    externalProductId: 1,
    name: "Вода негазована 1.5 л",
    imageUrl: null,
    displayRatio: 1,
    quantity: 2,
    price: 24.9,
    specialPrice: null,
    stock: 10,
    step: 1,
    confidence: 0.8,
    confidenceBand: "high",
    reasonCodes: ["regular_purchase"],
    reason: "Зазвичай купуєте щотижня.",
    nutritionStatus: "insufficient",
    promotions: [],
    alternatives: [],
    ...overrides,
  };
}

function product(overrides: Partial<ProductCandidate> = {}): ProductCandidate {
  return {
    productId: "p-1",
    externalProductId: 1,
    slug: "voda-1-5",
    name: "Вода негазована 1.5 л",
    imageUrl: null,
    price: 24.9,
    specialPrice: null,
    available: true,
    stock: 10,
    step: 1,
    displayRatio: 1,
    nutritionStatus: "insufficient",
    nutrition: null,
    promotions: [],
    ...overrides,
  };
}

describe("planCommit", () => {
  it("adds the approved quantity to what the cart already holds", () => {
    const plan = planCommit({
      approvedItems: [item({ quantity: 2 })],
      currentQuantities: { "p-1": 1 },
      refreshed: { "p-1": product() },
    });
    expect(plan).toEqual({ targets: { "p-1": 3 }, adjustments: [] });
  });

  it("treats an absent cart line as zero", () => {
    const plan = planCommit({
      approvedItems: [item({ quantity: 2 })],
      currentQuantities: {},
      refreshed: { "p-1": product() },
    });
    expect(plan.targets).toEqual({ "p-1": 2 });
  });

  it("caps a target at refreshed stock and warns", () => {
    const plan = planCommit({
      approvedItems: [item({ quantity: 4 })],
      currentQuantities: { "p-1": 2 },
      refreshed: { "p-1": product({ stock: 5 }) },
    });
    expect(plan.targets).toEqual({ "p-1": 5 });
    expect(plan.adjustments).toEqual([
      { productId: "p-1", code: "stock_capped", message: "Доступно менше, ніж потрібно: кількість зменшено." },
    ]);
  });

  it("floors a target to the package step and warns", () => {
    const plan = planCommit({
      approvedItems: [item({ quantity: 1, step: 0.5 })],
      currentQuantities: { "p-1": 0.7 },
      refreshed: { "p-1": product({ step: 0.5, stock: 10 }) },
    });
    expect(plan.targets).toEqual({ "p-1": 1.5 });
    expect(plan.adjustments).toEqual([
      { productId: "p-1", code: "step_adjusted", message: "Кількість вирівняно до кроку пакування." },
    ]);
  });

  it("does not invent a step warning for exact floating-point multiples", () => {
    const plan = planCommit({
      approvedItems: [item({ quantity: 0.1, step: 0.1 })],
      currentQuantities: { "p-1": 0.2 },
      refreshed: { "p-1": product({ step: 0.1, stock: 10 }) },
    });
    expect(plan.targets).toEqual({ "p-1": 0.3 });
    expect(plan.adjustments).toEqual([]);
  });

  it("excludes a product missing from the refresh", () => {
    const plan = planCommit({
      approvedItems: [item()],
      currentQuantities: {},
      refreshed: {},
    });
    expect(plan.targets).toEqual({});
    expect(plan.adjustments).toEqual([
      { productId: "p-1", code: "unavailable_product", message: "Товар зараз недоступний, тому його не додано." },
    ]);
  });

  it("excludes an unavailable product and one whose stock is below a single step", () => {
    expect(planCommit({
      approvedItems: [item()],
      currentQuantities: {},
      refreshed: { "p-1": product({ available: false }) },
    }).targets).toEqual({});

    expect(planCommit({
      approvedItems: [item()],
      currentQuantities: {},
      refreshed: { "p-1": product({ stock: 0.4, step: 0.5 }) },
    }).targets).toEqual({});
  });

  it("reports one exclusion, not a cap plus an exclusion, when flooring empties a line", () => {
    const plan = planCommit({
      approvedItems: [item({ quantity: 1, step: 2 })],
      currentQuantities: {},
      refreshed: { "p-1": product({ step: 2, stock: 1.5 }) },
    });
    expect(plan.targets).toEqual({});
    expect(plan.adjustments).toEqual([
      { productId: "p-1", code: "unavailable_product", message: "Товар зараз недоступний, тому його не додано." },
    ]);
  });

  it("warns about a price change without changing the target", () => {
    const plan = planCommit({
      approvedItems: [item({ quantity: 2, price: 24.9 })],
      currentQuantities: {},
      refreshed: { "p-1": product({ price: 29.9 }) },
    });
    expect(plan.targets).toEqual({ "p-1": 2 });
    expect(plan.adjustments).toEqual([
      { productId: "p-1", code: "price_changed", message: "Ціна змінилася після створення чернетки." },
    ]);
  });

  it("ignores a price difference within one kopiyka", () => {
    const plan = planCommit({
      approvedItems: [item({ price: 24.9 })],
      currentQuantities: {},
      refreshed: { "p-1": product({ price: 24.9 + 0.004 }) },
    });
    expect(plan.adjustments).toEqual([]);
  });

  it("detects a special price change too", () => {
    const plan = planCommit({
      approvedItems: [item({ price: 24.9, specialPrice: 19.9 })],
      currentQuantities: {},
      refreshed: { "p-1": product({ price: 24.9, specialPrice: 22.9 }) },
    });
    expect(plan.adjustments.map((entry) => entry.code)).toEqual(["price_changed"]);
  });

  it("plans several items independently", () => {
    const plan = planCommit({
      approvedItems: [item(), item({ productId: "p-2", name: "Молоко", quantity: 1 })],
      currentQuantities: { "p-1": 1 },
      refreshed: { "p-1": product(), "p-2": product({ productId: "p-2", name: "Молоко", stock: 3 }) },
    });
    expect(plan.targets).toEqual({ "p-1": 3, "p-2": 1 });
  });
});
