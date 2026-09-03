import { describe, expect, it, vi } from "vitest";
import {
  NormalizedReceiptSchema,
  type NormalizedReceipt,
} from "@/features/shared/contracts";
import * as scoring from "./score";
import {
  runRollingBacktest,
  BacktestReportSchema,
  type BacktestOptions,
} from "./backtest";

const EPOCH = Date.parse("2026-01-01T00:00:00.000Z");
const DAY = 86_400_000;
const at = (day: number) => new Date(EPOCH + day * DAY).toISOString();

const mockFeatures = {
  weightedPurchaseCount: 3,
  medianIntervalDays: 7,
  intervalMadDays: 0,
  daysSinceLastPurchase: 7,
  activeCityShare: 1,
  dueScore: 1,
  repeatScore: 0.6,
  stabilityScore: 1,
};

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

describe("B6-01 explicit evaluation context and input validation", () => {
  it("accepts an empty receipt list with a valid city", () => {
    const report = runRollingBacktest([], { activeCity: "Київ" });
    expect(report.windows).toEqual([]);
    expect(report.inputReceiptCount).toBe(0);
    expect(report.evaluatedReceiptCount).toBe(0);
    expect(report.skippedReceiptCount).toBe(0);
    expect(report.exactSkuWindowCount).toBe(0);
    expect(BacktestReportSchema.parse(report)).toEqual(report);
  });

  it("rejects missing or invalid options", () => {
    expect(() =>
      runRollingBacktest([], null as unknown as BacktestOptions),
    ).toThrow();
    expect(() =>
      runRollingBacktest([], undefined as unknown as BacktestOptions),
    ).toThrow();
    expect(() =>
      runRollingBacktest([], {} as unknown as BacktestOptions),
    ).toThrow();
    expect(() => runRollingBacktest([], { activeCity: "" })).toThrow();
    expect(() => runRollingBacktest([], { activeCity: "   " })).toThrow();
    expect(() =>
      runRollingBacktest([], { activeCity: 123 as unknown as string }),
    ).toThrow();
  });

  it("rejects non-array receipts", () => {
    expect(() =>
      runRollingBacktest(null as unknown as NormalizedReceipt[], {
        activeCity: "Київ",
      }),
    ).toThrow();
    expect(() =>
      runRollingBacktest({} as unknown as NormalizedReceipt[], {
        activeCity: "Київ",
      }),
    ).toThrow();
  });

  it("rejects invalid receipt timestamps", () => {
    const badReceipt = {
      ...receipt(0),
      purchasedAt: "not-a-datetime",
    };
    expect(() =>
      runRollingBacktest([badReceipt as unknown as NormalizedReceipt], {
        activeCity: "Київ",
      }),
    ).toThrow();
  });

  it("rejects duplicate fingerprints", () => {
    const r1 = receipt(0, { externalFingerprint: "duplicate-fp" });
    const r2 = receipt(1, { externalFingerprint: "duplicate-fp" });
    expect(() => runRollingBacktest([r1, r2], { activeCity: "Київ" })).toThrow(
      /duplicate/i,
    );
  });
});

describe("B6-02 causal folds", () => {
  it("B6-02 passes strictly prior history to the production predictor", () => {
    const spy = vi.spyOn(scoring, "inferNeeds"); // Calls through to the real implementation.
    const receipts = [0, 7, 14, 21].map((day) => receipt(day));
    const report = runRollingBacktest(receipts, { activeCity: "Київ" });
    expect(report.windows).toHaveLength(4);
    expect(spy).toHaveBeenCalledTimes(4);
    for (const [input] of spy.mock.calls) {
      const testTime = new Date(input.now).getTime();
      expect(input.activeCity).toBe("Київ");
      expect(
        input.receipts.every((r) => Date.parse(r.purchasedAt) < testTime),
      ).toBe(true);
      expect(
        input.receipts.every(
          (r) => Date.parse(r.purchasedAt) >= testTime - 180 * DAY,
        ),
      ).toBe(true);
    }
    expect(
      report.windows.every(
        (w) => Date.parse(w.trainingCutoff) < Date.parse(w.testDate),
      ),
    ).toBe(true);
  });
});

