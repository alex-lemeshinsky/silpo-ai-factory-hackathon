import { z } from "zod";

import {
  VerifiedCartSchema,
  type CartContext,
  type DraftItem,
  type ProductCandidate,
  type ProductSearchResult,
  type TimeSlot,
  type VerifiedCart,
} from "@/features/shared/contracts";
import type { DraftRepository } from "@/features/drafts/repository";
import type { SilpoGatewayHandle } from "@/features/silpo/gateway";
import { MissingCartBranchError } from "@/features/silpo/live/cart";
import { McpCallError } from "@/features/silpo/live/session";
import { err, ok, type Result } from "@/lib/result";

import { BASELINE_DEPENDENT_ADJUSTMENT_CODES, planCommit, type CommitAdjustment } from "./plan";
import { PlannedCartCommitSchema, type CartCommitRecord } from "./repository";
import { reconcileCommit } from "./reconcile";
import type { CartCommitRepository } from "./repository";

export interface CommitApprovedDraftInput {
  draftId: string;
  userId: string;
  idempotencyKey: string;
  correlationId: string;
}

export type CartCommitFailureCode =
  | "not_found"
  | "approval_required"
  | "needs_slot"
  | "unauthorized"
  | "cart_incomplete"
  | "commit_uncertain"
  | "unexpected";

export interface CartCommitFailure {
  code: CartCommitFailureCode;
  message: string;
  correlationId: string;
  availableSlots?: TimeSlot[];
}

export interface CommitApprovedDraftDeps {
  drafts: DraftRepository;
  commits: CartCommitRepository;
  openGateway: () => Promise<SilpoGatewayHandle>;
  now?: () => Date;
}

const FAILURE_COPY: Record<CartCommitFailureCode, string> = {
  not_found: "Чернетку не знайдено. Створіть нову.",
  approval_required: "Спочатку підтвердьте чернетку.",
  needs_slot: "Оберіть доступний час доставки.",
  unauthorized: "Не вдалося підтвердити вхід. Увійдіть у «Сільпо» ще раз.",
  cart_incomplete: "Кошик «Сільпо» не готовий: перевірте адресу та магазин доставки.",
  commit_uncertain: "Не вдалося підтвердити запис у кошик. Спробуйте ще раз.",
  unexpected: "Не вдалося оновити кошик. Спробуйте ще раз.",
};

/** The shape `CartCommitRepository.saveResult` persists. */
const StoredCommitResultSchema = z.object({
  status: z.enum(["verified", "partially_committed", "blocked"]),
  data: z.object({ cart: VerifiedCartSchema }),
});

function failure(code: CartCommitFailureCode, correlationId: string) {
  return err<CartCommitFailure>({ code, message: FAILURE_COPY[code], correlationId });
}

/**
 * Matches each approved item to its refreshed catalog entry by product ID
 * only. A same-named product with a different ID is not the approved product,
 * and silently substituting one would write something the user never
 * confirmed.
 *
 * The search is over every returned product rather than the results of the
 * item's own query, because `ProductSearchResult.query` is the term the server
 * echoes back. Joining on that text would make the whole commit depend on
 * Silpo not normalizing it, and a trimmed or case-folded echo would exclude
 * every line at once.
 */
function indexRefreshed(
  items: DraftItem[],
  searches: ProductSearchResult[],
): Record<string, ProductCandidate> {
  const byProductId = new Map<string, ProductCandidate>();
  for (const result of searches) {
    for (const candidate of result.products) {
      if (!byProductId.has(candidate.productId)) {
        byProductId.set(candidate.productId, candidate);
      }
    }
  }

  const refreshed: Record<string, ProductCandidate> = {};
  for (const item of items) {
    const match = byProductId.get(item.productId);
    if (match) {
      refreshed[item.productId] = match;
    }
  }
  return refreshed;
}

/**
 * Keeps only the adjustments a retry is entitled to report.
 *
 * A retry writes the persisted targets, so it must not re-derive quantities
 * from a cart that may already contain the first write. Availability and price
 * are independent of that baseline and stay; a re-computed cap or step
 * alignment would be a warning that was never true of the persisted target.
 */
function retryReportableAdjustments(adjustments: CommitAdjustment[]): CommitAdjustment[] {
  return adjustments.filter(
    (adjustment) => !BASELINE_DEPENDENT_ADJUSTMENT_CODES.has(adjustment.code),
  );
}

/**
 * The adjustments that shaped the persisted targets, if the record carries
 * them. A record written before this field existed has none, and the retry
 * falls back to what it can safely re-derive.
 */
function plannedAdjustmentsOf(record: CartCommitRecord): CommitAdjustment[] | null {
  const parsed = PlannedCartCommitSchema.safeParse(record.result);
  return parsed.success ? parsed.data.adjustments : null;
}

/** Union by product and code, keeping the persisted entry when both carry one. */
function mergeAdjustments(
  persisted: CommitAdjustment[],
  fresh: CommitAdjustment[],
): CommitAdjustment[] {
  const seen = new Set(persisted.map((entry) => `${entry.productId}::${entry.code}`));
  return [
    ...persisted,
    ...fresh.filter((entry) => !seen.has(`${entry.productId}::${entry.code}`)),
  ];
}

/**
 * Maps a gateway failure raised by a cart write. Mirrors the classification in
 * `src/features/drafts/service.ts` rather than introducing a second one.
 */
