import { describe, expect, it } from "vitest";
import {
  NeedCandidateSchema,
  NormalizedReceiptSchema,
  type NormalizedReceipt,
} from "@/features/shared/contracts";
import {
  buildCategoryHistory,
  DAY_MS,
  extractCategoryFeatures,
  PREDICTION_ALGORITHM_VERSION,
  PREDICTION_CONFIG,
} from "./features";
import { inferNeeds, scoreNeed, toConfidenceBand } from "./score";

const EPOCH = Date.parse("2026-01-01T00:00:00.000Z");
const DAY = 86_400_000;
const at = (day: number) => new Date(EPOCH + day * DAY).toISOString();

function receipt(
  day: number,
  overrides: Partial<NormalizedReceipt> = {},
): NormalizedReceipt {
  return NormalizedReceiptSchema.parse({
    sourceIds: [`synthetic-${day}`],
    channel: "offline",
    purchasedAt: at(day),
    city: "Київ",
    total: 40,
    locationWeight: 1,
    externalFingerprint: `fingerprint-${day}`,
    items: [
      {
        sourceId: `line-${day}`,
        externalProductId: 101,
        productId: null,
        name: "Вода негазована",
        normalizedName: "Вода негазована",
        categoryKey: "water",
        quantity: 2,
        unit: "шт",
        unitPrice: 20,
      },
    ],
    ...overrides,
  });
}