describe("B6-03 prediction and truth sets, top-K selection", () => {
  it("repeated lines and quantities in target receipt do not multiply hits or actual counts", () => {
    const t0 = receipt(0);
    const t7 = receipt(7);
    const t14 = receipt(14);
    const t21 = receipt(21, {
      items: [
        {
          sourceId: "line-21-a",
          externalProductId: 101,
          productId: null,
          name: "Вода негазована",
          normalizedName: "Вода негазована",
          categoryKey: "water",
          quantity: 2,
          unit: "шт",
          unitPrice: 20,
        },
        {
          sourceId: "line-21-b",
          externalProductId: 101,
          productId: null,
          name: "Вода негазована",
          normalizedName: "Вода негазована",
          categoryKey: "water",
          quantity: 5,
          unit: "шт",
          unitPrice: 20,
        },
      ],
    });

    const report = runRollingBacktest([t0, t7, t14, t21], {
      activeCity: "Київ",
    });
    const lastWindow = report.windows[3];
    expect(lastWindow.actualCategoryCount).toBe(1);
    expect(lastWindow.actualExternalProductCount).toBe(1);
    expect(lastWindow.prediction.categoryHits).toBe(1);
    expect(lastWindow.prediction.exactSkuHits).toBe(1);
  });

  it("handles five actual categories and calculates recall correctly", () => {
    const spy = vi.spyOn(scoring, "inferNeeds").mockReturnValue([
      {
        categoryKey: "c1",
        confidence: 0.8,
        confidenceBand: "high",
        typicalQuantity: 1,
        reasonCodes: ["category_repeat"],
        preferredExternalProductIds: [1],
        features: mockFeatures,
      },
      {
        categoryKey: "c2",
        confidence: 0.8,
        confidenceBand: "high",
        typicalQuantity: 1,
        reasonCodes: ["category_repeat"],
        preferredExternalProductIds: [2],
        features: mockFeatures,
      },
      {
        categoryKey: "c3",
        confidence: 0.8,
        confidenceBand: "high",
        typicalQuantity: 1,
        reasonCodes: ["category_repeat"],
        preferredExternalProductIds: [3],
        features: mockFeatures,
      },
    ]);

    const target = receipt(1, {
      items: ["c1", "c2", "c3", "c4", "c5"].map((cat, i) => ({
        sourceId: `line-${i}`,
        externalProductId: i + 1,
        productId: null,
        name: `Product ${i}`,
        normalizedName: `Product ${i}`,
        categoryKey: cat,
        quantity: 1,
        unit: "шт",
        unitPrice: 10,
      })),
    });

    const report = runRollingBacktest([receipt(0), target], {
      activeCity: "Київ",
    });
    spy.mockRestore();

    const w = report.windows[1];
    expect(w.actualCategoryCount).toBe(5);
    expect(w.prediction.categoryHits).toBe(3);
  });

  it("handles null-ID targets: remains category-eligible but excluded from exactSkuWindowCount", () => {
    const noIdReceipt = receipt(0, {
      items: [
        {
          sourceId: "line-no-id",
          externalProductId: null,
          productId: null,
          name: "Товар без коду",
          normalizedName: "Товар без коду",
          categoryKey: "water",
          quantity: 1,
          unit: "шт",
          unitPrice: 10,
        },
      ],
    });

    const report = runRollingBacktest([noIdReceipt], { activeCity: "Київ" });
    expect(report.evaluatedReceiptCount).toBe(1);
    expect(report.exactSkuWindowCount).toBe(0);
    expect(report.windows[0].actualCategoryCount).toBe(1);
    expect(report.windows[0].actualExternalProductCount).toBe(0);
    expect(report.prediction.exactSkuPrecisionAtK).toBeNull();
    expect(report.prediction.exactSkuRecallAtK).toBeNull();
    expect(report.prediction.categoryPrecisionAt3).toBe(0);
    expect(report.prediction.categoryRecallAt3).toBe(0);
  });

  it("skips service-only and unknown-only receipts", () => {
    const serviceReceipt = receipt(0, {
      items: [
        {
          sourceId: "line-pkg",
          externalProductId: 999,
          productId: null,
          name: "Пакет малий",
          normalizedName: "Пакет малий",
          categoryKey: "water",
          quantity: 1,
          unit: "шт",
          unitPrice: 2,
        },
      ],
    });
    const unknownReceipt = receipt(1, {
      items: [
        {
          sourceId: "line-uncat",
          externalProductId: 998,
          productId: null,
          name: "Щось невідоме",
          normalizedName: "Щось невідоме",
          categoryKey: "uncategorized",
          quantity: 1,
          unit: "шт",
          unitPrice: 20,
        },
      ],
    });
    const normalReceipt = receipt(2);

    const report = runRollingBacktest(
      [serviceReceipt, unknownReceipt, normalReceipt],
      { activeCity: "Київ" },
    );
    expect(report.inputReceiptCount).toBe(3);
    expect(report.skippedReceiptCount).toBe(2);
    expect(report.evaluatedReceiptCount).toBe(1);
  });

  it("skips needs without preferred IDs and selects first preferred ID of subsequent needs", () => {
    const spy = vi.spyOn(scoring, "inferNeeds").mockReturnValue([
      {
        categoryKey: "bread",
        confidence: 0.9,
        confidenceBand: "high",
        typicalQuantity: 1,
        reasonCodes: ["category_repeat"],
        preferredExternalProductIds: [],
        features: mockFeatures,
      },
      {
        categoryKey: "water",
        confidence: 0.85,
        confidenceBand: "high",
        typicalQuantity: 1,
        reasonCodes: ["category_repeat"],
        preferredExternalProductIds: [101, 102],
        features: mockFeatures,
      },
    ]);

    const report = runRollingBacktest([receipt(0), receipt(7)], {
      activeCity: "Київ",
    });
    spy.mockRestore();

    const w = report.windows[1];
    expect(w.prediction.externalProductIds).toEqual([101]);
  });

  it("skips duplicate preferred IDs across needs and ignores alternative replacement IDs", () => {
    const spy = vi.spyOn(scoring, "inferNeeds").mockReturnValue([
      {
        categoryKey: "water",
        confidence: 0.9,
        confidenceBand: "high",
        typicalQuantity: 1,
        reasonCodes: ["category_repeat"],
        preferredExternalProductIds: [101, 999, 998],
        features: mockFeatures,
      },
      {
        categoryKey: "soda",
        confidence: 0.85,
        confidenceBand: "high",
        typicalQuantity: 1,
        reasonCodes: ["category_repeat"],
        preferredExternalProductIds: [101],
        features: mockFeatures,
      },
      {
        categoryKey: "juice",
        confidence: 0.8,
        confidenceBand: "high",
        typicalQuantity: 1,
        reasonCodes: ["category_repeat"],
        preferredExternalProductIds: [202],
        features: mockFeatures,
      },
      {
        categoryKey: "tea",
        confidence: 0.75,
        confidenceBand: "high",
        typicalQuantity: 1,
        reasonCodes: ["category_repeat"],
        preferredExternalProductIds: [303],
        features: mockFeatures,
      },
      {
        categoryKey: "coffee",
        confidence: 0.7,
        confidenceBand: "medium",
        typicalQuantity: 1,
        reasonCodes: ["category_repeat"],
        preferredExternalProductIds: [404],
        features: mockFeatures,
      },
    ]);

    const report = runRollingBacktest([receipt(0), receipt(7)], {
      activeCity: "Київ",
    });
    spy.mockRestore();

    const w = report.windows[1];
    expect(w.prediction.externalProductIds).toEqual([101, 202, 303]);
  });
});

