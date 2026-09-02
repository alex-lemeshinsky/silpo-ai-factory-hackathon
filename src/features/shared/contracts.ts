import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);
const isoDateTime = z.string().datetime({ offset: true });
const finiteNonNegative = z.number().finite().nonnegative();
const finitePositive = z.number().finite().positive();
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const stepAligned = (quantity: number, step: number) =>
  Math.abs(quantity / step - Math.round(quantity / step)) <= 1e-9;

export const DataModeSchema = z.enum(["live", "demo"]);
export type DataMode = z.infer<typeof DataModeSchema>;
export const PurchaseChannelSchema = z.enum(["offline", "online"]);
export type PurchaseChannel = z.infer<typeof PurchaseChannelSchema>;
export const ConfidenceBandSchema = z.enum(["medium", "high"]);
export type ConfidenceBand = z.infer<typeof ConfidenceBandSchema>;
export const NutritionStatusSchema = z.enum(["known", "insufficient"]);
export type NutritionStatus = z.infer<typeof NutritionStatusSchema>;
export const DraftStatusSchema = z.enum([
  "syncing",
  "generating",
  "ready",
  "confirming",
  "partially_committed",
  "verified",
  "blocked",
]);
export type DraftStatus = z.infer<typeof DraftStatusSchema>;
export const ValidationSeveritySchema = z.enum(["warning", "error"]);
export type ValidationSeverity = z.infer<typeof ValidationSeveritySchema>;

export const RawPurchaseItemSchema = z.object({
  sourceId: nonEmptyString,
  externalProductId: z.number().int().nonnegative().nullable(),
  productId: nonEmptyString.nullable(),
  name: nonEmptyString,
  quantity: finitePositive,
  unit: nonEmptyString.nullable(),
  unitPrice: finiteNonNegative,
}).strict();
export type RawPurchaseItem = z.infer<typeof RawPurchaseItemSchema>;

export const RawPurchaseReceiptSchema = z.object({
  sourceId: nonEmptyString,
  channel: PurchaseChannelSchema,
  purchasedAt: isoDateTime,
  city: nonEmptyString.nullable(),
  total: finiteNonNegative,
  items: z.array(RawPurchaseItemSchema).min(1),
}).strict();
export type RawPurchaseReceipt = z.infer<typeof RawPurchaseReceiptSchema>;

export const NormalizedPurchaseItemSchema = RawPurchaseItemSchema.extend({
  normalizedName: nonEmptyString,
  categoryKey: nonEmptyString,
}).strict();
export type NormalizedPurchaseItem = z.infer<typeof NormalizedPurchaseItemSchema>;

export const NormalizedReceiptSchema = z.object({
  sourceIds: z.array(nonEmptyString).min(1).refine(unique, "sourceIds must be unique"),
  channel: PurchaseChannelSchema,
  purchasedAt: isoDateTime,
  city: nonEmptyString.nullable(),
  total: finiteNonNegative,
  externalFingerprint: nonEmptyString,
  items: z.array(NormalizedPurchaseItemSchema).min(1),
}).strict();
export type NormalizedReceipt = z.infer<typeof NormalizedReceiptSchema>;

export const NeedFeaturesSchema = z.object({
  weightedPurchaseCount: finiteNonNegative,
  medianIntervalDays: finiteNonNegative,
  intervalMadDays: finiteNonNegative,
  daysSinceLastPurchase: finiteNonNegative,
  activeCityShare: z.number().finite().min(0).max(1),
  repeatScore: z.number().finite().min(0).max(1),
  dueScore: z.number().finite().min(0).max(1),
  stabilityScore: z.number().finite().min(0).max(1),
}).strict();
export type NeedFeatures = z.infer<typeof NeedFeaturesSchema>;

export const NeedCandidateSchema = z.object({
  categoryKey: nonEmptyString,
  confidence: z.number().finite().min(0.55).max(1),
  confidenceBand: ConfidenceBandSchema,
  typicalQuantity: finitePositive,
  reasonCodes: z.array(nonEmptyString).min(1).refine(unique, "reasonCodes must be unique"),
  preferredExternalProductIds: z.array(z.number().int().nonnegative())
    .refine(unique, "preferredExternalProductIds must be unique"),
  features: NeedFeaturesSchema,
}).strict().superRefine((value, context) => {
  const correctBand = value.confidence >= 0.75 ? "high" : "medium";
  if (value.confidenceBand !== correctBand) {
    context.addIssue({
      code: "custom",
      path: ["confidenceBand"],
      message: "confidenceBand must match confidence thresholds",
    });
  }
});
export type NeedCandidate = z.infer<typeof NeedCandidateSchema>;

export const PromotionSchema = z.object({
  id: nonEmptyString,
  label: nonEmptyString,
  price: finiteNonNegative.nullable(),
}).strict();
export type Promotion = z.infer<typeof PromotionSchema>;

export const NutritionFactsSchema = z.object({
  caloriesKcal: finiteNonNegative.nullable(),
  proteinGrams: finiteNonNegative.nullable(),
  fatGrams: finiteNonNegative.nullable(),
  carbohydrateGrams: finiteNonNegative.nullable(),
}).strict();
export type NutritionFacts = z.infer<typeof NutritionFactsSchema>;