describe("Task 5 — Prediction feature extraction and scoring", () => {
  describe("5.1 & 5.2 — Observations and validation", () => {
    it("P5-02 abstains below three category observations", () => {
      expect(
        inferNeeds({
          receipts: [receipt(0), receipt(7)],
          now: at(21),
          activeCity: "Київ",
        }),
      ).toEqual([]);
    });

    it("P5-01 includes the 180-day boundary and excludes older/future receipts", () => {
      const histories = buildCategoryHistory({
        receipts: [
          receipt(-1 / DAY),
          receipt(0),
          receipt(7),
          receipt(14),
          receipt(181),
        ],
        now: at(180),
        activeCity: "Київ",
      });
      expect(histories[0].observations.map((o) => o.timestamp)).toEqual(
        [0, 7, 14].map((day) => EPOCH + day * DAY),
      );
    });

    it("P5-02 duplicate lines and simultaneous receipts count once", () => {
      const first = receipt(0);
      first.items.push({ ...first.items[0], sourceId: "second-line" });
      const simultaneous = receipt(0, {
        externalFingerprint: "other-fingerprint",
      });
      const histories = buildCategoryHistory({
        receipts: [first, simultaneous, receipt(7)],
        now: at(21),
        activeCity: "Київ",
      });
      expect(histories[0].observations).toHaveLength(2);
      expect(
        inferNeeds({
          receipts: [first, simultaneous, receipt(7)],
          now: at(21),
          activeCity: "Київ",
        }),
      ).toEqual([]);
    });

    it("P5-01 rejects invalid inputs with validation errors", () => {
      // Blank active city
      expect(() =>
        buildCategoryHistory({
          receipts: [receipt(0)],
          now: at(21),
          activeCity: "",
        }),
      ).toThrow();
      expect(() =>
        buildCategoryHistory({
          receipts: [receipt(0)],
          now: at(21),
          activeCity: "   ",
        }),
      ).toThrow();

      // Non-ISO date string for now
      expect(() =>
        buildCategoryHistory({
          receipts: [receipt(0)],
          now: "2026-01-01",
          activeCity: "Київ",
        }),
      ).toThrow();
      expect(() =>
        buildCategoryHistory({
          receipts: [receipt(0)],
          now: "invalid-date",
          activeCity: "Київ",
        }),
      ).toThrow();

      // Invalid Date for now
      expect(() =>
        buildCategoryHistory({
          receipts: [receipt(0)],
          now: new Date("invalid"),
          activeCity: "Київ",
        }),
      ).toThrow();

      // Malformed receipt fields
      expect(() =>
        buildCategoryHistory({
          receipts: [
            {
              ...receipt(0),
              total: -10,
            } as unknown as NormalizedReceipt,
          ],
          now: at(21),
          activeCity: "Київ",
        }),
      ).toThrow();

      // Duplicate externalFingerprint
      expect(() =>
        buildCategoryHistory({
          receipts: [
            receipt(0, { externalFingerprint: "dup-fp" }),
            receipt(7, { externalFingerprint: "dup-fp" }),
          ],
          now: at(21),
          activeCity: "Київ",
        }),
      ).toThrow();
    });

    it("P5-01 distinguishes invalid inputs from valid empty input", () => {
      expect(
        buildCategoryHistory({
          receipts: [],
          now: at(21),
          activeCity: "Київ",
        }),
      ).toEqual([]);
      expect(
        inferNeeds({
          receipts: [],
          now: at(21),
          activeCity: "Київ",
        }),
      ).toEqual([]);
    });

    it("P5-01 accepts Date object as now", () => {
      const histories = buildCategoryHistory({
        receipts: [receipt(0), receipt(7)],
        now: new Date(EPOCH + 21 * DAY),
        activeCity: "Київ",
      });
      expect(histories[0].observations).toHaveLength(2);
    });

    it("P5-01 coalesces equal instants with different timezone offsets", () => {
      const utcReceipt = receipt(0, {
        purchasedAt: "2026-01-01T00:00:00.000Z",
        externalFingerprint: "fp-utc",
      });
      const offsetReceipt = receipt(0, {
        purchasedAt: "2026-01-01T02:00:00.000+02:00",
        externalFingerprint: "fp-offset",
      });
      const histories = buildCategoryHistory({
        receipts: [utcReceipt, offsetReceipt],
        now: at(21),
        activeCity: "Київ",
      });
      expect(histories[0].observations).toHaveLength(1);
    });

    it("P5-01 preserves immutability and order independence", () => {
      const r0 = Object.freeze(receipt(0));
      const r7 = Object.freeze(receipt(7));
      const r14 = Object.freeze(receipt(14));
      const inputForward = Object.freeze([r0, r7, r14]);
      const inputReversed = Object.freeze([r14, r7, r0]);

      const historyFwd = buildCategoryHistory({
        receipts: inputForward,
        now: at(21),
        activeCity: "Київ",
      });
      const historyRev = buildCategoryHistory({
        receipts: inputReversed,
        now: at(21),
        activeCity: "Київ",
      });
      expect(historyFwd).toEqual(historyRev);
    });

    it("P5-02 excludes service rows even if categorized under grocery category", () => {
      const serviceReceipt = receipt(0, {
        items: [
          {
            sourceId: "service-line",
            externalProductId: 999,
            productId: null,
            name: "Пакет великий",
            normalizedName: "Пакет великий",
            categoryKey: "water",
            quantity: 1,
            unit: "шт",
            unitPrice: 3,
          },
        ],
      });
      const histories = buildCategoryHistory({
        receipts: [serviceReceipt],
        now: at(21),
        activeCity: "Київ",
      });
      expect(histories).toEqual([]);
    });

    it("P5-02 excludes uncategorized items", () => {
      const uncatReceipt = receipt(0, {
        items: [
          {
            sourceId: "uncat-line",
            externalProductId: 555,
            productId: null,
            name: "Дивний товар",
            normalizedName: "Дивний товар",
            categoryKey: "uncategorized",
            quantity: 1,
            unit: "шт",
            unitPrice: 10,
          },
        ],
      });
      const histories = buildCategoryHistory({
        receipts: [uncatReceipt],
        now: at(21),
        activeCity: "Київ",
      });
      expect(histories).toEqual([]);
    });

    it("P5-02 handles null externalProductId and externalProductId === 0 correctly", () => {
      const nullIdReceipt = receipt(0, {
        items: [
          {
            sourceId: "null-id-line",
            externalProductId: null,
            productId: null,
            name: "Вода без id",
            normalizedName: "Вода без id",
            categoryKey: "water",
            quantity: 1,
            unit: "шт",
            unitPrice: 15,
          },
        ],
      });
      const zeroIdReceipt = receipt(7, {
        items: [
          {
            sourceId: "zero-id-line",
            externalProductId: 0,
            productId: null,
            name: "Вода з id 0",
            normalizedName: "Вода з id 0",
            categoryKey: "water",
            quantity: 1,
            unit: "шт",
            unitPrice: 15,
          },
        ],
      });
      const histories = buildCategoryHistory({
        receipts: [nullIdReceipt, zeroIdReceipt],
        now: at(21),
        activeCity: "Київ",
      });
      expect(histories[0].observations).toHaveLength(2);
      const itemsDay0 = histories[0].observations[0].items;
      expect(itemsDay0[0].item.externalProductId).toBeNull();
      const itemsDay7 = histories[0].observations[1].items;
      expect(itemsDay7[0].item.externalProductId).toBe(0);
    });
  });

  describe("5.3 — Extract robust features, familiar IDs, and quantities", () => {
    it("P5-03 P5-07 computes the weekly active-city feature oracle", () => {
      const [evidence] = extractCategoryFeatures({
        receipts: [receipt(0), receipt(7), receipt(14)],
        now: at(21),
        activeCity: "Київ",
      });
      expect(evidence.features).toEqual({
        weightedPurchaseCount: 3,
        medianIntervalDays: 7,
        intervalMadDays: 0,
        daysSinceLastPurchase: 7,
        activeCityShare: 1,
        dueScore: 1,
        repeatScore: 0.6,
        stabilityScore: 1,
      });
      expect(evidence.typicalQuantity).toBe(2);
      expect(evidence.preferredExternalProductIds).toEqual([101]);
    });

    it("P5-03 uses even medians and MAD", () => {
      const [evidence] = extractCategoryFeatures({
        receipts: [0, 2, 6, 14, 24].map((day) => receipt(day)),
        now: at(30),
        activeCity: "Київ",
      });
      expect(evidence.features.medianIntervalDays).toBe(6);
      expect(evidence.features.intervalMadDays).toBe(3);
      expect(evidence.features.stabilityScore).toBe(0.5);
    });

    it("P5-03 handles other-city receipts by recalculating weights", () => {
      const receiptsOtherCity = [0, 7, 14].map((day) =>
        receipt(day, {
          city: "Львів",
          locationWeight: 1, // deliberately 1 in receipt
        }),
      );
      const [evidence] = extractCategoryFeatures({
        receipts: receiptsOtherCity,
        now: at(21),
        activeCity: "Київ",
      });
      expect(evidence.features.weightedPurchaseCount).toBeCloseTo(1.05, 10);
      expect(evidence.features.activeCityShare).toBe(0);
      expect(evidence.features.repeatScore).toBeCloseTo(0.21, 10);
      // Ensure receipt object was not mutated
      expect(receiptsOtherCity[0].locationWeight).toBe(1);

      // Changing only active city must change features without modifying receipts
      const [evidenceLviv] = extractCategoryFeatures({
        receipts: receiptsOtherCity,
        now: at(21),
        activeCity: "Львів",
      });
      expect(evidenceLviv.features.weightedPurchaseCount).toBe(3);
      expect(evidenceLviv.features.activeCityShare).toBe(1);
      expect(evidenceLviv.features.repeatScore).toBe(0.6);
    });

    it("P5-03 normalizes city whitespace and case, and handles null city", () => {
      const mixedCityReceipts = [
        receipt(0, { city: "  київ  " }),
        receipt(7, { city: "КИЇВ" }),
        receipt(14, { city: null }),
      ];
      const [evidence] = extractCategoryFeatures({
        receipts: mixedCityReceipts,
        now: at(21),
        activeCity: "Київ",
      });
      // 2 active (weight 1.0) + 1 null (weight 0.35) = 2.35
      expect(evidence.features.weightedPurchaseCount).toBeCloseTo(2.35, 10);
      expect(evidence.features.activeCityShare).toBeCloseTo(2 / 3, 10);
    });

    it("P5-03 retains remote SKU weight at shared timestamp even if category observation has active weight", () => {
      // Day 0: Kyiv (SKU 101, weight 1.0) and Lviv (SKU 102, weight 0.35)
      const r0Kyiv = receipt(0, {
        items: [
          {
            sourceId: "line-0-kyiv",
            externalProductId: 101,
            productId: null,
            name: "Вода 101",
            normalizedName: "Вода 101",
            categoryKey: "water",
            quantity: 1,
            unit: "шт",
            unitPrice: 10,
          },
        ],
      });
      const r0Lviv = receipt(0, {
        city: "Львів",
        externalFingerprint: "fp-r0-lviv",
        items: [
          {
            sourceId: "line-0-lviv",
            externalProductId: 102,
            productId: null,
            name: "Вода 102",
            normalizedName: "Вода 102",
            categoryKey: "water",
            quantity: 1,
            unit: "шт",
            unitPrice: 12,
          },
        ],
      });
      // Day 7: Kyiv (SKU 101) and Lviv (SKU 102)
      const r7Kyiv = receipt(7, {
        items: [
          {
            sourceId: "line-7-kyiv",
            externalProductId: 101,
            productId: null,
            name: "Вода 101",
            normalizedName: "Вода 101",
            categoryKey: "water",
            quantity: 1,
            unit: "шт",
            unitPrice: 10,
          },
        ],
      });
      const r7Lviv = receipt(7, {
        city: "Львів",
        externalFingerprint: "fp-r7-lviv",
        items: [
          {
            sourceId: "line-7-lviv",
            externalProductId: 102,
            productId: null,
            name: "Вода 102",
            normalizedName: "Вода 102",
            categoryKey: "water",
            quantity: 1,
            unit: "шт",
            unitPrice: 12,
          },
        ],
      });
      // Day 14: Kyiv (SKU 101)
      const r14Kyiv = receipt(14, {
        items: [
          {
            sourceId: "line-14-kyiv",
            externalProductId: 101,
            productId: null,
            name: "Вода 101",
            normalizedName: "Вода 101",
            categoryKey: "water",
            quantity: 1,
            unit: "шт",
            unitPrice: 10,
          },
        ],
      });

      const [evidence] = extractCategoryFeatures({
        receipts: [r0Kyiv, r0Lviv, r7Kyiv, r7Lviv, r14Kyiv],
        now: at(21),
        activeCity: "Київ",
      });
      // SKU 101 has weighted count: 1 + 1 + 1 = 3.0
      // SKU 102 has weighted count: 0.35 + 0.35 = 0.70
      // Order: [101, 102]
      expect(evidence.preferredExternalProductIds).toEqual([101, 102]);
    });

    it("P5-04 filters SKUs with fewer than two observations and orders ties by recency then numeric ID", () => {
      // Category water with 3 timestamps (days 0, 7, 14)
      // SKU 1: days 0, 7 (2 obs)
      // SKU 2: day 14 (1 obs) -> omitted
      // null ID: days 0, 7, 14 -> omitted
      // SKU 0: days 0, 7 (2 obs) -> retained
      const r0 = receipt(0, {
        items: [
          {
            sourceId: "r0-s1",
            externalProductId: 1,
            productId: null,
            name: "SKU 1",
            normalizedName: "SKU 1",
            categoryKey: "water",
            quantity: 1,
            unit: "шт",
            unitPrice: 10,
          },
          {
            sourceId: "r0-s0",
            externalProductId: 0,
            productId: null,
            name: "SKU 0",
            normalizedName: "SKU 0",
            categoryKey: "water",
            quantity: 1,
            unit: "шт",
            unitPrice: 10,
          },
          {
            sourceId: "r0-null",
            externalProductId: null,
            productId: null,
            name: "SKU null",
            normalizedName: "SKU null",
            categoryKey: "water",
            quantity: 1,
            unit: "шт",
            unitPrice: 10,
          },
        ],
      });
      const r7 = receipt(7, {
        items: [
          {
            sourceId: "r7-s1",
            externalProductId: 1,
            productId: null,
            name: "SKU 1",
            normalizedName: "SKU 1",
            categoryKey: "water",
            quantity: 1,
            unit: "шт",
            unitPrice: 10,
          },
          {
            sourceId: "r7-s0",
            externalProductId: 0,
            productId: null,
            name: "SKU 0",
            normalizedName: "SKU 0",
            categoryKey: "water",
            quantity: 1,
            unit: "шт",
            unitPrice: 10,
          },
        ],
      });
      const r14 = receipt(14, {
        items: [
          {
            sourceId: "r14-s2",
            externalProductId: 2,
            productId: null,
            name: "SKU 2",
            normalizedName: "SKU 2",
            categoryKey: "water",
            quantity: 1,
            unit: "шт",
            unitPrice: 10,
          },
        ],
      });

      const [evidence] = extractCategoryFeatures({
        receipts: [r0, r7, r14],
        now: at(21),
        activeCity: "Київ",
      });
      // SKU 0 and SKU 1 both have 2 observations (days 0, 7), same weight (2.0), same last timestamp (day 7).
      // Numeric ID tie-break: 0 before 1!
      // SKU 2 has 1 obs -> omitted. null is omitted.
      expect(evidence.preferredExternalProductIds).toEqual([0, 1]);
    });

    it("P5-04 orders equal weighted counts by recency then numeric ID", () => {
      // SKU 200: days 0, 7 (last timestamp day 7)
      // SKU 100: days 0, 14 (last timestamp day 14)
      const r0 = receipt(0, {
        items: [
          {
            sourceId: "r0-200",
            externalProductId: 200,
            productId: null,
            name: "SKU 200",
            normalizedName: "SKU 200",
            categoryKey: "water",
            quantity: 1,
            unit: "шт",
            unitPrice: 10,
          },
          {
            sourceId: "r0-100",
            externalProductId: 100,
            productId: null,
            name: "SKU 100",
            normalizedName: "SKU 100",
            categoryKey: "water",
            quantity: 1,
            unit: "шт",
            unitPrice: 10,
          },
        ],
      });
      const r7 = receipt(7, {
        items: [
          {
            sourceId: "r7-200",
            externalProductId: 200,
            productId: null,
            name: "SKU 200",
            normalizedName: "SKU 200",
            categoryKey: "water",
            quantity: 1,
            unit: "шт",
            unitPrice: 10,
          },
        ],
      });
      const r14 = receipt(14, {
        items: [
          {
            sourceId: "r14-100",
            externalProductId: 100,
            productId: null,
            name: "SKU 100",
            normalizedName: "SKU 100",
            categoryKey: "water",
            quantity: 1,
            unit: "шт",
            unitPrice: 10,
          },
        ],
      });
      const [evidence] = extractCategoryFeatures({
        receipts: [r0, r7, r14],
        now: at(21),
        activeCity: "Київ",
      });
      // Both have weighted count 2, but SKU 100 last purchased at day 14 > day 7
      expect(evidence.preferredExternalProductIds).toEqual([100, 200]);
    });

    it("P5-04 sums multiple line quantities per timestamp and preserves fractional quantity medians", () => {
      // Day 0: SKU 101 in two lines: qty 1.5 + qty 2.0 = 3.5
      // Day 7: SKU 101 in one line: qty 4.5
      // Day 14: other item to have 3 category observations
      const r0 = receipt(0, {
        items: [
          {
            sourceId: "r0-l1",
            externalProductId: 101,
            productId: null,
            name: "Вода 1",
            normalizedName: "Вода 1",
            categoryKey: "water",
            quantity: 1.5,
            unit: "л",
            unitPrice: 10,
          },
          {
            sourceId: "r0-l2",
            externalProductId: 101,
            productId: null,
            name: "Вода 1",
            normalizedName: "Вода 1",
            categoryKey: "water",
            quantity: 2.0,
            unit: "л",
            unitPrice: 10,
          },
        ],
      });
      const r7 = receipt(7, {
        items: [
          {
            sourceId: "r7-l1",
            externalProductId: 101,
            productId: null,
            name: "Вода 1",
            normalizedName: "Вода 1",
            categoryKey: "water",
            quantity: 4.5,
            unit: "л",
            unitPrice: 10,
          },
        ],
      });
      const r14 = receipt(14, {
        items: [
          {
            sourceId: "r14-other",
            externalProductId: 999,
            productId: null,
            name: "Вода інша",
            normalizedName: "Вода інша",
            categoryKey: "water",
            quantity: 1,
            unit: "л",
            unitPrice: 10,
          },
        ],
      });

      const [evidence] = extractCategoryFeatures({
        receipts: [r0, r7, r14],
        now: at(21),
        activeCity: "Київ",
      });
      // Preferred SKU is 101 (2 obs: at day 0 sum=3.5, at day 7 sum=4.5).
      // Median of [3.5, 4.5] = 4.0.
      expect(evidence.typicalQuantity).toBe(4.0);
      expect(evidence.quantityUncertain).toBe(false);
    });

    it("P5-04 consistent familiar-SKU unit wins even if category has other units", () => {
      // Preferred SKU 101 has unit "шт" consistently
      // Another SKU has unit "кг"
      const r0 = receipt(0, {
        items: [
          {
            sourceId: "r0-101",
            externalProductId: 101,
            productId: null,
            name: "Вода 101",
            normalizedName: "Вода 101",
            categoryKey: "water",
            quantity: 2,
            unit: "шт",
            unitPrice: 10,
          },
        ],
      });
      const r7 = receipt(7, {
        items: [
          {
            sourceId: "r7-101",
            externalProductId: 101,
            productId: null,
            name: "Вода 101",
            normalizedName: "Вода 101",
            categoryKey: "water",
            quantity: 2,
            unit: "шт",
            unitPrice: 10,
          },
          {
            sourceId: "r7-kg",
            externalProductId: 888,
            productId: null,
            name: "Вода на розлив",
            normalizedName: "Вода на розлив",
            categoryKey: "water",
            quantity: 5,
            unit: "кг",
            unitPrice: 5,
          },
        ],
      });
      const r14 = receipt(14, {
        items: [
          {
            sourceId: "r14-101",
            externalProductId: 101,
            productId: null,
            name: "Вода 101",
            normalizedName: "Вода 101",
            categoryKey: "water",
            quantity: 2,
            unit: "шт",
            unitPrice: 10,
          },
        ],
      });
      const [evidence] = extractCategoryFeatures({
        receipts: [r0, r7, r14],
        now: at(21),
        activeCity: "Київ",
      });
      expect(evidence.typicalQuantity).toBe(2);
      expect(evidence.quantityUncertain).toBe(false);
    });

    it("P5-04 mixed/null units with no compatible source return 1 and quantityUncertain: true", () => {
      // No preferred SKU (all different SKUs with 1 observation)
      // Different units: "шт", "кг", null
      const r0 = receipt(0, {
        items: [
          {
            sourceId: "r0-1",
            externalProductId: 1,
            productId: null,
            name: "Товар 1",
            normalizedName: "Товар 1",
            categoryKey: "water",
            quantity: 3,
            unit: "шт",
            unitPrice: 10,
          },
        ],
      });
      const r7 = receipt(7, {
        items: [
          {
            sourceId: "r7-2",
            externalProductId: 2,
            productId: null,
            name: "Товар 2",
            normalizedName: "Товар 2",
            categoryKey: "water",
            quantity: 5,
            unit: "кг",
            unitPrice: 10,
          },
        ],
      });
      const r14 = receipt(14, {
        items: [
          {
            sourceId: "r14-3",
            externalProductId: 3,
            productId: null,
            name: "Товар 3",
            normalizedName: "Товар 3",
            categoryKey: "water",
            quantity: 2,
            unit: null,
            unitPrice: 10,
          },
        ],
      });
      const [evidence] = extractCategoryFeatures({
        receipts: [r0, r7, r14],
        now: at(21),
        activeCity: "Київ",
      });
      expect(evidence.preferredExternalProductIds).toEqual([]);
      expect(evidence.typicalQuantity).toBe(1);
      expect(evidence.quantityUncertain).toBe(true);
    });
  });

  describe("5.4 — Score, explain, and return stable candidates", () => {
    it("asserts PREDICTION_ALGORITHM_VERSION constant and PREDICTION_CONFIG", () => {
      expect(PREDICTION_ALGORITHM_VERSION).toBe("prediction-v1");
      expect(DAY_MS).toBe(86_400_000);
      expect(PREDICTION_CONFIG.historyWindowDays).toBe(180);
      expect(PREDICTION_CONFIG.minCategoryObservations).toBe(3);
      expect(PREDICTION_CONFIG.minSkuObservations).toBe(2);
      expect(PREDICTION_CONFIG.activeCityWeight).toBe(1);
      expect(PREDICTION_CONFIG.otherCityWeight).toBe(0.35);
      expect(PREDICTION_CONFIG.repeatSaturation).toBe(5);
      expect(PREDICTION_CONFIG.dueWeight).toBe(0.4);
      expect(PREDICTION_CONFIG.repeatWeight).toBe(0.35);
      expect(PREDICTION_CONFIG.stabilityWeight).toBe(0.25);
      expect(PREDICTION_CONFIG.minimumConfidence).toBe(0.55);
      expect(PREDICTION_CONFIG.highConfidence).toBe(0.75);
    });

    it("P5-05 uses the agreed confidence weights", () => {
      expect(scoreNeed({ due: 1, repeat: 0.5, stability: 0.25 })).toBeCloseTo(
        0.6375,
        10,
      );
      expect(scoreNeed({ due: 2, repeat: -1, stability: 0.5 })).toBeCloseTo(
        0.525,
        10,
      );
    });

    it.each([
      [0, null],
      [0.549999, null],
      [0.55, "medium"],
      [0.749999, "medium"],
      [0.75, "high"],
      [1, "high"],
    ])("P5-05 bands %s as %s", (value, expected) => {
      expect(toConfidenceBand(value as number)).toBe(expected);
    });

    it("P5-05 rejects non-finite components in scoreNeed", () => {
      expect(() =>
        scoreNeed({ due: NaN, repeat: 0.5, stability: 0.5 }),
      ).toThrow();
      expect(() =>
        scoreNeed({ due: 0.5, repeat: Infinity, stability: 0.5 }),
      ).toThrow();
      expect(() =>
        scoreNeed({ due: 0.5, repeat: 0.5, stability: -Infinity }),
      ).toThrow();
    });

    it("P5-05 rejects non-finite or out-of-range confidence in toConfidenceBand", () => {
      expect(() => toConfidenceBand(NaN)).toThrow();
      expect(() => toConfidenceBand(Infinity)).toThrow();
      expect(() => toConfidenceBand(-Infinity)).toThrow();
      expect(() => toConfidenceBand(-0.0001)).toThrow();
      expect(() => toConfidenceBand(1.0001)).toThrow();
    });

    it("P5-06 P5-07 emits explainable schema-valid weekly needs", () => {
      const [need] = inferNeeds({
        receipts: [0, 7, 14].map((day) => receipt(day)),
        now: at(21),
        activeCity: "Київ",
      });
      expect(need.confidence).toBeCloseTo(0.86, 10);
      expect(need.confidenceBand).toBe("high");
      expect(need.reasonCodes).toEqual([
        "category_repeat",
        "cycle_due",
        "stable_cycle",
        "familiar_sku",
      ]);
      expect(NeedCandidateSchema.parse(need)).toEqual(need);
    });

    it("P5-07 abstains at day 14 because score 0.46 is below 0.55", () => {
      const needs = inferNeeds({
        receipts: [0, 7, 14].map((day) => receipt(day)),
        now: at(14),
        activeCity: "Київ",
      });
      expect(needs).toEqual([]);
    });

    it("P5-07 produces medium confidence 0.7235 for other-city receipts", () => {
      const needs = inferNeeds({
        receipts: [0, 7, 14].map((day) => receipt(day, { city: "Львів" })),
        now: at(21),
        activeCity: "Київ",
      });
      expect(needs).toHaveLength(1);
      const need = needs[0];
      expect(need.confidence).toBeCloseTo(0.7235, 10);
      expect(need.confidenceBand).toBe("medium");
      expect(need.reasonCodes).toEqual([
        "category_repeat",
        "cycle_due",
        "stable_cycle",
        "familiar_sku",
        "other_city_history",
      ]);
    });

    it("P5-05 breaks score ties between categories by ascending categoryKey", () => {
      const breadReceipts = [0, 7, 14].map((day) =>
        receipt(day, {
          sourceIds: [`bread-${day}`],
          externalFingerprint: `fp-bread-${day}`,
          items: [
            {
              sourceId: `b-line-${day}`,
              externalProductId: 500,
              productId: null,
              name: "Хліб",
              normalizedName: "Хліб",
              categoryKey: "bread",
              quantity: 1,
              unit: "шт",
              unitPrice: 15,
            },
          ],
        }),
      );
      const waterReceipts = [0, 7, 14].map((day) =>
        receipt(day, {
          sourceIds: [`water-${day}`],
          externalFingerprint: `fp-water-${day}`,
          items: [
            {
              sourceId: `w-line-${day}`,
              externalProductId: 101,
              productId: null,
              name: "Вода",
              normalizedName: "Вода",
              categoryKey: "water",
              quantity: 1,
              unit: "шт",
              unitPrice: 20,
            },
          ],
        }),
      );

      const needs = inferNeeds({
        receipts: [...waterReceipts, ...breadReceipts],
        now: at(21),
        activeCity: "Київ",
      });
      expect(needs).toHaveLength(2);
      expect(needs[0].categoryKey).toBe("bread");
      expect(needs[1].categoryKey).toBe("water");
      expect(needs[0].confidence).toBe(needs[1].confidence);
    });

    it("P5-06 emits all reason codes in exact condition and order", () => {
      const r0 = receipt(0, {
        city: "Львів",
        externalFingerprint: "fp-r0",
        items: [
          {
            sourceId: "l0",
            externalProductId: 1,
            productId: null,
            name: "Товар 1",
            normalizedName: "Товар 1",
            categoryKey: "water",
            quantity: 2,
            unit: "шт",
            unitPrice: 10,
          },
        ],
      });
      const r7 = receipt(7, {
        city: "Львів",
        externalFingerprint: "fp-r7",
        items: [
          {
            sourceId: "l7",
            externalProductId: 2,
            productId: null,
            name: "Товар 2",
            normalizedName: "Товар 2",
            categoryKey: "water",
            quantity: 3,
            unit: "кг",
            unitPrice: 10,
          },
        ],
      });
      const r14 = receipt(14, {
        city: "Київ",
        externalFingerprint: "fp-r14",
        items: [
          {
            sourceId: "l14",
            externalProductId: 3,
            productId: null,
            name: "Товар 3",
            normalizedName: "Товар 3",
            categoryKey: "water",
            quantity: 1,
            unit: null,
            unitPrice: 10,
          },
        ],
      });

      const needs = inferNeeds({
        receipts: [r0, r7, r14],
        now: at(21),
        activeCity: "Київ",
      });
      expect(needs).toHaveLength(1);
      expect(needs[0].reasonCodes).toEqual([
        "category_repeat",
        "cycle_due",
        "stable_cycle",
        "other_city_history",
        "quantity_uncertain",
      ]);
    });

    it("P5-01 produces identical candidates when input receipts or items are reversed", () => {
      const r0 = receipt(0);
      const r7 = receipt(7);
      const r14 = receipt(14);
      const forward = inferNeeds({
        receipts: [r0, r7, r14],
        now: at(21),
        activeCity: "Київ",
      });
      const reversed = inferNeeds({
        receipts: [r14, r7, r0],
        now: at(21),
        activeCity: "Київ",
      });
      expect(forward).toEqual(reversed);
    });
  });
});
