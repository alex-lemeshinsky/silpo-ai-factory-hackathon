# Tasks 5–6 Prediction and Rolling Backtest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline execution, or superpowers:subagent-driven-development when delegated execution is selected. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks 5 and 6 are sequential and must not run in parallel in the same feature directory.

**Goal:** Produce explainable deterministic needs, measure them with a causal rolling backtest, and expose the validated report only in demo mode.

**Architecture:** Pure prediction modules consume the existing normalized receipt contracts. A small application service reads the demo port and prepares evaluation input; the Next.js route controls mode and maps typed results. Task 6 consumes the reviewed Task 5 implementation rather than duplicating its scoring logic.

**Tech Stack:** Existing pnpm, TypeScript, Zod, Vitest, Next.js App Router, and the demo `SilpoGateway`. No new dependencies.

**Spec:** [Tasks 5–6 Prediction and Rolling Backtest Specification](../specs/2026-09-03-prediction-backtest-design.md).

**Status:** Ready for review; all implementation checkboxes are intentionally unchecked. This plan does not authorize live operations or claim feature completion.

## Global Constraints

- Use `pnpm` exclusively; add no dependencies or package/lockfile changes.
- Prediction is category-first and SKU-second.
- Exact-SKU candidates require at least two observations; category candidates require at least three.
- Prediction history is limited to 180 days; active-city weight is `1.0`, and other-city or unknown-city weight is `0.35`.
- Confidence is `0.40 × due + 0.35 × repeat + 0.25 × stability`; below `0.55` abstains, `[0.55, 0.75)` is medium, and `[0.75, 1]` is high.
- Purchases and prediction remain pure TypeScript with no React, Next.js, MCP SDK, AI SDK, DB client, environment, or demo-fixture imports.
- Reuse shared schemas and the `SilpoGateway` port without modifying them.
- No live calls, model calls, database writes, cart writes, or checkout links are introduced.
- Every numeric metric is finite and in `0..1`; a missing denominator produces `null`, never a fabricated percentage.
- Follow red-green-refactor and keep one focused implementation commit per backlog task.

## File ownership and interfaces

| Task | File | Responsibility |
|---|---|---|
| 5 | Create `src/features/prediction/features.ts` | Input validation, version/configuration, observations, robust feature and quantity extraction. |
| 5 | Create `src/features/prediction/score.ts` | Component scoring, confidence bands, reason codes, and candidate ordering. |
| 5 | Create `src/features/prediction/score.test.ts` | Task 5 behavioral tests, including feature extraction. |
| 6 | Create `src/features/prediction/backtest.ts` | Causal folds, baseline, metric aggregation, report schema and types. |
| 6 | Create `src/features/prediction/backtest.test.ts` | Pure evaluator tests with hand-calculated oracles. |
| 6 | Create `src/features/diagnostics/backtest-service.ts` | Injected gateway reads, corpus validation, normalization, typed result. |
| 6 | Create `src/features/diagnostics/backtest-service.test.ts` | Service failures, real synthetic fixture, read-only call boundary. |
| 6 | Create `src/app/api/backtest/route.ts` | Request-time configuration, demo-only composition, HTTP mapping. |
| 6 | Create `src/app/api/backtest/route.test.ts` | HTTP behavior with mocked server environment and service dependencies. |

The two diagnostics files and route test refine Task 6's original file list to honor the architecture and provide an evidence-producing HTTP gate. They are listed in the backlog. Task 17's future `diagnostics/service.ts` remains a separate consumer, not an implementation dependency.

Read-only dependencies: `src/features/shared/contracts.ts`, `src/features/purchases/{categorize,normalize}.ts`, `src/features/silpo/demo/demo-gateway.ts`, `src/lib/{env,result}.ts`, and `fixtures/demo/silpo-snapshot.json`. Do not alter the completed normalization or adapter behavior in this plan.

Task 5 exports these concrete interfaces from `features.ts`:

```ts
import type {
  NeedFeatures, NormalizedPurchaseItem, NormalizedReceipt,
} from "@/features/shared/contracts";

export interface InferNeedsInput {
  receipts: NormalizedReceipt[];
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
```

