import { describe, expect, it } from "vitest";

import type { DraftProposal } from "@/features/agent/draft-output";
import { DraftSchema, type NeedFeatures, type ProductCandidate, type ResolvedNeed } from "@/features/shared/contracts";

import { assembleDraft, UnresolvedProposalItemError } from "./assemble";

const features: NeedFeatures = {
  weightedPurchaseCount: 4,
  medianIntervalDays: 7,
  intervalMadDays: 1,
  daysSinceLastPurchase: 8,
  activeCityShare: 1,
  repeatScore: 0.8,
  dueScore: 1,
  stabilityScore: 0.9,
};

function product(overrides: Partial<ProductCandidate> = {}): ProductCandidate {
  return {
    productId: "p-1",
    externalProductId: 101,
    slug: "moloko",
    name: "Молоко 2.5%",
    imageUrl: null,
    price: 45.5,
    specialPrice: null,
    available: true,
    stock: 10,
    step: 1,
    displayRatio: 1,
    nutritionStatus: "insufficient",
    nutrition: null,
    promotions: [],
    ...overrides,
  };
}

function resolved(
  selected: ProductCandidate,
  alternatives: ProductCandidate[] = [],
  needOverrides: Partial<ResolvedNeed["need"]> = {},
): ResolvedNeed {
  return {
    need: {
      categoryKey: "dairy",
      confidence: 0.82,
      confidenceBand: "high",
      typicalQuantity: 1,
      reasonCodes: ["category_repeat", "cycle_due"],
      preferredExternalProductIds: [101],
      features,
      ...needOverrides,
    },
    selected,
    alternatives,
  };
}

const BASE = {
  id: "00000000-0000-4000-8000-000000000abc",
  mode: "demo" as const,
  trainingCutoff: "2026-09-08T09:00:00.000Z",
};

describe("assembleDraft", () => {
  it("maps product facts from the resolved need and prose from the proposal", () => {
    const selected = product({ promotions: [{ id: "promo-1", label: "-10%", price: 41 }] });
    const proposal: DraftProposal = {
      summary: "Ваш звичний набір",
      items: [{
        productId: "p-1",
        externalProductId: 101,
        quantity: 2,
        reason: "Купуєте приблизно щотижня",
        alternativeIds: [],
      }],
    };

    const draft = assembleDraft({ ...BASE, proposal, resolvedNeeds: [resolved(selected)] });

    expect(draft.items[0]).toMatchObject({
      productId: "p-1",
      name: "Молоко 2.5%",
      price: 45.5,
      step: 1,
      stock: 10,
      quantity: 2,
      reason: "Купуєте приблизно щотижня",
      confidence: 0.82,
      confidenceBand: "high",
      reasonCodes: ["category_repeat", "cycle_due"],
      nutritionStatus: "insufficient",
      promotions: [{ id: "promo-1", label: "-10%", price: 41 }],
    });
    expect(draft.algorithmVersion).toBe("prediction-v1");
    expect(draft.status).toBe("ready");
    expect(draft.version).toBe(1);
    expect(draft.mode).toBe("demo");
    expect(draft.trainingCutoff).toBe("2026-09-08T09:00:00.000Z");
    expect(DraftSchema.parse(draft)).toEqual(draft);
  });

  it("orders alternatives by the proposal's ranking and appends any it omitted", () => {
    const alternatives = [
      product({ productId: "alt-a", externalProductId: 201, slug: "a" }),
      product({ productId: "alt-b", externalProductId: 202, slug: "b" }),
      product({ productId: "alt-c", externalProductId: 203, slug: "c" }),
    ];
    const proposal: DraftProposal = {
      summary: "Ваш звичний набір",
      items: [{
        productId: "p-1",
        externalProductId: 101,
        quantity: 1,
        reason: "Купуєте приблизно щотижня",
        alternativeIds: ["alt-c", "alt-a"],
      }],
    };

    const draft = assembleDraft({
      ...BASE,
      proposal,
      resolvedNeeds: [resolved(product(), alternatives)],
    });

    expect(draft.items[0].alternatives.map((item) => item.productId)).toEqual(["alt-c", "alt-a", "alt-b"]);
  });

  it("totals the snapshots it wrote, preferring the special price, rounded to two decimals", () => {
    const proposal: DraftProposal = {
      summary: "Ваш звичний набір",
      items: [
        {
          productId: "p-1",
          externalProductId: 101,
          quantity: 3,
          reason: "Купуєте приблизно щотижня",
          alternativeIds: [],
        },
        {
          productId: "p-2",
          externalProductId: 102,
          quantity: 1,
          reason: "Час поповнити запас",
          alternativeIds: [],
        },
      ],
    };

    const draft = assembleDraft({
      ...BASE,
      proposal,
      resolvedNeeds: [
        resolved(product({ price: 10.115, specialPrice: null })),
        resolved(product({ productId: "p-2", externalProductId: 102, slug: "b", price: 49.9, specialPrice: 42.9 })),
      ],
    });

    // 3 × 10.115 = 30.345 → 30.35 after rounding, plus the 42.9 special.
    expect(draft.total).toBe(73.25);
    expect(DraftSchema.parse(draft)).toEqual(draft);
  });

  it("assembles an empty explained draft when nothing resolved", () => {
    const proposal: DraftProposal = {
      summary: "Поки що замало історії покупок, щоб зібрати чернетку.",
      items: [],
    };

    const draft = assembleDraft({ ...BASE, proposal, resolvedNeeds: [] });

    expect(draft.items).toEqual([]);
    expect(draft.total).toBe(0);
    expect(draft.status).toBe("ready");
    expect(draft.summary).toBe("Поки що замало історії покупок, щоб зібрати чернетку.");
  });

  it("throws rather than silently shortening the list for an unknown product id", () => {
    const proposal: DraftProposal = {
      summary: "Ваш звичний набір",
      items: [{
        productId: "ghost",
        externalProductId: 999,
        quantity: 1,
        reason: "Купуєте приблизно щотижня",
        alternativeIds: [],
      }],
    };

    expect(() => assembleDraft({ ...BASE, proposal, resolvedNeeds: [resolved(product())] }))
      .toThrow(UnresolvedProposalItemError);
  });
});
