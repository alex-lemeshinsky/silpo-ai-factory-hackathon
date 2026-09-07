import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import {
  MAX_BATCH_QUERIES,
  resolveProducts,
  type CatalogPort,
} from "@/features/products/resolve-products";
import {
  NeedCandidateSchema,
  ProductCandidateSchema,
  ProductDetailsSchema,
  type CartContext,
  type CustomerContext,
  type NeedCandidate,
  type ProductCandidate,
  type ProductDetails,
} from "@/features/shared/contracts";

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

const noRestrictions: CustomerContext = {
  familySize: 2,
  restrictionKeys: [],
  loyaltyBonusAvailable: null,
};

function need(overrides: Partial<NeedCandidate> = {}): NeedCandidate {
  return NeedCandidateSchema.parse({
    categoryKey: "dairy",
    confidence: 0.8,
    confidenceBand: "high",
    typicalQuantity: 1,
    reasonCodes: ["category_repeat"],
    preferredExternalProductIds: [40123],
    features: {
      weightedPurchaseCount: 6,
      medianIntervalDays: 7,
      intervalMadDays: 1,
      daysSinceLastPurchase: 8,
      activeCityShare: 1,
      repeatScore: 0.9,
      dueScore: 1,
      stabilityScore: 0.8,
    },
    ...overrides,
  });
}

function candidate(overrides: Partial<ProductCandidate> = {}): ProductCandidate {
  return ProductCandidateSchema.parse({
    productId: "p-1",
    externalProductId: 40123,
    slug: "moloko-25-900",
    name: "Молоко 2,5% 900 г",
    imageUrl: null,
    price: 45.5,
    specialPrice: null,
    available: true,
    stock: 12,
    step: 1,
    displayRatio: 1,
    nutritionStatus: "insufficient",
    nutrition: null,
    promotions: [],
    ...overrides,
  });
}

/** Returns the given products for every query unless a map is supplied. */
function fakeGateway(
  byQuery: Record<string, ProductCandidate[]>,
  overrides: Partial<CatalogPort> = {},
): CatalogPort & { queries: string[][] } {
  const queries: string[][] = [];
  return {
    queries,
    async findProducts(_context, requested) {
      queries.push(requested);
      return requested.map((query) => ({ query, products: byQuery[query] ?? [] }));
    },
    async getProductDetails() {
      throw new Error("not stubbed");
    },
    async getSimilarProducts() {
      return [];
    },
    async getReplacements() {
      return [];
    },
    ...overrides,
  };
}

it("searches each need by article and by category in one batch", async () => {
  const gateway = fakeGateway({ "40123": [candidate()] });

  await resolveProducts([need()], context, noRestrictions, gateway);

  expect(gateway.queries).toEqual([["40123", "молоко"]]);
});

it("sends at most two article queries per need and never repeats a query", async () => {
  const gateway = fakeGateway({});

  await resolveProducts(
    [
      need({ preferredExternalProductIds: [1, 2, 3, 4] }),
      need({ categoryKey: "water", preferredExternalProductIds: [1] }),
    ],
    context,
    noRestrictions,
    gateway,
  );

  expect(gateway.queries).toEqual([["1", "2", "молоко", "вода"]]);
});

it("resolves at most ten needs and stays inside the batch limit", async () => {
  const categories = [
    "water", "dairy", "eggs", "bread", "coffee",
    "tea", "grains", "meat", "fish", "produce", "oil", "sweets",
  ];
  const gateway = fakeGateway({});

  await resolveProducts(
    categories.map((categoryKey, index) =>
      need({ categoryKey, preferredExternalProductIds: [index * 10 + 1, index * 10 + 2] }),
    ),
    context,
    noRestrictions,
    gateway,
  );

  expect(gateway.queries[0]).toHaveLength(MAX_BATCH_QUERIES);
});

it("excludes service rows, unbuyable stock and restricted products", async () => {
  const gateway = fakeGateway({
    молоко: [
      candidate({ productId: "bag", name: "Пакет фасувальний", externalProductId: 1 }),
      candidate({ productId: "out-of-stock", stock: 0, externalProductId: 2 }),
      candidate({ productId: "below-step", stock: 1, step: 2, externalProductId: 3 }),
      candidate({ productId: "unavailable", available: false, externalProductId: 4 }),
      candidate({ productId: "keeper", externalProductId: 5 }),
    ],
  });

  const [resolved] = await resolveProducts(
    [need({ preferredExternalProductIds: [] })],
    context,
    noRestrictions,
    gateway,
  );

  expect(resolved?.selected.productId).toBe("keeper");
  expect(resolved?.alternatives).toEqual([]);
});

it("drops a need whose every candidate violates a restriction", async () => {
  const gateway = fakeGateway({
    молоко: [candidate({ productId: "milk", name: "Молоко 2,5% 900 г" })],
  });

  const resolved = await resolveProducts(
    [need({ preferredExternalProductIds: [] })],
    context,
    { ...noRestrictions, restrictionKeys: ["lactose-free"] },
    gateway,
  );

  expect(resolved).toEqual([]);
});

