import { z } from "zod";

import { isoDateTime, money, nonEmptyString } from "./common";

/**
 * External Silpo history and profile responses. Not `.strict()`, for the same
 * reason as the cart schemas: an added Silpo field must not be an outage.
 *
 * Personal fields present on the wire (names, birth dates, card numbers,
 * barcodes) are deliberately absent from these schemas. What is not parsed
 * cannot be carried forward by accident.
 */

export const OrderItemSchema = z.object({
  id: nonEmptyString,
  lagerId: z.number().int().nonnegative().nullable().default(null),
  productId: nonEmptyString.nullable().default(null),
  name: nonEmptyString,
  quantity: z.number().finite().positive(),
  unit: nonEmptyString.nullable().default(null),
  price: money,
});

export const OrderSchema = z.object({
  id: nonEmptyString,
  createdAt: isoDateTime,
  city: nonEmptyString.nullable().default(null),
  total: money,
  items: z.array(OrderItemSchema).default([]),
});

export const OnlineOrdersSchema = z.object({
  orders: z.array(OrderSchema).default([]),
});

export const OfflineOrdersSchema = z.object({
  orders: z.array(OrderSchema).default([]),
});

export const FamilySchema = z.object({
  // Only the count matters. Names and birth dates are not parsed.
  members: z.array(z.object({ relation: z.string().default("") })).default([]),
});

export const FoodRestrictionsSchema = z.object({
  restrictions: z.array(z.object({ key: nonEmptyString })).default([]),
});

export const LoyaltyInfoSchema = z.object({
  // Card number and barcode are not parsed.
  loyalty: z.object({
    bonusAvailable: money.nullable().default(null),
    isEnabled: z.boolean().default(false),
  }),
});
