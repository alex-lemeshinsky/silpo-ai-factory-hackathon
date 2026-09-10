# Task 17 Demo Diagnostics and Sanitized MCP Trace Design

Status: approved design, 2026-09-10. Not yet implemented.

## 1. Scope and authority

This specification refines [Task 17](../../tasks.md#task-17-demo-diagnostics-and-sanitized-mcp-trace). It defines the repository's structured tracing mechanism, the redaction guarantees that mechanism enforces, the demo-only diagnostics aggregation built on top of it, and the collapsed panel that shows the result. [AGENTS.md](../../../AGENTS.md), the [product specification](../../product-spec.md), the [project architecture](../../project-architecture.md), and the [design system](../../design-system.md) retain precedence.

Task 17 owns:

- `src/lib/logger.ts`: the sanitized trace record, its redaction rules, and the logger factory;
- the `tool_traces` persistence port and its two implementations;
- the `SilpoGateway` tracing decorator that produces one trace per Silpo call;
- the run-level traces emitted by the draft service and the cart commit service;
- the persisted price a replacement decision overwrites today, so accepted-replacement savings is computable;
- `src/features/diagnostics/service.ts` and its decision read model;
- `GET /api/demo/diagnostics`;
- the collapsed «Як працює прогноз» panel and its placement in the dashboard.

Task 17 does not own the rolling backtest evaluator (Task 6), the demo backtest application service (Task 6), any prediction, product-resolution, approval, or cart-write behavior, or any change to what those paths compute. It adds observability around them and one narrow persistence field they already had the data for.

Task 17 changes no product behavior. Every existing test must pass unchanged; a test that needs weakening is a defect in this design, not in the test.

## 2. Baseline and dependency evidence

Inspected baseline: `9d04c5b` (`fix: resolve second-round Task 16 review findings`). The working tree is clean.

The required implementation is present:

- Task 6 supplies `runRollingBacktest`, `BacktestReport`, `BacktestMetrics`, `ConfidenceBucket`, and the `loadDemoBacktest` application service this task composes rather than reimplements.
- Task 7 supplies the `tool_traces` table with exactly the columns the observability section requires: `correlation_id`, `tool_name`, `mode`, `duration_ms`, `retry_count`, `sanitized_status`, `metadata`, `created_at`. It supplies no repository for that table; section 10 covers the consequence.
- Task 13 supplies `createDraftForUser` and its injected-dependency shape.
- Task 15 supplies `draft_items.user_decision`, written in the `approveSelection` transaction.
- Task 16 supplies `cart_commits.result` holding a `VerifiedCart`, and the `/api/backtest` route whose demo gate this task copies.

Fresh prerequisite evidence on 2026-09-10:

```text
pnpm vitest run src/features/prediction/backtest.test.ts src/features/diagnostics/backtest-service.test.ts \
  src/features/drafts/repository.test.ts src/features/cart/repository.test.ts
Test Files  4 passed (4)
Tests      89 passed (89)
```

One database migration is required (section 6). No package change and no shared-contract change is required. No network access is required: every test in this task is fixture- or fake-driven, apart from the optional real-Postgres gate in section 11.

## 3. Governing design decisions

| Decision | Selected approach and consequence |
|---|---|
| Redaction mechanism | Structural, not filtered. Unknown keys are stripped, surviving fields are enum- or pattern-constrained, and `metadata` admits no strings at all. Personal data is unrepresentable in a trace rather than removed from one. |
| Sanitization totality | `sanitizeTrace(input: unknown)` never throws. Every field carries a safe fallback, so a malformed call degrades that field instead of losing the trace and its evidence of a fault. |
| Single emission path | Console output serializes the same sanitized record that is persisted. There is no path that redacts one destination and not the other. |
| Failure isolation | `logger.toolCall` never throws and never rejects. A sink failure is swallowed, matching `recordOutcome` in the commit service: observability must not be able to fail a cart write. |
| Trace seam | A `SilpoGateway` decorator applied inside the two application services, immediately after the gateway is opened. One trace per gateway call, identical in live and demo, including the catalog calls made inside `resolveProducts` that a service-level span would never see. |
| Trace naming | Rows are named by gateway method (`loadPurchaseHistory`), not by MCP tool. The architecture's observability section specifies «tool/service name», and gateway methods are the only names that exist in both modes. |
| Retry count | Recorded as the service-level attempt count: `0` on a first run, `1` or more on an idempotent commit retry. MCP-internal retries are not surfaced; section 12 records why and what would close it. |
| Savings data | One nullable column, `draft_items.replaced_from_price`, written inside the approval transaction from the row it already locks. Without it the originally-proposed price is destroyed at approval and the metric the product specification names is permanently uncomputable. |
| Savings comparability | The stored value is the *effective* unit price (`specialPrice ?? price`), so both sides of the subtraction are the same kind of number. |
| Landed replacements | Savings counts only replacements present in the committed cart, decided by product-ID membership in the `VerifiedCart` persisted in `cart_commits.result`. This admits `partially_committed` commits rather than discarding them. |
| Absent denominators | The service returns `null`. The component renders «Недостатньо спостережень». Copy stays where the design system owns it and the payload stays data-only. |
| Degraded backtest | A failing backtest yields `backtest: null` and HTTP 200, plus an `error` trace. A diagnostics panel that returns 500 because a sub-report failed is less useful than one that says it has nothing to show. |
| Trace scope | Traces are not user-scoped. `tool_traces` carries no user column by design, and no field in a sanitized row distinguishes one visitor from another. |
| Identity | The route reads an existing demo cookie and never mints a user row. A read-only diagnostics GET must not create identities. |
| Panel disclosure | Native `<details>`/`<summary>`, collapsed, fetching on first expand only. A collapsed panel costs one element and no request. |

## 4. Trace contract and redaction

`src/lib/logger.ts` is framework-free: no database client, no React, no Next, no MCP SDK.

```ts
export const TRACE_STATUSES = ["ok", "error", "blocked"] as const;
export type TraceStatus = (typeof TRACE_STATUSES)[number];

export interface ToolTrace {
  correlationId: string;
  toolName: string;
  mode: DataMode;
  durationMs: number;
  retryCount: number;
  predictionVersion: string | null;
  status: TraceStatus;
  metadata: Record<string, number | boolean | null>;
}

export function sanitizeTrace(input: unknown): ToolTrace;

export interface ToolTraceSink {
  append(trace: ToolTrace): Promise<void>;
}

export interface Logger {
  toolCall(input: unknown): Promise<void>;
}

export function createLogger(options: {
  sink: ToolTraceSink;
  console?: Pick<Console, "info">;
  now?: () => Date;
}): Logger;
```

`toolCall` accepts `unknown` deliberately. A typed parameter would make the redaction guarantee a compile-time claim about callers; `unknown` makes it a runtime property of the logger, which is what the task's specimen test asserts and what a future caller cannot circumvent.

Four independent mechanisms enforce redaction. Each one alone is sufficient for the specimen test; together they leave no field through which personal data can reach either destination.

1. **Unknown keys are stripped.** The parse uses Zod's default strip behavior. `authorization`, `phone`, `address`, `email`, `barcode`, `profileId`, raw prompts, and raw MCP payloads have no field to land in. Nothing is rejected: a caller passing extra keys still produces a trace, minus those keys.
2. **Surviving fields are constrained.** `correlationId` is a UUID; `mode` and `status` are enums; `toolName` must match `/^[a-z][a-z0-9_]{0,63}$/i`; `predictionVersion` must match `/^[a-z0-9][a-z0-9._-]{0,31}$/i` or be `null`; `durationMs` is an integer in `[0, 600000]`; `retryCount` is an integer in `[0, 10]`. No field admits free text.

`mode` reuses `DataModeSchema` from `src/features/shared/contracts.ts` rather than declaring a parallel enum. That module imports nothing but `zod`, so the import creates no cycle and no runtime coupling beyond the schema itself.
3. **`metadata` admits no strings.** Values are `number | boolean | null`; keys match `/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/`. Counts, versions expressed as numbers, and flags are representable; text is not.
4. **Fallbacks, not exceptions.** Every field degrades individually to a safe default (`toolName` to `"unknown"`, `status` to `"error"`, numeric fields to `0`, `correlationId` to a fresh UUID, `predictionVersion` to `null`, `metadata` to `{}`). `sanitizeTrace` is total.

Two operational rules complete the contract:

- `toolCall` awaits the sink inside a `try`/`catch` that swallows every failure. It returns a resolved promise on every path.
- Console output is `console.info(JSON.stringify(sanitized))` using the same record instance that was persisted. The `console` dependency is injectable so tests observe it and the suite stays quiet.

## 5. Tracing seam

`src/features/diagnostics/traced-gateway.ts`:

```ts
export function withTracedGateway(
  gateway: SilpoGateway,
  options: { logger: Logger; correlationId: string; mode: DataMode; retryCount?: number; now?: () => number },
): SilpoGateway;
```

The decorator wraps every one of the thirteen `SilpoGateway` methods. For each call it records start time, awaits the underlying method, and emits one trace with `toolName` set to the method name, `durationMs` set to the elapsed whole milliseconds, and `status` set to `"ok"`. On a rejection it emits `status: "error"` and rethrows **the original error object**, unchanged and with its prototype intact: `McpCallError`, `InvalidExternalDataError`, and `ZodError` all drive existing failure mapping by `instanceof`, and a decorator that wrapped or replaced them would silently reclassify live failures.

A trace emission never delays or fails the call it describes. `toolCall` already cannot reject; the decorator additionally does not await it before returning the underlying result.

Method coverage is asserted mechanically rather than by a list a future method could be added without joining: the test enumerates the keys of a fully stubbed gateway and requires a trace from each.

Both application services apply the decorator immediately after opening the gateway, so every downstream consumer — including `resolveProducts`, which issues the majority of a run's Silpo calls — is traced without knowing tracing exists:

```ts
handle = await deps.openGateway({ mode: input.mode, userId: input.userId });
const gateway = withTracedGateway(handle.gateway, {
  logger: deps.logger, correlationId, mode: input.mode,
});
```

Each service then emits exactly one run-level trace on every terminal path, success or failure:

- `createDraftForUser`: `toolName: "draft_run"`, `predictionVersion` set to `PREDICTION_ALGORITHM_VERSION`, `metadata` carrying `itemCount`. `status` is `"ok"` for a returned draft and `"error"` for any `DraftFailure`.
- `commitApprovedDraft`: `toolName: "cart_commit"`, `metadata` carrying `itemCount` and `attempt`, `retryCount` set to `0` on a first attempt and `1` on a run that reused a persisted commit record. `status` is `"ok"` for `verified`, `"blocked"` for `partially_committed` or `blocked`, and `"error"` for a failure.

Both services take `logger` as an injected dependency defaulting to a no-op logger, so every existing test constructs them unchanged. The two route handlers supply the production logger, because that is where every other production dependency in this repository is constructed.

## 6. Schema additions

Migration `drizzle/0005_diagnostics_trace_fields.sql`:

```sql
ALTER TABLE "draft_items" ADD COLUMN "replaced_from_price" double precision;--> statement-breakpoint
ALTER TABLE "tool_traces" ADD COLUMN "prediction_version" text;
```

`tool_traces.prediction_version` exists because the architecture's observability contract and the task both require the prediction algorithm version in every trace, and `tool_traces` as shipped by Task 7 has nowhere to put it. It is not folded into `metadata`: that field admits no strings by design, and weakening the rule to carry one known-safe slug would remove the mechanism that makes personal data unrepresentable.

Both columns are nullable and neither is backfilled. A `draft_items` row written before this migration has no recoverable original price, and inventing one would corrupt the metric it exists to support.

`DraftRepository.approveSelection` already selects and locks the pre-update `draft_items` rows to validate `productId` and `version`. In the `replaced` branch only, it additionally writes `replacedFromPrice: row.specialPrice ?? row.price`. The `kept` and `removed` branches leave the column untouched. No new input reaches the repository and `PersistDraftApprovalInput` is unchanged, so the approval service, its validation, and its tests are untouched.

The domain `DraftItem` does **not** gain the field. It is a diagnostics read-model concern; the draft the user sees and approves is unaffected, `DraftSchema`'s total refinement is unaffected, and the in-memory repository's stored shape gains the field only in its private record type.

## 7. Diagnostics service and metric definitions

`src/features/diagnostics/decision-repository.ts` exposes a narrow read model rather than widening `DraftRepository`, which is per-draft and per-user by construction:

```ts
export interface DecisionTotals {
  decidedItemCount: number;
  keptItemCount: number;
  replacedItemCount: number;
  landedReplacements: Array<{ replacedFromPrice: number; effectivePrice: number; quantity: number }>;
}

export interface DecisionRepository {
  totalsForUser(userId: string): Promise<DecisionTotals>;
}
```

The Postgres implementation reads `draft_items` joined to `drafts` filtered by `drafts.mode = 'demo'`, `drafts.user_id = $userId`, and `draft_items.user_decision IS NOT NULL`, and joins `cart_commits` by draft to parse each stored result through `VerifiedCartSchema`. A replacement is *landed* when its `productId` appears in that cart's items; a row whose commit is absent, `pending`, or unparseable is not landed. A replaced row with a null `replaced_from_price` — written before the migration — contributes to `replacedItemCount` but never to `landedReplacements`.

`src/features/diagnostics/service.ts`:

```ts
export interface DecisionMetrics {
  decidedItemCount: number;
  acceptanceRate: number | null;
  replacementRate: number | null;
  acceptedReplacementSavings: number | null;
  landedReplacementCount: number;
}

export interface DiagnosticsReport {
  generatedAt: string;
  backtest: BacktestReport | null;
  decisions: DecisionMetrics;
  traces: Array<{ toolName: string; durationMs: number; status: TraceStatus; at: string }>;
}

export function buildDiagnostics(
  userId: string | null,
  deps: { gateway: SilpoGateway; decisions: DecisionRepository; traces: ToolTraceRepository; logger: Logger; correlationId: string; now?: () => Date },
): Promise<DiagnosticsReport>;
```

The task's specimen writes `diagnostics.build(demoUserId)`. This specification realizes it as the exported function `buildDiagnostics(userId, deps)`, matching every other application service in this repository, which is a function with an injected dependency object rather than a constructed object. Both specimen assertions are preserved verbatim; only the call shape differs.

Definitions, stated so no requirement admits two readings:

- **Denominator** for both rates is `decidedItemCount`: `draft_items` rows in demo-mode drafts owned by the resolved user whose `user_decision` is not null. Zero, or a null `userId`, yields `null` for all three product-decision metrics.
- **`acceptanceRate`** is `(keptItemCount + replacedItemCount) / decidedItemCount`. A replacement is an acceptance: the recommendation survived to the cart, even though the exact SKU changed.
- **`replacementRate`** is `replacedItemCount / decidedItemCount`.
- **`acceptedReplacementSavings`** is the sum over `landedReplacements` of `(replacedFromPrice − effectivePrice) × quantity`, rounded to two decimals. Its denominator is `landedReplacements.length`; zero yields `null`, which is distinct from a computed `0`. The sum is net and may be negative when the user chose a costlier replacement; the panel selects its copy from the sign.
- **Traces** are the twenty newest `tool_traces` rows with `mode = 'demo'`, newest first, exposing `toolName`, `durationMs`, `status`, and `createdAt` only. `correlationId` and `metadata` are persisted but never returned: the design system forbids identifiers in the panel and nothing in the panel needs them.
- **Backtest** delegates to `loadDemoBacktest`. A failure yields `backtest: null` and one `error` trace named `demo_backtest`; the report is still returned.

`buildDiagnostics` performs no redaction of its own. Every trace it returns was sanitized before it was persisted, and re-sanitizing on read would hide a persistence defect rather than prevent one.

## 8. Route

`GET /api/demo/diagnostics`, `runtime = "nodejs"`, `dynamic = "force-dynamic"`.

1. `DATA_MODE === "live"` returns `404` with `{ error: "not_found" }`, matching `/api/backtest` exactly.
2. The demo cookie is read with `isDemoHandle`; a valid handle yields `demoUserIdFor(handle)`, anything else yields `null`. `ensureDemoUser` is never called: this route creates no rows.
3. It composes the demo gateway, the Postgres decision and trace repositories, and the production logger, then returns `200` with the `DiagnosticsReport`.
4. Any unexpected failure returns `500` with a typed `AppError` carrying a fresh correlation ID and safe copy. No provider text, URL, header, or stack trace is echoed.

Headers are `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

## 9. Panel

`src/components/autopilot/demo-diagnostics.tsx`, a client component rendered by `draft-dashboard.tsx` only when `mode === "demo"`, last in the main region, matching the design system's fixed dashboard order.

- Native `<details>` with `<summary>«Як працює прогноз»`, collapsed by default. Disclosure state, keyboard operation, and screen-reader semantics come from the element rather than from bespoke ARIA.
- The report is fetched on first expand only and cached in state. A collapsed panel issues no request.
- Loading and failure are rendered as text; failure never relies on color alone.
- Backtest block: exact-SKU precision and recall, category precision and recall@3, receipt hit rate, coverage, and the two confidence buckets. Every `null` renders «Недостатньо спостережень».
- Decision block: acceptance rate, replacement rate, and savings. `null` renders «Недостатньо спостережень»; a non-null savings value renders «економія» when positive or zero and «додаткові витрати» when negative, with the absolute value.
- Trace table: a `<caption>`, and columns for tool, duration, and status. Status is text. No correlation ID, no metadata, no request or response body, no product or user identifier is rendered.
- The `<summary>` meets the 44×44 px target and shows a visible focus ring.

`draft-dashboard.tsx` gains the conditional render and nothing else. The panel fetches its own data, so it works against today's static dashboard shell and will keep working once the client draft story lands.

## 10. File ownership

Created:

| Path | In task file list | Justification if not |
|---|---|---|
| `src/lib/logger.ts` | yes | — |
| `src/features/diagnostics/service.ts` | yes | — |
| `src/app/api/demo/diagnostics/route.ts` | yes | — |
| `src/components/autopilot/demo-diagnostics.tsx` | yes | — |
| `src/features/diagnostics/trace-repository.ts` | no | Task 7 created `tool_traces` without a repository. The logger needs a sink, and `src/lib` must not import the database client. |
| `src/features/diagnostics/traced-gateway.ts` | no | The approved trace seam. It also keeps both application services free of per-call instrumentation. |
| `src/features/diagnostics/decision-repository.ts` | no | The metrics need aggregate reads across `draft_items` and `cart_commits`. `DraftRepository` is per-draft and per-user by design; widening a Task 15-owned interface for a demo-only reader is the worse trade. |
| `drizzle/0005_replaced_from_price.sql` | no | Without it, accepted-replacement savings is permanently uncomputable. See section 6. |

Modified:

| Path | Change |
|---|---|
| `src/features/drafts/service.ts` | Injected `logger`, gateway decoration, one run-level trace. |
| `src/features/cart/commit-service.ts` | Injected `logger`, gateway decoration, one run-level trace. |
| `src/components/autopilot/draft-dashboard.tsx` | Conditional demo-only panel render. |
| `src/db/schema.ts` | The `replacedFromPrice` column. |
| `src/features/drafts/repository.ts` | Writes `replacedFromPrice` in the `replaced` branch of `approveSelection`; the in-memory twin records it in its private shape. |
| `src/app/api/drafts/handlers.ts` | Constructs and injects the production logger. |
| `src/app/api/cart/commit/handlers.ts` | Constructs and injects the production logger. |
| `vitest.config.ts` | Excludes the new Postgres gate from `pnpm test`, by the same mechanism as the OAuth gate. |
| `docs/project-architecture.md` | Records the trace seam, the trace field contract, and the diagnostics report shape. |
| `docs/tasks.md` | Task 17 checkboxes. |

## 11. Test strategy and acceptance matrix

| Behavior | Test |
|---|---|
| Secrets and personal fields never reach a persisted trace | `src/lib/logger.test.ts` — the task's specimen assertion verbatim |
| Unknown keys are stripped, not rejected | `src/lib/logger.test.ts` |
| `metadata` rejects string values and malformed keys | `src/lib/logger.test.ts` |
| `sanitizeTrace` is total over hostile input (`null`, arrays, cyclic objects, huge strings) | `src/lib/logger.test.ts` |
| Console receives the same sanitized record that is persisted | `src/lib/logger.test.ts` |
| A sink failure never rejects `toolCall` | `src/lib/logger.test.ts` |
| Trace repository append and recent-ordering contract | `src/features/diagnostics/trace-repository.test.ts` |
| Every `SilpoGateway` method emits a trace, enumerated mechanically | `src/features/diagnostics/traced-gateway.test.ts` |
| A rejecting method emits `status: "error"` and rethrows the original error instance | `src/features/diagnostics/traced-gateway.test.ts` |
| A failing logger never breaks the underlying gateway call | `src/features/diagnostics/traced-gateway.test.ts` |
| Decision totals, landed-replacement rule, pre-migration null price | `src/features/diagnostics/decision-repository.test.ts` |
| Backtest and product-decision metrics are exposed in demo mode | `src/features/diagnostics/service.test.ts` — the task's specimen assertion |
| Absent denominators yield `null`, distinct from `0` | `src/features/diagnostics/service.test.ts` |
| Savings arithmetic, including a negative net | `src/features/diagnostics/service.test.ts` |
| A failing backtest yields `backtest: null` and still returns | `src/features/diagnostics/service.test.ts` |
| Collapsed by default; no request until expanded | `src/components/autopilot/demo-diagnostics.test.tsx` |
| `null` metrics render «Недостатньо спостережень» | `src/components/autopilot/demo-diagnostics.test.tsx` |
| No identifier, metadata, or payload is rendered | `src/components/autopilot/demo-diagnostics.test.tsx` |
| 404 in live mode; 200 and shape in demo mode; `no-store` | `tests/integration/demo-diagnostics-route.test.ts` |
| The route mints no user row | `tests/integration/demo-diagnostics-route.test.ts` |
| Migration applies; the column round-trips; both Postgres repositories behave | `tests/integration/diagnostics-postgres.test.ts` |

`tests/integration/diagnostics-postgres.test.ts` follows `tests/integration/silpo-oauth-postgres.test.ts`: excluded from `pnpm test` by the same `vitest.config.ts` mechanism and run explicitly against a throwaway cluster. It exists because this task adds a migration and two Postgres repositories, and the first real-Postgres run on this repository caught two defects that every in-memory test passed.

Focused command:

```bash
pnpm vitest run src/lib/logger.test.ts src/features/diagnostics/service.test.ts \
  src/components/autopilot/demo-diagnostics.test.tsx tests/integration/demo-diagnostics-route.test.ts
```

Cumulative gates: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`.

## 12. Known gaps and limitations

- **MCP-internal retries are not counted.** `withBoundedRetry` counts attempts privately inside `McpSession.callTool`, and one gateway span may wrap several MCP calls, so a per-span retry count would be ill-defined. `retryCount` therefore records service-level attempts only. Surfacing the real count means threading an attempt callback out of `session.ts` and `retry.ts`, which belongs to the task that owns those files.
- **Trace rows are named by gateway method, not by MCP tool.** Demo mode has no MCP session, so tool-level names exist on only one of the two paths the panel must serve.
- **Traces are global to demo mode.** Two demo visitors on one deployment see the same trace rows. Nothing in a sanitized row distinguishes them, and adding a user column to a table designed to carry no identifier would be a worse outcome than the disclosure it prevents.
- **Savings is blind to drafts approved before migration 0005.** Those rows count toward the replacement rate and never toward savings.
- **Removed items carry no price history.** Only replacements persist their prior price, because only replacements need one. A future metric over removals would need its own field.

## 13. Documentation and handoff

`docs/project-architecture.md` gains, in the same commit: the trace seam and its position in the dependency direction, the four redaction mechanisms as an enforced contract, the `retryCount` limitation, and the diagnostics report shape. Section 11's observability list is reconciled with what is actually emitted.

`docs/tasks.md` Task 17 checkboxes are ticked by the coordinator on integration.

The handoff report names: changed files, the commands run with their fresh output, whether the Postgres gate was run and against what, and every item in section 12.

## 14. Definition of done

1. Every acceptance row in section 11 has a passing test that failed first for the expected reason.
2. The focused command and all four cumulative gates pass with fresh output.
3. No test that existed at `9d04c5b` was weakened or deleted.
4. No `TODO`, `TBD`, or placeholder remains in a committed plan or production path.
5. `git diff` shows no secret, no guessed object shape, no duplicated abstraction, and no file outside section 10.
6. `docs/project-architecture.md` reflects the delivered behavior.
7. One focused commit: `feat: expose sanitized demo diagnostics`.