`buildCategoryHistory(input: InferNeedsInput): CategoryHistory[]` returns all known categories, including those below the support minimum, with timestamp-ordered observations. `extractCategoryFeatures(input: InferNeedsInput): CategoryEvidence[]` returns only categories with three observations and all features. Both are pure. The baseline reuses `buildCategoryHistory` so it can evaluate two-observation SKUs even when a category is below its threshold.

Each item retains its contributing receipt's recalculated weight. A category's observation weight is the maximum across its items; a SKU's observation weight is the maximum only across items with that ID. This prevents an active-city item from giving an unrelated other-city SKU full weight at the same instant. Sort item evidence deterministically by external ID (null last), unit, source ID, and quantity before returning histories.

`score.ts` exports `scoreNeed`, `toConfidenceBand`, and `inferNeeds` with the exact signatures in P5-05. `backtest.ts` exports `BacktestOptions`, `BacktestReportSchema`, its inferred `BacktestReport`, and `runRollingBacktest` with B6-01's required city. No report field is added to the frozen shared contracts.

## Execution protocol

For every slice below: add the named behavioral test, run the focused command and record its expected failure, implement the minimum behavior, then rerun until green. A missing module is valid red evidence only for the first slice; subsequent failures must identify the behavior under construction. Refactor after green, never by weakening assertions. Test titles include requirement IDs.

Setup and evidence belong to their task's commit, not separate implementation tasks. Do not commit each slice independently. If a prerequisite or shared contract is missing, report the dependency instead of recreating it.

---

## Task 5 — Prediction feature extraction and scoring

**Prerequisites:** Tasks 1, 2, and 4 integrated. Task 3 is verified with cumulative tests and will be required by Task 6's service.

**Behavior to prove:** Repeated, due categories produce schema-valid, deterministic needs with the required features and thresholds; insufficient or unsupported evidence abstains.

**Focused command:** `pnpm vitest run src/features/prediction/score.test.ts`

### 5.1 — Confirm dependencies and create the behavioral fixture

- [x] Run `git status --short` and `git log -5 --oneline`; preserve unrelated work. Confirm the shared contracts include `NeedFeaturesSchema`, `NeedCandidateSchema`, and the completed normalizer.
- [x] Run the prerequisite gate:

```bash
pnpm vitest run src/features/shared/contracts.test.ts src/lib/env.test.ts src/features/silpo/demo/demo-gateway.test.ts src/features/purchases/normalize.test.ts
```

- [x] Add this local helper and first test in `score.test.ts`. Fixtures are already normalized and do not invoke the normalizer, preventing a second algorithm from obscuring prediction failures.

```ts
import { describe, expect, it } from "vitest";
import {
  NeedCandidateSchema, NormalizedReceiptSchema,
  type NormalizedReceipt,
} from "@/features/shared/contracts";
import { inferNeeds, scoreNeed, toConfidenceBand } from "./score";

const EPOCH = Date.parse("2026-01-01T00:00:00.000Z");
const DAY = 86_400_000;
const at = (day: number) => new Date(EPOCH + day * DAY).toISOString();

function receipt(
  day: number, overrides: Partial<NormalizedReceipt> = {},
): NormalizedReceipt {
  return NormalizedReceiptSchema.parse({
    sourceIds: [`synthetic-${day}`], channel: "offline",
    purchasedAt: at(day), city: "Київ", total: 40,
    locationWeight: 1, externalFingerprint: `fingerprint-${day}`,
    items: [{
      sourceId: `line-${day}`, externalProductId: 101,
      productId: null, name: "Вода негазована",
      normalizedName: "Вода негазована", categoryKey: "water",
      quantity: 2, unit: "шт", unitPrice: 20,
    }],
    ...overrides,
  });
}

it("P5-02 abstains below three category observations", () => {
  expect(inferNeeds({
    receipts: [receipt(0), receipt(7)], now: at(21), activeCity: "Київ",
  })).toEqual([]);
});
```

- [x] Run the focused command. Expected red: unresolved `./score` import. Create `features.ts` and `score.ts` only after recording that failure.

### 5.2 — Validate and collect observations

- [x] Add P5-01/P5-02 tests with the following exact cases. Use `buildCategoryHistory` directly for support and window assertions; do not rely on a coincidentally low confidence.