const productCandidateShape = {
  productId: nonEmptyString,
  externalProductId: z.number().int().nonnegative(),
  slug: nonEmptyString,
  name: nonEmptyString,
  imageUrl: z.string().url().nullable(),
  price: finiteNonNegative,
  specialPrice: finiteNonNegative.nullable(),
  available: z.boolean(),
  stock: finiteNonNegative,
  step: finitePositive,
  displayRatio: finitePositive,
  nutritionStatus: NutritionStatusSchema,
  nutrition: NutritionFactsSchema.nullable(),
  promotions: z.array(PromotionSchema),
};

function validateProductFacts(
  value: {
    price: number;
    specialPrice: number | null;
    nutritionStatus: NutritionStatus;
    nutrition: NutritionFacts | null;
  },
  context: z.RefinementCtx,
) {
  if (value.specialPrice !== null && value.specialPrice > value.price) {
    context.addIssue({ code: "custom", path: ["specialPrice"], message: "specialPrice cannot exceed price" });
  }
  const nutritionMatches =
    (value.nutritionStatus === "known" && value.nutrition !== null) ||
    (value.nutritionStatus === "insufficient" && value.nutrition === null);
  if (!nutritionMatches) {
    context.addIssue({
      code: "custom",
      path: ["nutrition"],
      message: "nutrition must match nutritionStatus",
    });
  }
}

export const ProductCandidateSchema = z.object(productCandidateShape).strict()
  .superRefine(validateProductFacts);
export type ProductCandidate = z.infer<typeof ProductCandidateSchema>;

export const ProductSearchResultSchema = z.object({
  query: nonEmptyString,
  products: z.array(ProductCandidateSchema),
}).strict();
export type ProductSearchResult = z.infer<typeof ProductSearchResultSchema>;

export const ProductDetailsSchema = z.object({
  ...productCandidateShape,
  description: z.string().nullable(),
  ingredients: z.string().nullable(),
}).strict().superRefine(validateProductFacts);
export type ProductDetails = z.infer<typeof ProductDetailsSchema>;

export const ResolvedNeedSchema = z.object({
  need: NeedCandidateSchema,
  selected: ProductCandidateSchema,
  alternatives: z.array(ProductCandidateSchema),
}).strict().superRefine((value, context) => {
  const ids = [value.selected.productId, ...value.alternatives.map((item) => item.productId)];
  if (!unique(ids)) {
    context.addIssue({ code: "custom", path: ["alternatives"], message: "product IDs must be unique" });
  }
});
export type ResolvedNeed = z.infer<typeof ResolvedNeedSchema>;

export const CustomerContextSchema = z.object({
  familySize: z.number().int().positive().nullable(),
  restrictionKeys: z.array(nonEmptyString).refine(unique, "restrictionKeys must be unique"),
  loyaltyBonusAvailable: finiteNonNegative.nullable(),
}).strict();
export type CustomerContext = z.infer<typeof CustomerContextSchema>;

export const TimeSlotSchema = z.object({
  id: nonEmptyString,
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  available: z.boolean(),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.endsAt) <= Date.parse(value.startsAt)) {
    context.addIssue({ code: "custom", path: ["endsAt"], message: "slot must end after it starts" });
  }
});
export type TimeSlot = z.infer<typeof TimeSlotSchema>;

export const CartContextSchema = z.object({
  cartId: nonEmptyString,
  deliveryType: z.enum(["delivery", "pickup"]),
  city: nonEmptyString.nullable(),
  branchId: nonEmptyString.nullable(),
  slot: TimeSlotSchema,
}).strict().superRefine((value, context) => {
  if (!value.slot.available) {
    context.addIssue({ code: "custom", path: ["slot"], message: "ready cart context needs an available slot" });
  }
});
export type CartContext = z.infer<typeof CartContextSchema>;

export const CartContextResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), context: CartContextSchema }).strict(),
  z.object({ status: z.literal("needs_slot"), availableSlots: z.array(TimeSlotSchema) }).strict(),
]);
export type CartContextResult = z.infer<typeof CartContextResultSchema>;

export const UpdateCartContextInputSchema = z.object({
  deliveryType: z.enum(["delivery", "pickup"]),
  addressId: nonEmptyString.nullable(),
  branchId: nonEmptyString.nullable(),
  slotId: nonEmptyString,
}).strict();
export type UpdateCartContextInput = z.infer<typeof UpdateCartContextInputSchema>;

