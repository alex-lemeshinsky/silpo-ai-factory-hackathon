import {
  DraftSchema,
  NeedCandidateSchema,
  ProductCandidateSchema,
  RawPurchaseReceiptSchema,
  SetCartProductsInputSchema,
  VerifiedCartSchema,
} from "@/features/shared/contracts";
import { err, ok } from "@/lib/result";

const need = {
  categoryKey: "water",
  confidence: 0.8,
  confidenceBand: "high" as const,
  typicalQuantity: 2,
  reasonCodes: ["cycle_due"],
  preferredExternalProductIds: [101],
  features: {
    weightedPurchaseCount: 4,
    medianIntervalDays: 7,
    intervalMadDays: 1,
    daysSinceLastPurchase: 8,
    activeCityShare: 1,
    repeatScore: 0.8,
    dueScore: 0.9,
    stabilityScore: 0.7,
  },
};

const product = {
  productId: "water-1",
  externalProductId: 101,
  slug: "water-1",
  name: "Вода негазована",
  imageUrl: null,
  price: 20,
  specialPrice: null,
  available: true,
  stock: 10,
  step: 1,
  displayRatio: 1,
  nutritionStatus: "insufficient" as const,
  nutrition: null,
  promotions: [],
};

const draft = {
  id: "draft-1",
  mode: "demo" as const,
  status: "ready" as const,
  algorithmVersion: "prediction-v1",
  trainingCutoff: "2026-09-02T00:00:00.000Z",
  summary: "Схоже, вода скоро закінчиться",
  items: [
    {
      productId: product.productId,
      externalProductId: product.externalProductId,
      name: product.name,
      quantity: 2,
      price: product.price,
      stock: product.stock,
      step: product.step,
      confidence: need.confidence,
      confidenceBand: need.confidenceBand,
      reasonCodes: need.reasonCodes,
      reason: "Купуєте приблизно раз на 7 днів",
      nutritionStatus: product.nutritionStatus,
      alternatives: [],
    },
  ],
  total: 40,
  version: 1,
};

it("accepts representative purchase, need, product, and draft values", () => {
  expect(
    RawPurchaseReceiptSchema.parse({
      sourceId: "receipt-1",
      channel: "offline",
      purchasedAt: "2026-08-25T10:00:00.000Z",
      city: "Київ",
      total: 40,
      items: [
        {
          sourceId: "item-1",
          externalProductId: 101,
          productId: "water-1",
          name: "Вода негазована",
          quantity: 2,
          unit: "шт",
          unitPrice: 20,
        },
      ],
    }),
  ).toBeDefined();
  expect(NeedCandidateSchema.parse(need)).toEqual(need);
  expect(ProductCandidateSchema.parse(product)).toEqual(product);
  expect(DraftSchema.parse(draft)).toEqual(draft);
});

it("rejects a draft item without a source product id", () => {
  const invalid = structuredClone(draft);
  invalid.items[0]!.productId = "";

  expect(() => DraftSchema.parse(invalid)).toThrow();
});

it("rejects confidence that disagrees with its band", () => {
  expect(() =>
    NeedCandidateSchema.parse({ ...need, confidence: 0.7, confidenceBand: "high" }),
  ).toThrow();
});

it("rejects draft quantity that is not aligned to the product step", () => {
  const invalid = structuredClone(draft);
  invalid.items[0]!.quantity = 1.5;
  invalid.total = 30;

  expect(() => DraftSchema.parse(invalid)).toThrow();
});

it("requires absolute rather than additive cart quantities", () => {
  expect(
    SetCartProductsInputSchema.parse({
      cartId: "cart-1",
      items: [{ productId: "water-1", quantity: 2 }],
      addQuantity: false,
    }).addQuantity,
  ).toBe(false);
  expect(() =>
    SetCartProductsInputSchema.parse({
      cartId: "cart-1",
      items: [{ productId: "water-1", quantity: 2 }],
      addQuantity: true,
    }),
  ).toThrow();
});

it("blocks checkout links when the cart has an error validation", () => {
  expect(() =>
    VerifiedCartSchema.parse({
      cartId: "cart-1",
      status: "verified",
      items: [{ productId: "water-1", quantity: 2, unitPrice: 20, available: true }],
      total: 40,
      validations: [
        { severity: "error", code: "slot_expired", message: "Оберіть слот", productId: null },
      ],
      checkoutLinks: { web: "https://example.test/cart", mobile: "https://example.test/app/cart" },
    }),
  ).toThrow();
});

it("accepts checkout links only for a verified cart without errors", () => {
  expect(
    VerifiedCartSchema.parse({
      cartId: "cart-1",
      status: "verified",
      items: [{ productId: "water-1", quantity: 2, unitPrice: 20, available: true }],
      total: 40,
      validations: [{ severity: "warning", code: "price_note", message: "Ціну перевірено", productId: "water-1" }],
      checkoutLinks: { web: "https://example.test/cart", mobile: "https://example.test/app/cart" },
    }).status,
  ).toBe("verified");
});

it("constructs typed success and failure results", () => {
  expect(ok(42)).toEqual({ ok: true, value: 42 });
  expect(
    err({
      code: "unexpected",
      message: "Безпечне повідомлення",
      correlationId: "correlation-1",
      retryAfterMs: null,
    }),
  ).toEqual({
    ok: false,
    error: {
      code: "unexpected",
      message: "Безпечне повідомлення",
      correlationId: "correlation-1",
      retryAfterMs: null,
    },
  });
});
