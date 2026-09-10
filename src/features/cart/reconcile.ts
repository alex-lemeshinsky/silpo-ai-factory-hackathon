import {
  VerifiedCartSchema,
  type CartValidation,
  type VerifiedCart,
} from "@/features/shared/contracts";

import { QUANTITY_ADJUSTMENT_CODES, type CommitAdjustment } from "./plan";

export interface ReconcileCommitInput {
  targets: Record<string, number>;
  adjustments: CommitAdjustment[];
  readback: VerifiedCart;
}

/** Matches the quantity tolerance used everywhere else in the domain. */
const QUANTITY_TOLERANCE = 1e-9;

/**
 * Decides the terminal outcome of a commit.
 *
 * The gateway cannot make this call: it does not know what was approved, so
 * it can only say `verified` or `blocked`. Only this function sees the
 * persisted targets and the pre-write adjustments, which is what separates a
 * cart that got everything from one that got part of it.
 */
export function reconcileCommit(input: ReconcileCommitInput): VerifiedCart {
  const validations: CartValidation[] = [
    ...input.readback.validations,
    ...input.adjustments.map((adjustment) => ({
      severity: "warning" as const,
      code: adjustment.code,
      message: adjustment.message,
      productId: adjustment.productId,
    })),
  ];

  const hasError = validations.some((validation) => validation.severity === "error");
  const targetIds = Object.keys(input.targets);
  const quantityById = new Map(
    input.readback.items.map((item) => [item.productId, item.quantity]),
  );
  const unmet = targetIds.some((productId) => {
    const quantity = quantityById.get(productId);
    return quantity === undefined || quantity + QUANTITY_TOLERANCE < input.targets[productId];
  });

  // A price change is reported but never hides a checkout: the approval was
  // for a product and a quantity, and the readback carries the real total.
  const quantityAdjusted = input.adjustments.some(
    (adjustment) => QUANTITY_ADJUSTMENT_CODES.has(adjustment.code),
  );

  const status = hasError || targetIds.length === 0
    ? "blocked"
    : unmet || quantityAdjusted
      ? "partially_committed"
      : "verified";

  return VerifiedCartSchema.parse({
    cartId: input.readback.cartId,
    status,
    items: input.readback.items,
    // The server's arithmetic is the authority; recomputing it here would
    // invent a second source of truth for money.
    total: input.readback.total,
    validations,
    checkoutLinks: status === "verified" ? input.readback.checkoutLinks : null,
  });
}
