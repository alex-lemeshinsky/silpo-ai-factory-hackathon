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
import { err, ok, type Result } from "@/lib/result";

import { planCommit } from "./plan";
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
 * only. A same-named product with a different ID is not the approved
 * product, and silently substituting one would write something the user
 * never confirmed.
 */
function indexRefreshed(
  items: DraftItem[],
  searches: ProductSearchResult[],
): Record<string, ProductCandidate> {
  const productsByQuery = new Map(searches.map((result) => [result.query, result.products]));
  const refreshed: Record<string, ProductCandidate> = {};
  for (const item of items) {
    const match = productsByQuery
      .get(item.name)
      ?.find((candidate) => candidate.productId === item.productId);
    if (match) {
      refreshed[item.productId] = match;
    }
  }
  return refreshed;
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
    await deps.drafts.recordCommitOutcome?.({
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
    if (existing) {
      targets = existing.targetQuantities;
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
      });
      targets = started.targetQuantities;
    }

    try {
      await gateway.setAbsoluteCartQuantities({
        cartId: cartContext.cartId,
        items: toTargetItems(targets),
        addQuantity: false,
      });
    } catch {
      // Never retried here. The record stays `pending`, so the next request
      // with this key reuses the same absolute targets.
      return failure("commit_uncertain", input.correlationId);
    }

    const after = await gateway.readCart(cartContext.cartId);
    const result = reconcileCommit({
      targets,
      adjustments: plan.adjustments,
      readback: after,
    });

    await deps.commits.saveResult(input.idempotencyKey, {
      status: result.status,
      data: { cart: result },
    });
    await recordOutcome(deps, input, result.status);

    return ok(result);
  } catch {
    return failure("unexpected", input.correlationId);
  } finally {
    // A failure to close never masks the commit's own outcome.
    await handle?.close().catch(() => {});
  }
}