describe("B6-04 B6-08 metric aggregation and hand-calculated oracle", () => {
  it("B6-04 B6-08 includes cold starts and uses fixed-K macro metrics", () => {
    const report = runRollingBacktest(
      [0, 7, 14, 21].map((day) => receipt(day)),
      {
        activeCity: "Київ",
      },
    );
    expect(report.evaluatedReceiptCount).toBe(4);
    expect(report.exactSkuWindowCount).toBe(4);
    expect(report.prediction.categoryPrecisionAt3).toBeCloseTo(1 / 12, 10);
    expect(report.prediction.exactSkuPrecisionAtK).toBeCloseTo(1 / 12, 10);
    expect(report.prediction.categoryRecallAt3).toBe(0.25);
    expect(report.prediction.exactSkuRecallAtK).toBe(0.25);
    expect(report.prediction.receiptHitRate).toBe(0.25);
    expect(report.prediction.coverage).toBe(0.25);
    expect(BacktestReportSchema.parse(report)).toEqual(report);
  });

  it("B6-04 distinguishes an empty denominator from no hits", () => {
    const empty = runRollingBacktest([], { activeCity: "Київ" });
    expect(empty.windows).toEqual([]);
    expect(Object.values(empty.prediction)).toEqual(Array(6).fill(null));
    expect(Object.values(empty.baseline)).toEqual(Array(6).fill(null));
    const cold = runRollingBacktest([receipt(0)], { activeCity: "Київ" });
    expect(Object.values(cold.prediction)).toEqual(Array(6).fill(0));
  });

  it("B6-04 aggregates macro-recall (0.6, not micro 2/6) across eligible windows", () => {
    const r1 = receipt(0, {
      items: [
        {
          sourceId: "line-1",
          externalProductId: 101,
          productId: null,
          name: "Вода",
          normalizedName: "Вода",
          categoryKey: "water",
          quantity: 1,
          unit: "шт",
          unitPrice: 10,
        },
      ],
    });
    const r2 = receipt(1, {
      items: ["water", "c2", "c3", "c4", "c5"].map((cat, i) => ({
        sourceId: `line-2-${i}`,
        externalProductId: 100 + i,
        productId: null,
        name: `Item ${cat}`,
        normalizedName: `Item ${cat}`,
        categoryKey: cat,
        quantity: 1,
        unit: "шт",
        unitPrice: 10,
      })),
    });

    const spy = vi.spyOn(scoring, "inferNeeds").mockReturnValue([
      {
        categoryKey: "water",
        confidence: 0.8,
        confidenceBand: "high",
        typicalQuantity: 1,
        reasonCodes: ["category_repeat"],
        preferredExternalProductIds: [101],
        features: mockFeatures,
      },
    ]);

    const report = runRollingBacktest([r1, r2], { activeCity: "Київ" });
    spy.mockRestore();

    expect(report.evaluatedReceiptCount).toBe(2);
    expect(report.prediction.categoryRecallAt3).toBeCloseTo(0.6, 10);
  });
});

