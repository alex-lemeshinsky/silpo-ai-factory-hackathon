import { expect, it } from "vitest";
import type { z } from "zod";

import type { CartContext } from "@/features/shared/contracts";
import { createLiveCatalogGateway } from "@/features/silpo/live/catalog";
import { UnadvertisedToolError, type McpSession } from "@/features/silpo/live/session";
import { InvalidExternalDataError, parseToolResult } from "@/features/silpo/schemas/common";

const CATALOG_TOOLS = [
  "silpo_find_products_batch",
  "silpo_get_promotions",
  "silpo_get_product_details",
  "silpo_get_similar_products",
  "silpo_get_replacements",
];

type Handlers = Record<string, (args: Record<string, unknown>) => unknown>;

/**
 * Routes through the real `parseToolResult`, so a malformed payload fails
 * here exactly as it would against the live session.
 */
function createFakeSession(
  tools: string[],
  handlers: Handlers,
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
      return parseToolResult(name, { structuredContent: handler(args) }, schema);
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

function rawProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "p-milk",
    lagerId: 40123,
    slug: "moloko-25-900",
    name: "Молоко 2,5% 900 г",
    imageUrl: null,
    price: 45.5,
    specialPrice: null,
    available: true,
    stock: 12,
    step: 1,
    displayRatio: 1,
    companyId: "company-1",
    branchId: "branch-7",
    nutrition: null,
    promotions: [],
    ...overrides,
  };
}

it("searches a batch with the cart branch and maps every result", async () => {
  const session = createFakeSession(CATALOG_TOOLS, {
    silpo_find_products_batch: () => ({
      results: [
        { query: "молоко", products: [rawProduct()] },
        { query: "40123", products: [] },
      ],
    }),
  });

  const results = await createLiveCatalogGateway({ readSession: session })
    .findProducts(context, ["молоко", "40123"]);

  expect(session.calls).toEqual([
    {
      tool: "silpo_find_products_batch",
      args: { items: ["молоко", "40123"], branchId: "branch-7" },
    },
  ]);
  expect(results).toEqual([
    {
      query: "молоко",
      products: [
        {
          productId: "p-milk",
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
        },
      ],
    },
    { query: "40123", products: [] },
  ]);
});

// The gate itself belongs to Task 10 and is proven against the real session
// in `session.test.ts`; this asserts only that the catalog gateway routes
// every call through `callTool` and so inherits it.
it("rejects a catalog tool the server does not advertise, without calling it", async () => {
  const session = createFakeSession(
    CATALOG_TOOLS.filter((tool) => tool !== "silpo_get_replacements"),
    { silpo_get_replacements: () => ({ products: [] }) },
  );

  await expect(
    createLiveCatalogGateway({ readSession: session }).getReplacements(context, "moloko-25-900"),
  ).rejects.toBeInstanceOf(UnadvertisedToolError);
  expect(session.calls).toEqual([]);
});

it("drops a product that could never be committed or represented", async () => {
  const session = createFakeSession(CATALOG_TOOLS, {
    silpo_find_products_batch: () => ({
      results: [
        {
          query: "молоко",
          products: [
            rawProduct({ id: "no-company", companyId: null }),
            rawProduct({ id: "no-branch", branchId: null }),
            // Fails ProductCandidateSchema: a special price above the list price.
            rawProduct({ id: "bad-price", price: 10, specialPrice: 20 }),
            rawProduct({ id: "keeper" }),
          ],
        },
      ],
    }),
  });

  const [result] = await createLiveCatalogGateway({ readSession: session })
    .findProducts(context, ["молоко"]);

  expect(result?.products.map((product) => product.productId)).toEqual(["keeper"]);
});

it("keeps a product whose promotion is unusable and drops only the promotion", async () => {
  const session = createFakeSession(CATALOG_TOOLS, {
    silpo_find_products_batch: () => ({
      results: [
        {
          query: "молоко",
          products: [
            rawProduct({
              id: "untitled-promo",
              promotions: [
                { id: "promo-1", title: "", price: 10 },
                { id: "promo-2", title: "Акція", price: 10 },
              ],
            }),
          ],
        },
      ],
    }),
  });

  const [result] = await createLiveCatalogGateway({ readSession: session })
    .findProducts(context, ["молоко"]);

  // A banner without a title says nothing about whether the product can be
  // bought, so it must not cost the guest the product.
  expect(result?.products.map((product) => product.productId)).toEqual(["untitled-promo"]);
  expect(result?.products[0]?.promotions.map((promotion) => promotion.id)).toEqual(["promo-2"]);
});

