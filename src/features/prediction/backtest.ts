import { z } from "zod";
import {
  type NormalizedReceipt,
  NormalizedReceiptSchema,
  ConfidenceBandSchema,
} from "@/features/shared/contracts";
import { isServiceItem } from "@/features/purchases/categorize";
import {
  DAY_MS,
  PREDICTION_ALGORITHM_VERSION,
  PREDICTION_CONFIG,
  buildCategoryHistory,
  compareCategoryKeys,
} from "./features";
import { inferNeeds, toConfidenceBand } from "./score";

export const BACKTEST_ALGORITHM_VERSION = PREDICTION_ALGORITHM_VERSION;
export const BACKTEST_EVALUATION_VERSION = "rolling-v2" as const;
export const BACKTEST_BASELINE_VERSION = "frequency-90d-v1" as const;
export const BACKTEST_CATEGORY_K = 3 as const;
export const BACKTEST_EXACT_K = 3 as const;
export const BACKTEST_HISTORY_WINDOW_DAYS = PREDICTION_CONFIG.historyWindowDays;
export const BACKTEST_BASELINE_WINDOW_DAYS = 90 as const;

const finiteZeroToOne = z.number().finite().min(0).max(1);

export const BacktestMetricsSchema = z
  .object({
    exactSkuPrecisionAtK: finiteZeroToOne.nullable(),
    exactSkuRecallAtK: finiteZeroToOne.nullable(),
    categoryPrecisionAt3: finiteZeroToOne.nullable(),
    categoryRecallAt3: finiteZeroToOne.nullable(),
    receiptHitRate: finiteZeroToOne.nullable(),
    coverage: finiteZeroToOne.nullable(),
  })
  .strict();
export type BacktestMetrics = z.infer<typeof BacktestMetricsSchema>;

export const WindowCategoryPredictionSchema = z
  .object({
    categoryKey: z.string().trim().min(1),
    confidence: finiteZeroToOne.nullable(),
    hit: z.boolean(),
  })
  .strict();
export type WindowCategoryPrediction = z.infer<
  typeof WindowCategoryPredictionSchema
>;

export const WindowPredictionSchema = z
  .object({
    categories: z.array(WindowCategoryPredictionSchema).max(3),
    externalProductIds: z.array(z.number().int().nonnegative()).max(3),
    categoryHits: z.number().int().nonnegative(),
    exactSkuHits: z.number().int().nonnegative(),
  })
  .strict();
export type WindowPrediction = z.infer<typeof WindowPredictionSchema>;

export const BacktestWindowSchema = z
  .object({
    testDate: z.string().datetime({ offset: true }),
    trainingCutoff: z.string().datetime({ offset: true }),
    trainingReceiptCount: z.number().int().nonnegative(),
    baselineTrainingReceiptCount: z.number().int().nonnegative(),
    actualCategoryCount: z.number().int().nonnegative(),
    actualExternalProductCount: z.number().int().nonnegative(),
    prediction: WindowPredictionSchema,
    baseline: WindowPredictionSchema,
  })
  .strict();
export type BacktestWindow = z.infer<typeof BacktestWindowSchema>;

export const ConfidenceBucketSchema = z
  .object({
    confidenceBand: ConfidenceBandSchema,
    predictionCount: z.number().int().nonnegative(),
    meanConfidence: finiteZeroToOne.nullable(),
    observedFrequency: finiteZeroToOne.nullable(),
  })
  .strict();
export type ConfidenceBucket = z.infer<typeof ConfidenceBucketSchema>;