export const DraftItemSchema = z.object({
  productId: nonEmptyString,
  externalProductId: z.number().int().nonnegative(),
  name: nonEmptyString,
  quantity: finitePositive,
  price: finiteNonNegative,
  stock: finiteNonNegative,
  step: finitePositive,
  confidence: z.number().finite().min(0.55).max(1),
  confidenceBand: ConfidenceBandSchema,
  reasonCodes: z.array(nonEmptyString).min(1).refine(unique, "reasonCodes must be unique"),
  reason: z.string().trim().min(1).max(160),
  nutritionStatus: NutritionStatusSchema,
  alternatives: z.array(ProductCandidateSchema),
}).strict().superRefine((value, context) => {
  if (value.quantity > value.stock) {
    context.addIssue({ code: "custom", path: ["quantity"], message: "quantity cannot exceed stock" });
  }
  if (!stepAligned(value.quantity, value.step)) {
    context.addIssue({ code: "custom", path: ["quantity"], message: "quantity must align with step" });
  }
  const correctBand = value.confidence >= 0.75 ? "high" : "medium";
  if (value.confidenceBand !== correctBand) {
    context.addIssue({ code: "custom", path: ["confidenceBand"], message: "confidenceBand must match confidence" });
  }
});
export type DraftItem = z.infer<typeof DraftItemSchema>;

export const DraftSchema = z.object({
  id: nonEmptyString,
  mode: DataModeSchema,
  status: DraftStatusSchema,
  algorithmVersion: nonEmptyString,
  trainingCutoff: isoDateTime,
  summary: z.string().trim().max(180),
  items: z.array(DraftItemSchema).max(10),
  total: finiteNonNegative,
  version: z.number().int().positive(),
}).strict().superRefine((value, context) => {
  const ids = value.items.map((item) => item.productId);
  if (!unique(ids)) {
    context.addIssue({ code: "custom", path: ["items"], message: "draft product IDs must be unique" });
  }
  const calculated = value.items.reduce((sum, item) => sum + item.quantity * item.price, 0);
  if (Math.abs(calculated - value.total) > 0.01) {
    context.addIssue({ code: "custom", path: ["total"], message: "total must match item snapshots" });
  }
});
export type Draft = z.infer<typeof DraftSchema>;

export const SetCartProductTargetSchema = z.object({
  productId: nonEmptyString,
  quantity: finitePositive,
}).strict();
export type SetCartProductTarget = z.infer<typeof SetCartProductTargetSchema>;

export const SetCartProductsInputSchema = z.object({
  cartId: nonEmptyString,
  items: z.array(SetCartProductTargetSchema).min(1),
  addQuantity: z.literal(false),
}).strict().superRefine((value, context) => {
  if (!unique(value.items.map((item) => item.productId))) {
    context.addIssue({ code: "custom", path: ["items"], message: "cart product IDs must be unique" });
  }
});
export type SetCartProductsInput = z.infer<typeof SetCartProductsInputSchema>;

export const CartValidationSchema = z.object({
  severity: ValidationSeveritySchema,
  code: nonEmptyString,
  message: nonEmptyString,
  productId: nonEmptyString.nullable(),
}).strict();
export type CartValidation = z.infer<typeof CartValidationSchema>;

export const VerifiedCartItemSchema = z.object({
  productId: nonEmptyString,
  quantity: finitePositive,
  unitPrice: finiteNonNegative,
  available: z.boolean(),
}).strict();
export type VerifiedCartItem = z.infer<typeof VerifiedCartItemSchema>;

const httpsUrl = z.string().url().refine(
  (value) => new URL(value).protocol === "https:",
  "checkout URL must use HTTPS",
);

export const CheckoutLinksSchema = z.object({
  web: httpsUrl,
  mobile: httpsUrl,
}).strict();
export type CheckoutLinks = z.infer<typeof CheckoutLinksSchema>;

export const VerifiedCartSchema = z.object({
  cartId: nonEmptyString,
  status: z.enum(["verified", "partially_committed", "blocked"]),
  items: z.array(VerifiedCartItemSchema),
  total: finiteNonNegative,
  validations: z.array(CartValidationSchema),
  checkoutLinks: CheckoutLinksSchema.nullable(),
}).strict().superRefine((value, context) => {
  const hasError = value.validations.some((validation) => validation.severity === "error");
  if (value.checkoutLinks !== null && (value.status !== "verified" || hasError)) {
    context.addIssue({
      code: "custom",
      path: ["checkoutLinks"],
      message: "checkout requires a verified cart without errors",
    });
  }
});
export type VerifiedCart = z.infer<typeof VerifiedCartSchema>;

export interface SilpoGateway {
  listTools(): Promise<string[]>;
  loadCustomerContext(): Promise<CustomerContext>;
  loadCartContext(): Promise<CartContextResult>;
  updateCartContext(input: UpdateCartContextInput): Promise<CartContext>;
  loadPurchaseHistory(context: CartContext): Promise<RawPurchaseReceipt[]>;
  findProducts(context: CartContext, queries: string[]): Promise<ProductSearchResult[]>;
  getPromotions(context: CartContext): Promise<Promotion[]>;
  getProductDetails(context: CartContext, slug: string): Promise<ProductDetails>;
  getSimilarProducts(context: CartContext, slug: string): Promise<ProductCandidate[]>;
  getTimeSlots(context: CartContext): Promise<TimeSlot[]>;
  setAbsoluteCartQuantities(input: SetCartProductsInput): Promise<void>;
  readCart(cartId: string): Promise<VerifiedCart>;
}