describe("B6-05 calibration buckets", () => {
  it("B6-05 calibrates emitted categories and retains empty buckets", () => {
    const report = runRollingBacktest(
      [0, 7, 14, 21].map((day) => receipt(day)),
      {
        activeCity: "Київ",
      },
    );
    expect(report.confidenceBuckets[0]).toEqual({
      confidenceBand: "medium",
      predictionCount: 0,
      meanConfidence: null,
      observedFrequency: null,
    });
    expect(report.confidenceBuckets[1]).toMatchObject({
      confidenceBand: "high",
      predictionCount: 1,
      observedFrequency: 1,
    });
    expect(report.confidenceBuckets[1].meanConfidence).toBeCloseTo(0.86, 10);
  });
});

describe("B6-06 baseline and boundary behavior", () => {
  it("B6-06 matches four-receipt oracle baseline metrics", () => {
    const report = runRollingBacktest(
      [0, 7, 14, 21].map((day) => receipt(day)),
      {
        activeCity: "Київ",
      },
    );
    expect(report.baseline.exactSkuPrecisionAtK).toBeCloseTo(1 / 6, 10);
    expect(report.baseline.exactSkuRecallAtK).toBe(0.5);
    expect(report.baseline.categoryPrecisionAt3).toBeCloseTo(1 / 12, 10);
    expect(report.baseline.categoryRecallAt3).toBe(0.25);
    expect(report.baseline.receiptHitRate).toBe(0.25);
    expect(report.baseline.coverage).toBe(0.25);
  });

  it("B6-06 respects exact 90-day lower boundary and excludes 89.999 days", () => {
    const rBefore = receipt(89.999, {
      sourceIds: ["r-before"],
      purchasedAt: new Date(EPOCH + 89.999 * DAY).toISOString(),
      externalFingerprint: "fp-before",
    });
    const rExact90 = receipt(90, {
      sourceIds: ["r-90"],
      purchasedAt: at(90),
      externalFingerprint: "fp-90",
    });
    const rInside = receipt(97, {
      sourceIds: ["r-97"],
      purchasedAt: at(97),
      externalFingerprint: "fp-97",
    });
    const target = receipt(180, {
      sourceIds: ["r-180"],
      purchasedAt: at(180),
      externalFingerprint: "fp-180",
    });

    const report = runRollingBacktest([rBefore, rExact90, rInside, target], {
      activeCity: "Київ",
    });

    const targetWindow = report.windows.find((w) => w.testDate === at(180))!;
    expect(targetWindow.baselineTrainingReceiptCount).toBe(2);
    expect(targetWindow.baseline.categories).toHaveLength(0);
    expect(targetWindow.baseline.externalProductIds).toEqual([101]);
  });

  it("ranks baseline by weighted frequency and breaks ties deterministically", () => {
    const rKyiv = (
      day: number,
      fp: string,
      items: NormalizedReceipt["items"],
    ) =>
      NormalizedReceiptSchema.parse({
        sourceIds: [`s-${fp}`],
        channel: "offline",
        purchasedAt: at(day),
        city: "Київ",
        total: 50,
        locationWeight: 1,
        externalFingerprint: fp,
        items,
      });
    const rLviv = (
      day: number,
      fp: string,
      items: NormalizedReceipt["items"],
    ) =>
      NormalizedReceiptSchema.parse({
        sourceIds: [`s-${fp}`],
        channel: "offline",
        purchasedAt: at(day),
        city: "Львів",
        total: 50,
        locationWeight: 0.35,
        externalFingerprint: fp,
        items,
      });

    const makeItem = (id: number, cat: string) => ({
      sourceId: `line-${id}-${cat}`,
      externalProductId: id,
      productId: null,
      name: `Name ${id}`,
      normalizedName: `Name ${id}`,
      categoryKey: cat,
      quantity: 1,
      unit: "шт",
      unitPrice: 10,
    });

    const receipts = [
      rKyiv(1, "k1", [makeItem(1, "catC"), makeItem(2, "catA")]),
      rKyiv(2, "k2", [makeItem(1, "catC"), makeItem(2, "catA")]),
      rKyiv(3, "k3", [makeItem(1, "catC"), makeItem(2, "catA")]),
      rLviv(4, "l1", [makeItem(3, "catB")]),
      rLviv(5, "l2", [makeItem(3, "catB")]),
      rLviv(6, "l3", [makeItem(3, "catB")]),
      rLviv(7, "l4", [makeItem(3, "catB")]),
      rKyiv(8, "k-target", [makeItem(1, "catC")]),
    ];

    const report = runRollingBacktest(receipts, { activeCity: "Київ" });
    const targetWin = report.windows[report.windows.length - 1];
    expect(targetWin.baseline.categories.map((c) => c.categoryKey)).toEqual([
      "catA",
      "catC",
      "catB",
    ]);
    expect(targetWin.baseline.externalProductIds).toEqual([1, 2, 3]);
  });
});

