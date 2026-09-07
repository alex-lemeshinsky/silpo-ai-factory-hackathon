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
    promotions: raw.promotions.map((promotion) => {
      const parsed = PromotionSchema.safeParse({
        id: promotion.id,
        label: promotion.title,
        price: promotion.price,
      });
      return parsed.success ? parsed.data : null;
    }),
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
  try {
    const parsed = ProductCandidateSchema.safeParse(toCandidateFields(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
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
      return response.promotions.flatMap((promotion) => {
        const parsed = PromotionSchema.safeParse({
          id: promotion.id,
          label: promotion.title,
          price: promotion.price,
        });
        return parsed.success ? [parsed.data] : [];
      });
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
