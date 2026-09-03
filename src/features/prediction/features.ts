import { z } from "zod";
import {
  type NeedFeatures,
  NeedFeaturesSchema,
  type NormalizedPurchaseItem,
  type NormalizedReceipt,
  NormalizedReceiptSchema,
} from "@/features/shared/contracts";
import { isServiceItem } from "@/features/purchases/categorize";

export const DAY_MS = 86_400_000;
export const PREDICTION_ALGORITHM_VERSION = "prediction-v1" as const;
export const PREDICTION_CONFIG = Object.freeze({
  historyWindowDays: 180,
  minCategoryObservations: 3,
  minSkuObservations: 2,
  activeCityWeight: 1,
  otherCityWeight: 0.35,
  repeatSaturation: 5,
  dueWeight: 0.40,
  repeatWeight: 0.35,
  stabilityWeight: 0.25,
  minimumConfidence: 0.55,
  highConfidence: 0.75,
} as const);

export interface InferNeedsInput {
  receipts: readonly NormalizedReceipt[];
  now: string | Date;
  activeCity: string;
}

export interface PurchaseObservation {
  timestamp: number;
  weight: 1 | 0.35;
  items: Array<{ item: NormalizedPurchaseItem; weight: 1 | 0.35 }>;
}

export interface CategoryHistory {
  categoryKey: string;
  observations: PurchaseObservation[];
}

export interface CategoryEvidence {
  categoryKey: string;
  typicalQuantity: number;
  quantityUncertain: boolean;
  preferredExternalProductIds: number[];
  features: NeedFeatures;
}

