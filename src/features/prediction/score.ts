import {
  type NeedCandidate,
  NeedCandidateSchema,
} from "@/features/shared/contracts";
import {
  compareCategoryKeys,
  extractCategoryFeatures,
  type InferNeedsInput,
  PREDICTION_CONFIG,
} from "./features";

export function scoreNeed(input: {
  due: number;
  repeat: number;
  stability: number;
}): number {
  const { due, repeat, stability } = input;
  if (
    !Number.isFinite(due) ||
    !Number.isFinite(repeat) ||
    !Number.isFinite(stability)
  ) {
    throw new TypeError("due, repeat, and stability must be finite numbers");
  }

  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  return (
    PREDICTION_CONFIG.dueWeight * clamp01(due) +
    PREDICTION_CONFIG.repeatWeight * clamp01(repeat) +
    PREDICTION_CONFIG.stabilityWeight * clamp01(stability)
  );
}

export function toConfidenceBand(
  confidence: number,
): "medium" | "high" | null {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new RangeError("confidence must be a finite number between 0 and 1");
  }

  if (confidence < PREDICTION_CONFIG.minimumConfidence) {
    return null;
  }
  if (confidence >= PREDICTION_CONFIG.highConfidence) {
    return "high";
  }
  return "medium";
}

export function inferNeeds(input: InferNeedsInput): NeedCandidate[] {
  const evidenceList = extractCategoryFeatures(input);
  const candidates: NeedCandidate[] = [];

  for (const evidence of evidenceList) {
    const confidence = scoreNeed({
      due: evidence.features.dueScore,
      repeat: evidence.features.repeatScore,
      stability: evidence.features.stabilityScore,
    });

    const confidenceBand = toConfidenceBand(confidence);
    if (confidenceBand === null) {
      continue;
    }

    const reasonCodes: string[] = ["category_repeat"];
    if (evidence.features.dueScore === 1) {
      reasonCodes.push("cycle_due");
    }
    if (evidence.features.stabilityScore >= 0.75) {
      reasonCodes.push("stable_cycle");
    }
    if (evidence.preferredExternalProductIds.length > 0) {
      reasonCodes.push("familiar_sku");
    }
    if (evidence.features.activeCityShare < 1) {
      reasonCodes.push("other_city_history");
    }
    if (evidence.quantityUncertain) {
      reasonCodes.push("quantity_uncertain");
    }

    const candidate = NeedCandidateSchema.parse({
      categoryKey: evidence.categoryKey,
      confidence,
      confidenceBand,
      typicalQuantity: evidence.typicalQuantity,
      reasonCodes,
      preferredExternalProductIds: evidence.preferredExternalProductIds,
      features: evidence.features,
    });

    candidates.push(candidate);
  }

  candidates.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      compareCategoryKeys(a.categoryKey, b.categoryKey),
  );

  return candidates;
}