```ts
import { buildCategoryHistory } from "./features";

it("P5-01 includes the 180-day boundary and excludes older/future receipts", () => {
  const histories = buildCategoryHistory({
    receipts: [receipt(-1 / DAY), receipt(0), receipt(7), receipt(14), receipt(181)],
    now: at(180), activeCity: "Київ",
  });
  expect(histories[0].observations.map(o => o.timestamp))
    .toEqual([0, 7, 14].map(day => EPOCH + day * DAY));
});

it("P5-02 duplicate lines and simultaneous receipts count once", () => {
  const first = receipt(0);
  first.items.push({ ...first.items[0], sourceId: "second-line" });
  const simultaneous = receipt(0, { externalFingerprint: "other-fingerprint" });
  const histories = buildCategoryHistory({
    receipts: [first, simultaneous, receipt(7)], now: at(21), activeCity: "Київ",
  });
  expect(histories[0].observations).toHaveLength(2);
  expect(inferNeeds({
    receipts: [first, simultaneous, receipt(7)], now: at(21), activeCity: "Київ",
  })).toEqual([]);
});
```

- [x] Add rejection assertions for malformed receipt fields, non-ISO date strings, invalid `Date`, blank active city, and repeated fingerprint; distinguish each from valid empty input. Add service rows deliberately labeled `water`, unknown categories, a null external ID, and ID `0`. Add equal instants encoded with different timezone offsets. Freeze input objects/arrays and confirm both reversed-input equality and no mutation.
- [x] Run the focused command. Expected red: missing collector or incorrect observation counts/window membership.
- [x] Implement `PREDICTION_CONFIG`, `PREDICTION_ALGORITHM_VERSION`, `DAY_MS`, validation, and `buildCategoryHistory` in `features.ts` according to P5-01–03. Copy input arrays, parse timestamps once, group with maps, and sort with an explicit comparator. Recompute weights from city, then coalesce simultaneous category observations using the maximum contributing weight. Retain each item's own weight and quantity for SKU support and P5-04.

```ts
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
```

- [x] Rerun the focused command; collector and validation cases must pass. Keep scoring tests pending only until their named slice, never disabled.

### 5.3 — Extract robust features, familiar IDs, and quantities

- [x] Add the feature oracle before implementing extraction:

```ts
import { extractCategoryFeatures } from "./features";

it("P5-03 P5-07 computes the weekly active-city feature oracle", () => {
  const [evidence] = extractCategoryFeatures({
    receipts: [receipt(0), receipt(7), receipt(14)],
    now: at(21), activeCity: "Київ",
  });
  expect(evidence.features).toEqual({
    weightedPurchaseCount: 3, medianIntervalDays: 7, intervalMadDays: 0,
    daysSinceLastPurchase: 7, activeCityShare: 1,
    dueScore: 1, repeatScore: 0.6, stabilityScore: 1,
  });
  expect(evidence.typicalQuantity).toBe(2);
  expect(evidence.preferredExternalProductIds).toEqual([101]);
});

it("P5-03 uses even medians and MAD", () => {
  const [evidence] = extractCategoryFeatures({
    receipts: [0, 2, 6, 14, 24].map(day => receipt(day)),
    now: at(30), activeCity: "Київ",
  });
  expect(evidence.features.medianIntervalDays).toBe(6);
  expect(evidence.features.intervalMadDays).toBe(3);
  expect(evidence.features.stabilityScore).toBe(0.5);
});
```

- [x] Add P5-03 tests for mixed active/other/null cities and whitespace/case normalization. Deliberately set `locationWeight: 1` on other-city receipts and assert recalculated weighted count `1.05`, share `0`, repeat `0.21`. Changing only active city must change the corresponding features without modifying the receipt weights. At a shared timestamp, include different SKUs from different cities and assert that a remote SKU retains weight `0.35` even when the category observation has weight `1.0`.
- [x] Add P5-04 fixtures: a one-observation SKU omitted; two-observation SKU retained; null omitted while ID `0` remains valid; equal counts ordered by recency then numeric ID; multiple line quantities summed once per timestamp; fractional quantity median preserved; one consistent familiar-SKU unit wins; mixed/null units with no compatible source return `1` and `quantityUncertain: true`.
- [x] Run the focused command. Expected red: absent extractor or wrong numerical/quantity values.
- [x] Implement `extractCategoryFeatures` using `buildCategoryHistory`, a nonmutating median helper, SKU histories, and the formulas in P5-03. Apply support before dividing by intervals. Use P5-04's ordered quantity decision exactly; do not multiply a historical amount by the due score.

