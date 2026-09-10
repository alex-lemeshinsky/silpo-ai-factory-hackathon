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

export const CartProductLineSchema = z.object({
  productId: nonEmptyString,
  quantity: z.number().finite().nonnegative(),
  price: money,
  specialPrice: money.nullable().default(null),
  available: z.boolean().default(true),
});
export type SilpoCartProductLine = z.infer<typeof CartProductLineSchema>;

/**
 * Checkout targets are copied verbatim. Whether a link may be shown is a
 * domain rule enforced by `VerifiedCartSchema`, not a parsing rule.
 */
/**
 * A cart that is not checkout-ready reports its links as empty strings rather
 * than omitting them, so an empty value is normalized to `null` instead of
 * failing the whole readback. This runs after a write, where a parse failure
 * would hide a commit that actually succeeded.
 */
const optionalCheckoutUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  nonEmptyString.nullable().default(null),
);

export const CartCheckoutSchema = z.object({
  webUrl: optionalCheckoutUrl,
  mobileUrl: optionalCheckoutUrl,
});
export type SilpoCartCheckout = z.infer<typeof CartCheckoutSchema>;

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
  products: z.array(CartProductLineSchema).default([]),
  checkout: CartCheckoutSchema.nullable().default(null),
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

/**
 * Response schema for a write whose effect is confirmed by an immediate cart
 * readback. Silpo's acknowledgement body is not part of that proof, so
 * validating its shape would turn a successful write into a false failure.
 */
export const AcknowledgedWriteSchema = z.unknown();
