import { z } from "zod";

import type { DraftItem, ProductCandidate } from "@/features/shared/contracts";

export type CommitAdjustmentCode =
  | "unavailable_product"
  | "stock_capped"
  | "step_adjusted"
  | "price_changed";

export interface CommitAdjustment {
  productId: string;
  code: CommitAdjustmentCode;
  message: string;
}

/**
 * Adjustments that changed how much would be written. Only these may keep a
 * commit out of `verified`: a price change is news the user should see, not a
 * reason to hide a checkout for a cart that got exactly what was approved.
 */
export const QUANTITY_ADJUSTMENT_CODES: ReadonlySet<CommitAdjustmentCode> = new Set([
  "unavailable_product",
  "stock_capped",
  "step_adjusted",
]);

/**
 * Adjustments that only mean something against the baseline that produced the
 * targets. A retry does not recompute targets, so re-deriving these against a
 * cart that may already contain the first write invents warnings that were
 * never true of the persisted target.
 */
export const BASELINE_DEPENDENT_ADJUSTMENT_CODES: ReadonlySet<CommitAdjustmentCode> = new Set([
  "stock_capped",
  "step_adjusted",
]);

/** Validates adjustments read back from the commit record. */
export const CommitAdjustmentSchema = z.object({
  productId: z.string().trim().min(1),
  code: z.enum(["unavailable_product", "stock_capped", "step_adjusted", "price_changed"]),
  message: z.string().trim().min(1),
}).strict();

export interface PlanCommitInput {
  approvedItems: DraftItem[];
  currentQuantities: Record<string, number>;
  refreshed: Record<string, ProductCandidate>;
}

export interface CommitPlan {
  targets: Record<string, number>;
  adjustments: CommitAdjustment[];
}

const UNAVAILABLE_COPY = "Товар зараз недоступний, тому його не додано.";
const STOCK_CAPPED_COPY = "Доступно менше, ніж потрібно: кількість зменшено.";
const STEP_ADJUSTED_COPY = "Кількість вирівняно до кроку пакування.";
const PRICE_CHANGED_COPY = "Ціна змінилася після створення чернетки.";

/** The tolerance the shared contracts already use for step alignment. */
const STEP_TOLERANCE = 1e-9;
/** One kopiyka: below this, a price difference is representation, not news. */
const PRICE_TOLERANCE = 0.01;

const alignedToStep = (quantity: number, step: number) =>
  Math.abs(quantity / step - Math.round(quantity / step)) <= STEP_TOLERANCE;

const floorToStep = (quantity: number, step: number) =>
  Math.floor(quantity / step + STEP_TOLERANCE) * step;

/** Keeps 0.1 + 0.2 from persisting as 0.30000000000000004. */
const roundQuantity = (quantity: number) => Math.round(quantity * 1e6) / 1e6;

const priceChanged = (item: DraftItem, product: ProductCandidate) =>
  Math.abs(product.price - item.price) > PRICE_TOLERANCE ||
  Math.abs((product.specialPrice ?? product.price) - (item.specialPrice ?? item.price)) > PRICE_TOLERANCE;

/**
 * Computes the absolute quantity each approved product should end at.
 *
 * The target is the cart's current quantity plus the approved quantity, so a
 * write with `addQuantity=false` is idempotent: repeating it cannot add the
 * same product twice. Every adjustment is a warning; none of them blocks the
 * write, but any of them forbids a `verified` outcome.
 */
export function planCommit(input: PlanCommitInput): CommitPlan {
  const targets: Record<string, number> = {};
  const adjustments: CommitAdjustment[] = [];

  const exclude = (productId: string) => {
    adjustments.push({ productId, code: "unavailable_product", message: UNAVAILABLE_COPY });
  };

  for (const item of input.approvedItems) {
    const product = input.refreshed[item.productId];
    if (!product || !product.available || product.stock < product.step) {
      exclude(item.productId);
      continue;
    }

    // Collected per item so an exclusion can discard capping noise and report
    // one clear cause instead of three.
    const pending: CommitAdjustment[] = [];

    if (priceChanged(item, product)) {
      pending.push({ productId: item.productId, code: "price_changed", message: PRICE_CHANGED_COPY });
    }

    const current = input.currentQuantities[item.productId] ?? 0;
    let target = current + item.quantity;

    if (target > product.stock) {
      target = product.stock;
      pending.push({ productId: item.productId, code: "stock_capped", message: STOCK_CAPPED_COPY });
    }

    if (!alignedToStep(target, product.step)) {
      target = floorToStep(target, product.step);
      pending.push({ productId: item.productId, code: "step_adjusted", message: STEP_ADJUSTED_COPY });
    }

    if (target < product.step) {
      exclude(item.productId);
      continue;
    }

    // The approval authorizes adding, never removing. When capping or
    // flooring lands at or below what the cart already holds there is nothing
    // to add, so the existing line is left untouched rather than written down
    // to a smaller absolute quantity.
    // Reaching here means a cap or a step floor reduced the target, because
    // `item.quantity` is positive, so `pending` always explains the cause.
    if (target <= current) {
      adjustments.push(...pending);
      continue;
    }

    targets[item.productId] = roundQuantity(target);
    adjustments.push(...pending);
  }

  return { targets, adjustments };
}