```ts
// Local helpers in features.ts; callers supply nonempty finite values.
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
```

Inside the extractor, after constructing sorted observations, calculate intervals, their median, median absolute deviations, weighted count, and active share. Validate the final eight fields with `NeedFeaturesSchema`. An ineligible category is omitted; non-finite arithmetic is rejected.

- [x] Rerun the focused command until all extraction and quantity cases pass.

### 5.4 — Score, explain, and return stable candidates

- [x] Add the component and threshold tests:

```ts
it("P5-05 uses the agreed confidence weights", () => {
  expect(scoreNeed({ due: 1, repeat: 0.5, stability: 0.25 }))
    .toBeCloseTo(0.6375, 10);
  expect(scoreNeed({ due: 2, repeat: -1, stability: 0.5 }))
    .toBeCloseTo(0.525, 10);
});
it.each([
  [0, null], [0.549999, null], [0.55, "medium"],
  [0.749999, "medium"], [0.75, "high"], [1, "high"],
])("P5-05 bands %s as %s", (value, expected) => {
  expect(toConfidenceBand(value as number)).toBe(expected);
});
it("P5-06 P5-07 emits explainable schema-valid weekly needs", () => {
  const [need] = inferNeeds({
    receipts: [0, 7, 14].map(day => receipt(day)), now: at(21), activeCity: "Київ",
  });
  expect(need.confidence).toBeCloseTo(0.86, 10);
  expect(need.confidenceBand).toBe("high");
  expect(need.reasonCodes).toEqual([
    "category_repeat", "cycle_due", "stable_cycle", "familiar_sku",
  ]);
  expect(NeedCandidateSchema.parse(need)).toEqual(need);
});
```

- [x] Add invalid-component tests for `NaN` and infinities, out-of-range band input, the day-14 `0.46` abstention, other-city `0.7235` medium result, score ties between `bread` and `water`, and every optional reason condition/order. Assert algorithm version equals `prediction-v1`. Assert reversed receipt/item input yields identical candidates.
- [x] Run the focused command. Expected red: score, band, reason, or ordering mismatch.
- [x] Implement scoring as the weighted clamped sum from `PREDICTION_CONFIG`; map a valid candidate's exact features into that function. Build reasons using the ordered P5-06 table. Filter null bands, parse with `NeedCandidateSchema`, and sort descending confidence then ascending category key.

```ts
// score.ts: comparator used after candidate validation.
function compareCategoryKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
// Sort a newly constructed array, never the caller's receipt array.
// candidates.sort((a, b) =>
//   b.confidence - a.confidence || compareCategoryKeys(a.categoryKey, b.categoryKey));
```

- [x] Rerun all Task 5 tests. Remove no acceptance cases to make the suite green.

### 5.5 — Verify, review, and commit Task 5

- [x] Run the focused command from a fresh invocation, then cumulative/static gates:

```bash
pnpm vitest run src/features/prediction/score.test.ts
pnpm test
pnpm lint
pnpm typecheck
git diff --check
git diff -- src/features/prediction
```

- [x] Inspect imports for purity, outputs for shared-schema conformance, reason codes for unsupported claims, and numeric tests for independent expected values. Check every P5 requirement against the traceability table below.
- [x] Stage only the three Task 5 files and commit:

```bash
git add src/features/prediction/features.ts src/features/prediction/score.ts src/features/prediction/score.test.ts
git commit -m "feat: score replenishment needs"
git rev-parse HEAD
```

- [x] Complete spec review, then code-quality review; resolve findings within the task's focused commit. The controller reruns focused and cumulative tests before integrating and marking Task 5's backlog checkboxes. Do not begin Task 6 until that gate is met.

---

## Task 6 — Rolling backtest and demo endpoint

**Prerequisites:** Tasks 2–5 integrated, including the reviewed predictor. No dependency on database, live gateway, dashboard, or Gemini tasks.

**Behavior to prove:** Every prediction uses only prior evidence; metrics and baseline are reproducible; the report endpoint is inaccessible in live mode and performs only synthetic read operations.

**Focused commands:**

