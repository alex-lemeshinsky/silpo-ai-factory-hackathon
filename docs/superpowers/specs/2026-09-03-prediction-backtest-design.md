# Tasks 5–6 Prediction and Rolling Backtest Specification

Status: specified for review on 2026-09-03; implementation has not started.

## 1. Scope and authority

This specification refines [Task 5 and Task 6](../../tasks.md#task-5-prediction-feature-extraction-and-scoring). It defines observable behavior; the [implementation plan](../plans/2026-09-03-prediction-backtest.md) defines execution and evidence. It does not supersede [AGENTS.md](../../../AGENTS.md), the [product specification](../../product-spec.md), [project architecture](../../project-architecture.md), or [agent architecture](../../agent-architecture.md).

Task 5 produces deterministic category needs from normalized purchases. Task 6 measures those needs against subsequent receipts and exposes a synthetic demo report. These tasks are sequential: the evaluator must exercise the production predictor.

Excluded: catalog resolution, model calls, persistence, approval, cart writes, checkout, UI, online acceptance/replacement/savings metrics, tuning weights against the evaluation set, and real customer data in diagnostics. Tasks 7, 11–13, and 17 retain those responsibilities. A score is a heuristic confidence, not a calibrated probability or proof that a product is in stock.

## 2. Repository evidence and dependency gates

Inspected baseline: `af53dae` (`feat: normalize purchase history`). The working tree was clean. Tasks 1–4 are integrated; Task 5 is pending; Task 6 must wait for Task 5's reviewed commit.

| Existing boundary | Consequence for this work |
|---|---|
| `NormalizedReceiptSchema`, `NeedFeaturesSchema`, `NeedCandidateSchema` in `src/features/shared/contracts.ts` | Reuse them unchanged. `NeedCandidate` already requires `features`; the abbreviated backlog example is not its complete shape. |
| `normalizePurchases(receipts, activeCity, cutoff)` | It filters inclusively to the preceding 180 days. Do not normalize a multi-year evaluation corpus once at its final date and claim to evaluate earlier history. |
| `NormalizedReceipt.locationWeight` | It reflects the city used during normalization. Prediction recalculates weights from the explicitly supplied active city, without mutating receipts. |
| `createDemoSilpoGateway(): SilpoGateway` | The demo endpoint uses this validated, synthetic source through an injected port. |
| `getServerEnv()` | This remains the only environment reader. It is called at request time, not module import time. |
| No existing `BacktestReport` or diagnostics service | Define the report next to the evaluator, and a small application service under diagnostics. Do not modify frozen shared contracts. |

The current demo snapshot has 30 receipts from 2026-03-10 to 2026-08-31, a span below 180 days, and a minimum inter-receipt gap above four hours. Section 7 specifies how the service verifies these properties before using the existing normalizer.

Fresh prerequisite evidence during planning: `pnpm vitest run src/features/shared/contracts.test.ts src/lib/env.test.ts src/features/silpo/demo/demo-gateway.test.ts src/features/purchases/normalize.test.ts` passed 38 tests in four files. This is prerequisite evidence, not proof that Tasks 5–6 are implemented.

## 3. Design decisions

| Decision | Selected approach and trade-off |
|---|---|
| Prediction | Median/MAD heuristics with explicit versioned constants. This uses the approved architecture and is inspectable; learned models would add unsupported infrastructure and tuning risk. |
| Observation | One category or SKU occurrence per distinct purchase timestamp, after service filtering. Multiple lines and simultaneous receipts cannot inflate recurrence. A wider shopping-session heuristic is optional in the architecture and is deferred. |
| Evaluation | One chronological holdout per eligible receipt, including cold starts. Random train/test splits violate temporal causality; omitting abstentions would inflate results. |
| Endpoint | Route → application service → pure evaluator. Putting demo imports or environment reads in prediction would violate the domain boundary. |
| Report ownership | Feature-local Zod schema and inferred types. Moving it into frozen shared contracts is unnecessary. |

The formulas and metric definitions below fill previously unspecified details. They retain the required observation minima, city weights, confidence weights, history limit, and thresholds. Changes to these decisions require a version change and renewed evaluation; do not silently tune them during implementation.

## 4. Global constraints

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

## 5. Task 5 requirements

### P5-01 — Inputs, time, and purity

Public input:

```ts
interface InferNeedsInput {
  receipts: NormalizedReceipt[];
  now: string | Date;
  activeCity: string;
}
```

Parse receipts with the existing schema; reject invalid dates, a blank active city, and repeated `externalFingerprint` values. A string date must be an ISO datetime with a timezone. Accept a valid `Date` by copying its timestamp. Do not use the wall clock, locale-dependent date parsing, randomness, or in-place sorting. Invalid data throws a validation error; it is distinct from valid but insufficient history, which returns `[]`.

Use elapsed UTC milliseconds with `DAY_MS = 86_400_000`, including fractional days. The inference window is inclusive: `now - 180 × DAY_MS <= purchasedAt <= now`. Future events and events one millisecond before the lower bound are excluded. Timestamp comparisons use numeric instants, not ISO string ordering.

### P5-02 — Eligible items and observations

Reuse `isServiceItem` from purchases to exclude service rows even if a caller labels them as a grocery category. Exclude `categoryKey === "uncategorized"`; do not infer a category from an ID or use an LLM.

Group remaining items by category and timestamp. Each timestamp counts once toward category support. For each non-null external ID, count distinct timestamps within that category; repeated lines do not increase SKU support. A null ID may contribute to its known category but never to exact-SKU candidates. ID `0` is valid under the shared schema.

If multiple receipts at the same timestamp contribute to a category or SKU, its observation weight is `1.0` if any contributing receipt matches the active city, otherwise `0.35`. City comparison uses trimmed, lowercased strings, matching the normalizer; null cities never match. Category support is an unweighted integer, separate from weighted evidence. Require three category timestamps and two SKU timestamps, inclusive. Do not add another four-hour deduplication algorithm to prediction.

### P5-03 — Features and versioned formulas

`PREDICTION_ALGORITHM_VERSION = "prediction-v1"`. Export an immutable `PREDICTION_CONFIG` from `features.ts` containing the history limit, support minima, city weights, `repeatSaturation = 5`, confidence weights, and thresholds. Scoring and backtest consume it rather than repeating literals.

For sorted category observations `t[0] ... t[n-1]`, with `n >= 3`:

| Feature | Definition |
|---|---|
| `weightedPurchaseCount` | Sum of category observation weights. |
| `medianIntervalDays` | Median of the `n - 1` positive adjacent timestamp differences divided by `DAY_MS`. For even length, average the middle two values. |
| `intervalMadDays` | Median of the absolute distances of those intervals from their median. |
| `daysSinceLastPurchase` | `(now - t[n - 1]) / DAY_MS`. |
| `activeCityShare` | Number of category observations with weight `1.0`, divided by `n`. |
| `dueScore` | `clamp01(daysSinceLastPurchase / medianIntervalDays)`. |
| `repeatScore` | `clamp01(weightedPurchaseCount / 5)`. |
| `stabilityScore` | `clamp01(1 - intervalMadDays / medianIntervalDays)`. |

Simultaneous observations are collapsed before intervals are calculated, so eligible categories cannot have a zero median. If any computed feature is non-finite, reject the calculation rather than returning an invalid candidate. Counts, intervals, MAD, elapsed days, and quantities remain unrounded; only the three score components are clamped. Tests use numeric tolerances.

### P5-04 — Familiar SKU ordering and quantity

Within each eligible category, keep external IDs with at least two timestamps. Sort by descending weighted SKU count, descending last purchase timestamp, then ascending numeric ID. Return unique IDs in `preferredExternalProductIds`; an empty list does not remove an otherwise eligible category. These are historical preferences, not claims about current catalog availability.

Calculate `typicalQuantity` without mixing incompatible units:

1. If the first preferred SKU has exactly one known unit across all its occurrences, sum its line quantities per timestamp and take the median of those sums.
2. Otherwise, if every category item uses the same non-null unit, sum category quantities per timestamp and take their median.
3. Otherwise, return the conservative proposal `1` and include `quantity_uncertain`.

Do not convert units, infer package sizes, round to integer pieces, or extrapolate quantities from elapsed cycles. Quantity is advisory history evidence; Task 11's product resolution and later approval/commit still validate current stock, unit compatibility, and `step` before a cart write. These tasks create no executable cart quantities.

### P5-05 — Scoring, abstention, and output

```ts
scoreNeed(input: { due: number; repeat: number; stability: number }): number;
toConfidenceBand(confidence: number): "medium" | "high" | null;
inferNeeds(input: InferNeedsInput): NeedCandidate[];
```

`scoreNeed` rejects non-finite components, clamps each finite input to `0..1`, then applies the specified weighted sum. `toConfidenceBand` rejects non-finite or out-of-range confidence, returns `null` below `0.55`, and otherwise uses the exact thresholds without display rounding.

`inferNeeds` emits only candidates passing the category threshold and confidence threshold. Validate emitted candidates with `NeedCandidateSchema`. Sort by descending unrounded confidence, then ascending category key using a locale-independent string comparison. Do not impose the later draft's ten-item limit in the predictor.

### P5-06 — Explainability and future persistence

Emit unique reason codes in this fixed order, including each only when its condition holds:

| Code | Condition |
|---|---|
| `category_repeat` | Always for an emitted category. |
| `cycle_due` | `dueScore === 1`. |
| `stable_cycle` | `stabilityScore >= 0.75`. |
| `familiar_sku` | At least one preferred external ID. |
| `other_city_history` | `activeCityShare < 1`. |
| `quantity_uncertain` | The quantity fallback in P5-04 was used. |

The output includes all eight existing `NeedFeatures` fields. It contains no receipt IDs, raw names, precise locations, or customer identifiers. Future DraftService persistence uses the exported algorithm version and the inference `now` as `trainingCutoff`; Task 5 does not add a database or change `NeedCandidate` to carry run metadata.

### P5-07 — Numerical acceptance examples

At day 21, active-city water purchases on days 0, 7, and 14 give count `3`, interval `7`, MAD `0`, elapsed `7`, active share `1`, due `1`, repeat `0.6`, stability `1`, confidence `0.86`, band `high`. With quantity `2` and the same SKU/unit each time, typical quantity is `2`.

The same purchases entirely outside the active city give weighted count `1.05`, repeat `0.21`, confidence `0.7235`, and band `medium`. At day 14 the active-city example scores `0.46` and abstains. Two category timestamps always abstain, regardless of score. Intervals `[2, 4, 8, 10]` give median `6` and MAD `3`.

The backlog's helper example remains exact: `scoreNeed({ due: 1, repeat: 0.5, stability: 0.25 }) = 0.6375`.

## 6. Task 6 domain requirements

### B6-01 — Explicit evaluation context and public API

```ts
interface BacktestOptions { activeCity: string }
runRollingBacktest(
  receipts: NormalizedReceipt[],
  options: BacktestOptions,
): BacktestReport;
```

The required city refines the backlog's incomplete one-argument sketch. There is no reliable way to recover the active city from old weights; inferring it from a future receipt would leak evaluation context. Use the caller's fixed city for every fold. No installed shared contract changes.

The evaluator owns `BacktestReportSchema` and its inferred type in `backtest.ts`. It validates receipts/options, requires unique fingerprints, copies input before sorting, and has no gateway, fixture, framework, environment, or database dependency. Its results are deterministic under input permutations.

### B6-02 — Eligible targets and causal folds

Filter target rows by the same service/known-category policy as prediction. A receipt with no eligible category rows is skipped and counted in `skippedReceiptCount`. Each other receipt is a target, including the first receipt and cold starts. Receipts with equal timestamps remain separate targets, ordered by fingerprint; none can train on another at that timestamp.

For target instant `T`:

- Set `testDate = ISO(T)` and `trainingCutoff = ISO(T - 1 millisecond)`.
- Use only receipts with `T - 180 × DAY_MS <= purchasedAt < T` for training.
- Call the real `inferNeeds({ receipts: training, now: testDate, activeCity })`. Using the target time as the prediction time preserves due-score semantics; excluding the target from input enforces causality.
- Keep all windows, including those with empty training or no predictions.
- Record training receipt counts before item filtering, including valid empty receipts. They are audit metadata, not recurrence counts.

Target items, quantities, city, and future receipts cannot influence predictions, SKU preferences, baseline ranking, or confidence. Tests must prove this from actual predictor inputs and unchanged predictions, not merely from a reported cutoff string.

The domain API assumes normalized receipts contain only evidence available at their timestamp. It cannot reverse look-ahead merges performed by an upstream importer. The demo service verifies the corpus conditions in B6-09; broader raw-history replay requires causal normalization before this API.

### B6-03 — Prediction and truth sets

`categoryK = 3` and `exactK = 3` are fixed report metadata in evaluator version `rolling-v1`.

- Category predictions are the first three needs in `inferNeeds` order, with their confidence.
- Exact-SKU predictions walk all needs in score order, take only the first preferred ID of each need, skip missing IDs and duplicate IDs, and stop at three. Alternative IDs are not extra recommendations and must not inflate hits.
- Actual categories are the unique eligible target category keys.
- Actual SKUs are the unique non-null external IDs of eligible target rows. Quantity and duplicate lines do not multiply hits. A target with no such ID remains eligible for category evaluation but is omitted from exact-SKU aggregates.

This measures historical familiar-SKU selection. It does not measure resolver availability, alternative acceptance, or checkout success.

### B6-04 — Metrics and denominators

All summary metrics are macro averages over their eligible windows unless otherwise stated. For each eligible target:

| Metric | Definition |
|---|---|
| Category precision@3 | `categoryHits / 3`, including when fewer than three predictions are emitted. |
| Category recall@3 | `categoryHits / actualCategoryCount`. |
| Exact-SKU precision@K | `exactSkuHits / 3`, only when the target has at least one known external ID. |
| Exact-SKU recall@K | `exactSkuHits / actualExternalProductCount`, with the same eligibility. |
| Receipt hit rate | Windows with at least one category hit divided by all category-eligible windows. |
| Coverage | Windows with at least one category prediction divided by all category-eligible windows. |

Abstention therefore contributes zero to precision, recall, hit rate, and coverage when ground truth exists. Fixed-K precision deliberately penalizes underfilled lists; recall describes how much of the receipt was covered. Category and exact precision must not be conflated.

An empty input, or all skipped targets, yields empty windows and `null` summary metrics. Zero hits with eligible targets yields `0`. Empty exact ground truth yields `null` exact aggregates if there are no other exact-eligible targets. Emit no `NaN`, infinities, fabricated sample counts, or hard-coded reference percentages.

### B6-05 — Calibration

Calibrate only the selected top-three category predictions actually evaluated. Return exactly two buckets in order: `medium` (`[0.55, 0.75)`) and `high` (`[0.75, 1]`). Each carries prediction count, mean confidence, and observed frequency (`category hits in the bucket / prediction count`). An empty bucket has count `0` and both values `null`. Baseline predictions have no probabilistic confidence and do not enter these buckets.

### B6-06 — Comparable 90-day baseline

For each target, independently count category and SKU occurrences in `[T - 90 × DAY_MS, T)`, using the same item exclusions, distinct-timestamp observation rule, city weights, and support minima as Task 5. Rank eligible categories and SKUs by descending weighted occurrence count, then ascending category key or numeric ID. Take three of each. Do not apply due/MAD scoring, use future data, or derive the baseline from predictor output.

Use the same target sets, fixed-K denominators, cold starts, and macro aggregation for both systems. Baseline version is `frequency-90d-v1`; its definition includes weighted frequency and the common minimum-support policy. Report this metadata so consumers cannot mistake it for an unrestricted frequency baseline.

### B6-07 — Report schema

The following is the serialized shape; define it with strict Zod schemas and infer the implementation types. Reuse `ConfidenceBandSchema`. Non-null metric fields must use finite `0..1` validation, counts must be non-negative integers, and category/SKU predictions must be unique and limited to three.

```ts
interface BacktestMetrics {
  exactSkuPrecisionAtK: number | null;
  exactSkuRecallAtK: number | null;
  categoryPrecisionAt3: number | null;
  categoryRecallAt3: number | null;
  receiptHitRate: number | null;
  coverage: number | null;
}

interface WindowPrediction {
  categories: Array<{ categoryKey: string; confidence: number | null }>;
  externalProductIds: number[];
  categoryHits: number;
  exactSkuHits: number;
}

interface BacktestWindow {
  testDate: string;
  trainingCutoff: string;
  trainingReceiptCount: number;
  baselineTrainingReceiptCount: number;
  actualCategoryCount: number;
  actualExternalProductCount: number;
  prediction: WindowPrediction;
  baseline: WindowPrediction;
}

interface ConfidenceBucket {
  confidenceBand: "medium" | "high";
  predictionCount: number;
  meanConfidence: number | null;
  observedFrequency: number | null;
}

interface BacktestReport {
  algorithmVersion: "prediction-v1";
  evaluationVersion: "rolling-v1";
  baselineVersion: "frequency-90d-v1";
  categoryK: 3;
  exactK: 3;
  historyWindowDays: 180;
  baselineWindowDays: 90;
  inputReceiptCount: number;
  evaluatedReceiptCount: number;
  skippedReceiptCount: number;
  exactSkuWindowCount: number;
  windows: BacktestWindow[];
  prediction: BacktestMetrics;
  baseline: BacktestMetrics;
  confidenceBuckets: ConfidenceBucket[];
}
```

Validate report consistency: counts match windows and sum to the input count; `trainingCutoff < testDate`; hits do not exceed predictions or actual set sizes; model confidences are in `[0.55, 1]`; baseline confidences are null; bucket counts match evaluated category predictions; empty denominators have null values. No raw receipts, fingerprints, source IDs, private fields, or checkout URLs enter the report.

### B6-08 — Hand-computable oracle

Use one SKU `101`, one category `water`, quantity `2`, and active-city receipts at days `0, 7, 14, 21`. All four receipts are evaluation windows. The first three abstain under the support rule; the fourth predicts water and SKU 101 with confidence `0.86`.

Predictor summary: category and exact precision `1/12`, category and exact recall `1/4`, hit rate `1/4`, coverage `1/4`. The high bucket has one prediction, mean confidence `0.86`, observed frequency `1`; the medium bucket is empty with null values.

The baseline first predicts SKU 101 at day 14 (two prior SKU observations), and first predicts water at day 21 (three category observations). Baseline exact precision is `1/6` and recall `1/2`; baseline category metrics, hit rate, and coverage equal the predictor in this fixture. These values test aggregation independently of the implementation.

## 7. Task 6 application requirements

### B6-09 — Demo service and normalization boundary

Create `src/features/diagnostics/backtest-service.ts`. Export:

```ts
loadDemoBacktest(
  gateway: SilpoGateway,
  correlationId: string,
): Promise<Result<BacktestReport, AppError>>;
```

The route constructs a fresh demo gateway and injects it. The service reads cart context, requires a ready context with a nonblank city, then loads purchase history. Revalidate returned domain data with existing schemas and require unique receipt source IDs; no shape guessing. A needs-slot context returns `needs_slot` without loading history or changing context.

For this fixed synthetic demo corpus, validate that the entire history spans at most 180 days and that every pair of adjacent sorted raw receipts is more than four hours apart. The current snapshot satisfies both. These explicit corpus preconditions prevent the existing normalizer's final-cutoff filtering or cross-receipt merge from silently invalidating evaluation. Return `invalid_external_data` if either condition fails; do not silently truncate or globally deduplicate a changed corpus. Tests enforce the preconditions so future fixture extensions require a deliberate causal-import design.

For nonempty valid history, normalize with the ready context's city and the greatest purchase timestamp, then call `runRollingBacktest(normalized, { activeCity: context.city })`. For empty history, call the evaluator with `[]` without deriving an invalid maximum date. The system date and the demo delivery-slot calendar do not affect historical results. No live slot validation or MCP protocol change is part of this synthetic endpoint.

Return `ok(report)` on success. Schema/corpus failures map to `invalid_external_data`; other thrown failures map to `unexpected`; preserve the supplied correlation ID and use safe Ukrainian messages without exception contents. `retryAfterMs` is null. Do not log raw data or fabricate success after failure.

The service may call only `loadCartContext` and `loadPurchaseHistory`. It does not call customer context, catalog, mutation, live, model, or database capabilities. The corpus checks are a limitation of this bounded demo importer, not a claim that the domain evaluator rejects longer normalized histories.

### B6-10 — HTTP behavior and privacy

`GET /api/backtest` is dynamic, uses the Node.js runtime for existing normalization, and returns `Cache-Control: no-store` on every response. It reads `getServerEnv()` on the request path; it never reads raw `process.env` or accepts a client-supplied mode, city, history, or cutoff.

| Condition | Response |
|---|---|
| Valid server configuration, `DATA_MODE=live` | `404`, body `{ "error": "not_found" }`; no demo gateway construction or history access. |
| `DATA_MODE=demo`, successful service | `200`, body `{ "mode": "demo", "report": BacktestReport }`. |
| Demo context needs a slot | `409`, body `{ "error": AppError }` with `needs_slot`. |
| Invalid fixture/domain data or invalid server configuration | `500`, safe `{ "error": AppError }`. |
| Unexpected dependency failure | `500`, safe `{ "error": AppError }` with `unexpected`. |

Generate a correlation ID once per request using the platform UUID facility and pass it to the service. Treat invalid server configuration as `unexpected`; do not expose `getServerEnv()` error text. Live-mode 404 is promised for valid server configuration; the existing environment parser still requires its documented keys.

The route contains only configuration/composition, service invocation, and HTTP mapping. It must not calculate folds, scores, or metrics. Its output is explicitly labeled demo. Task 17 owns visible UI labels and rendering null metrics as «Недостатньо спостережень».

## 8. Acceptance and verification map

Each ID is an acceptance obligation. The plan maps it to a red-green step and exact file. Test titles should include the IDs for durable traceability.

| Requirement | Observable evidence |
|---|---|
| P5-01 | Invalid input rejects; lower boundary and fractional UTC offsets work; future data and mutation are absent. |
| P5-02 | Two category observations abstain; repeated lines and same-time receipts do not inflate support; unknown/service rows excluded; null and zero IDs distinguished. |
| P5-03 | Hand-calculated median, MAD, weighted count, city share, and three components match, including changed active city. |
| P5-04 | Preferred IDs obey support and tie order; compatible quantity medians and mixed-unit fallback are correct. |
| P5-05 | Weight example, clamp behavior, thresholds, schema conformance, and deterministic category ties pass. |
| P5-06 | Exact reason-code conditions/order and version constant are asserted. |
| P5-07 | Three concrete numerical examples pass. |
| B6-01 | Required active city, invalid data, permutation determinism, and pure imports are verified. |
| B6-02 | Predictor input excludes held-out, equal-time, future, and stale receipts; future poisoning and target mutation leave prior predictions unchanged. |
| B6-03 | Top-K selection, unique IDs, known-category policy, null-ID targets, and replacement-list inflation are tested. |
| B6-04 | Fixed-K and macro metrics, cold starts, empty history, all skipped targets, and zero-versus-null semantics pass. |
| B6-05 | Medium/high boundaries and empty/calibrated buckets pass. |
| B6-06 | Independent 90-day bounds, support minima, weights, and deterministic frequency ties pass. |
| B6-07 | Runtime report schema rejects inconsistent metadata, invalid hits, confidences, and leaked fields. |
| B6-08 | The four-receipt oracle matches all predictor and baseline metrics. |
| B6-09 | Actual demo adapter produces a repeatable report; service validates corpus, short-circuits failures, and uses only two read methods. |
| B6-10 | Route tests prove demo response, live 404 with zero gateway access, no-store, request-time configuration, and safe error mapping. |

Task 5 gate: focused scoring tests, all completed prerequisite tests, `pnpm lint`, and `pnpm typecheck`. Task 6 adds evaluator/service/route tests, the full unit suite, static checks, and `pnpm build`. These tasks add no UI, so browser/responsive tests and live/write smoke are not applicable. A build smoke proves route registration; route tests prove behavior.

Review order remains implementer → spec reviewer → code-quality reviewer → implementer fixes → controller verification/integration. Commit only scoped files and report commands, results, limitations, and exact hashes. Do not mark the backlog complete during planning.