describe("B6-02 leakage resistance and temporal invariance", () => {
  it("future receipts do not change predictions or baselines of preexisting windows", () => {
    const initialReceipts = [0, 7, 14, 21].map((day) => receipt(day));
    const initialReport = runRollingBacktest(initialReceipts, {
      activeCity: "Київ",
    });

    const futureReceipts = [
      ...initialReceipts,
      receipt(30, {
        items: [
          {
            sourceId: "line-future-1",
            externalProductId: 999,
            productId: null,
            name: "Майбутній товар",
            normalizedName: "Майбутній товар",
            categoryKey: "future_cat",
            quantity: 1,
            unit: "шт",
            unitPrice: 10,
          },
        ],
      }),
      receipt(37, {
        items: [
          {
            sourceId: "line-future-2",
            externalProductId: 999,
            productId: null,
            name: "Майбутній товар",
            normalizedName: "Майбутній товар",
            categoryKey: "future_cat",
            quantity: 1,
            unit: "шт",
            unitPrice: 10,
          },
        ],
      }),
      receipt(44, {
        items: [
          {
            sourceId: "line-future-3",
            externalProductId: 999,
            productId: null,
            name: "Майбутній товар",
            normalizedName: "Майбутній товар",
            categoryKey: "future_cat",
            quantity: 1,
            unit: "шт",
            unitPrice: 10,
          },
        ],
      }),
    ];

    const extendedReport = runRollingBacktest(futureReceipts, {
      activeCity: "Київ",
    });

    for (let i = 0; i < 4; i++) {
      expect(extendedReport.windows[i].prediction).toEqual(
        initialReport.windows[i].prediction,
      );
      expect(extendedReport.windows[i].baseline).toEqual(
        initialReport.windows[i].baseline,
      );
    }
  });

  it("handles equal-time target receipts without training on each other", () => {
    const r1 = receipt(0, {
      sourceIds: ["r1"],
      externalFingerprint: "fp-a",
    });
    const r2 = receipt(0, {
      sourceIds: ["r2"],
      externalFingerprint: "fp-b",
    });
    const report = runRollingBacktest([r1, r2], { activeCity: "Київ" });
    expect(report.windows).toHaveLength(2);
    expect(report.windows[0].trainingReceiptCount).toBe(0);
    expect(report.windows[1].trainingReceiptCount).toBe(0);
  });

  it("input reordering and timezone-equivalent representations yield identical reports", () => {
    const r0 = receipt(0);
    const r7 = receipt(7);
    const r14 = receipt(14);
    const r21 = receipt(21);

    const normal = runRollingBacktest([r0, r7, r14, r21], {
      activeCity: "Київ",
    });
    const reversed = runRollingBacktest([r21, r14, r7, r0], {
      activeCity: "Київ",
    });
    expect(reversed).toEqual(normal);

    const r0Offset = {
      ...r0,
      purchasedAt: "2026-01-01T02:00:00.000+02:00",
    };
    const reportOffset = runRollingBacktest([r0Offset, r7, r14, r21], {
      activeCity: "Київ",
    });
    expect(reportOffset).toEqual(normal);
  });

  it("does not mutate frozen inputs", () => {
    const frozen = [0, 7, 14, 21].map((day) => {
      const r = receipt(day);
      r.items.forEach((item) => Object.freeze(item));
      Object.freeze(r.items);
      return Object.freeze(r);
    });
    Object.freeze(frozen);

    expect(() =>
      runRollingBacktest(frozen, { activeCity: "Київ" }),
    ).not.toThrow();
  });
});