```bash
pnpm vitest run src/features/prediction/backtest.test.ts
pnpm vitest run src/features/diagnostics/backtest-service.test.ts src/app/api/backtest/route.test.ts
```

### 6.1 — Create evaluator fixtures and the causal red test

- [x] Verify clean task scope and the Task 5 hash. Run its focused tests before writing the evaluator.
- [x] Create this independent fixture in `backtest.test.ts`. Do not import a helper from another test module or an unvalidated raw JSON fixture.

```ts
import { expect, it, vi } from "vitest";
import {
  NormalizedReceiptSchema, type NormalizedReceipt,
} from "@/features/shared/contracts";
import * as scoring from "./score";
import { runRollingBacktest, BacktestReportSchema } from "./backtest";

const EPOCH = Date.parse("2026-01-01T00:00:00.000Z");
const DAY = 86_400_000;
const at = (day: number) => new Date(EPOCH + day * DAY).toISOString();
function receipt(day: number, overrides: Partial<NormalizedReceipt> = {}): NormalizedReceipt {
  return NormalizedReceiptSchema.parse({
    sourceIds: [`synthetic-${day}`], channel: "offline", purchasedAt: at(day),
    city: "Київ", total: 40, locationWeight: 1,
    externalFingerprint: `fingerprint-${day}`,
    items: [{
      sourceId: `line-${day}`, externalProductId: 101, productId: null,
      name: "Вода негазована", normalizedName: "Вода негазована",
      categoryKey: "water", quantity: 2, unit: "шт", unitPrice: 20,
    }],
    ...overrides,
  });
}

it("B6-02 passes strictly prior history to the production predictor", () => {
  const spy = vi.spyOn(scoring, "inferNeeds"); // Calls through to the real implementation.
  const receipts = [0, 7, 14, 21].map(day => receipt(day));
  const report = runRollingBacktest(receipts, { activeCity: "Київ" });
  expect(report.windows).toHaveLength(4);
  expect(spy).toHaveBeenCalledTimes(4);
  for (const [input] of spy.mock.calls) {
    const testTime = new Date(input.now).getTime();
    expect(input.activeCity).toBe("Київ");
    expect(input.receipts.every(r => Date.parse(r.purchasedAt) < testTime)).toBe(true);
    expect(input.receipts.every(r => Date.parse(r.purchasedAt) >= testTime - 180 * DAY)).toBe(true);
  }
  expect(report.windows.every(w => Date.parse(w.trainingCutoff) < Date.parse(w.testDate)))
    .toBe(true);
});
```

- [x] Run the evaluator command. Expected red: missing evaluator import.
- [x] Add B6-01 input rejection cases for a blank active city, missing options, an invalid receipt timestamp, and duplicate fingerprints. Verify that `[]` with a valid explicit city is accepted; invalid input must not be converted into an empty successful report.
- [x] Add the local Zod report schemas and `BacktestOptions` from B6-07, then implement numeric chronological ordering and strictly prior folds. Use `new Date(T - 1).toISOString()` for metadata and the actual target time for inference. Do not use the last training timestamp as the prediction time.

### 6.2 — Define target sets and metric aggregation

- [x] Add the complete hand-calculated oracle assertions:

```ts
it("B6-04 B6-08 includes cold starts and uses fixed-K macro metrics", () => {
  const report = runRollingBacktest([0, 7, 14, 21].map(day => receipt(day)), {
    activeCity: "Київ",
  });
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
```

- [x] Add B6-03 cases with repeated target lines, five actual categories, null-ID targets, service-only/unknown-only receipts, needs without preferred IDs, duplicate preferred IDs across needs, and long replacement lists. For synthetic candidate-selection tests, stub only `inferNeeds` with schema-valid candidates and separately assert it receives prior-only data; retain the real-predictor oracle above.
- [x] Add a macro-recall oracle with two eligible windows whose recalls are `1` and `0.2`: the aggregate must be `0.6`, not the micro value `2/6`. Exact-only missing ground truth must not remove a category window.
- [x] Run the evaluator command; expected red is a concrete selection or denominator mismatch.
- [x] Implement set intersection counts and fixed-K selection exactly as B6-03. Aggregate nullable per-window ratios with this local helper, using category-eligible and exact-eligible windows separately:

```ts
function meanOrNull(values: number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}
```

For category precision, average `window.prediction.categoryHits / 3` over every evaluated window. For category recall, average hits divided by `actualCategoryCount`. For exact metrics, first keep windows with `actualExternalProductCount > 0`. Compute receipt hit rate and coverage from category booleans across all evaluated windows. Use the same aggregation function with `window.baseline` for baseline results.

- [x] Rerun the evaluator command; confirm explicit zero and null cases both pass.

### 6.3 — Baseline, calibration, and leakage resistance

- [x] Add B6-06 baseline assertions from the four-receipt oracle: exact precision `1/6`, exact recall `0.5`, category precision `1/12`, category recall/hit rate/coverage `0.25`.
- [x] Add a baseline boundary fixture at target day 180: occurrences at days `89.999`, `90`, and `97`. The just-before-90-day event cannot contribute to baseline support; the exact lower boundary can. Add future high-frequency SKUs and assert earlier predictions/baseline rankings are unchanged. Test weighted frequency and ties separately from due/MAD behavior.
- [x] Add the calibration oracle:

```ts
it("B6-05 calibrates emitted categories and retains empty buckets", () => {
  const report = runRollingBacktest([0, 7, 14, 21].map(day => receipt(day)), {
    activeCity: "Київ",
  });
  expect(report.confidenceBuckets[0]).toEqual({
    confidenceBand: "medium", predictionCount: 0,
    meanConfidence: null, observedFrequency: null,
  });
  expect(report.confidenceBuckets[1]).toMatchObject({
    confidenceBand: "high", predictionCount: 1, observedFrequency: 1,
  });
  expect(report.confidenceBuckets[1].meanConfidence).toBeCloseTo(0.86, 10);
});
```

- [x] Add equal-time target receipts, reordered inputs, timezone-equivalent dates, exact 180-day boundary, target-item mutation, and frozen inputs. Compare the affected window's selected categories, confidences, and SKU IDs after target mutation; hit flags and metrics may change because labels changed. For future poisoning, compare all preexisting windows only, because appending targets legitimately changes aggregate metrics.
- [x] Run the evaluator command. Expected red: baseline support/rank, bucket, or temporal-invariance mismatch.
- [x] Implement baseline by filtering normalized training receipts to 90 days before building histories; count category observations and distinct timestamps per external ID with recomputed weights. For the baseline's global SKU ranking, combine any occurrences across categories by ID and timestamp, taking the maximum contributing item weight at that timestamp. Apply the support minima, take top three with deterministic ties, and give baseline category rows `confidence: null`.
- [x] Implement two confidence buckets using only selected model category predictions. Use `toConfidenceBand` and `meanOrNull`; observed frequency is bucket hits/count. Record a `hit` flag on each model and baseline category row, then validate bucket membership, counts, means, frequencies, and category hit totals against those rows with `BacktestReportSchema`. This report format uses `rolling-v2`; algorithm version and history-window metadata reuse the predictor-owned constants.
- [x] Add B6-07 schema rejection tests by mutating a known-valid report: extra raw receipt field; count/window mismatch; cutoff equal to test time; hit greater than actual/predicted count; inconsistent hit flags; baseline confidence non-null; model confidence below threshold; bucket support or band mismatch; incorrect bucket means or frequencies; zero support with numeric means. Assert each mutation rejects.
- [x] Rerun evaluator plus Task 5 tests. The oracle and leakage checks must all pass before introducing the service.

### 6.4 — Application service with an injected, read-only gateway

- [x] Create `backtest-service.test.ts` with Node test environment (`// @vitest-environment node` on its first line). Use a fresh real demo adapter per test, and spy on its methods. This keeps port parity and fixture validation active without live calls.

```ts
import { expect, it, vi } from "vitest";
import { createDemoSilpoGateway } from "@/features/silpo/demo/demo-gateway";
import { loadDemoBacktest } from "./backtest-service";

it("B6-09 evaluates the actual synthetic fixture using only allowed reads", async () => {
  const gateway = createDemoSilpoGateway();
  const contextRead = vi.spyOn(gateway, "loadCartContext");
  const historyRead = vi.spyOn(gateway, "loadPurchaseHistory");
  const writes = [
    vi.spyOn(gateway, "updateCartContext"),
    vi.spyOn(gateway, "setAbsoluteCartQuantities"),
  ];
  const result = await loadDemoBacktest(gateway, "synthetic-correlation");
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected a successful synthetic report");
  expect(result.value.inputReceiptCount).toBe(30);
  expect(contextRead).toHaveBeenCalledTimes(1);
  expect(historyRead).toHaveBeenCalledTimes(1);
  for (const write of writes) expect(write).not.toHaveBeenCalled();
  expect(await loadDemoBacktest(createDemoSilpoGateway(), "another-correlation"))
    .toEqual(result);
});
```