export const BacktestReportSchema = z
  .object({
    algorithmVersion: z.literal(BACKTEST_ALGORITHM_VERSION),
    evaluationVersion: z.literal(BACKTEST_EVALUATION_VERSION),
    baselineVersion: z.literal(BACKTEST_BASELINE_VERSION),
    categoryK: z.literal(BACKTEST_CATEGORY_K),
    exactK: z.literal(BACKTEST_EXACT_K),
    historyWindowDays: z.literal(BACKTEST_HISTORY_WINDOW_DAYS),
    baselineWindowDays: z.literal(BACKTEST_BASELINE_WINDOW_DAYS),
    inputReceiptCount: z.number().int().nonnegative(),
    evaluatedReceiptCount: z.number().int().nonnegative(),
    skippedReceiptCount: z.number().int().nonnegative(),
    exactSkuWindowCount: z.number().int().nonnegative(),
    windows: z.array(BacktestWindowSchema),
    prediction: BacktestMetricsSchema,
    baseline: BacktestMetricsSchema,
    confidenceBuckets: z.array(ConfidenceBucketSchema).length(2),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      data.inputReceiptCount !==
      data.evaluatedReceiptCount + data.skippedReceiptCount
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "inputReceiptCount must equal evaluatedReceiptCount + skippedReceiptCount",
        path: ["inputReceiptCount"],
      });
    }

    if (data.evaluatedReceiptCount !== data.windows.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "evaluatedReceiptCount must equal windows.length",
        path: ["evaluatedReceiptCount"],
      });
    }

    const actualExactWindows = data.windows.filter(
      (w) => w.actualExternalProductCount > 0,
    ).length;
    if (data.exactSkuWindowCount !== actualExactWindows) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "exactSkuWindowCount must match count of windows with actualExternalProductCount > 0",
        path: ["exactSkuWindowCount"],
      });
    }

    let totalModelCategoryPredictions = 0;
    const expectedBucketEvidence = {
      medium: { confidences: [] as number[], hits: [] as number[] },
      high: { confidences: [] as number[], hits: [] as number[] },
    };

    for (let i = 0; i < data.windows.length; i++) {
      const w = data.windows[i];
      if (Date.parse(w.trainingCutoff) >= Date.parse(w.testDate)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "trainingCutoff must be strictly before testDate",
          path: ["windows", i, "trainingCutoff"],
        });
      }

      // Prediction categories
      const predCatKeys = new Set<string>();
      for (let c = 0; c < w.prediction.categories.length; c++) {
        const cat = w.prediction.categories[c];
        if (predCatKeys.has(cat.categoryKey)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate prediction categoryKey: ${cat.categoryKey}`,
            path: ["windows", i, "prediction", "categories", c],
          });
        }
        predCatKeys.add(cat.categoryKey);
        if (
          cat.confidence === null ||
          cat.confidence < PREDICTION_CONFIG.minimumConfidence ||
          cat.confidence > 1
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Model category prediction confidence must be in [${PREDICTION_CONFIG.minimumConfidence}, 1]`,
            path: ["windows", i, "prediction", "categories", c, "confidence"],
          });
        } else {
          const band =
            cat.confidence >= PREDICTION_CONFIG.highConfidence
              ? "high"
              : "medium";
          expectedBucketEvidence[band].confidences.push(cat.confidence);
          expectedBucketEvidence[band].hits.push(cat.hit ? 1 : 0);
        }
      }
      totalModelCategoryPredictions += w.prediction.categories.length;

      // Unique prediction SKU IDs
      const predSkuIds = new Set<number>();
      for (let s = 0; s < w.prediction.externalProductIds.length; s++) {
        const id = w.prediction.externalProductIds[s];
        if (predSkuIds.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate prediction externalProductId: ${id}`,
            path: ["windows", i, "prediction", "externalProductIds", s],
          });
        }
        predSkuIds.add(id);
      }

      // Baseline categories
      const baseCatKeys = new Set<string>();
      for (let c = 0; c < w.baseline.categories.length; c++) {
        const cat = w.baseline.categories[c];
        if (baseCatKeys.has(cat.categoryKey)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate baseline categoryKey: ${cat.categoryKey}`,
            path: ["windows", i, "baseline", "categories", c],
          });
        }
        baseCatKeys.add(cat.categoryKey);
        if (cat.confidence !== null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Baseline category confidence must be null",
            path: ["windows", i, "baseline", "categories", c, "confidence"],
          });
        }
      }

      // Unique baseline SKU IDs
      const baseSkuIds = new Set<number>();
      for (let s = 0; s < w.baseline.externalProductIds.length; s++) {
        const id = w.baseline.externalProductIds[s];
        if (baseSkuIds.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate baseline externalProductId: ${id}`,
            path: ["windows", i, "baseline", "externalProductIds", s],
          });
        }
        baseSkuIds.add(id);
      }

      // Hit bounds
      if (
        w.prediction.categoryHits > w.prediction.categories.length ||
        w.prediction.categoryHits > w.actualCategoryCount
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "prediction.categoryHits cannot exceed predictions or actual categories",
          path: ["windows", i, "prediction", "categoryHits"],
        });
      }
      if (
        w.prediction.categoryHits !==
        w.prediction.categories.filter((category) => category.hit).length
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "prediction.categoryHits must match category hit flags",
          path: ["windows", i, "prediction", "categoryHits"],
        });
      }
      if (
        w.prediction.exactSkuHits > w.prediction.externalProductIds.length ||
        w.prediction.exactSkuHits > w.actualExternalProductCount
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "prediction.exactSkuHits cannot exceed predictions or actual products",
          path: ["windows", i, "prediction", "exactSkuHits"],
        });
      }
      if (
        w.baseline.categoryHits > w.baseline.categories.length ||
        w.baseline.categoryHits > w.actualCategoryCount
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "baseline.categoryHits cannot exceed predictions or actual categories",
          path: ["windows", i, "baseline", "categoryHits"],
        });
      }
      if (
        w.baseline.categoryHits !==
        w.baseline.categories.filter((category) => category.hit).length
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "baseline.categoryHits must match category hit flags",
          path: ["windows", i, "baseline", "categoryHits"],
        });
      }
      if (
        w.baseline.exactSkuHits > w.baseline.externalProductIds.length ||
        w.baseline.exactSkuHits > w.actualExternalProductCount
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "baseline.exactSkuHits cannot exceed predictions or actual products",
          path: ["windows", i, "baseline", "exactSkuHits"],
        });
      }
    }

    // Confidence buckets
    const [bMedium, bHigh] = data.confidenceBuckets;
    if (bMedium.confidenceBand !== "medium") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "First confidence bucket must be 'medium'",
        path: ["confidenceBuckets", 0, "confidenceBand"],
      });
    }
    if (bHigh.confidenceBand !== "high") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Second confidence bucket must be 'high'",
        path: ["confidenceBuckets", 1, "confidenceBand"],
      });
    }

    const bucketPredCountSum =
      bMedium.predictionCount + bHigh.predictionCount;
    if (bucketPredCountSum !== totalModelCategoryPredictions) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Total bucket predictionCount (${bucketPredCountSum}) must match total evaluated model category predictions (${totalModelCategoryPredictions})`,
        path: ["confidenceBuckets"],
      });
    }

    for (let b = 0; b < data.confidenceBuckets.length; b++) {
      const bucket = data.confidenceBuckets[b];
      const expectedBand = b === 0 ? "medium" : "high";
      const expectedEvidence = expectedBucketEvidence[expectedBand];
      const expectedCount = expectedEvidence.confidences.length;
      const expectedMean = meanOrNull(expectedEvidence.confidences);
      const expectedFrequency = meanOrNull(expectedEvidence.hits);

      if (bucket.predictionCount !== expectedCount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${expectedBand} bucket predictionCount must match window predictions`,
          path: ["confidenceBuckets", b, "predictionCount"],
        });
      }

      const valuesMatch = (actual: number | null, expected: number | null) =>
        actual === expected ||
        (actual !== null &&
          expected !== null &&
          Math.abs(actual - expected) <= 1e-12);

      if (!valuesMatch(bucket.meanConfidence, expectedMean)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${expectedBand} bucket meanConfidence must match window predictions`,
          path: ["confidenceBuckets", b, "meanConfidence"],
        });
      }
      if (!valuesMatch(bucket.observedFrequency, expectedFrequency)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${expectedBand} bucket observedFrequency must match category hit flags`,
          path: ["confidenceBuckets", b, "observedFrequency"],
        });
      }

      if (bucket.predictionCount === 0) {
        if (
          bucket.meanConfidence !== null ||
          bucket.observedFrequency !== null
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "Empty bucket must have null meanConfidence and observedFrequency",
            path: ["confidenceBuckets", b],
          });
        }
      } else {
        if (
          bucket.meanConfidence === null ||
          bucket.observedFrequency === null
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "Non-empty bucket must have non-null meanConfidence and observedFrequency",
            path: ["confidenceBuckets", b],
          });
        }
      }
    }

    // Metrics null / non-null rules
    const checkMetrics = (m: BacktestMetrics, path: string[]) => {
      if (data.evaluatedReceiptCount === 0) {
        if (
          m.categoryPrecisionAt3 !== null ||
          m.categoryRecallAt3 !== null ||
          m.receiptHitRate !== null ||
          m.coverage !== null
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Metrics must be null when evaluatedReceiptCount is 0",
            path,
          });
        }
      } else {
        if (
          m.categoryPrecisionAt3 === null ||
          m.categoryRecallAt3 === null ||
          m.receiptHitRate === null ||
          m.coverage === null
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "Category metrics must not be null when evaluatedReceiptCount > 0",
            path,
          });
        }
      }

      if (data.exactSkuWindowCount === 0) {
        if (m.exactSkuPrecisionAtK !== null || m.exactSkuRecallAtK !== null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "Exact SKU metrics must be null when exactSkuWindowCount is 0",
            path,
          });
        }
      } else {
        if (m.exactSkuPrecisionAtK === null || m.exactSkuRecallAtK === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "Exact SKU metrics must not be null when exactSkuWindowCount > 0",
            path,
          });
        }
      }
    };

    checkMetrics(data.prediction, ["prediction"]);
    checkMetrics(data.baseline, ["baseline"]);
  });
export type BacktestReport = z.infer<typeof BacktestReportSchema>;

export interface BacktestOptions {
  activeCity: string;
}

export function meanOrNull(values: number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function computeBaselineWindow(
  trainingReceipts: readonly NormalizedReceipt[],
  testDate: string,
  activeCity: string,
  actualCategories: Set<string>,
  actualProducts: Set<number>,
): WindowPrediction {
  const testTime = Date.parse(testDate);
  const baselineMinTime = testTime - BACKTEST_BASELINE_WINDOW_DAYS * DAY_MS;

  const baselineReceipts = trainingReceipts.filter((r) => {
    const t = Date.parse(r.purchasedAt);
    return t >= baselineMinTime && t < testTime;
  });

  const categoryHistories = buildCategoryHistory({
    receipts: baselineReceipts,
    now: testDate,
    activeCity,
  });

  // Eligible categories: support >= minCategoryObservations (3)
  const eligibleCategories = categoryHistories
    .filter(
      (h) => h.observations.length >= PREDICTION_CONFIG.minCategoryObservations,
    )
    .map((h) => ({
      categoryKey: h.categoryKey,
      weightedCount: h.observations.reduce((sum, o) => sum + o.weight, 0),
    }));

  eligibleCategories.sort((a, b) => {
    if (b.weightedCount !== a.weightedCount) {
      return b.weightedCount - a.weightedCount;
    }
    return compareCategoryKeys(a.categoryKey, b.categoryKey);
  });

  const selectedCategories: WindowCategoryPrediction[] = eligibleCategories
    .slice(0, BACKTEST_CATEGORY_K)
    .map((c) => ({
      categoryKey: c.categoryKey,
      confidence: null,
      hit: actualCategories.has(c.categoryKey),
    }));

  // Global SKU ranking across categories
  const skuTimestampMap = new Map<number, Map<number, number>>();

  for (const h of categoryHistories) {
    for (const obs of h.observations) {
      for (const entry of obs.items) {
        const extId = entry.item.externalProductId;
        if (extId === null) continue;
        let tsMap = skuTimestampMap.get(extId);
        if (!tsMap) {
          tsMap = new Map();
          skuTimestampMap.set(extId, tsMap);
        }
        const prevWeight = tsMap.get(obs.timestamp) ?? 0;
        if (entry.weight > prevWeight) {
          tsMap.set(obs.timestamp, entry.weight);
        }
      }
    }
  }

  const eligibleSkus: Array<{ skuId: number; weightedCount: number }> = [];
  for (const [skuId, tsMap] of skuTimestampMap.entries()) {
    if (tsMap.size >= PREDICTION_CONFIG.minSkuObservations) {
      const weightedCount = Array.from(tsMap.values()).reduce(
        (sum, w) => sum + w,
        0,
      );
      eligibleSkus.push({ skuId, weightedCount });
    }
  }

  eligibleSkus.sort((a, b) => {
    if (b.weightedCount !== a.weightedCount) {
      return b.weightedCount - a.weightedCount;
    }
    return a.skuId - b.skuId;
  });

  const selectedSkuIds = eligibleSkus
    .slice(0, BACKTEST_EXACT_K)
    .map((s) => s.skuId);

  const categoryHits = selectedCategories.filter((c) => c.hit).length;
  const exactSkuHits = selectedSkuIds.filter((id) =>
    actualProducts.has(id),
  ).length;

  return {
    categories: selectedCategories,
    externalProductIds: selectedSkuIds,
    categoryHits,
    exactSkuHits,
  };
}

function computeAggregateMetrics(
  windows: BacktestWindow[],
  type: "prediction" | "baseline",
): BacktestMetrics {
  if (windows.length === 0) {
    return {
      exactSkuPrecisionAtK: null,
      exactSkuRecallAtK: null,
      categoryPrecisionAt3: null,
      categoryRecallAt3: null,
      receiptHitRate: null,
      coverage: null,
    };
  }

  const catPrecisions = windows.map(
    (w) => w[type].categoryHits / BACKTEST_CATEGORY_K,
  );
  const categoryPrecisionAt3 = meanOrNull(catPrecisions);

  const catRecalls = windows.map(
    (w) => w[type].categoryHits / w.actualCategoryCount,
  );
  const categoryRecallAt3 = meanOrNull(catRecalls);

  const hitBooleans = windows.map((w) => (w[type].categoryHits > 0 ? 1 : 0));
  const receiptHitRate = meanOrNull(hitBooleans);

  const coverageBooleans = windows.map((w) =>
    w[type].categories.length > 0 ? 1 : 0,
  );
  const coverage = meanOrNull(coverageBooleans);

  const exactEligibleWindows = windows.filter(
    (w) => w.actualExternalProductCount > 0,
  );
  let exactSkuPrecisionAtK: number | null = null;
  let exactSkuRecallAtK: number | null = null;

  if (exactEligibleWindows.length > 0) {
    const exactPrecisions = exactEligibleWindows.map(
      (w) => w[type].exactSkuHits / BACKTEST_EXACT_K,
    );
    exactSkuPrecisionAtK = meanOrNull(exactPrecisions);

    const exactRecalls = exactEligibleWindows.map(
      (w) => w[type].exactSkuHits / w.actualExternalProductCount,
    );
    exactSkuRecallAtK = meanOrNull(exactRecalls);
  }

  return {
    exactSkuPrecisionAtK,
    exactSkuRecallAtK,
    categoryPrecisionAt3,
    categoryRecallAt3,
    receiptHitRate,
    coverage,
  };
}

export function runRollingBacktest(
  receipts: readonly NormalizedReceipt[],
  options: BacktestOptions,
): BacktestReport {
  if (!options || typeof options !== "object") {
    throw new TypeError("options must be an object");
  }

  const { activeCity } = options;
  if (typeof activeCity !== "string" || activeCity.trim().length === 0) {
    throw new TypeError("activeCity must be a non-empty string");
  }

  if (!Array.isArray(receipts)) {
    throw new TypeError("receipts must be an array");
  }

  const seenFingerprints = new Set<string>();
  const validatedReceipts: NormalizedReceipt[] = [];

  for (const r of receipts) {
    const validated = NormalizedReceiptSchema.parse(r);
    if (seenFingerprints.has(validated.externalFingerprint)) {
      throw new Error(
        `Duplicate externalFingerprint: ${validated.externalFingerprint}`,
      );
    }
    seenFingerprints.add(validated.externalFingerprint);
    validatedReceipts.push(validated);
  }

  const sortedReceipts = [...validatedReceipts].sort((a, b) => {
    const diff = Date.parse(a.purchasedAt) - Date.parse(b.purchasedAt);
    if (diff !== 0) return diff;
    return a.externalFingerprint < b.externalFingerprint
      ? -1
      : a.externalFingerprint > b.externalFingerprint
        ? 1
        : 0;
  });

  const windows: BacktestWindow[] = [];
  let skippedReceiptCount = 0;

  // Medium bucket: [0.55, 0.75); High bucket: [0.75, 1.0]
  const mediumConfidences: number[] = [];
  const mediumHits: number[] = [];
  const highConfidences: number[] = [];
  const highHits: number[] = [];

  for (const targetReceipt of sortedReceipts) {
    const targetTimestamp = Date.parse(targetReceipt.purchasedAt);

    // Eligible items for target
    const eligibleItems = targetReceipt.items.filter(
      (item) =>
        !isServiceItem(item.name) && item.categoryKey !== "uncategorized",
    );

    if (eligibleItems.length === 0) {
      skippedReceiptCount++;
      continue;
    }

    const actualCategories = new Set(
      eligibleItems.map((item) => item.categoryKey),
    );
    const actualProducts = new Set(
      eligibleItems
        .map((item) => item.externalProductId)
        .filter((id): id is number => id !== null),
    );

    const actualCategoryCount = actualCategories.size;
    const actualExternalProductCount = actualProducts.size;

    const testDate = new Date(targetTimestamp).toISOString();
    const trainingCutoff = new Date(targetTimestamp - 1).toISOString();

    const trainingMinTime =
      targetTimestamp - BACKTEST_HISTORY_WINDOW_DAYS * DAY_MS;
    const baselineMinTime =
      targetTimestamp - BACKTEST_BASELINE_WINDOW_DAYS * DAY_MS;

    const trainingReceipts = sortedReceipts.filter((r) => {
      const t = Date.parse(r.purchasedAt);
      return t >= trainingMinTime && t < targetTimestamp;
    });

    const baselineTrainingReceipts = sortedReceipts.filter((r) => {
      const t = Date.parse(r.purchasedAt);
      return t >= baselineMinTime && t < targetTimestamp;
    });

    // Predictor candidates
    const needs = inferNeeds({
      receipts: trainingReceipts,
      now: testDate,
      activeCity: activeCity.trim(),
    });

    const predCategories: WindowCategoryPrediction[] = needs
      .slice(0, BACKTEST_CATEGORY_K)
      .map((n) => ({
        categoryKey: n.categoryKey,
        confidence: n.confidence,
        hit: actualCategories.has(n.categoryKey),
      }));

    const predSkuIds: number[] = [];
    for (const need of needs) {
      if (
        need.preferredExternalProductIds &&
        need.preferredExternalProductIds.length > 0
      ) {
        const firstId = need.preferredExternalProductIds[0];
        if (
          firstId !== null &&
          firstId !== undefined &&
          !predSkuIds.includes(firstId)
        ) {
          predSkuIds.push(firstId);
          if (predSkuIds.length === BACKTEST_EXACT_K) break;
        }
      }
    }

    const predCatHits = predCategories.filter((c) => c.hit).length;
    const predSkuHits = predSkuIds.filter((id) =>
      actualProducts.has(id),
    ).length;

    const prediction: WindowPrediction = {
      categories: predCategories,
      externalProductIds: predSkuIds,
      categoryHits: predCatHits,
      exactSkuHits: predSkuHits,
    };

    // Calibration bucket data collection
    for (const cat of predCategories) {
      if (cat.confidence !== null) {
        const band = toConfidenceBand(cat.confidence);
        const hit = cat.hit ? 1 : 0;
        if (band === "medium") {
          mediumConfidences.push(cat.confidence);
          mediumHits.push(hit);
        } else if (band === "high") {
          highConfidences.push(cat.confidence);
          highHits.push(hit);
        }
      }
    }

    // Baseline predictions
    const baseline = computeBaselineWindow(
      trainingReceipts,
      testDate,
      activeCity.trim(),
      actualCategories,
      actualProducts,
    );

    windows.push({
      testDate,
      trainingCutoff,
      trainingReceiptCount: trainingReceipts.length,
      baselineTrainingReceiptCount: baselineTrainingReceipts.length,
      actualCategoryCount,
      actualExternalProductCount,
      prediction,
      baseline,
    });
  }

  const evaluatedReceiptCount = windows.length;
  const exactSkuWindowCount = windows.filter(
    (w) => w.actualExternalProductCount > 0,
  ).length;

  const predMetrics = computeAggregateMetrics(windows, "prediction");
  const baseMetrics = computeAggregateMetrics(windows, "baseline");

  const mediumCount = mediumConfidences.length;
  const mediumMean = meanOrNull(mediumConfidences);
  const mediumFreq =
    mediumCount === 0
      ? null
      : mediumHits.reduce((s, h) => s + h, 0) / mediumCount;

  const highCount = highConfidences.length;
  const highMean = meanOrNull(highConfidences);
  const highFreq =
    highCount === 0 ? null : highHits.reduce((s, h) => s + h, 0) / highCount;

  const confidenceBuckets: ConfidenceBucket[] = [
    {
      confidenceBand: "medium",
      predictionCount: mediumCount,
      meanConfidence: mediumMean,
      observedFrequency: mediumFreq,
    },
    {
      confidenceBand: "high",
      predictionCount: highCount,
      meanConfidence: highMean,
      observedFrequency: highFreq,
    },
  ];

  const report: BacktestReport = {
    algorithmVersion: BACKTEST_ALGORITHM_VERSION,
    evaluationVersion: BACKTEST_EVALUATION_VERSION,
    baselineVersion: BACKTEST_BASELINE_VERSION,
    categoryK: BACKTEST_CATEGORY_K,
    exactK: BACKTEST_EXACT_K,
    historyWindowDays: BACKTEST_HISTORY_WINDOW_DAYS,
    baselineWindowDays: BACKTEST_BASELINE_WINDOW_DAYS,
    inputReceiptCount: sortedReceipts.length,
    evaluatedReceiptCount,
    skippedReceiptCount,
    exactSkuWindowCount,
    windows,
    prediction: predMetrics,
    baseline: baseMetrics,
    confidenceBuckets,
  };

  return BacktestReportSchema.parse(report);
}
