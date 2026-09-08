import { expect, it } from "vitest";

import {
  buildModelInput,
  buildRetryPrompt,
  buildSystemInstruction,
  buildUserPrompt,
} from "@/features/agent/prompt";
import type { DraftAgentInput } from "@/features/agent/draft-output";
import {
  NeedCandidateSchema,
  ProductCandidateSchema,
  ResolvedNeedSchema,
  type ResolvedNeed,
} from "@/features/shared/contracts";

const POISON = {
  phone: "+380671234567",
  address: "вул. Хрещатик, 22, кв. 5",
  barcode: "9780201379624",
  token: "ya29.a0AfH6SMB-secret-token",
  databaseId: "6f1c0f8e-3f2a-4e0b-9d1a-2c3b4d5e6f70",
};

function resolvedNeed(): ResolvedNeed {
  return ResolvedNeedSchema.parse({
    need: NeedCandidateSchema.parse({
      categoryKey: "dairy",
      confidence: 0.8,
      confidenceBand: "high",
      typicalQuantity: 1.5,
      reasonCodes: ["category_repeat", "cycle_due"],
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
    }),
    selected: ProductCandidateSchema.parse({
      productId: "p-1",
      externalProductId: 40123,
      slug: "moloko-25-900",
      name: "Молоко 2,5% 900 г",
      imageUrl: "https://example.test/p-1.jpg",
      price: 45.5,
      specialPrice: 39.9,
      available: true,
      stock: 20,
      step: 1,
      displayRatio: 0.9,
      nutritionStatus: "insufficient",
      nutrition: null,
      promotions: [{ id: "promo-1", label: "Мінус 20%", price: 39.9 }],
    }),
    alternatives: [],
  });
}

/** Domain objects carrying extra properties, the way a leak would arrive. */
function poisonedInput(): DraftAgentInput {
  const resolved = resolvedNeed();
  return {
    mode: "live",
    resolvedNeeds: [{
      ...resolved,
      selected: { ...resolved.selected, ...POISON },
      need: { ...resolved.need, ...POISON },
    } as ResolvedNeed],
    customerContext: {
      familySize: 3,
      restrictionKeys: ["lactose_free"],
      loyaltyBonusAvailable: 128.5,
      ...POISON,
    } as DraftAgentInput["customerContext"],
  };
}

it("passes no private value into the model input or the prompt", () => {
  const modelInput = buildModelInput(poisonedInput());
  const text = `${JSON.stringify(modelInput)}\n${buildUserPrompt(modelInput)}`;

  for (const value of Object.values(POISON)) {
    expect(text).not.toContain(value);
  }
});

it("projects exactly the approved product fields", () => {
  const modelInput = buildModelInput(poisonedInput());

  expect(Object.keys(modelInput.needs[0].selected).sort()).toEqual([
    "externalProductId",
    "inStock",
    "name",
    "nutritionStatus",
    "price",
    "productId",
    "promotionLabels",
    "specialPrice",
  ]);
});

it("omits loyalty, slug, imageUrl, step, displayRatio and raw stock", () => {
  const text = JSON.stringify(buildModelInput(poisonedInput()));

  for (const forbidden of ["loyaltyBonusAvailable", "slug", "imageUrl", "displayRatio", '"step"', '"stock"', '"features"']) {
    expect(text).not.toContain(forbidden);
  }
  expect(text).not.toContain("promo-1");
});

it("carries the server quantity, not the habit", () => {
  // typicalQuantity 1.5 with step 1 becomes two whole packages.
  expect(buildModelInput(poisonedInput()).needs[0].quantity).toBe(2);
});

it("states the no-invention and insufficient-nutrition rules", () => {
  const system = buildSystemInstruction();

  expect(system).toContain("даних недостатньо");
  expect(system).toMatch(/ціну/i);
  expect(system).toMatch(/структуров/i);
});

it("carries violation codes but no model text into the retry prompt", () => {
  const modelInput = buildModelInput(poisonedInput());
  const retry = buildRetryPrompt(modelInput, ["unknown_product", "reason_contains_price"]);

  expect(retry).toContain("unknown_product");
  expect(retry).toContain("reason_contains_price");
  expect(retry).not.toBe(buildUserPrompt(modelInput));
});