- [x] Also spy on every remaining gateway method and require zero calls. Add typed mocked `needs_slot` context with no history call, null/blank city, empty history, schema-invalid data, duplicate source IDs, a corpus over 180 days, adjacent receipts within four hours, and a thrown error containing a synthetic secret sentinel. Assert safe code/message/correlation ID and absence of the sentinel.
- [x] Run the service command. Expected red: missing service or missing validation/short-circuit.
- [x] Implement `loadDemoBacktest(gateway, correlationId)` returning `Result<BacktestReport, AppError>`. Reuse `ok`/`err`, schemas, and the normalizer. Sort a copy of raw history for B6-09's corpus checks, require unique source IDs, derive cutoff from the maximum receipt timestamp, normalize once only after the preconditions pass, then call the evaluator with the context's explicit city.

```ts
// The error constructors in this module never receive exception.message.
const messages = {
  needs_slot: "Оберіть доступний слот для демонстраційного контексту.",
  invalid_external_data: "Не вдалося перевірити демонстраційні дані.",
  unexpected: "Не вдалося побудувати звіт. Спробуйте ще раз.",
} as const;
```

Use `needs_slot` for the known context result, `invalid_external_data` for schema or corpus rejection, and `unexpected` for other dependency failures. Set `retryAfterMs: null`. Do not introduce retries or broad exception text logging.

- [x] Run service and evaluator tests together. Change the mocked system date and assert a byte-equivalent report to prove snapshot-relative evaluation.

### 6.5 — Demo-only route and response tests

- [x] Create `route.test.ts` with `// @vitest-environment node`. Mock `getServerEnv`, `createDemoSilpoGateway`, and `loadDemoBacktest` at module boundaries. Tests must use typed synthetic configuration; they never modify or print real environment values.
- [x] Add the live-mode denial test before the route implementation:

```ts
import { beforeEach, expect, it, vi } from "vitest";
import type { ServerEnv } from "@/lib/env";
import { getServerEnv } from "@/lib/env";
import { createDemoSilpoGateway } from "@/features/silpo/demo/demo-gateway";
import { loadDemoBacktest } from "@/features/diagnostics/backtest-service";
import { GET } from "./route";

vi.mock("@/lib/env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/features/silpo/demo/demo-gateway", () => ({ createDemoSilpoGateway: vi.fn() }));
vi.mock("@/features/diagnostics/backtest-service", () => ({ loadDemoBacktest: vi.fn() }));

const config: ServerEnv = {
  NODE_ENV: "test", DATA_MODE: "live", AGENT_MODEL: "gemini-3.7-flash",
  DATABASE_URL: "postgres://synthetic:synthetic@localhost/synthetic",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  GOOGLE_GENERATIVE_AI_API_KEY: "synthetic-test-key",
  PUBLIC_BASE_URL: "http://localhost:3000",
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getServerEnv).mockReturnValue(config);
});
it("B6-10 denies live mode before constructing any gateway", async () => {
  const response = await GET();
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "not_found" });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(createDemoSilpoGateway).not.toHaveBeenCalled();
  expect(loadDemoBacktest).not.toHaveBeenCalled();
});
```

- [x] Add demo success using `runRollingBacktest([], { activeCity: "Київ" })` as a schema-valid report fixture and a typed mock port obtained with `vi.importActual` of the demo adapter. Return `ok(report)` from the mocked service. Assert `200`, `{ mode: "demo", report }`, no-store, one factory call, and one service call with that gateway and a nonempty correlation ID.
- [x] Add `needs_slot → 409`, `invalid_external_data → 500`, `unexpected → 500`, configuration throw, and factory/service throw tests. Use a synthetic secret sentinel in thrown messages and assert it is absent from response text. Assert no-store for every status. Call GET first in live mode and then demo mode to prove mode is read per request rather than cached at import.
- [x] Run the route command. Expected red: missing route or concrete HTTP/mode behavior mismatch.
- [x] Implement the route with the following composition shape; use platform `Response.json` and the existing result contract, with safe error mapping from B6-10:

