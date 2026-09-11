import { and, eq, inArray, isNotNull } from "drizzle-orm";

import type { DbClient } from "@/db/client";
import { cartCommits, draftItems, drafts } from "@/db/schema";
import { StoredCommitResultSchema } from "@/features/cart/repository";

export interface LandedReplacement {
  replacedFromPrice: number;
  effectivePrice: number;
  quantity: number;
}

export interface DecisionTotals {
  decidedItemCount: number;
  keptItemCount: number;
  replacedItemCount: number;
  landedReplacements: LandedReplacement[];
}

export interface DecisionRepository {
  totalsForUser(userId: string): Promise<DecisionTotals>;
}

export const EMPTY_DECISION_TOTALS: DecisionTotals = {
  decidedItemCount: 0,
  keptItemCount: 0,
  replacedItemCount: 0,
  landedReplacements: [],
};

export function createInMemoryDecisionRepository(totals: DecisionTotals): DecisionRepository {
  return {
    async totalsForUser(): Promise<DecisionTotals> {
      return structuredClone(totals);
    },
  };
}

/**
 * Demo-mode product-decision totals for one visitor.
 *
 * A replacement counts toward savings only when it actually reached the
 * cart, which is decided by product-ID membership in the `VerifiedCart`
 * persisted by the commit. That admits `partially_committed` commits, where
 * some lines landed and others did not, instead of discarding them whole.
 *
 * A replaced row whose `replaced_from_price` is null was approved before
 * migration 0005. It counts toward the replacement rate, because the user
 * really did replace it, and never toward savings, because the amount is
 * unknowable and a zero would understate the metric silently.
 */
export function createPostgresDecisionRepository(db: DbClient): DecisionRepository {
  return {
    async totalsForUser(userId: string): Promise<DecisionTotals> {
      const rows = await db
        .select({
          draftId: draftItems.draftId,
          productId: draftItems.productId,
          userDecision: draftItems.userDecision,
          price: draftItems.price,
          specialPrice: draftItems.specialPrice,
          quantity: draftItems.quantity,
          replacedFromPrice: draftItems.replacedFromPrice,
        })
        .from(draftItems)
        .innerJoin(drafts, eq(draftItems.draftId, drafts.id))
        .where(
          and(
            eq(drafts.userId, userId),
            eq(drafts.mode, "demo"),
            isNotNull(draftItems.userDecision),
          ),
        );

      if (rows.length === 0) {
        return structuredClone(EMPTY_DECISION_TOTALS);
      }

      const commitRows = await db
        .select({ draftId: cartCommits.draftId, result: cartCommits.result })
        .from(cartCommits)
        .where(
          and(
            eq(cartCommits.userId, userId),
            inArray(cartCommits.status, ["verified", "partially_committed"]),
          ),
        );

      const landedByDraft = new Map<string, Set<string>>();
      for (const row of commitRows) {
        if (row.draftId === null) continue;
        const parsed = StoredCommitResultSchema.safeParse(row.result);
        if (!parsed.success) continue;
        const productIds = landedByDraft.get(row.draftId) ?? new Set<string>();
        for (const item of parsed.data.data.cart.items) {
          productIds.add(item.productId);
        }
        landedByDraft.set(row.draftId, productIds);
      }

      const totals: DecisionTotals = {
        decidedItemCount: rows.length,
        keptItemCount: 0,
        replacedItemCount: 0,
        landedReplacements: [],
      };

      for (const row of rows) {
        if (row.userDecision === "kept") totals.keptItemCount += 1;
        if (row.userDecision !== "replaced") continue;
        totals.replacedItemCount += 1;

        const effectivePrice = row.specialPrice ?? row.price;
        if (
          row.replacedFromPrice === null ||
          effectivePrice === null ||
          row.quantity === null ||
          row.productId === null ||
          !landedByDraft.get(row.draftId)?.has(row.productId)
        ) {
          continue;
        }
        totals.landedReplacements.push({
          replacedFromPrice: row.replacedFromPrice,
          effectivePrice,
          quantity: row.quantity,
        });
      }

      return totals;
    },
  };
}
