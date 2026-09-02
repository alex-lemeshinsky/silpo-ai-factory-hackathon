import { z } from "zod";

import snapshotJson from "../../../../fixtures/demo/silpo-snapshot.json";
import {
  CartContextSchema,
  CustomerContextSchema,
  ProductCandidateSchema,
  ProductDetailsSchema,
  ProductSearchResultSchema,
  PromotionSchema,
  RawPurchaseReceiptSchema,
  SetCartProductsInputSchema,
  TimeSlotSchema,
  UpdateCartContextInputSchema,
  VerifiedCartSchema,
  type CartContext,
  type ProductCandidate,
  type SilpoGateway,
  type VerifiedCart,
} from "@/features/shared/contracts";

const nonEmptyString = z.string().trim().min(1);
const unique = <T>(values: T[]) => new Set(values).size === values.length;

const DemoSnapshotSchema = z.object({
  tools: z.array(nonEmptyString).min(1).refine(unique, "tool names must be unique"),
  customerContext: CustomerContextSchema,
  cartContext: z.object({
    status: z.literal("ready"),
    context: CartContextSchema,
  }).strict(),
  timeSlots: z.array(TimeSlotSchema).min(1),
  purchaseHistory: z.array(RawPurchaseReceiptSchema).length(30),
  promotions: z.array(PromotionSchema),
  productSearchResults: z.array(ProductSearchResultSchema).min(1),
  productDetails: z.array(ProductDetailsSchema).min(1),
  similarProducts: z.array(z.object({
    slug: nonEmptyString,
    products: z.array(ProductCandidateSchema),
  }).strict()),
  carts: z.array(VerifiedCartSchema).min(2),
}).strict().superRefine((value, context) => {
  const uniqueFields = [
    [value.timeSlots.map((slot) => slot.id), "timeSlots"],
    [value.purchaseHistory.map((receipt) => receipt.sourceId), "purchaseHistory"],
    [value.productSearchResults.map((result) => result.query), "productSearchResults"],
    [value.productDetails.map((details) => details.slug), "productDetails"],
    [value.similarProducts.map((entry) => entry.slug), "similarProducts"],
    [value.carts.map((cart) => cart.cartId), "carts"],
  ] as const;

  for (const [values, field] of uniqueFields) {
    if (!unique(values)) {
      context.addIssue({ code: "custom", path: [field], message: `${field} keys must be unique` });
    }
  }

  const cartStatuses = new Set(value.carts.map((cart) => cart.status));
  if (!cartStatuses.has("verified") || !cartStatuses.has("blocked")) {
    context.addIssue({
      code: "custom",
      path: ["carts"],
      message: "demo snapshot needs verified and blocked cart states",
    });
  }
});

const snapshot = DemoSnapshotSchema.parse(snapshotJson);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertKnownContext(context: CartContext) {
  CartContextSchema.parse(context);
}

export function createDemoSilpoGateway(): SilpoGateway {
  let currentContext = clone(snapshot.cartContext.context);
  const carts = new Map<string, VerifiedCart>(
    snapshot.carts.map((cart) => [cart.cartId, clone(cart)]),
  );
  const catalog = new Map<string, ProductCandidate>();

  for (const result of snapshot.productSearchResults) {
    for (const product of result.products) {
      catalog.set(product.productId, product);
    }
  }
  for (const entry of snapshot.similarProducts) {
    for (const product of entry.products) {
      catalog.set(product.productId, product);
    }
  }

  return {
    async listTools() {
      return clone(snapshot.tools);
    },

    async loadCustomerContext() {
      return clone(snapshot.customerContext);
    },

    async loadCartContext() {
      return { status: "ready", context: clone(currentContext) };
    },

    async updateCartContext(input) {
      const parsedInput = UpdateCartContextInputSchema.parse(input);
      const slot = snapshot.timeSlots.find((candidate) => candidate.id === parsedInput.slotId);
      if (!slot?.available) {
        throw new Error("Demo cart context requires an available time slot");
      }

      currentContext = CartContextSchema.parse({
        ...currentContext,
        deliveryType: parsedInput.deliveryType,
        branchId: parsedInput.branchId,
        slot,
      });
      return clone(currentContext);
    },

    async loadPurchaseHistory(context) {
      assertKnownContext(context);
      return clone(snapshot.purchaseHistory);
    },

    async findProducts(context, queries) {
      assertKnownContext(context);
      const parsedQueries = z.array(nonEmptyString).parse(queries);
      return parsedQueries.map((query) => {
        const result = snapshot.productSearchResults.find((candidate) => candidate.query === query);
        return result ? clone(result) : { query, products: [] };
      });
    },

    async getPromotions(context) {
      assertKnownContext(context);
      return clone(snapshot.promotions);
    },

    async getProductDetails(context, slug) {
      assertKnownContext(context);
      const parsedSlug = nonEmptyString.parse(slug);
      const details = snapshot.productDetails.find((candidate) => candidate.slug === parsedSlug);
      if (!details) {
        throw new Error("Unknown demo product slug");
      }
      return clone(details);
    },

    async getSimilarProducts(context, slug) {
      assertKnownContext(context);
      const parsedSlug = nonEmptyString.parse(slug);
      const entry = snapshot.similarProducts.find((candidate) => candidate.slug === parsedSlug);
      return clone(entry?.products ?? []);
    },

    async getTimeSlots(context) {
      assertKnownContext(context);
      return clone(snapshot.timeSlots);
    },

    async setAbsoluteCartQuantities(input) {
      const parsedInput = SetCartProductsInputSchema.parse(input);
      const currentCart = carts.get(parsedInput.cartId);
      if (!currentCart) {
        throw new Error("Unknown demo cart");
      }

      const items = clone(currentCart.items);
      for (const target of parsedInput.items) {
        const product = catalog.get(target.productId);
        if (!product) {
          throw new Error("Unknown demo product");
        }

        const cartItem = {
          productId: product.productId,
          quantity: target.quantity,
          unitPrice: product.specialPrice ?? product.price,
          available: product.available,
        };
        const existingIndex = items.findIndex((item) => item.productId === target.productId);
        if (existingIndex === -1) {
          items.push(cartItem);
        } else {
          items[existingIndex] = cartItem;
        }
      }

      const total = Number(
        items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0).toFixed(2),
      );
      carts.set(parsedInput.cartId, VerifiedCartSchema.parse({ ...currentCart, items, total }));
    },

    async readCart(cartId) {
      const parsedCartId = nonEmptyString.parse(cartId);
      const cart = carts.get(parsedCartId);
      if (!cart) {
        throw new Error("Unknown demo cart");
      }
      return clone(cart);
    },
  };
}