export function compareCategoryKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function validateInferNeedsInput(input: InferNeedsInput): {
  nowTimestamp: number;
  activeCity: string;
  receipts: NormalizedReceipt[];
} {
  if (!input || typeof input !== "object") {
    throw new TypeError("Input must be an object");
  }

  const { activeCity, now, receipts } = input;

  if (typeof activeCity !== "string" || activeCity.trim().length === 0) {
    throw new TypeError("activeCity must be a non-empty string");
  }

  let nowTimestamp: number;
  if (now instanceof Date) {
    if (isNaN(now.getTime())) {
      throw new TypeError("Invalid now Date");
    }
    nowTimestamp = now.getTime();
  } else if (typeof now === "string") {
    const parsed = z.string().datetime({ offset: true }).safeParse(now);
    if (!parsed.success) {
      throw new TypeError("now must be an ISO datetime string with timezone");
    }
    nowTimestamp = Date.parse(now);
    if (isNaN(nowTimestamp)) {
      throw new TypeError("Invalid now datetime string");
    }
  } else {
    throw new TypeError("now must be a string or Date");
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

  return {
    nowTimestamp,
    activeCity: activeCity.trim(),
    receipts: validatedReceipts,
  };
}

function matchesCity(receiptCity: string | null, activeCity: string): boolean {
  if (!receiptCity) return false;
  return receiptCity.trim().toLowerCase() === activeCity.trim().toLowerCase();
}

function compareObservationItems(
  a: { item: NormalizedPurchaseItem; weight: 1 | 0.35 },
  b: { item: NormalizedPurchaseItem; weight: 1 | 0.35 },
): number {
  // 1. externalProductId (null last, then ascending numeric)
  if (a.item.externalProductId !== b.item.externalProductId) {
    if (a.item.externalProductId === null) return 1;
    if (b.item.externalProductId === null) return -1;
    return a.item.externalProductId - b.item.externalProductId;
  }
  // 2. unit
  const unitA = a.item.unit ?? "";
  const unitB = b.item.unit ?? "";
  if (unitA !== unitB) {
    return unitA < unitB ? -1 : 1;
  }
  // 3. sourceId
  if (a.item.sourceId !== b.item.sourceId) {
    return a.item.sourceId < b.item.sourceId ? -1 : 1;
  }
  // 4. quantity
  return a.item.quantity - b.item.quantity;
}

export function buildCategoryHistory(input: InferNeedsInput): CategoryHistory[] {
  const { nowTimestamp, activeCity, receipts } = validateInferNeedsInput(input);

  const minTimestamp = nowTimestamp - PREDICTION_CONFIG.historyWindowDays * DAY_MS;

  // Map categoryKey -> timestamp -> array of items with weights
  const categoryMap = new Map<
    string,
    Map<number, Array<{ item: NormalizedPurchaseItem; weight: 1 | 0.35 }>>
  >();

  for (const receipt of receipts) {
    const timestamp = Date.parse(receipt.purchasedAt);
    if (timestamp < minTimestamp || timestamp > nowTimestamp) {
      continue;
    }

    const isCityMatch = matchesCity(receipt.city, activeCity);
    const weight: 1 | 0.35 = isCityMatch
      ? PREDICTION_CONFIG.activeCityWeight
      : PREDICTION_CONFIG.otherCityWeight;

    for (const item of receipt.items) {
      if (isServiceItem(item.name)) {
        continue;
      }
      if (item.categoryKey === "uncategorized") {
        continue;
      }

      let timestampMap = categoryMap.get(item.categoryKey);
      if (!timestampMap) {
        timestampMap = new Map();
        categoryMap.set(item.categoryKey, timestampMap);
      }

      let itemList = timestampMap.get(timestamp);
      if (!itemList) {
        itemList = [];
        timestampMap.set(timestamp, itemList);
      }

      itemList.push({ item: { ...item }, weight });
    }
  }

  const categoryHistories: CategoryHistory[] = [];

  for (const [categoryKey, timestampMap] of categoryMap.entries()) {
    const observations: PurchaseObservation[] = [];

    const sortedTimestamps = Array.from(timestampMap.keys()).sort((a, b) => a - b);

    for (const ts of sortedTimestamps) {
      const items = timestampMap.get(ts)!;
      const obsWeight = Math.max(...items.map((i) => i.weight)) as 1 | 0.35;
      const sortedItems = [...items].sort(compareObservationItems);

      observations.push({
        timestamp: ts,
        weight: obsWeight,
        items: sortedItems,
      });
    }

    categoryHistories.push({
      categoryKey,
      observations,
    });
  }

  categoryHistories.sort((a, b) => compareCategoryKeys(a.categoryKey, b.categoryKey));

  return categoryHistories;
}

export function median(values: number[]): number {
  if (values.length === 0) {
    throw new RangeError("Cannot compute median of empty array");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function extractCategoryFeatures(
  input: InferNeedsInput,
): CategoryEvidence[] {
  const { nowTimestamp } = validateInferNeedsInput(input);
  const categoryHistories = buildCategoryHistory(input);
  const evidenceList: CategoryEvidence[] = [];

  for (const history of categoryHistories) {
    if (history.observations.length < PREDICTION_CONFIG.minCategoryObservations) {
      continue;
    }

    const n = history.observations.length;
    const intervals: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      intervals.push(
        (history.observations[i + 1].timestamp -
          history.observations[i].timestamp) /
          DAY_MS,
      );
    }

    const medianIntervalDays = median(intervals);
    const intervalMadDays = median(
      intervals.map((int) => Math.abs(int - medianIntervalDays)),
    );
    const daysSinceLastPurchase =
      (nowTimestamp - history.observations[n - 1].timestamp) / DAY_MS;
    const weightedPurchaseCount = history.observations.reduce(
      (sum, obs) => sum + obs.weight,
      0,
    );
    const activeCityCount = history.observations.filter(
      (obs) => obs.weight === PREDICTION_CONFIG.activeCityWeight,
    ).length;
    const activeCityShare = activeCityCount / n;

    const dueScore = clamp01(daysSinceLastPurchase / medianIntervalDays);
    const repeatScore = clamp01(
      weightedPurchaseCount / PREDICTION_CONFIG.repeatSaturation,
    );
    const stabilityScore = clamp01(1 - intervalMadDays / medianIntervalDays);

    const featuresRaw = {
      weightedPurchaseCount,
      medianIntervalDays,
      intervalMadDays,
      daysSinceLastPurchase,
      activeCityShare,
      repeatScore,
      dueScore,
      stabilityScore,
    };

    const featuresResult = NeedFeaturesSchema.safeParse(featuresRaw);
    if (!featuresResult.success) {
      // Non-finite or invalid feature
      continue;
    }
    const features = featuresResult.data;

    // Collect SKU data
    const skuMap = new Map<
      number,
      Map<number, { maxWeight: 1 | 0.35; quantitySum: number }>
    >();

    for (const obs of history.observations) {
      for (const entry of obs.items) {
        const extId = entry.item.externalProductId;
        if (extId === null) continue;

        let tsMap = skuMap.get(extId);
        if (!tsMap) {
          tsMap = new Map();
          skuMap.set(extId, tsMap);
        }

        const current = tsMap.get(obs.timestamp);
        if (!current) {
          tsMap.set(obs.timestamp, {
            maxWeight: entry.weight,
            quantitySum: entry.item.quantity,
          });
        } else {
          if (entry.weight > current.maxWeight) {
            current.maxWeight = entry.weight;
          }
          current.quantitySum += entry.item.quantity;
        }
      }
    }

    const eligibleSkus = Array.from(skuMap.entries())
      .filter(([, tsMap]) => tsMap.size >= PREDICTION_CONFIG.minSkuObservations)
      .map(([skuId, tsMap]) => {
        const timestamps = Array.from(tsMap.keys()).sort((a, b) => a - b);
        const weightedSkuCount = Array.from(tsMap.values()).reduce(
          (sum, d) => sum + d.maxWeight,
          0,
        );
        const lastPurchaseTimestamp = timestamps[timestamps.length - 1];
        return {
          skuId,
          weightedSkuCount,
          lastPurchaseTimestamp,
          tsMap,
        };
      });

    eligibleSkus.sort((a, b) => {
      if (b.weightedSkuCount !== a.weightedSkuCount) {
        return b.weightedSkuCount - a.weightedSkuCount;
      }
      if (b.lastPurchaseTimestamp !== a.lastPurchaseTimestamp) {
        return b.lastPurchaseTimestamp - a.lastPurchaseTimestamp;
      }
      return a.skuId - b.skuId;
    });

    const preferredExternalProductIds = eligibleSkus.map((s) => s.skuId);

    // Quantity decision
    let typicalQuantity = 1;
    let quantityUncertain = true;

    if (eligibleSkus.length > 0) {
      const firstSku = eligibleSkus[0];
      const firstSkuUnits = new Set<string | null>();
      for (const obs of history.observations) {
        for (const entry of obs.items) {
          if (entry.item.externalProductId === firstSku.skuId) {
            firstSkuUnits.add(entry.item.unit);
          }
        }
      }
      if (!firstSkuUnits.has(null) && firstSkuUnits.size === 1) {
        const sums = Array.from(firstSku.tsMap.values()).map(
          (d) => d.quantitySum,
        );
        typicalQuantity = median(sums);
        quantityUncertain = false;
      }
    }

    if (quantityUncertain) {
      const allCategoryUnits = new Set<string | null>();
      for (const obs of history.observations) {
        for (const entry of obs.items) {
          allCategoryUnits.add(entry.item.unit);
        }
      }
      if (!allCategoryUnits.has(null) && allCategoryUnits.size === 1) {
        const categorySums = history.observations.map((obs) =>
          obs.items.reduce((sum, e) => sum + e.item.quantity, 0),
        );
        typicalQuantity = median(categorySums);
        quantityUncertain = false;
      }
    }

    evidenceList.push({
      categoryKey: history.categoryKey,
      typicalQuantity,
      quantityUncertain,
      preferredExternalProductIds,
      features,
    });
  }

  return evidenceList;
}