it("returns at most three alternatives, all distinct from the selection", async () => {
  const gateway = fakeGateway({
    молоко: [1, 2, 3, 4, 5].map((index) =>
      candidate({ productId: `p-${index}`, externalProductId: index }),
    ),
  });

  const [resolved] = await resolveProducts(
    [need({ preferredExternalProductIds: [] })],
    context,
    noRestrictions,
    gateway,
  );

  expect(resolved?.alternatives).toHaveLength(3);
  expect(resolved?.alternatives.map((product) => product.productId))
    .not.toContain(resolved?.selected.productId);
});

it("performs no search when there is nothing to resolve", async () => {
  const gateway = fakeGateway({});
  const findProducts = vi.spyOn(gateway, "findProducts");

  expect(await resolveProducts([], context, noRestrictions, gateway)).toEqual([]);
  expect(findProducts).not.toHaveBeenCalled();
});

it("keeps the products feature free of frameworks and transport", () => {
  const forbidden = [
    "react",
    "next/",
    "@modelcontextprotocol",
    "@ai-sdk",
    "drizzle",
    "postgres",
    "@/db/",
    "@/features/silpo/",
  ];

  for (const file of ["resolve-products.ts", "category-queries.ts", "dietary.ts"]) {
    const source = readFileSync(join(process.cwd(), "src/features/products", file), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    for (const specifier of imports) {
      for (const marker of forbidden) {
        expect(specifier.includes(marker), `${file} must not import ${specifier}`).toBe(false);
      }
    }
  }
});

it("prefers a selectable familiar SKU over a cheaper newcomer", async () => {
  const gateway = fakeGateway({
    "40123": [candidate({ productId: "familiar", externalProductId: 40123, price: 100 })],
    молоко: [candidate({ productId: "newcomer", externalProductId: 999, price: 20 })],
  });

  const [resolved] = await resolveProducts([need()], context, noRestrictions, gateway);

  expect(resolved?.selected.productId).toBe("familiar");
  expect(resolved?.alternatives.map((product) => product.productId)).toEqual(["newcomer"]);
});

it("anchors the budget on the familiar SKU even when it cannot be bought", async () => {
  const gateway = fakeGateway({
    "40123": [
      candidate({ productId: "familiar", externalProductId: 40123, price: 30, stock: 0 }),
    ],
    молоко: [
      candidate({ productId: "cheaper", externalProductId: 1, price: 20 }),
      candidate({ productId: "pricier", externalProductId: 2, price: 40 }),
    ],
  });

  const [resolved] = await resolveProducts([need()], context, noRestrictions, gateway);

  // 20 is within the familiar 30; 40 is not, so it ranks last despite being
  // the only other option.
  expect(resolved?.selected.productId).toBe("cheaper");
  expect(resolved?.alternatives.map((product) => product.productId)).toEqual(["pricier"]);
});

it("ranks within budget first, then an active discount", async () => {
  const gateway = fakeGateway({
    молоко: [
      candidate({ productId: "over-budget", externalProductId: 1, price: 100 }),
      candidate({ productId: "full-price", externalProductId: 2, price: 50 }),
      candidate({ productId: "discounted", externalProductId: 3, price: 50, specialPrice: 40 }),
    ],
  });

  const [resolved] = await resolveProducts(
    [need({ preferredExternalProductIds: [] })],
    context,
    noRestrictions,
    gateway,
  );

  expect(resolved?.selected.productId).toBe("discounted");
  expect(resolved?.alternatives.map((product) => product.productId))
    .toEqual(["full-price", "over-budget"]);
});

it("breaks an equal-budget tie by package distance, then price, then product ID", async () => {
  const gateway = fakeGateway({
    молоко: [
      candidate({ productId: "p-a", externalProductId: 1, price: 30, displayRatio: 1 }),
      candidate({ productId: "p-b", externalProductId: 2, price: 30, displayRatio: 2 }),
      candidate({ productId: "p-c", externalProductId: 3, price: 30, displayRatio: 1.5 }),
    ],
  });

  const [resolved] = await resolveProducts(
    [need({ preferredExternalProductIds: [] })],
    context,
    noRestrictions,
    gateway,
  );

  // Median ratio is 1.5, so p-c sits at distance 0; p-a and p-b tie at 0.5
  // and equal price, leaving the product ID as the only stable separator.
  expect([resolved?.selected.productId, ...(resolved?.alternatives ?? []).map((p) => p.productId)])
    .toEqual(["p-c", "p-a", "p-b"]);
});

it("produces identical output when the search returns products in another order", async () => {
  const products = [
    candidate({ productId: "p-a", externalProductId: 1, price: 30, displayRatio: 1 }),
    candidate({ productId: "p-b", externalProductId: 2, price: 30, displayRatio: 2 }),
    candidate({ productId: "p-c", externalProductId: 3, price: 30, displayRatio: 1.5 }),
  ];
  const forward = await resolveProducts(
    [need({ preferredExternalProductIds: [] })],
    context,
    noRestrictions,
    fakeGateway({ молоко: products }),
  );
  const reversed = await resolveProducts(
    [need({ preferredExternalProductIds: [] })],
    context,
    noRestrictions,
    fakeGateway({ молоко: [...products].reverse() }),
  );

  expect(reversed).toEqual(forward);
});

function details(overrides: Record<string, unknown> = {}): ProductDetails {
  return ProductDetailsSchema.parse({
    ...candidate(),
    description: null,
    ingredients: null,
    nutritionStatus: "known",
    nutrition: {
      caloriesKcal: 60,
      proteinGrams: 2.8,
      fatGrams: 2.5,
      carbohydrateGrams: 4.7,
    },
    ...overrides,
  });
}

it("asks for replacements when the familiar SKU cannot be bought", async () => {
  const getReplacements = vi.fn(async () => [
    candidate({ productId: "replacement", externalProductId: 555 }),
  ]);
  const getSimilarProducts = vi.fn(async () => []);
  const gateway = fakeGateway(
    { "40123": [candidate({ productId: "familiar", externalProductId: 40123, stock: 0 })] },
    { getReplacements, getSimilarProducts, getProductDetails: async () => details() },
  );

  const [resolved] = await resolveProducts([need()], context, noRestrictions, gateway);

  expect(getReplacements).toHaveBeenCalledTimes(1);
  expect(getReplacements).toHaveBeenCalledWith(context, "moloko-25-900");
  expect(getSimilarProducts).not.toHaveBeenCalled();
  expect(resolved?.selected.productId).toBe("replacement");
});

it("asks for similar products only when nothing eligible was found", async () => {
  const getSimilarProducts = vi.fn(async () => [
    candidate({ productId: "similar", externalProductId: 777 }),
  ]);
  const getReplacements = vi.fn(async () => []);
  const gateway = fakeGateway(
    { молоко: [candidate({ productId: "sold-out", externalProductId: 9, stock: 0 })] },
    { getSimilarProducts, getReplacements, getProductDetails: async () => details() },
  );

  const [resolved] = await resolveProducts(
    [need({ preferredExternalProductIds: [] })],
    context,
    noRestrictions,
    gateway,
  );

  expect(getSimilarProducts).toHaveBeenCalledTimes(1);
  expect(getReplacements).not.toHaveBeenCalled();
  expect(resolved?.selected.productId).toBe("similar");
});

it("makes no fallback call when the familiar SKU is on the shelf", async () => {
  const getReplacements = vi.fn(async () => []);
  const getSimilarProducts = vi.fn(async () => []);
  const gateway = fakeGateway(
    { "40123": [candidate({ productId: "familiar", externalProductId: 40123 })] },
    { getReplacements, getSimilarProducts, getProductDetails: async () => details() },
  );

  await resolveProducts([need()], context, noRestrictions, gateway);

  expect(getReplacements).not.toHaveBeenCalled();
  expect(getSimilarProducts).not.toHaveBeenCalled();
});

it("enriches the selected product only", async () => {
  const getProductDetails = vi.fn(async () => details());
  const gateway = fakeGateway(
    {
      молоко: [
        candidate({ productId: "p-1", externalProductId: 1 }),
        candidate({ productId: "p-2", externalProductId: 2 }),
      ],
    },
    { getProductDetails },
  );

  const [resolved] = await resolveProducts(
    [need({ preferredExternalProductIds: [] })],
    context,
    noRestrictions,
    gateway,
  );

  expect(getProductDetails).toHaveBeenCalledTimes(1);
  expect(resolved?.selected.nutritionStatus).toBe("known");
  expect(resolved?.selected.nutrition).toEqual({
    caloriesKcal: 60,
    proteinGrams: 2.8,
    fatGrams: 2.5,
    carbohydrateGrams: 4.7,
  });
  expect(resolved?.alternatives[0]?.nutritionStatus).toBe("insufficient");
});

it("keeps the draft when enrichment fails", async () => {
  const gateway = fakeGateway(
    { молоко: [candidate({ productId: "p-1", externalProductId: 1 })] },
    {
      getProductDetails: async () => {
        throw new Error("rate_limited");
      },
    },
  );

  const [resolved] = await resolveProducts(
    [need({ preferredExternalProductIds: [] })],
    context,
    noRestrictions,
    gateway,
  );

  expect(resolved?.selected.productId).toBe("p-1");
  expect(resolved?.selected.nutritionStatus).toBe("insufficient");
});

it("drops the need when the fallback lookup fails", async () => {
  const gateway = fakeGateway(
    { молоко: [candidate({ productId: "sold-out", externalProductId: 9, stock: 0 })] },
    {
      getSimilarProducts: async () => {
        throw new Error("mcp_call_failed");
      },
    },
  );

  const resolved = await resolveProducts(
    [need({ preferredExternalProductIds: [] })],
    context,
    noRestrictions,
    gateway,
  );

  expect(resolved).toEqual([]);
});


