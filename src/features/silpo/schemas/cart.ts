import { z } from "zod";

import { isoDateTime, money, nonEmptyString } from "./common";

/**
 * External Silpo MCP response schemas.
 *
 * Deliberately NOT `.strict()`. Zod strips unknown keys, so a field Silpo
 * adds is additive rather than an outage. Required fields are still
 * validated: a missing or mistyped one stops the flow instead of letting a
 * guessed shape through. Internal contracts keep their own `.strict()`.
 *
 * Field names follow SILPO_MCP.md's documented request parameters and must
 * be reconciled against a live `tools/list` once credentials exist.
 */

/** Documented values from SILPO_MCP.md. */
export const SILPO_DELIVERY_TYPES = [
  "SelfPickup",
  "DeliveryHome",
  "LongDelivery",
  "DeliveryExpressByPromise",
  "WideAssortDelivery",
  "B2B",
  "PreOrder",
  "NovaPoshta",
] as const;

export const SilpoDeliveryTypeSchema = z.enum(SILPO_DELIVERY_TYPES);
export type SilpoDeliveryTypeName = z.infer<typeof SilpoDeliveryTypeSchema>;

export const SilpoAddressSchema = z.object({
  addressType: nonEmptyString.nullable().default(null),
  city: nonEmptyString.nullable().default(null),
  street: nonEmptyString.nullable().default(null),
  house: nonEmptyString.nullable().default(null),
  district: nonEmptyString.nullable().default(null),
  latitude: z.number().finite().nullable().default(null),
  longitude: z.number().finite().nullable().default(null),
});

export const SilpoCartTimeslotSchema = z.object({
  id: nonEmptyString.nullable().default(null),
  start: isoDateTime,
  end: isoDateTime,
});

export const MyShoppingCartSchema = z.object({
  exists: z.boolean(),
  cartId: nonEmptyString.nullable().default(null),
});
export type SilpoMyShoppingCart = z.infer<typeof MyShoppingCartSchema>;

export const CartValidationSchema = z.object({
  severity: z.string(),
  code: nonEmptyString,
  message: z.string(),
  productId: nonEmptyString.nullable().default(null),
});

export const ShoppingCartSchema = z.object({
  id: nonEmptyString,
  branchId: nonEmptyString.nullable().default(null),
  deliveryType: z.string(),
  timeslot: SilpoCartTimeslotSchema.nullable().default(null),
  address: SilpoAddressSchema.nullable().default(null),
  /** Copied verbatim into an update; never interpreted here. */
  shipments: z.array(z.unknown()).default([]),
  total: money,
  validations: z.array(CartValidationSchema).default([]),
});
export type SilpoShoppingCart = z.infer<typeof ShoppingCartSchema>;

export const SilpoTimeSlotSchema = z.object({
  id: nonEmptyString,
  start: isoDateTime,
  end: isoDateTime,
  available: z.boolean(),
});
export type SilpoTimeSlot = z.infer<typeof SilpoTimeSlotSchema>;

export const TimeSlotsSchema = z.object({
  slots: z.array(SilpoTimeSlotSchema).default([]),
});

export const DeliveryTypesSchema = z.object({
  deliveryTypes: z.array(
    z.object({
      deliveryType: z.string(),
      branchId: nonEmptyString.nullable().default(null),
    }),
  ).default([]),
});
export type SilpoDeliveryType = z.infer<typeof DeliveryTypesSchema>["deliveryTypes"][number];

export const BranchesSchema = z.object({
  branches: z.array(
    z.object({
      id: nonEmptyString,
      name: z.string().default(""),
      hasPickup: z.boolean().default(false),
      hasNovaPoshta: z.boolean().default(false),
    }),
  ).default([]),
});
export type SilpoBranch = z.infer<typeof BranchesSchema>["branches"][number];

export const FoundAddressSchema = z.object({
  latitude: z.number().finite(),
  longitude: z.number().finite(),
  city: nonEmptyString.nullable().default(null),
  street: nonEmptyString.nullable().default(null),
  houseNumber: nonEmptyString.nullable().default(null),
  district: nonEmptyString.nullable().default(null),
});
export type SilpoFoundAddress = z.infer<typeof FoundAddressSchema>;

export const DeliveryAddressesSchema = z.object({
  addresses: z.array(
    z.object({
      id: nonEmptyString,
      isDefault: z.boolean().default(false),
      addressType: nonEmptyString.nullable().default(null),
      city: nonEmptyString.nullable().default(null),
      street: nonEmptyString.nullable().default(null),
      house: nonEmptyString.nullable().default(null),
      district: nonEmptyString.nullable().default(null),
    }),
  ).default([]),
});
export type SilpoDeliveryAddress = z.infer<typeof DeliveryAddressesSchema>["addresses"][number];

export const CreatedCartSchema = z.object({
  cartId: nonEmptyString,
});