```ts
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };
```

`GET(): Promise<Response>` generates one UUID, reads `getServerEnv`, returns live 404 before gateway creation, constructs a demo gateway, awaits `loadDemoBacktest`, and maps success or typed errors. A catch block returns a safe `unexpected` AppError with that UUID. It must not include error contents or compute any metric. It exports no extra framework-unsupported route handlers or configuration keys.

- [x] Run route and service tests together; confirm all mock call-count assertions pass.

### 6.6 — Final verification, reviews, and commit

- [x] Run focused and cumulative checks from fresh invocations:

```bash
pnpm vitest run src/features/prediction/score.test.ts src/features/prediction/backtest.test.ts
pnpm vitest run src/features/diagnostics/backtest-service.test.ts src/app/api/backtest/route.test.ts
pnpm test
pnpm lint
pnpm typecheck
pnpm build
git diff --check
git diff -- src/features/prediction src/features/diagnostics src/app/api/backtest
```

Expected: all commands exit zero; build lists `/api/backtest` as dynamic and needs no real credentials during module import. Browser, responsive, model, and live-write tests are inapplicable to these files. Do not report them as run.

- [x] Review every B6 requirement against the mapping below. Inspect exports/imports, report privacy, schema consistency, denominator handling, and the dependency boundary. Confirm no fixture, shared-contract, package, or normalization edits slipped into Task 6.
- [x] Commit only the Task 6 files:

```bash
git add src/features/prediction/backtest.ts src/features/prediction/backtest.test.ts src/features/diagnostics/backtest-service.ts src/features/diagnostics/backtest-service.test.ts src/app/api/backtest/route.ts src/app/api/backtest/route.test.ts
git commit -m "feat: add rolling prediction backtest"
git rev-parse HEAD
```

- [x] Complete spec review, code-quality review, fixes, and controller rerun before marking Task 6 complete. Report changed files, command results, exact commit hash, synthetic-corpus limitations, and any remaining operational dependency. Task 17 can consume the validated report; it must not recalculate the metrics in UI code.

## Requirement-to-step traceability

| Requirement | Implementation/test slices | Acceptance source |
|---|---|---|
| P5-01 | 5.2 | Input, UTC bounds, validation, immutability. |
| P5-02 | 5.1–5.2 | Item filtering, observation support, null/zero IDs. |
| P5-03 | 5.2–5.3 | Versioned config, robust features, fresh city weights. |
| P5-04 | 5.3 | Familiar ID ordering and compatible quantities. |
| P5-05 | 5.4 | Scoring, thresholds, abstention, schema, ties. |
| P5-06 | 5.4–5.5 | Reasons, version, privacy. |
| P5-07 | 5.3–5.4 | Independently calculated numeric examples. |
| B6-01 | 6.1, 6.3 | Explicit city, valid input, determinism. |
| B6-02 | 6.1, 6.3 | Actual predictor call arguments and causal invariance. |
| B6-03 | 6.2 | Unique truth/prediction sets and top-K selection. |
| B6-04 | 6.2 | Fixed-K macro metrics, cold starts, null denominators. |
| B6-05 | 6.3 | Calibration boundaries and support. |
| B6-06 | 6.3 | Comparable weighted-frequency baseline. |
| B6-07 | 6.1–6.3 | Report schema, consistency, privacy. |
| B6-08 | 6.2–6.3 | Complete four-receipt oracle. |
| B6-09 | 6.4 | Actual fixture, corpus guards, read-only port, errors. |
| B6-10 | 6.5–6.6 | Mode isolation, HTTP mapping, no-store, build. |

## Planning handoff

This document and its spec are the reviewable planning deliverable. No production code is created by this planning change. Future execution should first read both documents and the applicable normative sources, then carry out Task 5 and Task 6 in order with their separate commit/review gates. Revise the spec before implementation if a documented formula, metric meaning, corpus precondition, or interface needs to change; do not silently adjust an implementation to a different interpretation.