describe("B6-07 schema consistency and rejection", () => {
  it("rejects mutated reports violating consistency rules", () => {
    const valid = runRollingBacktest(
      [0, 7, 14, 21].map((day) => receipt(day)),
      {
        activeCity: "Київ",
      },
    );

    // 1. Extra raw field
    expect(() =>
      BacktestReportSchema.parse({
        ...valid,
        extraField: "forbidden",
      } as unknown as typeof valid),
    ).toThrow();

    // 2. Count mismatch: inputReceiptCount !== evaluated + skipped
    expect(() =>
      BacktestReportSchema.parse({ ...valid, inputReceiptCount: 99 }),
    ).toThrow(/inputReceiptCount/);

    // 3. Count mismatch: evaluatedReceiptCount !== windows.length
    expect(() =>
      BacktestReportSchema.parse({ ...valid, evaluatedReceiptCount: 99 }),
    ).toThrow(/evaluatedReceiptCount/);

    // 4. Cutoff equal to testDate
    const badCutoff = structuredClone(valid);
    badCutoff.windows[0].trainingCutoff = badCutoff.windows[0].testDate;
    expect(() => BacktestReportSchema.parse(badCutoff)).toThrow(
      /trainingCutoff/,
    );

    // 5. Hits greater than actual count
    const badHits = structuredClone(valid);
    badHits.windows[3].prediction.categoryHits = 5;
    expect(() => BacktestReportSchema.parse(badHits)).toThrow(/categoryHits/);

    // 6. Baseline confidence non-null
    const badBaseline = structuredClone(valid);
    badBaseline.windows[3].baseline.categories[0].confidence = 0.8;
    expect(() => BacktestReportSchema.parse(badBaseline)).toThrow(/confidence/);

    // 7. Model confidence below threshold
    const lowConf = structuredClone(valid);
    lowConf.windows[3].prediction.categories[0].confidence = 0.54;
    expect(() => BacktestReportSchema.parse(lowConf)).toThrow(/confidence/);

    // 8. Bucket prediction count mismatch
    const badBuckets = structuredClone(valid);
    badBuckets.confidenceBuckets[1].predictionCount = 99;
    expect(() => BacktestReportSchema.parse(badBuckets)).toThrow(/bucket/i);

    // 9. Zero support with numeric means
    const zeroWithMean = structuredClone(valid);
    zeroWithMean.confidenceBuckets[0].predictionCount = 0;
    zeroWithMean.confidenceBuckets[0].meanConfidence = 0.7;
    expect(() => BacktestReportSchema.parse(zeroWithMean)).toThrow(
      /Empty bucket/,
    );
  });
});
