import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { buildFallbackItem, buildFallbackProposal, REASON_CLAUSES, MAX_REASON_LENGTH } from "@/features/agent/fallback";
import { validateProposal } from "@/features/agent/draft-output";
import {
  NeedCandidateSchema,
  ProductCandidateSchema,
  ResolvedNeedSchema,
  type NeedCandidate,
  type ProductCandidate,
  type ResolvedNeed,
} from "@/features/shared/contracts";

function need(overrides: Partial<NeedCandidate> = {}): NeedCandidate {
  return NeedCandidateSchema.parse({
    categoryKey: "dairy",
    confidence: 0.8,
    confidenceBand: "high",
    typicalQuantity: 1,
    reasonCodes: ["category_repeat"],
    preferredExternalProductIds: [40123],
    features: {
      weightedPurchaseCount: 6,
      medianIntervalDays: 7,
      intervalMadDays: 1,
      daysSinceLastPurchase: 8,
      activeCityShare: 1,
      repeatScore: 0.9,
      dueScore: 1,
      stabilityScore: 0.8,
    },
    ...overrides,
  });
}

function candidate(overrides: Partial<ProductCandidate> = {}): ProductCandidate {
  return ProductCandidateSchema.parse({
    productId: "p-1",
    externalProductId: 40123,
    slug: "moloko-25-900",
    name: "Молоко 2,5% 900 г",
    imageUrl: null,
    price: 45.5,
    specialPrice: null,
    available: true,
    stock: 20,
    step: 1,
    displayRatio: 0.9,
    nutritionStatus: "insufficient",
    nutrition: null,
    promotions: [],
    ...overrides,
  });
}

function resolved(overrides: Partial<ResolvedNeed> = {}): ResolvedNeed {
  return ResolvedNeedSchema.parse({
    need: need(),
    selected: candidate(),
    alternatives: [candidate({ productId: "p-2", externalProductId: 40124, slug: "alt-a" })],
    ...overrides,
  });
}

function input(resolvedNeeds: ResolvedNeed[] = [resolved()]) {
  return {
    mode: "demo" as const,
    resolvedNeeds,
    customerContext: { familySize: 2, restrictionKeys: [], loyaltyBonusAvailable: null },
  };
}

const ALL_CODES = [
  "category_repeat",
  "cycle_due",
  "stable_cycle",
  "familiar_sku",
  "other_city_history",
  "quantity_uncertain",
];

it("covers exactly the reason codes the scorer can emit", () => {
  const scorer = readFileSync(join(process.cwd(), "src/features/prediction/score.ts"), "utf8");
  const emitted = [...scorer.matchAll(/reasonCodes(?:\.push\(|: string\[\] = \[)"([a-z_]+)"/g)]
    .map((match) => match[1]);

  expect(new Set(emitted)).toEqual(new Set(ALL_CODES));
  expect(Object.keys(REASON_CLAUSES).sort()).toEqual([...ALL_CODES].sort());
});

it("writes a reason a draft item would accept", () => {
  const reason = buildFallbackItem(resolved({ need: need({ reasonCodes: ALL_CODES }) })).reason;

  expect(reason.length).toBeGreaterThan(0);
  expect(reason.length).toBeLessThanOrEqual(MAX_REASON_LENGTH);
});

it("never states a price or a percentage", () => {
  const reason = buildFallbackItem(resolved({ need: need({ reasonCodes: ALL_CODES }) })).reason;

  expect(reason).not.toMatch(/₴|%|грн/i);
});

it("uses the server quantity and every resolver alternative", () => {
  const item = buildFallbackItem(resolved({ need: need({ typicalQuantity: 1.5 }) }));

  expect(item.quantity).toBe(2);
  expect(item.alternativeIds).toEqual(["p-2"]);
});

it("explains an empty draft rather than returning nothing", () => {
  const proposal = buildFallbackProposal(input([]));

  expect(proposal.items).toEqual([]);
  expect(proposal.summary.length).toBeGreaterThan(0);
});

it("produces a proposal the post-validator accepts unchanged", () => {
  const built = input();
  const result = validateProposal(buildFallbackProposal(built), built);

  expect(result.proposal.items).toHaveLength(1);
  expect(result.normalizations).toEqual([]);
});

it("falls back to default reason when no reason codes match known clauses", () => {
  const reason = buildFallbackItem(resolved({ need: need({ reasonCodes: ["unknown_code"] }) })).reason;

  expect(reason).toBe("Позиція з вашої історії покупок.");
});

it("orders clauses by the vocabulary's own declaration order", () => {
  const codes = ["quantity_uncertain", "stable_cycle", "cycle_due"];
  const reason = buildFallbackItem(resolved({ need: need({ reasonCodes: codes }) })).reason;

  // The first clause is capitalized in the sentence, so compare lowercased.
  const positionOf = (code: string) => reason.toLowerCase().indexOf(REASON_CLAUSES[code]);
  const vocabularyOrder = Object.keys(REASON_CLAUSES).filter((code) => codes.includes(code));
  const positions = vocabularyOrder.map(positionOf);

  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(reason.startsWith("За вашим звичним циклом")).toBe(true);
});

it("has no second ordering list that could drift from the vocabulary", () => {
  const source = readFileSync(join(process.cwd(), "src/features/agent/fallback.ts"), "utf8");

  expect(source).not.toContain("CLAUSE_ORDER");
});