it("drops a malformed product row without failing the whole search", async () => {
  const session = createFakeSession(CATALOG_TOOLS, {
    silpo_find_products_batch: () => ({
      results: [
        {
          query: "молоко",
          products: [
            // Shapes Silpo could plausibly send: a decimal encoded as a
            // string, and an image path that is not an absolute URL.
            rawProduct({ id: "string-price", price: "45.50" }),
            rawProduct({ id: "relative-image", imageUrl: "/img/moloko.png" }),
            rawProduct({ id: "keeper" }),
          ],
        },
      ],
    }),
  });

  const [result] = await createLiveCatalogGateway({ readSession: session })
    .findProducts(context, ["молоко"]);

  expect(result?.products.map((product) => product.productId)).toEqual(["keeper"]);
});

it("reports nutrition as known only when a value is actually present", async () => {
  const session = createFakeSession(CATALOG_TOOLS, {
    silpo_find_products_batch: () => ({
      results: [
        {
          query: "молоко",
          products: [
            rawProduct({ id: "empty-block", nutrition: {} }),
            rawProduct({
              id: "partial",
              nutrition: { calories: 60, proteins: null, fats: null, carbohydrates: null },
            }),
          ],
        },
      ],
    }),
  });

  const [result] = await createLiveCatalogGateway({ readSession: session })
    .findProducts(context, ["молоко"]);

  expect(result?.products[0]).toMatchObject({
    productId: "empty-block",
    nutritionStatus: "insufficient",
    nutrition: null,
  });
  expect(result?.products[1]).toMatchObject({
    productId: "partial",
    nutritionStatus: "known",
    nutrition: {
      caloriesKcal: 60,
      proteinGrams: null,
      fatGrams: null,
      carbohydrateGrams: null,
    },
  });
});

it("maps promotions, details, similar products and replacements", async () => {
  const session = createFakeSession(CATALOG_TOOLS, {
    silpo_get_promotions: () => ({
      promotions: [{ id: "promo-1", title: "Знижка тижня", price: 39.9 }],
    }),
    silpo_get_product_details: () => ({
      product: {
        ...rawProduct(),
        description: "Пастеризоване молоко",
        ingredients: "Молоко незбиране",
        nutrition: { calories: 60, proteins: 2.8, fats: 2.5, carbohydrates: 4.7 },
      },
    }),
    silpo_get_similar_products: () => ({ products: [rawProduct({ id: "p-similar" })] }),
    silpo_get_replacements: () => ({ products: [rawProduct({ id: "p-replacement" })] }),
  });
  const gateway = createLiveCatalogGateway({ readSession: session });

  expect(await gateway.getPromotions(context)).toEqual([
    { id: "promo-1", label: "Знижка тижня", price: 39.9 },
  ]);
  expect(await gateway.getProductDetails(context, "moloko-25-900")).toMatchObject({
    productId: "p-milk",
    description: "Пастеризоване молоко",
    ingredients: "Молоко незбиране",
    nutritionStatus: "known",
  });
  expect((await gateway.getSimilarProducts(context, "moloko-25-900"))[0]?.productId)
    .toBe("p-similar");
  expect((await gateway.getReplacements(context, "moloko-25-900"))[0]?.productId)
    .toBe("p-replacement");
  expect(session.calls.map((call) => call.args)).toEqual([
    { branchId: "branch-7" },
    { slug: "moloko-25-900", branchId: "branch-7" },
    { slug: "moloko-25-900", branchId: "branch-7" },
    { slug: "moloko-25-900", branchId: "branch-7" },
  ]);
});

it("tolerates an unknown field but rejects a malformed envelope", async () => {
  const tolerant = createFakeSession(CATALOG_TOOLS, {
    silpo_find_products_batch: () => ({
      unknownTopLevelField: true,
      results: [{ query: "молоко", products: [{ ...rawProduct(), loyaltyOnlyPrice: 42 }] }],
    }),
  });
  const [result] = await createLiveCatalogGateway({ readSession: tolerant })
    .findProducts(context, ["молоко"]);
  expect(result?.products).toHaveLength(1);

  // A single row is dropped, but a response whose shape cannot be trusted at
  // all stops the flow rather than resolving against a guess.
  const malformed = createFakeSession(CATALOG_TOOLS, {
    silpo_find_products_batch: () => ({ results: [{ products: [rawProduct()] }] }),
  });
  await expect(
    createLiveCatalogGateway({ readSession: malformed }).findProducts(context, ["молоко"]),
  ).rejects.toBeInstanceOf(InvalidExternalDataError);
});

it("refuses details for a product it cannot represent", async () => {
  const session = createFakeSession(CATALOG_TOOLS, {
    silpo_get_product_details: () => ({
      product: { ...rawProduct(), companyId: null, description: null, ingredients: null },
    }),
  });

  await expect(
    createLiveCatalogGateway({ readSession: session }).getProductDetails(context, "moloko-25-900"),
  ).rejects.toBeInstanceOf(InvalidExternalDataError);
});
