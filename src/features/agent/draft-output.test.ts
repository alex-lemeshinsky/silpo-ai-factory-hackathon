import { expect, it } from "vitest";
import { z } from "zod";

import {
  DraftProposalSchema,
  InvalidProposalError,
  UnknownProductError,
  executableQuantity,
  validateProposal,
  type DraftProposal,
  type DraftProposalItem,
} from "@/features/agent/draft-output";
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

function jsonSchemaText(): string {
  return JSON.stringify(z.toJSONSchema(DraftProposalSchema, { target: "draft-7" }));
}

it("accepts the normative proposal shape", () => {
  const parsed = DraftProposalSchema.parse({
    summary: "Чернетка за вашою історією покупок.",
    items: [
      {
        productId: "p-1",
        externalProductId: 40123,
        quantity: 2,
        reason: "Ви регулярно купуєте цю категорію.",
        alternativeIds: ["p-2"],
      },
    ],
  });

  expect(parsed.items[0].productId).toBe("p-1");
});

it("emits a JSON Schema Google structured output accepts", () => {
  const text = jsonSchemaText();

  for (const forbidden of ["anyOf", "oneOf", "allOf", "patternProperties", '"not"']) {
    expect(text).not.toContain(forbidden);
  }
  expect(text).not.toContain('"additionalProperties":true');
});

it("keeps at most ten items and bounded copy", () => {
  expect(DraftProposalSchema.safeParse({ summary: "s", items: Array(11).fill(null) }).success).toBe(false);
  expect(DraftProposalSchema.safeParse({ summary: "x".repeat(181), items: [] }).success).toBe(false);
});

it("rounds the habitual quantity up to a whole package", () => {
  expect(executableQuantity(need({ typicalQuantity: 1.5 }), candidate({ step: 1 }))).toBe(2);
});

it("leaves an exact multiple of step alone", () => {
  expect(executableQuantity(need({ typicalQuantity: 0.9 }), candidate({ step: 0.3 }))).toBeCloseTo(0.9, 9);
});

it("never proposes less than one whole package", () => {
  expect(executableQuantity(need({ typicalQuantity: 0.4 }), candidate({ step: 0.5 }))).toBe(0.5);
});

it("clamps demand to the stock on hand", () => {
  expect(executableQuantity(need({ typicalQuantity: 20 }), candidate({ step: 2, stock: 5 }))).toBe(4);
});

it("produces a quantity a draft item would accept", () => {
  const product = candidate({ step: 0.3, stock: 3 });
  const quantity = executableQuantity(need({ typicalQuantity: 0.7 }), product);

  expect(Math.abs(quantity / product.step - Math.round(quantity / product.step))).toBeLessThanOrEqual(1e-9);
  expect(quantity).toBeLessThanOrEqual(product.stock);
});

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

function item(overrides: Partial<DraftProposalItem> = {}): DraftProposalItem {
  return {
    productId: "p-1",
    externalProductId: 40123,
    quantity: 1,
    reason: "Ви регулярно купуєте цю категорію.",
    alternativeIds: ["p-2"],
    ...overrides,
  };
}

function proposal(items: DraftProposalItem[]): DraftProposal {
  return DraftProposalSchema.parse({ summary: "Чернетка.", items });
}

it("rejects a product id absent from resolved candidates", () => {
  expect(() => validateProposal(proposal([item({ productId: "p-999" })]), input()))
    .toThrow(/unknown product/);
});

it("rejects an external id that disagrees with the server", () => {
  expect(() => validateProposal(proposal([item({ externalProductId: 999 })]), input()))
    .toThrow(InvalidProposalError);
});

it("rejects an alternative belonging to another need", () => {
  const other = resolved({
    need: need({ categoryKey: "water" }),
    selected: candidate({ productId: "p-3", externalProductId: 40125, slug: "water" }),
    alternatives: [],
  });

  expect(() => validateProposal(proposal([item({ alternativeIds: ["p-3"] })]), input([resolved(), other])))
    .toThrow(/alternative_not_in_need/);
});

it.each(["Ціна лише 45 ₴ сьогодні", "Знижка 20%", "Всього 30 грн"])(
  "rejects a reason stating a price or a discount: %s",
  (reason) => {
    expect(() => validateProposal(proposal([item({ reason })]), input())).toThrow(InvalidProposalError);
  },
);

it("rejects an empty reason", () => {
  expect(() => validateProposal(proposal([item({ reason: "   " })]), input())).toThrow(InvalidProposalError);
});

it("reports every rejection code, not only the first", () => {
  try {
    validateProposal(proposal([item({ productId: "p-999" }), item({ reason: " " })]), input());
    expect.unreachable("validateProposal should have thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(UnknownProductError);
    expect((error as InvalidProposalError).codes).toEqual(["unknown_product", "reason_empty"]);
  }
});

it("replaces the model's quantity with the server's", () => {
  const result = validateProposal(proposal([item({ quantity: 99 })]), input());

  expect(result.proposal.items[0].quantity).toBe(1);
  expect(result.normalizations).toContain("quantity_replaced");
});

it("does not report a replacement when the model already agreed", () => {
  const result = validateProposal(proposal([item({ quantity: 1 })]), input());

  expect(result.normalizations).not.toContain("quantity_replaced");
});

it("drops a repeated product and keeps the first mention", () => {
  const result = validateProposal(proposal([item({ reason: "Перше." }), item({ reason: "Друге." })]), input());

  expect(result.proposal.items).toHaveLength(1);
  expect(result.proposal.items[0].reason).toBe("Перше.");
  expect(result.normalizations).toContain("duplicate_product");
});

it("appends alternatives the model left out, keeping its order for the rest", () => {
  const wide = resolved({
    alternatives: [
      candidate({ productId: "p-2", externalProductId: 40124, slug: "alt-a" }),
      candidate({ productId: "p-3", externalProductId: 40125, slug: "alt-b" }),
    ],
  });
  const result = validateProposal(proposal([item({ alternativeIds: ["p-3"] })]), input([wide]));

  expect(result.proposal.items[0].alternativeIds).toEqual(["p-3", "p-2"]);
  expect(result.normalizations).toContain("alternatives_completed");
});

it("returns validated items in resolver order, not the model's", () => {
  const second = resolved({
    need: need({ categoryKey: "water" }),
    selected: candidate({ productId: "p-9", externalProductId: 40199, slug: "water" }),
    alternatives: [],
  });
  const model = proposal([
    item({ productId: "p-9", externalProductId: 40199, alternativeIds: [] }),
    item(),
  ]);

  const result = validateProposal(model, input([resolved(), second]));

  expect(result.proposal.items.map((entry) => entry.productId)).toEqual(["p-1", "p-9"]);
});

it("returns only the needs the model named", () => {
  const second = resolved({
    need: need({ categoryKey: "water" }),
    selected: candidate({ productId: "p-9", externalProductId: 40199, slug: "water" }),
    alternatives: [],
  });

  const result = validateProposal(proposal([item()]), input([resolved(), second]));

  expect(result.proposal.items).toHaveLength(1);
});

