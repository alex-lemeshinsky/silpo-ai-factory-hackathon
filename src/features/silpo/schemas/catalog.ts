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
  id: z.string().default(""),
  title: z.string().default(""),
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
