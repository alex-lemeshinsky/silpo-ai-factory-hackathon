import { expect, it, vi } from "vitest";

import { generateDraftWithModel, type DraftModel, type DraftModelRequest } from "@/features/agent/draft-agent";
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

interface RecordingModel extends DraftModel {
  requests: DraftModelRequest[];
}

/** Replies in order; a thrown entry simulates a provider failure. */
function fakeModel(...replies: unknown[]): RecordingModel {
  const requests: DraftModelRequest[] = [];
  return {
    requests,
    async generateProposal(request) {
      requests.push(request);
      const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
      if (reply instanceof Error) {
        throw reply;
      }
      return reply;
    },
  };
}

function goodReply(overrides: Record<string, unknown> = {}) {
  return {
    summary: "Чернетка за вашою історією покупок.",
    items: [{
      productId: "p-1",
      externalProductId: 40123,
      quantity: 1,
      reason: "Ви регулярно купуєте цю категорію.",
      alternativeIds: ["p-2"],
      ...overrides,
    }],
  };
}

it("accepts a valid proposal on the first attempt", async () => {
  const result = await generateDraftWithModel(fakeModel(goodReply()), input());

  expect(result.source).toBe("model");
  expect(result.attempts).toBe(1);
  expect(result.proposal.items[0].reason).toBe("Ви регулярно купуєте цю категорію.");
});

it("retries once after a schema-invalid reply and reports two attempts", async () => {
  const model = fakeModel({ summary: 5, items: "nope" }, goodReply());

  const result = await generateDraftWithModel(model, input());

  expect(result.source).toBe("model");
  expect(result.attempts).toBe(2);
  expect(model.requests).toHaveLength(2);
});

it("falls back deterministically when the model names an unknown product twice", async () => {
  const model = fakeModel(goodReply({ productId: "p-999" }));

  const result = await generateDraftWithModel(model, input());

  expect(result.source).toBe("fallback");
  expect(result.attempts).toBe(2);
  expect(result.proposal.items[0].productId).toBe("p-1");
});

it("falls back when the provider throws on both attempts", async () => {
  const model = fakeModel(new Error("503 upstream"));

  const result = await generateDraftWithModel(model, input());

  expect(result.source).toBe("fallback");
  expect(result.attempts).toBe(2);
});

it("carries violation codes into the retry prompt and no model text", async () => {
  const model = fakeModel(goodReply({ reason: "Лише 45 ₴ сьогодні" }), goodReply());

  await generateDraftWithModel(model, input());

  expect(model.requests[1].prompt).toContain("reason_contains_price");
  expect(model.requests[1].prompt).not.toContain("45 ₴");
});

it("does not call the model when nothing was resolved", async () => {
  const model = fakeModel(goodReply());

  const result = await generateDraftWithModel(model, input([]));

  expect(model.requests).toHaveLength(0);
  expect(result.attempts).toBe(0);
  expect(result.source).toBe("fallback");
  expect(result.proposal.items).toEqual([]);
});

it("completes a need the model omitted instead of dropping it", async () => {
  const second = resolved({
    need: need({ categoryKey: "water" }),
    selected: candidate({ productId: "p-9", externalProductId: 40199, slug: "water" }),
    alternatives: [],
  });
  const model = fakeModel(goodReply());

  const result = await generateDraftWithModel(model, input([resolved(), second]));

  expect(result.proposal.items.map((entry) => entry.productId)).toEqual(["p-1", "p-9"]);
  expect(result.normalizations).toContain("missing_need");
});

it("orders items by resolver confidence, not by the model's order", async () => {
  const second = resolved({
    need: need({ categoryKey: "water" }),
    selected: candidate({ productId: "p-9", externalProductId: 40199, slug: "water" }),
    alternatives: [],
  });
  const model = fakeModel({
    summary: "Чернетка.",
    items: [
      { productId: "p-9", externalProductId: 40199, quantity: 1, reason: "Вода.", alternativeIds: [] },
      { productId: "p-1", externalProductId: 40123, quantity: 1, reason: "Молоко.", alternativeIds: ["p-2"] },
    ],
  });

  const result = await generateDraftWithModel(model, input([resolved(), second]));

  expect(result.proposal.items.map((entry) => entry.productId)).toEqual(["p-1", "p-9"]);
});

it("never rejects for a model fault", async () => {
  const model: DraftModel = { generateProposal: vi.fn().mockRejectedValue(new Error("boom")) };

  await expect(generateDraftWithModel(model, input())).resolves.toMatchObject({ source: "fallback" });
});