function writeFailureCode(error: unknown): CartCommitFailureCode {
  // The server rejected the call, so nothing was written. Inviting a retry
  // would loop forever on credentials that only reauthorization renews.
  if (error instanceof McpCallError && error.status === 401) return "unauthorized";
  // Raised before the write; every retry would re-read the same cart.
  if (error instanceof MissingCartBranchError) return "cart_incomplete";
  // Never retried here. The record stays `pending`, so the next request with
  // this key reuses the same absolute targets.
  return "commit_uncertain";
}

const currentQuantitiesOf = (cart: VerifiedCart): Record<string, number> =>
  Object.fromEntries(cart.items.map((item) => [item.productId, item.quantity]));

const toTargetItems = (targets: Record<string, number>) =>
  Object.entries(targets).map(([productId, quantity]) => ({ productId, quantity }));

/**
 * The cart is already written by the time this runs. A failure to note the
 * outcome on the draft must never turn a successful commit into an error.
 */
async function recordOutcome(
  deps: CommitApprovedDraftDeps,
  input: CommitApprovedDraftInput,
  status: "verified" | "partially_committed" | "blocked",
): Promise<void> {
  try {
    await deps.drafts.recordCommitOutcome({
      draftId: input.draftId,
      userId: input.userId,
      status,
    });
  } catch {
    // Intentionally swallowed; see the comment above.
  }
}

export async function commitApprovedDraft(
  input: CommitApprovedDraftInput,
  deps: CommitApprovedDraftDeps,
): Promise<Result<VerifiedCart, CartCommitFailure>> {
  const now = deps.now ?? (() => new Date());
  let handle: SilpoGatewayHandle | undefined;

  try {
    const draft = await deps.drafts.get(input.draftId, input.userId);
    if (!draft) return failure("not_found", input.correlationId);

    // The approval record is the only authorization for a cart write.
    const approval = await deps.drafts.getApproval(input.draftId, input.userId);
    if (!approval || approval.idempotencyKey !== input.idempotencyKey) {
      return failure("approval_required", input.correlationId);
    }

    const existing = await deps.commits.get(input.idempotencyKey);
    if (existing && existing.status !== "pending") {
      const stored = StoredCommitResultSchema.safeParse(existing.result);
      const cart = stored.success ? stored.data.data.cart : null;
      return cart ? ok(cart) : failure("unexpected", input.correlationId);
    }

    handle = await deps.openGateway();
    const { gateway } = handle;

    const context = await gateway.loadCartContext();
    if (context.status !== "ready") {
      return err<CartCommitFailure>({
        code: "needs_slot",
        message: FAILURE_COPY.needs_slot,
        correlationId: input.correlationId,
        availableSlots: context.availableSlots,
      });
    }
    const cartContext: CartContext = context.context;

    const before = await gateway.readCart(cartContext.cartId);
    const searches = await gateway.findProducts(
      cartContext,
      draft.items.map((item) => item.name),
    );

    // The refresh runs on every attempt, but only the first one is allowed to
    // decide quantities. On a retry it contributes validations alone, so the
    // reported outcome stays faithful without ever recomputing a target from
    // a cart the first attempt may already have changed.
    const plan = planCommit({
      approvedItems: draft.items,
      currentQuantities: currentQuantitiesOf(before),
      refreshed: indexRefreshed(draft.items, searches),
    });

    let targets: Record<string, number>;
    let adjustments: CommitAdjustment[];
    if (existing) {
      targets = existing.targetQuantities;
      // The persisted plan is what actually shaped these targets. Fresh
      // baseline-independent findings are added on top, so a retry reports the
      // original cap *and* anything that changed since.
      const planned = plannedAdjustmentsOf(existing);
      const fresh = retryReportableAdjustments(plan.adjustments);
      adjustments = planned === null ? fresh : mergeAdjustments(planned, fresh);
    } else if (Object.keys(plan.targets).length === 0) {
      // `cart_commits.target_quantities` rejects an empty map, so there is no
      // record to persist and nothing to write.
      const blocked = reconcileCommit({
        targets: {},
        adjustments: plan.adjustments,
        readback: before,
      });

      await recordOutcome(deps, input, blocked.status);
      return ok(blocked);
    } else {
      const started = await deps.commits.start({
        key: input.idempotencyKey,
        targetQuantities: plan.targets,
        userId: input.userId,
        draftId: input.draftId,
        confirmationTimestamp: now(),
        adjustments: plan.adjustments,
      });
      targets = started.targetQuantities;
      adjustments = plan.adjustments;
    }

    try {
      await gateway.setAbsoluteCartQuantities({
        cartId: cartContext.cartId,
        items: toTargetItems(targets),
        addQuantity: false,
      });
    } catch (error) {
      return failure(writeFailureCode(error), input.correlationId);
    }

    const after = await gateway.readCart(cartContext.cartId);
    const result = reconcileCommit({
      targets,
      adjustments,
      readback: after,
    });

    await deps.commits.saveResult(input.idempotencyKey, {
      status: result.status,
      data: { cart: result },
    });
    await recordOutcome(deps, input, result.status);

    return ok(result);
  } catch (error) {
    // A read that fails on an expired token must say so too, or the user is
    // told to retry something only reauthorization can fix.
    const unauthorized = error instanceof McpCallError && error.status === 401;
    return failure(unauthorized ? "unauthorized" : "unexpected", input.correlationId);
  } finally {
    // A failure to close never masks the commit's own outcome.
    await handle?.close().catch(() => {});
  }
}
