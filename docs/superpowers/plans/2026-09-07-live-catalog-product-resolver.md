# Live Catalog Gateway and Product Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn predicted category needs into verified, purchasable Silpo products — a read-only catalog gateway plus a deterministic resolver that hands Gemini only candidates that exist, are in stock, and respect the guest's dietary restrictions.

**Architecture:** `schemas/catalog.ts` parses the five catalog tools at the external boundary. `live/catalog.ts` maps them onto existing shared contracts and drops anything that cannot be represented as a valid `ProductCandidate`. `products/resolve-products.ts` holds every selection and ranking decision as a pure module over a narrow structural port that both the live and demo gateways satisfy. Two small vocabulary modules — category queries and dietary exclusions — keep their tables out of the policy file.

**Tech Stack:** TypeScript, Zod 4, Vitest, `@modelcontextprotocol/client` (only through Task 10's `McpSession`).

**Spec:** [2026-09-07-live-catalog-product-resolver-design.md](../specs/2026-09-07-live-catalog-product-resolver-design.md)

> **Executed 2026-09-07 as `811fc87`, then revised by review on 2026-09-08.** Six behaviors below no longer match the shipped code — row-level product parsing, promotion tolerance, parallel resolution waves, cross-need product exclusion, and two documentation lines. The spec's section 8 records what changed and why; read it rather than this plan for current behavior.

## Global Constraints

- Use `pnpm` exclusively. Add no production or development dependency.
- Task 11 is **read-only**. Use `openReadSession` only. Perform no cart write and open no write session.
- Do not edit `src/features/silpo/live/session.ts`, `src/features/silpo/live/retry.ts`, `src/features/silpo/oauth/*`, `src/features/purchases/*`, `src/features/prediction/*`, `src/lib/env.ts`, `src/db/schema.ts`, `vitest.config.ts`, `package.json`, `fixtures/demo/silpo-snapshot.json`, or `SILPO_MCP.md`.
- Every catalog call goes through `McpSession.callTool`, which already owns `tools/list` gating, the bounded `429` ladder and the single `401` refresh. Define no retry policy of your own.
- External MCP response schemas are **not** `.strict()` — Zod strips unknown keys, so a field Silpo adds is additive. Internal contracts in `src/features/shared/contracts.ts` keep their existing `.strict()`.
- Never invent or derive a price, stock level, promotion, package step, product ID or nutrition value. `nutritionStatus` is `"known"` only when a nutrition block carries at least one finite value.
- Bags, delivery fees, acceleration fees and other service rows are never recommended. Reuse `isServiceItem` from `src/features/purchases/categorize.ts`; do not write a second pattern list.
- `src/features/products/*` is pure: no React, Next.js, MCP SDK, AI SDK or database import, and no import of `schemas/catalog.ts` or `live/catalog.ts`.
- Resolver output is deterministic. The same inputs must produce the same `ResolvedNeed[]` in the same order on every run.
- Per draft run: at most one `findProducts` call with at most **30** queries, at most **10** fallback calls, at most **10** `getProductDetails` calls. At most **10** needs are resolved and at most **3** alternatives are returned per need.
- **Response field names are provisional.** `SILPO_MCP.md` documents tool names and request parameters, not full response schemas. When credentials become available, reconcile every schema against a live `tools/list` and report a mismatch as a spec deviation — do not silently reshape a schema to match whatever arrived. The same applies to the restriction-key vocabulary in Task 4.
- **Commit discipline:** work on branch `task-11-live-catalog-product-resolver`. Each task below ends in its own commit on that branch. The final task squashes the branch into one commit on `main` with the backlog's mandated message, `feat: resolve live product candidates`.

---

### Task 1: Replacements on the shared port

`silpo_get_replacements` is Silpo's purpose-built substitute list for unavailable products, and the resolver's fallback depends on it. `SilpoGateway` has no such method, so the port grows one and the demo gateway implements it in the same commit — otherwise live and demo stop being interchangeable behind one port.

The demo implementation reuses the snapshot's existing `similarProducts` entries filtered to selectable products, because a replacement is by definition offered in place of something unavailable. The fixture file itself is **not** modified, and `listTools()` keeps returning exactly the recorded MCP surface — the demo snapshot records what was captured, not what the gateway can synthesize.

**Files:**
- Modify: `src/features/shared/contracts.ts` (the `SilpoGateway` interface at the end of the file)
- Modify: `src/features/silpo/demo/demo-gateway.ts`
- Test: `src/features/silpo/demo/demo-gateway.test.ts`

**Interfaces:**
- Consumes: `CartContext`, `ProductCandidate` (existing).
- Produces: `SilpoGateway.getReplacements(context: CartContext, slug: string): Promise<ProductCandidate[]>`, implemented by `createDemoSilpoGateway()`.

- [ ] **Step 1: Write the failing test**

Append to `src/features/silpo/demo/demo-gateway.test.ts`:

```ts
it("offers replacements drawn from selectable similar products", async () => {
  const gateway = createDemoSilpoGateway();
  const cart = await loadReadyCart();

  const replacements = await gateway.getReplacements(cart, "demo-water-still-15l");

  expect(replacements.length).toBeGreaterThan(0);
  for (const product of replacements) {
    expect(product.available).toBe(true);
    expect(product.stock).toBeGreaterThan(0);
  }
});

it("returns no replacements for an unknown slug", async () => {
  const gateway = createDemoSilpoGateway();
  const cart = await loadReadyCart();

  expect(await gateway.getReplacements(cart, "demo-unknown-slug")).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/features/silpo/demo/demo-gateway.test.ts`
Expected: FAIL — `gateway.getReplacements is not a function`, and `tsc` would report the property does not exist on `SilpoGateway`.

- [ ] **Step 3: Add the method to the port**

In `src/features/shared/contracts.ts`, inside `export interface SilpoGateway`, add the new method directly after `getSimilarProducts`:

```ts
  getSimilarProducts(context: CartContext, slug: string): Promise<ProductCandidate[]>;
  getReplacements(context: CartContext, slug: string): Promise<ProductCandidate[]>;
```

- [ ] **Step 4: Implement it in the demo gateway**

In `src/features/silpo/demo/demo-gateway.ts`, add this method immediately after `getSimilarProducts`:

```ts
    async getReplacements(context, slug) {
      assertKnownContext(context);
      const parsedSlug = nonEmptyString.parse(slug);
      const entry = snapshot.similarProducts.find((candidate) => candidate.slug === parsedSlug);
      // A replacement stands in for something unavailable, so only a product
      // that can actually be bought right now qualifies.
      const selectable = (entry?.products ?? []).filter(
        (product) => product.available && product.stock > 0,
      );
      return clone(selectable);
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/features/silpo/demo/demo-gateway.test.ts && pnpm typecheck`
Expected: PASS. `typecheck` proves no other implementer of `SilpoGateway` was left incomplete.

- [ ] **Step 6: Commit**

```bash
git add src/features/shared/contracts.ts src/features/silpo/demo/demo-gateway.ts src/features/silpo/demo/demo-gateway.test.ts
git commit -m "feat: add product replacements to the Silpo gateway port"
```

---

### Task 2: Catalog schemas and the live catalog gateway

The external boundary and its mapping. The gateway maps faithfully and filters nothing on availability, stock, service rows or diet — those are domain policy and belong to the resolver, so live and demo get identical treatment from one implementation.

The one thing the gateway *does* remove is a product that cannot be represented as a valid `ProductCandidate`: no `companyId` or `branchId` (Task 16 could never commit it, and the contract has nowhere to carry them), or a payload that fails `ProductCandidateSchema`. Dropping rather than throwing keeps one malformed row from failing an entire search.

**Files:**
- Create: `src/features/silpo/schemas/catalog.ts`
- Create: `src/features/silpo/live/catalog.ts`
- Test: `tests/contract/silpo-catalog.test.ts`

**Interfaces:**
- Consumes: `McpSession` from `src/features/silpo/live/session.ts`; `parseToolResult` and `InvalidExternalDataError` from `src/features/silpo/schemas/common.ts`; `CartContext`, `ProductCandidate`, `ProductDetails`, `ProductSearchResult`, `Promotion` from shared contracts.
- Produces: `createLiveCatalogGateway({ readSession }): LiveCatalogGateway` with `findProducts(context, queries)`, `getPromotions(context)`, `getProductDetails(context, slug)`, `getSimilarProducts(context, slug)` and `getReplacements(context, slug)`.

- [ ] **Step 1: Write the failing contract test**

Create `tests/contract/silpo-catalog.test.ts`:

```ts
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

it("tolerates an unknown field but rejects a missing required one", async () => {
  const tolerant = createFakeSession(CATALOG_TOOLS, {
    silpo_find_products_batch: () => ({
      unknownTopLevelField: true,
      results: [{ query: "молоко", products: [{ ...rawProduct(), loyaltyOnlyPrice: 42 }] }],
    }),
  });
  const [result] = await createLiveCatalogGateway({ readSession: tolerant })
    .findProducts(context, ["молоко"]);
  expect(result?.products).toHaveLength(1);

  const malformed = createFakeSession(CATALOG_TOOLS, {
    silpo_find_products_batch: () => ({
      results: [{ query: "молоко", products: [{ ...rawProduct(), price: "45.50" }] }],
    }),
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/contract/silpo-catalog.test.ts`
Expected: FAIL — cannot resolve `@/features/silpo/live/catalog`.

- [ ] **Step 3: Write the catalog schemas**

Create `src/features/silpo/schemas/catalog.ts`:

```ts
import { z } from "zod";

import { money, nonEmptyString } from "./common";

/**
 * External Silpo catalog responses. Not `.strict()`, for the same reason as
 * the cart and history schemas: an added Silpo field must not be an outage.
 *
 * `companyId` and `branchId` are parsed as nullable so the mapping boundary
 * can act on their absence — a product without them can never be committed.
 */

/** Every value is independently nullable; a partial block is normal. */
export const RawNutritionSchema = z.object({
  calories: z.number().finite().nonnegative().nullable().default(null),
  proteins: z.number().finite().nonnegative().nullable().default(null),
  fats: z.number().finite().nonnegative().nullable().default(null),
  carbohydrates: z.number().finite().nonnegative().nullable().default(null),
});

export const RawPromotionSchema = z.object({
  id: nonEmptyString,
  title: nonEmptyString,
  price: money.nullable().default(null),
});

export const RawProductSchema = z.object({
  id: nonEmptyString,
  lagerId: z.number().int().nonnegative(),
  slug: nonEmptyString,
  name: nonEmptyString,
  imageUrl: z.string().url().nullable().default(null),
  price: money,
  specialPrice: money.nullable().default(null),
  available: z.boolean().default(false),
  stock: z.number().finite().nonnegative().default(0),
  step: z.number().finite().positive().default(1),
  displayRatio: z.number().finite().positive().default(1),
  companyId: nonEmptyString.nullable().default(null),
  branchId: nonEmptyString.nullable().default(null),
  nutrition: RawNutritionSchema.nullable().default(null),
  promotions: z.array(RawPromotionSchema).default([]),
});
export type RawSilpoProduct = z.infer<typeof RawProductSchema>;

export const RawProductDetailsSchema = RawProductSchema.extend({
  description: z.string().nullable().default(null),
  ingredients: z.string().nullable().default(null),
});
export type RawSilpoProductDetails = z.infer<typeof RawProductDetailsSchema>;

export const FindProductsBatchResponseSchema = z.object({
  results: z.array(
    z.object({
      query: nonEmptyString,
      products: z.array(RawProductSchema).default([]),
    }),
  ).default([]),
});

export const PromotionsResponseSchema = z.object({
  promotions: z.array(RawPromotionSchema).default([]),
});

export const ProductDetailsResponseSchema = z.object({
  product: RawProductDetailsSchema,
});

export const ProductListResponseSchema = z.object({
  products: z.array(RawProductSchema).default([]),
});
```

- [ ] **Step 4: Write the live catalog gateway**

Create `src/features/silpo/live/catalog.ts`:

```ts
import {
  ProductCandidateSchema,
  ProductDetailsSchema,
  ProductSearchResultSchema,
  PromotionSchema,
  type CartContext,
  type ProductCandidate,
  type ProductDetails,
  type ProductSearchResult,
  type Promotion,
} from "@/features/shared/contracts";

import {
  FindProductsBatchResponseSchema,
  ProductDetailsResponseSchema,
  ProductListResponseSchema,
  PromotionsResponseSchema,
  type RawSilpoProduct,
  type RawSilpoProductDetails,
} from "../schemas/catalog";
import { InvalidExternalDataError } from "../schemas/common";
import type { McpSession } from "./session";

export interface LiveCatalogDeps {
  readSession: McpSession;
}

export interface LiveCatalogGateway {
  findProducts(context: CartContext, queries: string[]): Promise<ProductSearchResult[]>;
  getPromotions(context: CartContext): Promise<Promotion[]>;
  getProductDetails(context: CartContext, slug: string): Promise<ProductDetails>;
  getSimilarProducts(context: CartContext, slug: string): Promise<ProductCandidate[]>;
  getReplacements(context: CartContext, slug: string): Promise<ProductCandidate[]>;
}

/**
 * Nutrition is `known` only when the block carries at least one real value.
 * A missing nutrient is never derived from the ones that are present.
 */
function toNutrition(raw: RawSilpoProduct["nutrition"]) {
  if (raw === null) {
    return { nutritionStatus: "insufficient" as const, nutrition: null };
  }
  const nutrition = {
    caloriesKcal: raw.calories,
    proteinGrams: raw.proteins,
    fatGrams: raw.fats,
    carbohydrateGrams: raw.carbohydrates,
  };
  const hasValue = Object.values(nutrition).some((value) => value !== null);
  return hasValue
    ? { nutritionStatus: "known" as const, nutrition }
    : { nutritionStatus: "insufficient" as const, nutrition: null };
}

/** Built field by field: no raw payload is ever spread into a returned object. */
function toCandidateFields(raw: RawSilpoProduct) {
  return {
    productId: raw.id,
    externalProductId: raw.lagerId,
    slug: raw.slug,
    name: raw.name,
    imageUrl: raw.imageUrl,
    price: raw.price,
    specialPrice: raw.specialPrice,
    available: raw.available,
    stock: raw.stock,
    step: raw.step,
    displayRatio: raw.displayRatio,
    ...toNutrition(raw.nutrition),
    promotions: raw.promotions.map((promotion) =>
      PromotionSchema.parse({
        id: promotion.id,
        label: promotion.title,
        price: promotion.price,
      }),
    ),
  };
}

/**
 * Returns null for a product that cannot be represented: without a company
 * and branch ID Task 16 could never commit it, and `ProductCandidate` has
 * nowhere to carry them. A row that fails the domain contract is dropped for
 * the same reason — one malformed product must not fail an entire search.
 */
function toCandidate(raw: RawSilpoProduct): ProductCandidate | null {
  if (raw.companyId === null || raw.branchId === null) {
    return null;
  }
  const parsed = ProductCandidateSchema.safeParse(toCandidateFields(raw));
  return parsed.success ? parsed.data : null;
}

function toCandidates(products: RawSilpoProduct[]): ProductCandidate[] {
  return products
    .map(toCandidate)
    .filter((product): product is ProductCandidate => product !== null);
}

function toDetails(tool: string, raw: RawSilpoProductDetails): ProductDetails {
  if (raw.companyId === null || raw.branchId === null) {
    throw new InvalidExternalDataError(tool);
  }
  const parsed = ProductDetailsSchema.safeParse({
    ...toCandidateFields(raw),
    description: raw.description,
    ingredients: raw.ingredients,
  });
  if (!parsed.success) {
    // Details returns one required object, so there is nothing to drop.
    // L11-08 makes this non-fatal for the resolver.
    throw new InvalidExternalDataError(tool, { cause: parsed.error });
  }
  return parsed.data;
}

export function createLiveCatalogGateway(deps: LiveCatalogDeps): LiveCatalogGateway {
  const { readSession } = deps;

  async function listBySlug(tool: string, context: CartContext, slug: string) {
    const response = await readSession.callTool(
      tool,
      { slug, branchId: context.branchId },
      ProductListResponseSchema,
    );
    return toCandidates(response.products);
  }

  return {
    async findProducts(context, queries) {
      const response = await readSession.callTool(
        "silpo_find_products_batch",
        { items: queries, branchId: context.branchId },
        FindProductsBatchResponseSchema,
      );
      return response.results.map((result) =>
        ProductSearchResultSchema.parse({
          query: result.query,
          products: toCandidates(result.products),
        }),
      );
    },

    async getPromotions(context) {
      const response = await readSession.callTool(
        "silpo_get_promotions",
        { branchId: context.branchId },
        PromotionsResponseSchema,
      );
      return response.promotions.map((promotion) =>
        PromotionSchema.parse({
          id: promotion.id,
          label: promotion.title,
          price: promotion.price,
        }),
      );
    },

    async getProductDetails(context, slug) {
      const response = await readSession.callTool(
        "silpo_get_product_details",
        { slug, branchId: context.branchId },
        ProductDetailsResponseSchema,
      );
      return toDetails("silpo_get_product_details", response.product);
    },

    getSimilarProducts(context, slug) {
      return listBySlug("silpo_get_similar_products", context, slug);
    },

    getReplacements(context, slug) {
      return listBySlug("silpo_get_replacements", context, slug);
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run tests/contract/silpo-catalog.test.ts && pnpm typecheck`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/features/silpo/schemas/catalog.ts src/features/silpo/live/catalog.ts tests/contract/silpo-catalog.test.ts
git commit -m "feat: add live Silpo catalog gateway"
```

---

### Task 3: Category query vocabulary

`NeedCandidate` carries an English `categoryKey` and numeric article IDs — nothing Silpo can search on. This module supplies the missing Ukrainian text, and two tests pin it from both sides so it cannot silently drift: one against `categorize.ts`, one against the demo fixture. Reading source files to pin a constant is the idiom `oauth/transport.test.ts` already uses against `SILPO_MCP.md`.

**Files:**
- Create: `src/features/products/category-queries.ts`
- Test: `src/features/products/category-queries.test.ts`

**Interfaces:**
- Consumes: nothing at runtime.
- Produces: `queryForCategory(categoryKey: string): string | null`.

- [ ] **Step 1: Write the failing test**

Create `src/features/products/category-queries.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { queryForCategory } from "@/features/products/category-queries";

/**
 * Read from source rather than imported, so adding a category to
 * `categorize.ts` without a query fails here instead of silently losing
 * that category's search path.
 */
function categoryKeysFromSource(): string[] {
  const source = readFileSync(
    join(process.cwd(), "src/features/purchases/categorize.ts"),
    "utf8",
  );
  const keys = [...source.matchAll(/categoryKey:\s*"([a-z-]+)"/g)].map((match) => match[1]);
  expect(keys.length).toBeGreaterThan(5);
  return [...new Set(keys)];
}

it("supplies exactly one query for every predicted category", () => {
  for (const key of categoryKeysFromSource()) {
    expect(queryForCategory(key), `missing query for "${key}"`).toEqual(expect.any(String));
  }
});

it("returns null for a category it does not know", () => {
  expect(queryForCategory("uncategorized")).toBeNull();
  expect(queryForCategory("truffles")).toBeNull();
});

it("keeps the fixture-backed queries identical to the demo snapshot", () => {
  const snapshot = JSON.parse(
    readFileSync(join(process.cwd(), "fixtures/demo/silpo-snapshot.json"), "utf8"),
  ) as { productSearchResults: { query: string }[] };
  const fixtureQueries = new Set(snapshot.productSearchResults.map((result) => result.query));

  // Demo mode resolves nothing for a category whose query misses the fixture.
  for (const key of ["water", "dairy", "grains", "eggs"]) {
    expect(fixtureQueries.has(queryForCategory(key) ?? "")).toBe(true);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/features/products/category-queries.test.ts`
Expected: FAIL — cannot resolve `@/features/products/category-queries`.

- [ ] **Step 3: Write the vocabulary**

Create `src/features/products/category-queries.ts`:

```ts
/**
 * Ukrainian search text for each category `categorize.ts` can produce.
 * `NeedCandidate` carries no product name, so without this table a category
 * need has nothing to search Silpo with.
 *
 * Four entries are pinned by `fixtures/demo/silpo-snapshot.json` and are
 * asserted against it: `water`, `dairy`, `grains` and `eggs`. `grains` is
 * therefore narrower than the category it serves — a known limitation to
 * revisit whenever the demo fixture is broadened.
 */
const CATEGORY_QUERIES: Record<string, string> = {
  water: "вода",
  dairy: "молоко",
  eggs: "яйця",
  bread: "хліб",
  coffee: "кава",
  tea: "чай",
  grains: "вівсяні пластівці",
  meat: "курка",
  fish: "риба",
  produce: "овочі",
  oil: "олія",
  sweets: "шоколад",
  snacks: "чіпси",
  household: "серветки",
};

export function queryForCategory(categoryKey: string): string | null {
  return CATEGORY_QUERIES[categoryKey] ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/features/products/category-queries.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/features/products/category-queries.ts src/features/products/category-queries.test.ts
git commit -m "feat: add category search vocabulary"
```

---

### Task 4: Dietary exclusion vocabulary

Dietary compatibility is a **hard exclusion, not a ranking key**: a product that violates a declared restriction is never offered, even if nothing else is available. It lives in its own module so the resolver holds policy rather than vocabulary.

An unrecognized restriction key excludes nothing. Guessing what it means would be worse than ignoring it — and, like the schema field names, this vocabulary must be reconciled against a live `silpo_get_my_food_restrictions` once credentials exist.

**Files:**
- Create: `src/features/products/dietary.ts`
- Test: `src/features/products/dietary.test.ts`

**Interfaces:**
- Consumes: `ProductCandidate` from shared contracts.
- Produces: `isDietaryCompatible(product: ProductCandidate, restrictionKeys: string[]): boolean`.

- [ ] **Step 1: Write the failing test**

Create `src/features/products/dietary.test.ts`:

```ts
import { expect, it } from "vitest";

import { isDietaryCompatible } from "@/features/products/dietary";
import { ProductCandidateSchema, type ProductCandidate } from "@/features/shared/contracts";

function product(name: string): ProductCandidate {
  return ProductCandidateSchema.parse({
    productId: `p-${name}`,
    externalProductId: 1,
    slug: "slug",
    name,
    imageUrl: null,
    price: 10,
    specialPrice: null,
    available: true,
    stock: 5,
    step: 1,
    displayRatio: 1,
    nutritionStatus: "insufficient",
    nutrition: null,
    promotions: [],
  });
}

it("accepts everything when no restriction is declared", () => {
  expect(isDietaryCompatible(product("Молоко 2,5%"), [])).toBe(true);
});

it("excludes a product matching a declared restriction", () => {
  expect(isDietaryCompatible(product("Молоко 2,5% 900 г"), ["lactose-free"])).toBe(false);
  expect(isDietaryCompatible(product("Напій вівсяний 1 л"), ["lactose-free"])).toBe(true);
});

it("applies every declared restriction, not just the first", () => {
  const restrictions = ["lactose-free", "nut-free"];
  expect(isDietaryCompatible(product("Паста горіхова 200 г"), restrictions)).toBe(false);
  expect(isDietaryCompatible(product("Вода негазована 1,5 л"), restrictions)).toBe(true);
});

it("ignores a restriction key it does not recognize", () => {
  expect(isDietaryCompatible(product("Молоко 2,5%"), ["low-fodmap"])).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/features/products/dietary.test.ts`
Expected: FAIL — cannot resolve `@/features/products/dietary`.

- [ ] **Step 3: Write the vocabulary**

Create `src/features/products/dietary.ts`:

```ts
import type { ProductCandidate } from "@/features/shared/contracts";

const VEGETARIAN_EXCLUSIONS = [
  /м['’]яс/i,
  /курк/i,
  /куряч/i,
  /свинин/i,
  /яловичин/i,
  /ковбас/i,
  /сосиск/i,
  /фарш/i,
  /риб/i,
  /філе/i,
  /індич/i,
];

const DAIRY_EXCLUSIONS = [/молок/i, /вершк/i, /кефір/i, /йогурт/i, /сметан/i, /сир/i, /ряжанк/i];

/**
 * Exclusion patterns per restriction key. A key absent from this table
 * excludes nothing: guessing what an unknown restriction means would be
 * worse than ignoring one. Reconcile against a live
 * `silpo_get_my_food_restrictions` once credentials exist.
 */
const RESTRICTION_PATTERNS: Record<string, RegExp[]> = {
  "no-added-sugar": [/цукор/i, /цукром/i, /підсолодж/i],
  "lactose-free": DAIRY_EXCLUSIONS,
  "gluten-free": [/пшенич/i, /хліб/i, /борошн/i, /глютен/i, /макарон/i, /булк/i, /батон/i],
  "nut-free": [/горіх/i, /арахіс/i, /фундук/i, /мигдал/i, /кеш['’]ю/i],
  vegetarian: VEGETARIAN_EXCLUSIONS,
  vegan: [...VEGETARIAN_EXCLUSIONS, ...DAIRY_EXCLUSIONS, /яйц/i, /мед/i, /масло вершкове/i],
};

/**
 * A hard exclusion rather than a ranking signal: a product that violates a
 * declared restriction is never offered, even when nothing else is left.
 */
export function isDietaryCompatible(
  product: ProductCandidate,
  restrictionKeys: string[],
): boolean {
  return restrictionKeys.every((key) => {
    const patterns = RESTRICTION_PATTERNS[key];
    if (patterns === undefined) {
      return true;
    }
    return !patterns.some((pattern) => pattern.test(product.name));
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/features/products/dietary.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/features/products/dietary.ts src/features/products/dietary.test.ts
git commit -m "feat: add dietary exclusion vocabulary"
```

---

### Task 5: Resolver batching and filters

The resolver's skeleton: one bounded search covering every need, then the three filters that decide what may be offered at all. Selection order is deliberately naive here — pool order — and Task 6 replaces it with the real ranking. Keeping them apart means a reviewer can reject the ranking without rejecting the batching.

**Files:**
- Create: `src/features/products/resolve-products.ts`
- Test: `src/features/products/resolve-products.test.ts`

**Interfaces:**
- Consumes: `queryForCategory` (Task 3), `isDietaryCompatible` (Task 4), `isServiceItem` from `@/features/purchases/categorize`, and the shared contracts.
- Produces: `resolveProducts(needs: NeedCandidate[], context: CartContext, customerContext: CustomerContext, gateway: CatalogPort): Promise<ResolvedNeed[]>`, plus the `CatalogPort` interface and the constants `MAX_RESOLVED_NEEDS`, `MAX_BATCH_QUERIES`, `MAX_ARTICLE_QUERIES_PER_NEED` and `MAX_ALTERNATIVES`.
- Enforces: `src/features/products/*` imports no framework, transport or database module — proved by the purity test in Step 1, not by prose.

- [ ] **Step 1: Write the failing test**

Create `src/features/products/resolve-products.test.ts`:

```ts
import { expect, it, vi } from "vitest";

import {
  MAX_BATCH_QUERIES,
  resolveProducts,
  type CatalogPort,
} from "@/features/products/resolve-products";
import {
  NeedCandidateSchema,
  ProductCandidateSchema,
  type CartContext,
  type CustomerContext,
  type NeedCandidate,
  type ProductCandidate,
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
```

The purity test needs two more imports at the top of the file:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/features/products/resolve-products.test.ts`
Expected: FAIL — cannot resolve `@/features/products/resolve-products`.

- [ ] **Step 3: Write the resolver skeleton**

Create `src/features/products/resolve-products.ts`:

```ts
import { isServiceItem } from "@/features/purchases/categorize";
import {
  ResolvedNeedSchema,
  type CartContext,
  type CustomerContext,
  type NeedCandidate,
  type ProductCandidate,
  type ProductDetails,
  type ProductSearchResult,
  type ResolvedNeed,
} from "@/features/shared/contracts";

import { queryForCategory } from "./category-queries";
import { isDietaryCompatible } from "./dietary";

/** A draft holds ten items, so resolving more needs would be wasted work. */
export const MAX_RESOLVED_NEEDS = 10;
/** `silpo_find_products_batch` searches up to 30 items in one call. */
export const MAX_BATCH_QUERIES = 30;
export const MAX_ARTICLE_QUERIES_PER_NEED = 2;
export const MAX_ALTERNATIVES = 3;

/**
 * The narrow slice of `SilpoGateway` the resolver needs. Both the live
 * catalog gateway and the demo gateway satisfy it structurally, so the
 * resolver stays pure and provider-agnostic.
 */
export interface CatalogPort {
  findProducts(context: CartContext, queries: string[]): Promise<ProductSearchResult[]>;
  getProductDetails(context: CartContext, slug: string): Promise<ProductDetails>;
  getSimilarProducts(context: CartContext, slug: string): Promise<ProductCandidate[]>;
  getReplacements(context: CartContext, slug: string): Promise<ProductCandidate[]>;
}

interface QueryPlan {
  need: NeedCandidate;
  articleQueries: string[];
  categoryQuery: string | null;
}

function planQueries(need: NeedCandidate): QueryPlan {
  return {
    need,
    articleQueries: need.preferredExternalProductIds
      .slice(0, MAX_ARTICLE_QUERIES_PER_NEED)
      .map((id) => String(id)),
    categoryQuery: queryForCategory(need.categoryKey),
  };
}

function dedupeById(products: ProductCandidate[]): ProductCandidate[] {
  const seen = new Set<string>();
  const unique: ProductCandidate[] = [];
  for (const product of products) {
    if (seen.has(product.productId)) {
      continue;
    }
    seen.add(product.productId);
    unique.push(product);
  }
  return unique;
}

/** At least one whole package must be buyable right now. */
function isSelectable(product: ProductCandidate): boolean {
  return product.available && product.stock > 0 && product.stock >= product.step;
}

function isEligible(product: ProductCandidate, restrictionKeys: string[]): boolean {
  return (
    !isServiceItem(product.name) &&
    isSelectable(product) &&
    isDietaryCompatible(product, restrictionKeys)
  );
}

function poolFor(plan: QueryPlan, byQuery: Map<string, ProductCandidate[]>): ProductCandidate[] {
  const categoryHits = plan.categoryQuery === null ? [] : byQuery.get(plan.categoryQuery) ?? [];
  return dedupeById([
    ...plan.articleQueries.flatMap((query) => byQuery.get(query) ?? []),
    ...categoryHits,
  ]);
}

function resolveOne(
  plan: QueryPlan,
  byQuery: Map<string, ProductCandidate[]>,
  customerContext: CustomerContext,
): ResolvedNeed | null {
  const eligible = poolFor(plan, byQuery).filter((product) =>
    isEligible(product, customerContext.restrictionKeys),
  );
  if (eligible.length === 0) {
    return null;
  }

  const selected = eligible[0];
  const alternatives = eligible
    .filter((product) => product.productId !== selected.productId)
    .slice(0, MAX_ALTERNATIVES);

  return ResolvedNeedSchema.parse({ need: plan.need, selected, alternatives });
}

/**
 * Turns predicted needs into verified, purchasable products. Deterministic:
 * the same inputs always produce the same output in the same order.
 */
export async function resolveProducts(
  needs: NeedCandidate[],
  context: CartContext,
  customerContext: CustomerContext,
  gateway: CatalogPort,
): Promise<ResolvedNeed[]> {
  const plans = needs.slice(0, MAX_RESOLVED_NEEDS).map(planQueries);

  const queries: string[] = [];
  for (const plan of plans) {
    const planQueryList = [
      ...plan.articleQueries,
      ...(plan.categoryQuery === null ? [] : [plan.categoryQuery]),
    ];
    for (const query of planQueryList) {
      if (queries.length < MAX_BATCH_QUERIES && !queries.includes(query)) {
        queries.push(query);
      }
    }
  }
  if (queries.length === 0) {
    return [];
  }

  const results = await gateway.findProducts(context, queries);
  const byQuery = new Map(results.map((result) => [result.query, result.products]));

  const resolved: ResolvedNeed[] = [];
  for (const plan of plans) {
    const item = resolveOne(plan, byQuery, customerContext);
    if (item !== null) {
      resolved.push(item);
    }
  }
  return resolved;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/features/products/resolve-products.test.ts && pnpm typecheck`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/features/products/resolve-products.ts src/features/products/resolve-products.test.ts
git commit -m "feat: batch product search and filter unbuyable candidates"
```

---

### Task 6: Ranking and selection

Replaces Task 5's naive pool-order selection with the documented policy. Two rules carry the design: a selectable familiar SKU wins outright regardless of ranking, because the habit is the recommendation; and the sort chain ends in `productId`, so equal-budget candidates order identically on every run instead of inheriting Silpo's response order.

The budget and package-size reference is the familiar SKU **even when it cannot be bought today** — it expresses what the guest normally spends and normally buys, which is exactly what an alternative should be measured against.

**Files:**
- Modify: `src/features/products/resolve-products.ts`
- Test: `src/features/products/resolve-products.test.ts`

**Interfaces:**
- Consumes: everything from Task 5.
- Produces: no new export. `resolveProducts` keeps its signature; only ordering changes.

- [ ] **Step 1: Write the failing tests**

Append to `src/features/products/resolve-products.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/features/products/resolve-products.test.ts`
Expected: FAIL — the naive selection returns pool order, so `selected.productId` is wrong in every new test.

- [ ] **Step 3: Add the ranking helpers**

In `src/features/products/resolve-products.ts`, add these above `resolveOne`:

```ts
const CLOSE_ENOUGH = 1e-9;

function effectivePrice(product: ProductCandidate): number {
  return product.specialPrice ?? product.price;
}

function hasActiveDiscount(product: ProductCandidate): boolean {
  return product.specialPrice !== null || product.promotions.length > 0;
}

/** Lower middle value for an even count, so the reference is deterministic. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** The first preferred SKU present in `products`, in preference order. */
function familiarIn(products: ProductCandidate[], need: NeedCandidate): ProductCandidate | null {
  for (const externalProductId of need.preferredExternalProductIds) {
    const match = products.find((product) => product.externalProductId === externalProductId);
    if (match !== undefined) {
      return match;
    }
  }
  return null;
}

/**
 * The familiar SKU anchors both budget and package size even when it cannot
 * be bought today: it expresses the habit an alternative should match.
 * Without one, the pool's own middle stands in.
 */
function referenceFor(pool: ProductCandidate[], familiar: ProductCandidate | null) {
  if (familiar !== null) {
    return { price: effectivePrice(familiar), ratio: familiar.displayRatio };
  }
  return {
    price: median(pool.map(effectivePrice)),
    ratio: median(pool.map((product) => product.displayRatio)),
  };
}

/**
 * Dietary compatibility is absent from this chain on purpose: it is a hard
 * filter applied before ranking, so everything here already complies.
 */
function compareCandidates(reference: { price: number; ratio: number }) {
  return (a: ProductCandidate, b: ProductCandidate): number => {
    const budget =
      Number(effectivePrice(a) > reference.price) - Number(effectivePrice(b) > reference.price);
    if (budget !== 0) {
      return budget;
    }
    const discount = Number(!hasActiveDiscount(a)) - Number(!hasActiveDiscount(b));
    if (discount !== 0) {
      return discount;
    }
    const distance =
      Math.abs(a.displayRatio - reference.ratio) - Math.abs(b.displayRatio - reference.ratio);
    if (Math.abs(distance) > CLOSE_ENOUGH) {
      return distance;
    }
    const price = effectivePrice(a) - effectivePrice(b);
    if (Math.abs(price) > CLOSE_ENOUGH) {
      return price;
    }
    // The last key must be total, or Silpo's response order would leak into
    // the draft and the same inputs could produce different output.
    return a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0;
  };
}
```

- [ ] **Step 4: Use them in `resolveOne`**

Replace the body of `resolveOne` in `src/features/products/resolve-products.ts` with:

```ts
function resolveOne(
  plan: QueryPlan,
  byQuery: Map<string, ProductCandidate[]>,
  customerContext: CustomerContext,
): ResolvedNeed | null {
  const pool = poolFor(plan, byQuery);
  const eligible = pool.filter((product) =>
    isEligible(product, customerContext.restrictionKeys),
  );
  if (eligible.length === 0) {
    return null;
  }

  // Anchored on the whole pool, so an unbuyable familiar SKU still counts.
  const reference = referenceFor(eligible, familiarIn(pool, plan.need));
  const ranked = [...eligible].sort(compareCandidates(reference));
  // A familiar SKU that can be bought wins outright: the habit is the
  // recommendation, and ranking only decides what stands in for it.
  const selected = familiarIn(eligible, plan.need) ?? ranked[0];
  const alternatives = ranked
    .filter((product) => product.productId !== selected.productId)
    .slice(0, MAX_ALTERNATIVES);

  return ResolvedNeedSchema.parse({ need: plan.need, selected, alternatives });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/features/products/resolve-products.test.ts && pnpm typecheck`
Expected: PASS, 13 tests.

- [ ] **Step 6: Commit**

```bash
git add src/features/products/resolve-products.ts src/features/products/resolve-products.test.ts
git commit -m "feat: rank resolved product candidates deterministically"
```

---

### Task 7: Fallback lookups and nutrition enrichment

The two remaining catalog calls, both bounded to one per need and both non-fatal. `getReplacements` is Silpo's substitute list for an unavailable product, which is precisely the case where the familiar SKU was found but cannot be bought. `getSimilarProducts` covers the emptier case where nothing eligible came back at all.

Enrichment is deliberately shallow: only the selected product gets a details call, so a ten-item draft costs ten enrichment round trips rather than thirty. A details failure leaves the product's search-result nutrition status untouched — losing a nutrition label must not cost the user an otherwise valid draft.

**Files:**
- Modify: `src/features/products/resolve-products.ts`
- Test: `src/features/products/resolve-products.test.ts`

**Interfaces:**
- Consumes: `CatalogPort.getReplacements`, `CatalogPort.getSimilarProducts`, `CatalogPort.getProductDetails`.
- Produces: no new export. `resolveProducts` keeps its signature.

- [ ] **Step 1: Write the failing tests**

Append to `src/features/products/resolve-products.test.ts`. Add `ProductDetailsSchema` and `type ProductDetails` to the existing import from `@/features/shared/contracts`, then:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/features/products/resolve-products.test.ts`
Expected: FAIL — no fallback or enrichment call is made yet, so the replacement and similar tests find no product and the enrichment test sees `insufficient`.

- [ ] **Step 3: Add the fallback and enrichment helpers**

In `src/features/products/resolve-products.ts`, add above `resolveOne`:

```ts
/**
 * A failed catalog extra must not cost the user an otherwise valid draft,
 * so these two lookups degrade to "nothing found" instead of propagating.
 * A `findProducts` failure is different: it is the primary data and stays
 * fatal.
 */
async function safeList(
  call: () => Promise<ProductCandidate[]>,
): Promise<ProductCandidate[]> {
  try {
    return await call();
  } catch {
    return [];
  }
}

/** At most one extra lookup per need. */
async function fallbackFor(
  pool: ProductCandidate[],
  eligible: ProductCandidate[],
  familiar: ProductCandidate | null,
  context: CartContext,
  gateway: CatalogPort,
): Promise<ProductCandidate[]> {
  if (familiar !== null && !eligible.some((product) => product.productId === familiar.productId)) {
    // Silpo's purpose-built substitute list for an unavailable product.
    return safeList(() => gateway.getReplacements(context, familiar.slug));
  }
  if (eligible.length === 0 && pool.length > 0) {
    return safeList(() => gateway.getSimilarProducts(context, pool[0].slug));
  }
  return [];
}

/**
 * Nutrition arrives only from the details call, and only for the product
 * the guest is actually being offered. Nothing is derived: a failure leaves
 * the search-result status exactly as it was.
 */
async function withNutrition(
  product: ProductCandidate,
  context: CartContext,
  gateway: CatalogPort,
): Promise<ProductCandidate> {
  try {
    const detail = await gateway.getProductDetails(context, product.slug);
    return ProductCandidateSchema.parse({
      ...product,
      nutritionStatus: detail.nutritionStatus,
      nutrition: detail.nutrition,
    });
  } catch {
    return product;
  }
}
```

Add `ProductCandidateSchema` to the existing import from `@/features/shared/contracts`.

- [ ] **Step 4: Wire them into `resolveOne` and `resolveProducts`**

Replace `resolveOne` in `src/features/products/resolve-products.ts` with:

```ts
async function resolveOne(
  plan: QueryPlan,
  byQuery: Map<string, ProductCandidate[]>,
  context: CartContext,
  customerContext: CustomerContext,
  gateway: CatalogPort,
): Promise<ResolvedNeed | null> {
  const { restrictionKeys } = customerContext;
  const pool = poolFor(plan, byQuery);
  const familiar = familiarIn(pool, plan.need);
  let eligible = pool.filter((product) => isEligible(product, restrictionKeys));

  const fallback = await fallbackFor(pool, eligible, familiar, context, gateway);
  if (fallback.length > 0) {
    eligible = dedupeById([
      ...eligible,
      ...fallback.filter((product) => isEligible(product, restrictionKeys)),
    ]);
  }
  if (eligible.length === 0) {
    return null;
  }

  const reference = referenceFor(eligible, familiar);
  const ranked = [...eligible].sort(compareCandidates(reference));
  const selected = familiarIn(eligible, plan.need) ?? ranked[0];
  const alternatives = ranked
    .filter((product) => product.productId !== selected.productId)
    .slice(0, MAX_ALTERNATIVES);

  return ResolvedNeedSchema.parse({
    need: plan.need,
    selected: await withNutrition(selected, context, gateway),
    alternatives,
  });
}
```

Then update the loop at the end of `resolveProducts`:

```ts
  const resolved: ResolvedNeed[] = [];
  for (const plan of plans) {
    const item = await resolveOne(plan, byQuery, context, customerContext, gateway);
    if (item !== null) {
      resolved.push(item);
    }
  }
  return resolved;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/features/products/resolve-products.test.ts && pnpm typecheck`
Expected: PASS, 19 tests.

- [ ] **Step 6: Commit**

```bash
git add src/features/products/resolve-products.ts src/features/products/resolve-products.test.ts
git commit -m "feat: add bounded catalog fallbacks and nutrition enrichment"
```

---

### Task 8: Documentation, full verification, and the mandated commit

Records the resolved policy in its owning documents, proves the whole repository still passes, and lands Task 11 as the single commit the backlog specifies.

**Files:**
- Modify: `docs/tasks.md` (Task 11 section, lines beginning `### Task 11`)
- Modify: `docs/agent-architecture.md` (the `ProductResolver` entry in §4, and the Alternatives row in §7)

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: no code.

- [ ] **Step 1: Record the approved ownership and completion in the backlog**

In `docs/tasks.md`, extend the Task 11 **Files** list with the controller-approved additions and mark every step checked:

```markdown
**Files:**
- Create: `src/features/silpo/schemas/catalog.ts`
- Create: `src/features/silpo/live/catalog.ts`
- Create: `src/features/products/resolve-products.ts`
- Create: `src/features/products/category-queries.ts` (controller-approved addition)
- Create: `src/features/products/dietary.ts` (controller-approved addition)
- Modify: `src/features/shared/contracts.ts` (controller-approved: add `getReplacements` to `SilpoGateway`)
- Modify: `src/features/silpo/demo/demo-gateway.ts` (controller-approved: implement `getReplacements`)
- Test: `tests/contract/silpo-catalog.test.ts`
- Test: `src/features/products/resolve-products.test.ts`
- Test: `src/features/products/category-queries.test.ts` (controller-approved addition)
- Test: `src/features/products/dietary.test.ts` (controller-approved addition)
- Test: `src/features/silpo/demo/demo-gateway.test.ts` (controller-approved addition)
```

Append the completion note after the commit block, matching Task 10's format:

```markdown
Виконано 2026-09-07. Специфікація: [design](./superpowers/specs/2026-09-07-live-catalog-product-resolver-design.md). Read-only live smoke не виконано — немає облікових даних.
```

- [ ] **Step 2: Record the resolved policy in the agent architecture**

In `docs/agent-architecture.md` §4, replace the `ProductResolver` paragraph with:

```markdown
Шукає exact familiar SKU за артикулом, перевіряє branch availability і будує дозволений список alternatives. Дієтична сумісність є жорстким фільтром, а не ranking-ключем: товар, що порушує обмеження, не пропонується взагалі. Далі ranking policy до Gemini: ціна в межах звичної → активна знижка → відстань за розміром паковання → ціна → `productId` для детермінованого порядку. Орієнтир ціни й паковання — звичний SKU, навіть якщо він зараз недоступний. Nutrition завантажується через `get_product_details` лише для обраного товару; помилка збагачення не скасовує чернетку.
```

In §7, replace the Alternatives row of the raw MCP mapping table with:

```markdown
| Alternatives | `silpo_get_similar_products`, `silpo_get_replacements` (обидва на порту `SilpoGateway`) |
```

- [ ] **Step 3: Run the full verification suite**

Run each and paste real output into the handoff — no claim without fresh output:

```bash
pnpm vitest run tests/contract/silpo-catalog.test.ts src/features/products/resolve-products.test.ts src/features/products/category-queries.test.ts src/features/products/dietary.test.ts
```

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Expected: all pass, including every Task 9 and Task 10 suite unmodified as regression evidence.

- [ ] **Step 4: Commit the documentation**

```bash
git add docs/tasks.md docs/agent-architecture.md
git commit -m "docs: record Task 11 catalog and resolver policy"
```

- [ ] **Step 5: Squash the branch onto main**

```bash
git checkout main
git merge --squash task-11-live-catalog-product-resolver
git commit -m "feat: resolve live product candidates"
```

- [ ] **Step 6: Re-run verification on the squashed commit**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Expected: PASS. Report the commit hash, the changed files, the exact commands and their output, and these two standing verification limits:

- no Silpo credentials exist here, so the read-only live smoke against `https://mcp.silpo.ua/mcp` was not run and the catalog field names in `schemas/catalog.ts` and the restriction keys in `dietary.ts` remain unreconciled against a live `tools/list`;
- the demo fixture carries search results for four queries only, so `bread` and `coffee` needs resolve to nothing in demo mode and are dropped.

---

## Handoff Report

When every task is checked, report:

- changed files;
- each command run and its real output;
- the mandated commit hash on `main`;
- the two verification limits above;
- any place where a provisional field name or restriction key had to be guessed.
