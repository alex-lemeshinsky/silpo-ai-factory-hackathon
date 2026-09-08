import { isServiceItem } from "@/features/purchases/categorize";
import {
  ProductCandidateSchema,
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

/** One batch for the whole run: two categories sharing a query cost one search. */
function planBatch(plans: QueryPlan[]): string[] {
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
  return queries;
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

interface RankedNeed {
  plan: QueryPlan;
  /** Eligible candidates in selection order; empty when the need cannot be met. */
  ranked: ProductCandidate[];
}

/**
 * Builds one need's ranked shortlist. Needs do not depend on each other, so
 * these run as one wave rather than ten in series — the draft has a median
 * latency budget, and a round trip per need would spend most of it waiting.
 */
async function rankOne(
  plan: QueryPlan,
  byQuery: Map<string, ProductCandidate[]>,
  context: CartContext,
  customerContext: CustomerContext,
  gateway: CatalogPort,
): Promise<RankedNeed> {
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
    return { plan, ranked: [] };
  }

  const reference = referenceFor(eligible, familiar);
  return { plan, ranked: [...eligible].sort(compareCandidates(reference)) };
}

interface Selection {
  plan: QueryPlan;
  selected: ProductCandidate;
  alternatives: ProductCandidate[];
}

/**
 * Picks one need's product from what earlier needs left. A selectable
 * familiar SKU wins outright; otherwise the top of the ranking does.
 */
function selectFrom(rankedNeed: RankedNeed, taken: Set<string>): Selection | null {
  const available = rankedNeed.ranked.filter((product) => !taken.has(product.productId));
  if (available.length === 0) {
    return null;
  }
  const selected = familiarIn(available, rankedNeed.plan.need) ?? available[0];
  const alternatives = available
    .filter((product) => product.productId !== selected.productId)
    .slice(0, MAX_ALTERNATIVES);
  return { plan: rankedNeed.plan, selected, alternatives };
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
  const queries = planBatch(plans);
  if (queries.length === 0) {
    return [];
  }

  const results = await gateway.findProducts(context, queries);
  const byQuery = new Map(results.map((result) => [result.query, result.products]));

  const rankedNeeds = await Promise.all(
    plans.map((plan) => rankOne(plan, byQuery, context, customerContext, gateway)),
  );

  // Selection walks the needs in order and is pure, so an earlier need's
  // choice bars a later one from repeating it: `DraftSchema` rejects a draft
  // that names the same product twice, and prediction has already sorted
  // these by confidence, so the earlier need has the better claim.
  const taken = new Set<string>();
  const selections: Selection[] = [];
  for (const rankedNeed of rankedNeeds) {
    const selection = selectFrom(rankedNeed, taken);
    if (selection === null) {
      continue;
    }
    taken.add(selection.selected.productId);
    selections.push(selection);
  }

  const enriched = await Promise.all(
    selections.map((selection) => withNutrition(selection.selected, context, gateway)),
  );

  return selections.map((selection, index) =>
    ResolvedNeedSchema.parse({
      need: selection.plan.need,
      selected: enriched[index],
      alternatives: selection.alternatives,
    }),
  );
}
