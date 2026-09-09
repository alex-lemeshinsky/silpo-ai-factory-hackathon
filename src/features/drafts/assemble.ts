import type { DraftProposal } from "@/features/agent/draft-output";
import { PREDICTION_ALGORITHM_VERSION } from "@/features/prediction/features";
import {
  DraftSchema,
  effectiveUnitPrice,
  type DataMode,
  type Draft,
  type DraftItem,
  type ProductCandidate,
  type ResolvedNeed,
} from "@/features/shared/contracts";

/**
 * A proposal item naming a product that never reached the resolver.
 * Unreachable in production — `validateProposal` rejects an unknown id and
 * the fallback builds only from `resolvedNeeds` — so it is thrown rather
 * than skipped: dropping the item would turn an upstream contract break
 * into a quietly shorter shopping list.
 */
export class UnresolvedProposalItemError extends Error {
  constructor(readonly productId: string) {
    super("proposal item has no resolved need");
    this.name = "UnresolvedProposalItemError";
  }
}

export interface AssembleDraftInput {
  id: string;
  mode: DataMode;
  trainingCutoff: string;
  proposal: DraftProposal;
  resolvedNeeds: ResolvedNeed[];
}

/**
 * The model's surviving ranking first, then anything it did not name, in
 * resolver order. `validateProposal` already completed and deduped the
 * list, so the tail is normally empty; it exists so a proposal built
 * before ranking never costs the guest a swap option.
 */
function orderAlternatives(resolved: ResolvedNeed, rankedIds: string[]): ProductCandidate[] {
  const remaining = new Map(resolved.alternatives.map((product) => [product.productId, product]));
  const ordered: ProductCandidate[] = [];
  for (const id of rankedIds) {
    const product = remaining.get(id);
    if (product !== undefined) {
      ordered.push(product);
      remaining.delete(id);
    }
  }
  return [...ordered, ...remaining.values()];
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Field by field from two sources: prose and quantity from the proposal,
 * every purchasable fact from the resolved need. Nothing is spread, so a
 * field added to either side is excluded by default rather than admitted.
 */
export function assembleDraft(input: AssembleDraftInput): Draft {
  const byProductId = new Map(
    input.resolvedNeeds.map((resolved) => [resolved.selected.productId, resolved]),
  );

  const items: DraftItem[] = input.proposal.items.map((item) => {
    const resolved = byProductId.get(item.productId);
    if (resolved === undefined) {
      throw new UnresolvedProposalItemError(item.productId);
    }
    const product = resolved.selected;
    return {
      productId: item.productId,
      externalProductId: item.externalProductId,
      name: product.name,
      imageUrl: product.imageUrl,
      displayRatio: product.displayRatio,
      quantity: item.quantity,
      price: product.price,
      specialPrice: product.specialPrice,
      stock: product.stock,
      step: product.step,
      confidence: resolved.need.confidence,
      confidenceBand: resolved.need.confidenceBand,
      reasonCodes: [...resolved.need.reasonCodes],
      reason: item.reason,
      nutritionStatus: product.nutritionStatus,
      promotions: product.promotions.map((promotion) => ({ ...promotion })),
      alternatives: orderAlternatives(resolved, item.alternativeIds),
    };
  });

  // Computed from the snapshots just written, so `DraftSchema`'s 0.01
  // tolerance holds by construction rather than by luck.
  const total = roundMoney(
    items.reduce((sum, item) => sum + item.quantity * effectiveUnitPrice(item), 0),
  );

  return DraftSchema.parse({
    id: input.id,
    mode: input.mode,
    status: "ready",
    algorithmVersion: PREDICTION_ALGORITHM_VERSION,
    trainingCutoff: input.trainingCutoff,
    summary: input.proposal.summary,
    items,
    total,
    version: 1,
  });
}
