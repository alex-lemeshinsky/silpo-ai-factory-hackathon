import {
  CartValidationSchema,
  CheckoutLinksSchema,
  SetCartProductsInputSchema,
  VerifiedCartSchema,
  type CheckoutLinks,
  type SetCartProductsInput,
  type ValidationSeverity,
  type VerifiedCart,
} from "@/features/shared/contracts";

import { nonEmptyString } from "../schemas/common";
import {
  AcknowledgedWriteSchema,
  ShoppingCartSchema,
  type SilpoCartCheckout,
} from "../schemas/cart";
import type { McpSession } from "./session";

export interface LiveCartDeps {
  readSession: McpSession;
  writeSession: McpSession;
}

export interface LiveCartGateway {
  setAbsoluteCartQuantities(input: SetCartProductsInput): Promise<void>;
  readCart(cartId: string): Promise<VerifiedCart>;
}

/**
 * Silpo's severity vocabulary is not part of a validated enum, so an
 * unrecognized value must never become the permissive branch: anything that
 * is not an explicit warning blocks the cart.
 */
export function mapCartValidationSeverity(raw: string): ValidationSeverity {
  return raw.trim().toLowerCase() === "warning" ? "warning" : "error";
}

function toCheckoutLinks(checkout: SilpoCartCheckout | null): CheckoutLinks | null {
  if (!checkout?.webUrl || !checkout.mobileUrl) return null;
  const parsed = CheckoutLinksSchema.safeParse({
    web: checkout.webUrl,
    mobile: checkout.mobileUrl,
  });
  return parsed.success ? parsed.data : null;
}

export function createLiveCartGateway(deps: LiveCartDeps): LiveCartGateway {
  const { readSession, writeSession } = deps;

  const readRawCart = (cartId: string) =>
    readSession.callTool("silpo_get_shopping_cart_by_id", { cartId }, ShoppingCartSchema);

  return {
    async setAbsoluteCartQuantities(input: SetCartProductsInput): Promise<void> {
      const parsed = SetCartProductsInputSchema.parse(input);

      // `SetCartProductsInput` carries no branch and the tool requires one.
      // This read is retryable; the write below deliberately is not.
      const cart = await readRawCart(parsed.cartId);

      await writeSession.callTool(
        "silpo_add_or_update_cart_products",
        {
          cartId: parsed.cartId,
          branchId: cart.branchId,
          products: parsed.items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
          })),
          addQuantity: false,
        },
        AcknowledgedWriteSchema,
      );
    },

    async readCart(cartId: string): Promise<VerifiedCart> {
      const cart = await readRawCart(nonEmptyString.parse(cartId));

      const validations = cart.validations.map((validation) =>
        CartValidationSchema.parse({
          severity: mapCartValidationSeverity(validation.severity),
          code: validation.code,
          // The domain contract requires a non-empty message; the code is the
          // only safe substitute that carries no external free text.
          message: validation.message.trim() || validation.code,
          productId: validation.productId,
        }),
      );

      const hasError = validations.some((validation) => validation.severity === "error");

      return VerifiedCartSchema.parse({
        cartId: cart.id,
        status: hasError ? "blocked" : "verified",
        // A zero-quantity line is valid for Silpo and meaningless here.
        items: cart.products
          .filter((line) => line.quantity > 0)
          .map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            unitPrice: line.specialPrice ?? line.price,
            available: line.available,
          })),
        total: cart.total,
        validations,
        checkoutLinks: hasError ? null : toCheckoutLinks(cart.checkout),
      });
    },
  };
}
