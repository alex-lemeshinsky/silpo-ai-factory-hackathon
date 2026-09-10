# Demo Diagnostics and Sanitized MCP Trace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Silpo call a structurally redacted trace, persist those traces, and expose a demo-only diagnostics report and collapsed «Як працює прогноз» panel combining rolling-backtest metrics, product-decision metrics, and sanitized `tool / duration / status` rows.

**Architecture:** `src/lib/logger.ts` owns a total sanitizer whose redaction is structural: unknown keys are stripped, surviving fields are pattern- or enum-constrained, and the metadata map admits no strings at all. A `SilpoGateway` decorator applied inside the draft and cart-commit services emits one trace per gateway call in both live and demo mode, and each service emits one run-level trace. A migration adds the two columns the metrics and the trace contract need. A diagnostics application service composes the existing `loadDemoBacktest` with a narrow decision read model and recent traces; a demo-only route and a lazily-fetching `<details>` panel expose it.

**Tech Stack:** TypeScript 5.9, Next.js 16 App Router, React 19, Zod 4, Drizzle ORM with Postgres, Vitest 4, Testing Library.

**Spec:** [docs/superpowers/specs/2026-09-10-demo-diagnostics-design.md](../specs/2026-09-10-demo-diagnostics-design.md)

## Global Constraints

- Use `pnpm` exclusively. This task adds no dependency and no environment variable. It adds exactly one migration, `drizzle/0005_diagnostics_trace_fields.sql`, containing exactly two `ALTER TABLE ... ADD COLUMN` statements.
- `SILPO_MCP.md` is a read-only integration contract. Do not edit it.
- Stage files explicitly. Never use `git add .`. Preserve any user-owned working-tree change.
- Work on `main`, which is where this repository integrates tasks.
- All slices below form one repository backlog task and end in **one** final commit with the message documented in `docs/tasks.md`: `feat: expose sanitized demo diagnostics`.
- This task changes no product behavior. Every test that passes at baseline `0a5c3f8` must still pass, unmodified, except where a slice below explicitly extends a test file with new cases. Weakening an existing assertion is a defect in this plan, not in the test.
- `src/lib/logger.ts` imports `zod` and, type- and schema-only, `@/features/shared/contracts`. It must not import a database client, React, Next.js, the MCP SDK, or the AI SDK.
- `src/features/purchases` and `src/features/prediction` stay untouched and framework-free.
- No test in this task opens a network connection or requires a database, except `tests/integration/diagnostics-postgres.test.ts`, which is excluded from `pnpm test` and run explicitly.
- Redaction is structural, never a denylist. Do not write a list of forbidden key names anywhere: unknown keys are stripped by the schema and `metadata` admits no strings, so no denylist can be forgotten or outgrown.
- `logger.toolCall` must never throw and never reject on any input or any sink failure. Observability must not be able to fail a draft run or a cart write.
- The tracing decorator rethrows the original error instance unchanged. `McpCallError`, `InvalidExternalDataError`, `UnadvertisedToolError`, and `ZodError` all drive existing failure mapping through `instanceof`.
- Ukrainian user-facing copy is exact as written in this plan.
- Absent denominators produce `null`, never `0`. The API returns `null`; the component renders «Недостатньо спостережень».
- `GET /api/demo/diagnostics` returns `404` in live mode and never creates a `users` row.
- The panel renders no correlation ID, no metadata, no request or response body, and no product or user identifier.

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/db/schema.ts` | Modify | Add `draftItems.replacedFromPrice` and `toolTraces.predictionVersion`. |
| `src/db/schema.test.ts` | Modify | Prove both columns exist with the expected snake_case names and nullability. |
| `drizzle/0005_diagnostics_trace_fields.sql` | Create | The two `ADD COLUMN` statements. |
| `src/lib/logger.ts` | Create | `ToolTrace`, `sanitizeTrace`, `ToolTraceSink`, `Logger`, `createLogger`, `createNoopLogger`. |
| `src/lib/logger.test.ts` | Create | Redaction, totality, metadata typing, console parity, sink-failure isolation. |
| `src/features/diagnostics/trace-repository.ts` | Create | `ToolTraceRepository` port plus in-memory and Postgres implementations. |
| `src/features/diagnostics/trace-repository.test.ts` | Create | Append, recency ordering, limit, and the sanitized read projection. |
| `src/features/diagnostics/traced-gateway.ts` | Create | `withTracedGateway`: one trace per `SilpoGateway` method. |
| `src/features/diagnostics/traced-gateway.test.ts` | Create | Mechanical method coverage, error identity, isolation from logger faults. |
| `src/features/drafts/service.ts` | Modify | Injected `logger`, gateway decoration, one `draft_run` trace. |
| `src/features/drafts/service.test.ts` | Modify | Prove the run trace and the decoration, without touching existing cases. |
| `src/features/cart/commit-service.ts` | Modify | Injected `logger`, gateway decoration, one `cart_commit` trace. |
| `src/features/cart/commit-service.test.ts` | Modify | Prove the commit trace status mapping and retry count. |
| `src/features/cart/repository.ts` | Modify | Export `StoredCommitResultSchema`, so the decision reader parses the same persisted shape the commit writes. |
| `src/features/drafts/repository.ts` | Modify | Write `replacedFromPrice` in the `replaced` branch of `approveSelection`. |
| `src/features/drafts/repository.test.ts` | Modify | Prove the price is captured on replace and left null on keep and remove. |
| `src/features/diagnostics/decision-repository.ts` | Create | `DecisionRepository`: demo-mode decision totals and landed replacements. |
| `src/features/diagnostics/decision-repository.test.ts` | Create | Totals, landed rule, and the pre-migration null-price case. |
| `src/features/diagnostics/service.ts` | Create | `buildDiagnostics`: backtest, decision metrics, recent traces. |
| `src/features/diagnostics/service.test.ts` | Create | Metric definitions, null denominators, negative savings, degraded backtest. |
| `src/app/api/demo/diagnostics/route.ts` | Create | Mode gate, identity read, composition, HTTP mapping. |
| `tests/integration/demo-diagnostics-route.test.ts` | Create | 404 in live, 200 shape in demo, headers, no row creation. |
| `src/components/autopilot/demo-diagnostics.tsx` | Create | The collapsed, lazily-fetching panel. |
| `src/components/autopilot/demo-diagnostics.test.tsx` | Create | Collapsed default, lazy fetch, null copy, disclosure safety. |
| `src/components/autopilot/draft-dashboard.tsx` | Modify | Render the panel last, demo mode only. |
| `src/components/autopilot/draft-dashboard.test.tsx` | Modify | Prove presence in demo and absence in live. |
| `src/app/globals.css` | Modify | Panel styles, using existing tokens only. |
| `vitest.config.ts` | Modify | Exclude the new Postgres gate from `pnpm test`. |
| `tests/integration/diagnostics-postgres.test.ts` | Create | Real-Postgres evidence for the migration and both new repositories. |
| `docs/project-architecture.md` | Modify | Record the trace seam, the redaction contract, and the report shape. |
| `docs/tasks.md` | Modify | Refine the Task 17 file list and record completion evidence. |

## Locked Interfaces

Define these names once and use them unchanged in every later slice.

```ts
// src/lib/logger.ts
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
}): Logger;

export function createNoopLogger(): Logger;
```

```ts
// src/features/diagnostics/trace-repository.ts
export interface SanitizedTraceRow {
  toolName: string;
  durationMs: number;
  status: TraceStatus;
  at: string;
}

export interface ToolTraceRepository extends ToolTraceSink {
  append(trace: ToolTrace): Promise<void>;
  recent(mode: DataMode, limit: number): Promise<SanitizedTraceRow[]>;
  all(): Promise<ToolTrace[]>;
}

export function createInMemoryToolTraceRepository(now?: () => Date): ToolTraceRepository;
export function createPostgresToolTraceRepository(db: DbClient): ToolTraceRepository;
```

```ts
// src/features/diagnostics/traced-gateway.ts
export interface TracedGatewayOptions {
  logger: Logger;
  correlationId: string;
  mode: DataMode;
  retryCount?: number;
  now?: () => number;
}

export function withTracedGateway(
  gateway: SilpoGateway,
  options: TracedGatewayOptions,
): SilpoGateway;
```

```ts
// src/features/diagnostics/decision-repository.ts
export interface LandedReplacement {
  replacedFromPrice: number;
  effectivePrice: number;
  quantity: number;
}

export interface DecisionTotals {
  decidedItemCount: number;
  keptItemCount: number;
  replacedItemCount: number;
  landedReplacements: LandedReplacement[];
}

export interface DecisionRepository {
  totalsForUser(userId: string): Promise<DecisionTotals>;
}

export const EMPTY_DECISION_TOTALS: DecisionTotals;
export function createInMemoryDecisionRepository(totals: DecisionTotals): DecisionRepository;
export function createPostgresDecisionRepository(db: DbClient): DecisionRepository;
```

```ts
// src/features/diagnostics/service.ts
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
  traces: SanitizedTraceRow[];
}

export interface BuildDiagnosticsDeps {
  gateway: SilpoGateway;
  decisions: DecisionRepository;
  traces: ToolTraceRepository;
  logger: Logger;
  correlationId: string;
  now?: () => Date;
}

export function buildDiagnostics(
  userId: string | null,
  deps: BuildDiagnosticsDeps,
): Promise<DiagnosticsReport>;

export const DIAGNOSTICS_TRACE_LIMIT = 20;
```

```ts
// src/features/drafts/service.ts — CreateDraftDeps gains one optional field
logger?: Logger;

// src/features/cart/commit-service.ts — CommitApprovedDraftDeps gains one optional field
logger?: Logger;

// src/features/diagnostics/decision-repository.ts is the only reader of
// draft_items.replaced_from_price. The domain DraftItem is unchanged.
```

### Exact user-facing copy

```tsx
// src/components/autopilot/demo-diagnostics.tsx
const PANEL_TITLE = "Як працює прогноз";
const INSUFFICIENT = "Недостатньо спостережень";
const LOADING = "Завантажуємо діагностику…";
const FAILED = "Не вдалося завантажити діагностику.";
const BACKTEST_TITLE = "Якість прогнозу";
const DECISIONS_TITLE = "Рішення користувача";
const TRACES_TITLE = "Виклики «Сільпо»";
const TRACES_CAPTION = "Інструмент, тривалість і статус останніх викликів";
const SAVINGS_POSITIVE = "економія";
const SAVINGS_NEGATIVE = "додаткові витрати";
const LABEL_EXACT_PRECISION = "Точність за товаром";
const LABEL_EXACT_RECALL = "Повнота за товаром";
const LABEL_CATEGORY_PRECISION = "Точність за категорією";
const LABEL_CATEGORY_RECALL = "Повнота за категорією";
const LABEL_HIT_RATE = "Влучань у чек";
const LABEL_COVERAGE = "Покриття";
const LABEL_ACCEPTANCE = "Прийнято рекомендацій";
const LABEL_REPLACEMENT = "Замінено рекомендацій";
const LABEL_SAVINGS = "Прийняті заміни";
const COLUMN_TOOL = "Інструмент";
const COLUMN_DURATION = "Тривалість";
const COLUMN_STATUS = "Статус";
const STATUS_COPY = { ok: "успішно", error: "помилка", blocked: "потребує уваги" } as const;
```

---

## Task 17: Demo Diagnostics and Sanitized MCP Trace

**Prerequisites:** Commits for Tasks 6, 7, 13, 15, and 16 are integrated. Baseline `0a5c3f8` (`docs: specify demo diagnostics and sanitized MCP trace`).

**Behavior to prove:** No secret and no personal field can reach a persisted trace or the console, whatever a caller passes. Every Silpo call in both modes produces one trace, and a tracing fault can neither fail nor reclassify the call it describes. The demo route reports backtest metrics, product-decision metrics, and sanitized trace rows, returns `null` rather than `0` when a denominator is absent, is absent entirely in live mode, and creates no rows. The panel is collapsed, costs no request until opened, and shows no identifier.

### 17.0 — Confirm dependencies and framework rules

- [ ] Confirm the working tree is clean and the baseline is present:

```bash
git status --short && git log -1 --format='%h %s'
```

- [ ] Confirm the modules this task composes are green before it changes anything:

```bash
pnpm vitest run src/features/prediction/backtest.test.ts src/features/diagnostics/backtest-service.test.ts src/features/drafts/repository.test.ts src/features/cart/repository.test.ts src/db/schema.test.ts
```

Expected: PASS.

- [ ] Read `src/features/diagnostics/backtest-service.ts`. `loadDemoBacktest(gateway, correlationId)` returns `Result<BacktestReport, AppError>`. This task composes it and does not reimplement any part of it.

- [ ] Read `src/features/prediction/backtest.ts` lines 27–37 and 74–101. `BacktestMetrics` fields are nullable by contract, and `confidenceBuckets` always has exactly two entries. The panel must render `null` metrics as «Недостатньо спостережень» rather than `0`.

- [ ] Read `src/app/api/backtest/route.ts`. Its live-mode gate, `Cache-Control: no-store` header, and lazy demo-gateway import are the pattern slice 17.9 copies.

- [ ] Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`. This installed Next.js version differs from training data.

- [ ] Read spec section 12. Do not attempt to surface MCP-internal retry counts, do not add a user column to `tool_traces`, and do not backfill either new column.

---

### 17.1 — Add the two columns the trace contract and the savings metric need

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/schema.test.ts`
- Create: `drizzle/0005_diagnostics_trace_fields.sql`

**Interfaces:**
- Consumes: the existing `draftItems` and `toolTraces` table definitions.
- Produces: `draftItems.replacedFromPrice` (`replaced_from_price`, nullable `double precision`) and `toolTraces.predictionVersion` (`prediction_version`, nullable `text`).

- [ ] **Step 1: Write the failing schema tests**

Append to `src/db/schema.test.ts`. Add `toolTraces` to the existing import from `./schema`:

```ts
describe("diagnostics schema additions", () => {
  it("A17-01 keeps the price a replacement decision would otherwise destroy", () => {
    const columns = getTableColumns(draftItems);

    expect(columns.replacedFromPrice.name).toBe("replaced_from_price");
    // Nullable: rows approved before this migration have no recoverable price,
    // and a backfilled value would corrupt the savings metric.
    expect(columns.replacedFromPrice.notNull).toBe(false);
  });

  it("A17-02 gives a trace a typed home for the prediction version", () => {
    const columns = getTableColumns(toolTraces);

    expect(columns.predictionVersion.name).toBe("prediction_version");
    expect(columns.predictionVersion.notNull).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/db/schema.test.ts`
Expected: FAIL. TypeScript reports that `replacedFromPrice` and `predictionVersion` do not exist on the column maps.

- [ ] **Step 3: Add the two columns**

In `src/db/schema.ts`, inside the `draftItems` table definition, after the `promotions` column:

```ts
  /**
   * The effective unit price of the product this row originally proposed,
   * captured when a `replaced` decision overwrites the row. Null for every
   * other decision and for rows approved before migration 0005.
   */
  replacedFromPrice: doublePrecision("replaced_from_price"),
```

In the `toolTraces` table definition, after `sanitizedStatus`:

```ts
  /**
   * The prediction algorithm version this run used. A typed column rather
   * than a `metadata` entry, because `metadata` admits no strings by design.
   */
  predictionVersion: text("prediction_version"),
```

- [ ] **Step 4: Create the migration**

Create `drizzle/0005_diagnostics_trace_fields.sql`:

```sql
ALTER TABLE "draft_items" ADD COLUMN "replaced_from_price" double precision;--> statement-breakpoint
ALTER TABLE "tool_traces" ADD COLUMN "prediction_version" text;
```

Write the file by hand rather than running `pnpm db:generate`: the generator would also rewrite `drizzle/meta`, and this repository's earlier migrations are hand-written in the same style.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/db/schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Confirm nothing else moved**

Run: `pnpm typecheck`
Expected: PASS. No existing query selects `*` into a strict schema, so two new nullable columns break no reader.

---

### 17.2 — Build the sanitized trace record and the logger

**Files:**
- Create: `src/lib/logger.ts`
- Create: `src/lib/logger.test.ts`

**Interfaces:**
- Consumes: `DataModeSchema` and `DataMode` from `src/features/shared/contracts.ts`.
- Produces: `TRACE_STATUSES`, `TraceStatus`, `ToolTrace`, `sanitizeTrace`, `ToolTraceSink`, `Logger`, `createLogger`, `createNoopLogger`.

- [ ] **Step 1: Write the failing logger tests**

Create `src/lib/logger.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import {
  createLogger,
  createNoopLogger,
  sanitizeTrace,
  type ToolTrace,
  type ToolTraceSink,
} from "./logger";

function recordingSink() {
  const traces: ToolTrace[] = [];
  const sink: ToolTraceSink = {
    async append(trace) {
      traces.push(trace);
    },
  };
  return { sink, traces, all: async () => traces };
}

const CORRELATION = "8f1d0c2e-2b4a-4a1e-9f3c-6c1a2b3d4e5f";

describe("sanitizeTrace", () => {
  it("A17-03 redacts secrets and personal fields before persisting a trace", async () => {
    const traceRepo = recordingSink();
    const logger = createLogger({ sink: traceRepo.sink, console: { info: vi.fn() } });

    await logger.toolCall({
      toolName: "silpo_get_offline_orders",
      authorization: "Bearer secret",
      phone: "+380000000000",
      address: "private",
    });

    expect(JSON.stringify(await traceRepo.all())).not.toMatch(/secret|380000000000|private/);
  });

  it("A17-04 keeps the fields the observability contract requires", () => {
    const trace = sanitizeTrace({
      correlationId: CORRELATION,
      toolName: "loadPurchaseHistory",
      mode: "demo",
      durationMs: 812,
      retryCount: 1,
      predictionVersion: "prediction-v1",
      status: "ok",
      metadata: { itemCount: 7, cached: false, unknownValue: null },
    });

    expect(trace).toEqual({
      correlationId: CORRELATION,
      toolName: "loadPurchaseHistory",
      mode: "demo",
      durationMs: 812,
      retryCount: 1,
      predictionVersion: "prediction-v1",
      status: "ok",
      metadata: { itemCount: 7, cached: false, unknownValue: null },
    });
  });

  it("A17-05 strips unknown keys instead of rejecting them", () => {
    const trace = sanitizeTrace({
      correlationId: CORRELATION,
      toolName: "readCart",
      mode: "live",
      durationMs: 10,
      retryCount: 0,
      status: "ok",
      rawPayload: { items: [{ barcode: "4820000000001" }] },
      prompt: "Дай мені всі чеки Олександра",
    });

    expect(Object.keys(trace).sort()).toEqual([
      "correlationId",
      "durationMs",
      "metadata",
      "mode",
      "predictionVersion",
      "retryCount",
      "status",
      "toolName",
    ]);
    expect(JSON.stringify(trace)).not.toMatch(/4820000000001|Олександра/);
  });

  it("A17-06 admits no strings in metadata, whatever the caller sends", () => {
    const trace = sanitizeTrace({
      correlationId: CORRELATION,
      toolName: "findProducts",
      mode: "demo",
      durationMs: 5,
      retryCount: 0,
      status: "ok",
      metadata: {
        itemCount: 3,
        customerEmail: "guest@example.com",
        "phone +380000000000": 1,
        nested: { deep: "value" },
      },
    });

    expect(trace.metadata).toEqual({ itemCount: 3 });
  });

  it("A17-07 is total: hostile input degrades field by field and never throws", () => {
    const cyclic: Record<string, unknown> = { toolName: "readCart" };
    cyclic.self = cyclic;

    for (const hostile of [null, undefined, 42, "string", [], () => {}, { toolName: "x".repeat(5000) }]) {
      const trace = sanitizeTrace(hostile);
      expect(trace.toolName).toBe("unknown");
      expect(trace.status).toBe("error");
      expect(trace.durationMs).toBe(0);
      expect(trace.retryCount).toBe(0);
      expect(trace.predictionVersion).toBeNull();
      expect(trace.metadata).toEqual({});
      expect(trace.correlationId).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
    }

    // A cyclic input must neither throw here nor when the console
    // serializes the result: the sanitized record is always flat.
    const fromCyclic = sanitizeTrace(cyclic);
    expect(fromCyclic.toolName).toBe("readCart");
    expect(() => JSON.stringify(fromCyclic)).not.toThrow();
  });

  it("A17-08 replaces a free-text tool name rather than storing it", () => {
    const trace = sanitizeTrace({
      correlationId: CORRELATION,
      toolName: "call for guest +380000000000",
      mode: "demo",
      durationMs: 1,
      retryCount: 0,
      status: "ok",
    });

    expect(trace.toolName).toBe("unknown");
  });

  it("A17-09 clamps a duration that would otherwise carry an unbounded number", () => {
    expect(sanitizeTrace({ durationMs: -5 }).durationMs).toBe(0);
    expect(sanitizeTrace({ durationMs: 10_000_000 }).durationMs).toBe(600_000);
    expect(sanitizeTrace({ durationMs: 12.7 }).durationMs).toBe(12);
  });
});

describe("createLogger", () => {
  it("A17-10 writes the same sanitized record to the console and the sink", async () => {
    const traceRepo = recordingSink();
    const info = vi.fn();
    const logger = createLogger({ sink: traceRepo.sink, console: { info } });

    await logger.toolCall({
      correlationId: CORRELATION,
      toolName: "readCart",
      mode: "live",
      durationMs: 3,
      retryCount: 0,
      status: "ok",
      authorization: "Bearer secret",
    });

    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(info.mock.calls[0][0] as string)).toEqual(traceRepo.traces[0]);
  });

  it("A17-11 never rejects when the sink fails", async () => {
    const info = vi.fn();
    const logger = createLogger({
      sink: { append: async () => { throw new Error("database is down"); } },
      console: { info },
    });

    await expect(
      logger.toolCall({ toolName: "readCart", mode: "live", status: "ok" }),
    ).resolves.toBeUndefined();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("A17-12 never rejects when the console itself throws", async () => {
    const traceRepo = recordingSink();
    const logger = createLogger({
      sink: traceRepo.sink,
      console: { info: () => { throw new Error("stream closed"); } },
    });

    await expect(logger.toolCall({ toolName: "readCart" })).resolves.toBeUndefined();
    expect(traceRepo.traces).toHaveLength(1);
  });

  it("A17-13 gives services a logger that records nothing", async () => {
    await expect(createNoopLogger().toolCall({ toolName: "readCart" })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/logger.test.ts`
Expected: FAIL with `Failed to resolve import "./logger"`.

- [ ] **Step 3: Implement the sanitizer and the logger**

Create `src/lib/logger.ts`:

```ts
import { z } from "zod";

import { DataModeSchema, type DataMode } from "@/features/shared/contracts";

export const TRACE_STATUSES = ["ok", "error", "blocked"] as const;
export type TraceStatus = (typeof TRACE_STATUSES)[number];

/** Server-generated identifiers only. Every `crypto.randomUUID()` matches. */
const CORRELATION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/i;
const VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
const METADATA_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;

/** A single MCP call takes minutes at worst; anything larger is a bug, not data. */
const MAX_DURATION_MS = 600_000;
const MAX_RETRY_COUNT = 10;

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

const boundedInt = (max: number) =>
  z.coerce.number().finite().transform((value) => Math.min(Math.max(Math.trunc(value), 0), max));

/**
 * Redaction is structural, not a denylist.
 *
 * The object schema strips every key it does not name, so `authorization`,
 * `phone`, `address`, raw prompts and raw MCP payloads have no field to land
 * in. The fields that survive are pattern- or enum-constrained, so none of
 * them admits free text. `metadata` admits numbers, booleans and null and
 * nothing else, which makes personal data unrepresentable rather than
 * filtered — there is no list here for a future author to forget to extend.
 *
 * Every field carries a fallback, so the function is total: a malformed call
 * degrades that one field and still produces the evidence that a fault
 * occurred, instead of throwing inside a `finally` block on a cart write.
 */
const ToolTraceSchema = z.object({
  correlationId: z.string().regex(CORRELATION_PATTERN).catch(() => crypto.randomUUID()),
  toolName: z.string().regex(TOOL_NAME_PATTERN).catch("unknown"),
  mode: DataModeSchema.catch("demo"),
  durationMs: boundedInt(MAX_DURATION_MS).catch(0),
  retryCount: boundedInt(MAX_RETRY_COUNT).catch(0),
  predictionVersion: z.string().regex(VERSION_PATTERN).nullable().catch(null),
  status: z.enum(TRACE_STATUSES).catch("error"),
  // Filtered per entry rather than validated as a whole: a record schema
  // would reject the entire map on one bad key, and a caller that attached
  // one stray string would lose the item count next to it.
  metadata: z.unknown().transform(toSafeMetadata),
});

function toSafeMetadata(value: unknown): Record<string, number | boolean | null> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const safe: Record<string, number | boolean | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!METADATA_KEY_PATTERN.test(key)) continue;
    if (entry === null || typeof entry === "boolean") {
      safe[key] = entry;
    } else if (typeof entry === "number" && Number.isFinite(entry)) {
      safe[key] = entry;
    }
    // Everything else — strings above all — is dropped without comment.
  }
  return safe;
}

export function sanitizeTrace(input: unknown): ToolTrace {
  const source = typeof input === "object" && input !== null && !Array.isArray(input) ? input : {};
  const parsed = ToolTraceSchema.safeParse(source);
  // `.catch()` on every field makes a whole-object failure unreachable, but a
  // total function must not depend on that reasoning staying true.
  return parsed.success ? parsed.data : ToolTraceSchema.parse({});
}

export interface ToolTraceSink {
  append(trace: ToolTrace): Promise<void>;
}

export interface Logger {
  toolCall(input: unknown): Promise<void>;
}

/**
 * Console output serializes the same record that is persisted, so there is no
 * path that redacts one destination and not the other.
 *
 * Nothing here can throw or reject. A draft run and a cart write both call
 * this from paths whose failure would be reported to the user, and an
 * observability fault must never become a product fault.
 */
export function createLogger(options: {
  sink: ToolTraceSink;
  console?: Pick<Console, "info">;
}): Logger {
  const target = options.console ?? console;
  return {
    async toolCall(input: unknown): Promise<void> {
      const trace = sanitizeTrace(input);
      try {
        target.info(JSON.stringify(trace));
      } catch {
        // A closed or replaced stream must not suppress persistence.
      }
      try {
        await options.sink.append(trace);
      } catch {
        // Intentionally swallowed; see the comment above.
      }
    },
  };
}

export function createNoopLogger(): Logger {
  return { async toolCall(): Promise<void> {} };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/logger.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Confirm the module stayed a leaf**

```bash
grep -n "^import" src/lib/logger.ts
```

Expected: exactly two imports, `zod` and `@/features/shared/contracts`. `contracts.ts` imports nothing but `zod`, so this creates no cycle. Any import of a database client, React, Next.js, the MCP SDK, or the AI SDK is a defect.

---

### 17.3 — Persist and read back sanitized traces

**Files:**
- Create: `src/features/diagnostics/trace-repository.ts`
- Create: `src/features/diagnostics/trace-repository.test.ts`

**Interfaces:**
- Consumes: `ToolTrace`, `ToolTraceSink`, `TraceStatus` from `src/lib/logger.ts`; `toolTraces` from `src/db/schema.ts`; `DbClient` from `src/db/client.ts`.
- Produces: `SanitizedTraceRow`, `ToolTraceRepository`, `createInMemoryToolTraceRepository`, `createPostgresToolTraceRepository`.

- [ ] **Step 1: Write the failing repository tests**

Create `src/features/diagnostics/trace-repository.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { sanitizeTrace } from "@/lib/logger";

import { createInMemoryToolTraceRepository } from "./trace-repository";

const trace = (overrides: Record<string, unknown> = {}) =>
  sanitizeTrace({
    correlationId: "corr-1",
    toolName: "loadPurchaseHistory",
    mode: "demo",
    durationMs: 100,
    retryCount: 0,
    status: "ok",
    ...overrides,
  });

describe("createInMemoryToolTraceRepository", () => {
  it("A17-14 returns the newest rows first, bounded by the limit", async () => {
    let tick = 0;
    const repo = createInMemoryToolTraceRepository(() => new Date(1_700_000_000_000 + tick++ * 1000));

    await repo.append(trace({ toolName: "listTools" }));
    await repo.append(trace({ toolName: "loadCartContext" }));
    await repo.append(trace({ toolName: "loadPurchaseHistory" }));

    const rows = await repo.recent("demo", 2);
    expect(rows.map((row) => row.toolName)).toEqual(["loadPurchaseHistory", "loadCartContext"]);
  });

  it("A17-15 never returns rows from the other mode", async () => {
    const repo = createInMemoryToolTraceRepository();

    await repo.append(trace({ mode: "live", toolName: "readCart" }));
    await repo.append(trace({ mode: "demo", toolName: "listTools" }));

    expect((await repo.recent("demo", 20)).map((row) => row.toolName)).toEqual(["listTools"]);
  });

  it("A17-16 projects only tool, duration, status and time into a read row", async () => {
    const repo = createInMemoryToolTraceRepository(() => new Date("2026-09-10T08:00:00.000Z"));

    await repo.append(trace({ metadata: { itemCount: 4 }, predictionVersion: "prediction-v1" }));

    expect(await repo.recent("demo", 20)).toEqual([
      {
        toolName: "loadPurchaseHistory",
        durationMs: 100,
        status: "ok",
        at: "2026-09-10T08:00:00.000Z",
      },
    ]);
  });

  it("A17-17 keeps the full record available for redaction evidence", async () => {
    const repo = createInMemoryToolTraceRepository();

    await repo.append(trace({ authorization: "Bearer secret", phone: "+380000000000" } as never));

    expect(JSON.stringify(await repo.all())).not.toMatch(/secret|380000000000/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/features/diagnostics/trace-repository.test.ts`
Expected: FAIL with `Failed to resolve import "./trace-repository"`.

- [ ] **Step 3: Implement both repositories**

Create `src/features/diagnostics/trace-repository.ts`:

```ts
import { desc, eq } from "drizzle-orm";

import type { DbClient } from "@/db/client";
import { toolTraces } from "@/db/schema";
import type { DataMode } from "@/features/shared/contracts";
import { sanitizeTrace, type ToolTrace, type ToolTraceSink, type TraceStatus } from "@/lib/logger";

/** What the demo panel is allowed to see. Never a correlation ID or metadata. */
export interface SanitizedTraceRow {
  toolName: string;
  durationMs: number;
  status: TraceStatus;
  at: string;
}

export interface ToolTraceRepository extends ToolTraceSink {
  append(trace: ToolTrace): Promise<void>;
  recent(mode: DataMode, limit: number): Promise<SanitizedTraceRow[]>;
  /** Full records, for tests that must prove nothing sensitive was stored. */
  all(): Promise<ToolTrace[]>;
}

interface StoredTrace {
  trace: ToolTrace;
  createdAt: Date;
}

export function createInMemoryToolTraceRepository(
  now: () => Date = () => new Date(),
): ToolTraceRepository {
  const stored: StoredTrace[] = [];

  return {
    async append(trace: ToolTrace): Promise<void> {
      // Re-sanitized on the way in: a caller reaching the repository directly
      // must not be a way around the logger.
      stored.push({ trace: sanitizeTrace(trace), createdAt: now() });
    },

    async recent(mode: DataMode, limit: number): Promise<SanitizedTraceRow[]> {
      return stored
        .filter((entry) => entry.trace.mode === mode)
        .slice()
        .reverse()
        .slice(0, Math.max(0, Math.trunc(limit)))
        .map((entry) => ({
          toolName: entry.trace.toolName,
          durationMs: entry.trace.durationMs,
          status: entry.trace.status,
          at: entry.createdAt.toISOString(),
        }));
    },

    async all(): Promise<ToolTrace[]> {
      return stored.map((entry) => structuredClone(entry.trace));
    },
  };
}

export function createPostgresToolTraceRepository(db: DbClient): ToolTraceRepository {
  return {
    async append(trace: ToolTrace): Promise<void> {
      const safe = sanitizeTrace(trace);
      await db.insert(toolTraces).values({
        correlationId: safe.correlationId,
        toolName: safe.toolName,
        mode: safe.mode,
        durationMs: safe.durationMs,
        retryCount: safe.retryCount,
        predictionVersion: safe.predictionVersion,
        sanitizedStatus: safe.status,
        metadata: safe.metadata,
      });
    },

    async recent(mode: DataMode, limit: number): Promise<SanitizedTraceRow[]> {
      const rows = await db
        .select({
          toolName: toolTraces.toolName,
          durationMs: toolTraces.durationMs,
          sanitizedStatus: toolTraces.sanitizedStatus,
          createdAt: toolTraces.createdAt,
        })
        .from(toolTraces)
        .where(eq(toolTraces.mode, mode))
        .orderBy(desc(toolTraces.createdAt))
        .limit(Math.max(0, Math.trunc(limit)));

      // Rows predate nothing, but the columns are nullable, so each one is
      // put back through the sanitizer rather than trusted as read.
      return rows.map((row) => {
        const safe = sanitizeTrace({
          toolName: row.toolName ?? "unknown",
          durationMs: row.durationMs ?? 0,
          status: row.sanitizedStatus ?? "error",
          mode,
        });
        return {
          toolName: safe.toolName,
          durationMs: safe.durationMs,
          status: safe.status,
          at: row.createdAt.toISOString(),
        };
      });
    },

    async all(): Promise<ToolTrace[]> {
      const rows = await db.select().from(toolTraces).orderBy(desc(toolTraces.createdAt));
      return rows.map((row) =>
        sanitizeTrace({
          correlationId: row.correlationId ?? undefined,
          toolName: row.toolName ?? undefined,
          mode: row.mode ?? undefined,
          durationMs: row.durationMs ?? 0,
          retryCount: row.retryCount ?? 0,
          predictionVersion: row.predictionVersion,
          status: row.sanitizedStatus ?? undefined,
          metadata: row.metadata ?? {},
        }),
      );
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/features/diagnostics/trace-repository.test.ts`
Expected: PASS, 4 tests.

---

### 17.4 — Trace every Silpo call through a gateway decorator

**Files:**
- Create: `src/features/diagnostics/traced-gateway.ts`
- Create: `src/features/diagnostics/traced-gateway.test.ts`

**Interfaces:**
- Consumes: `SilpoGateway` and `DataMode` from `src/features/shared/contracts.ts`; `Logger` from `src/lib/logger.ts`.
- Produces: `TracedGatewayOptions`, `withTracedGateway`.

- [ ] **Step 1: Write the failing decorator tests**

Create `src/features/diagnostics/traced-gateway.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import type { SilpoGateway } from "@/features/shared/contracts";
import type { Logger, ToolTrace } from "@/lib/logger";
import { sanitizeTrace } from "@/lib/logger";

import { withTracedGateway } from "./traced-gateway";

function collectingLogger() {
  const traces: ToolTrace[] = [];
  const logger: Logger = {
    async toolCall(input) {
      traces.push(sanitizeTrace(input));
    },
  };
  return { logger, traces };
}

/**
 * Every method resolves. The decorator must not care what any of them
 * returns, so a single stub value is honest here.
 */
function stubGateway(): SilpoGateway {
  const resolve = async () => undefined as never;
  return {
    listTools: resolve,
    loadCustomerContext: resolve,
    loadCartContext: resolve,
    updateCartContext: resolve,
    loadPurchaseHistory: resolve,
    findProducts: resolve,
    getPromotions: resolve,
    getProductDetails: resolve,
    getSimilarProducts: resolve,
    getReplacements: resolve,
    getTimeSlots: resolve,
    setAbsoluteCartQuantities: resolve,
    readCart: resolve,
  };
}

describe("withTracedGateway", () => {
  it("A17-18 emits one trace for every gateway method, enumerated from the port", async () => {
    const { logger, traces } = collectingLogger();
    const base = stubGateway();
    const traced = withTracedGateway(base, { logger, correlationId: "corr-1", mode: "demo" });

    const methodNames = Object.keys(base) as Array<keyof SilpoGateway>;
    for (const name of methodNames) {
      await (traced[name] as (...args: never[]) => Promise<unknown>)();
    }

    expect(traces.map((entry) => entry.toolName).sort()).toEqual([...methodNames].sort());
    expect(traces.every((entry) => entry.status === "ok")).toBe(true);
    expect(traces.every((entry) => entry.mode === "demo")).toBe(true);
    expect(traces.every((entry) => entry.correlationId === "corr-1")).toBe(true);
  });

  it("A17-19 records elapsed time from the injected clock", async () => {
    const { logger, traces } = collectingLogger();
    let clock = 1000;
    const traced = withTracedGateway(
      { ...stubGateway(), readCart: async () => { clock += 250; return undefined as never; } },
      { logger, correlationId: "corr-1", mode: "live", now: () => clock },
    );

    await traced.readCart("cart-1");

    expect(traces[0].durationMs).toBe(250);
  });

  it("A17-20 records an error and rethrows the original error instance", async () => {
    class GatewayFailure extends Error {}
    const failure = new GatewayFailure("boom");
    const { logger, traces } = collectingLogger();
    const traced = withTracedGateway(
      { ...stubGateway(), readCart: async () => { throw failure; } },
      { logger, correlationId: "corr-1", mode: "live" },
    );

    // Identity, not shape: the services classify failures with `instanceof`.
    await expect(traced.readCart("cart-1")).rejects.toBe(failure);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ toolName: "readCart", status: "error" });
  });

  it("A17-21 lets the underlying call succeed even when the logger throws", async () => {
    const logger: Logger = { toolCall: vi.fn(async () => { throw new Error("logger down"); }) };
    const traced = withTracedGateway(
      { ...stubGateway(), listTools: async () => ["silpo_get_offline_orders"] },
      { logger, correlationId: "corr-1", mode: "demo" },
    );

    await expect(traced.listTools()).resolves.toEqual(["silpo_get_offline_orders"]);
  });

  it("A17-22 passes arguments through untouched", async () => {
    const findProducts = vi.fn(async () => [] as never);
    const { logger } = collectingLogger();
    const context = { cartId: "cart-1" } as never;
    const traced = withTracedGateway(
      { ...stubGateway(), findProducts },
      { logger, correlationId: "corr-1", mode: "demo" },
    );

    await traced.findProducts(context, ["вода", "хліб"]);

    expect(findProducts).toHaveBeenCalledWith(context, ["вода", "хліб"]);
  });

  it("A17-23 carries the caller's retry count onto every trace", async () => {
    const { logger, traces } = collectingLogger();
    const traced = withTracedGateway(stubGateway(), {
      logger,
      correlationId: "corr-1",
      mode: "live",
      retryCount: 1,
    });

    await traced.readCart("cart-1");

    expect(traces[0].retryCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/features/diagnostics/traced-gateway.test.ts`
Expected: FAIL with `Failed to resolve import "./traced-gateway"`.

- [ ] **Step 3: Implement the decorator**

Create `src/features/diagnostics/traced-gateway.ts`:

```ts
import type { DataMode, SilpoGateway } from "@/features/shared/contracts";
import type { Logger } from "@/lib/logger";

export interface TracedGatewayOptions {
  logger: Logger;
  correlationId: string;
  mode: DataMode;
  /** Service-level attempts. MCP-internal retries are not observable here. */
  retryCount?: number;
  now?: () => number;
}

/**
 * One trace per gateway call, in both live and demo mode.
 *
 * The decorator is applied inside the application services rather than at
 * gateway construction, so it needs no route change, and it covers every
 * consumer of the gateway — including `resolveProducts`, which issues most
 * of a draft run's Silpo calls and would be invisible to spans written by
 * hand in the service.
 *
 * Two properties matter more than the trace itself. The original error
 * instance is rethrown untouched, because `McpCallError`, `ZodError`,
 * `InvalidExternalDataError` and `UnadvertisedToolError` are classified by
 * `instanceof` and a wrapped error would silently reclassify a live failure.
 * And a logger fault can neither fail nor delay the call: `toolCall` already
 * cannot reject, and its promise is deliberately not awaited.
 */
export function withTracedGateway(
  gateway: SilpoGateway,
  options: TracedGatewayOptions,
): SilpoGateway {
  const now = options.now ?? (() => Date.now());

  const record = (toolName: string, startedAt: number, status: "ok" | "error"): void => {
    // `toolCall` cannot reject, but a hand-written fake in a test can throw
    // synchronously, and a real call must not depend on it never doing so.
    try {
      void Promise.resolve(
        options.logger.toolCall({
          correlationId: options.correlationId,
          toolName,
          mode: options.mode,
          durationMs: now() - startedAt,
          retryCount: options.retryCount ?? 0,
          status,
        }),
      ).catch(() => {});
    } catch {
      // Intentionally swallowed; see the comment above.
    }
  };

  const traced = {} as Record<string, unknown>;
  for (const toolName of Object.keys(gateway) as Array<keyof SilpoGateway>) {
    const method = gateway[toolName];
    traced[toolName] = async (...args: unknown[]): Promise<unknown> => {
      const startedAt = now();
      try {
        const result = await (method as (...inner: unknown[]) => Promise<unknown>).apply(
          gateway,
          args,
        );
        record(toolName, startedAt, "ok");
        return result;
      } catch (error) {
        record(toolName, startedAt, "error");
        throw error;
      }
    };
  }

  return traced as unknown as SilpoGateway;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/features/diagnostics/traced-gateway.test.ts`
Expected: PASS, 6 tests.

---

### 17.5 — Emit traces from the draft run and the cart commit

**Files:**
- Modify: `src/features/drafts/service.ts`
- Modify: `src/features/drafts/service.test.ts`
- Modify: `src/features/cart/commit-service.ts`
- Modify: `src/features/cart/commit-service.test.ts`

**Interfaces:**
- Consumes: `withTracedGateway` from `src/features/diagnostics/traced-gateway.ts`; `createNoopLogger`, `Logger` from `src/lib/logger.ts`; `PREDICTION_ALGORITHM_VERSION` from `src/features/prediction/features.ts`.
- Produces: `CreateDraftDeps.logger?: Logger` and `CommitApprovedDraftDeps.logger?: Logger`. Both default to `createNoopLogger()`, so every existing caller and test compiles unchanged.

- [ ] **Step 1: Write the failing draft-service test**

Append to `src/features/drafts/service.test.ts`. Add these imports at the top of the file:

```ts
import { withTracedGateway } from "@/features/diagnostics/traced-gateway";
import { sanitizeTrace, type Logger, type ToolTrace } from "@/lib/logger";
```

Then append:

```ts
function collectingLogger() {
  const traces: ToolTrace[] = [];
  const logger: Logger = {
    async toolCall(input) {
      traces.push(sanitizeTrace(input));
    },
  };
  return { logger, traces };
}

describe("createDraftForUser tracing", () => {
  it("A17-24 traces every gateway call the run makes, including catalog calls", async () => {
    const { logger, traces } = collectingLogger();
    const { deps } = makeDeps({ logger });

    const result = await createDraftForUser(RUN, deps);

    expect(result.ok).toBe(true);
    const toolNames = new Set(traces.map((entry) => entry.toolName));
    expect(toolNames.has("listTools")).toBe(true);
    expect(toolNames.has("loadPurchaseHistory")).toBe(true);
    // resolveProducts issues this one; a span written by hand in the service
    // would never see it.
    expect(toolNames.has("findProducts")).toBe(true);
  });

  it("A17-25 emits exactly one run trace carrying item count and prediction version", async () => {
    const { logger, traces } = collectingLogger();
    const { deps } = makeDeps({ logger });

    const result = await createDraftForUser(RUN, deps);
    if (!result.ok) throw new Error("expected a draft");

    const runTraces = traces.filter((entry) => entry.toolName === "draft_run");
    expect(runTraces).toHaveLength(1);
    expect(runTraces[0]).toMatchObject({
      mode: "demo",
      status: "ok",
      correlationId: "corr-1",
      predictionVersion: "prediction-v1",
      metadata: { itemCount: result.value.draft.items.length },
    });
  });

  it("A17-26 marks the run trace as an error when the run fails", async () => {
    const { logger, traces } = collectingLogger();
    const { deps } = makeDeps({
      logger,
      openGateway: async () => { throw new McpCallError("silpo_get_offline_orders", 401, null); },
    });

    const result = await createDraftForUser(RUN, deps);

    expect(result.ok).toBe(false);
    const runTraces = traces.filter((entry) => entry.toolName === "draft_run");
    expect(runTraces).toHaveLength(1);
    expect(runTraces[0].status).toBe("error");
  });

  it("A17-27 never lets a logger fault fail the run", async () => {
    const { deps } = makeDeps({
      logger: { toolCall: async () => { throw new Error("logger down"); } },
    });

    await expect(createDraftForUser(RUN, deps)).resolves.toMatchObject({ ok: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/features/drafts/service.test.ts`
Expected: FAIL. TypeScript reports that `logger` is not a member of `CreateDraftDeps`; the tracing assertions find no traces.

- [ ] **Step 3: Wire tracing into the draft service**

In `src/features/drafts/service.ts`, add the imports:

```ts
import { withTracedGateway } from "@/features/diagnostics/traced-gateway";
import { PREDICTION_ALGORITHM_VERSION } from "@/features/prediction/features";
import { createNoopLogger, type Logger } from "@/lib/logger";
```

Add one field to `CreateDraftDeps`, after `repository`:

```ts
  /** Optional so every existing caller and test constructs deps unchanged. */
  logger?: Logger;
```

Inside `createDraftForUser`, replace the opening of the `try` block:

```ts
  const logger = deps.logger ?? createNoopLogger();
  // Wall-clock, not `deps.now`: tests pin the domain clock to a constant, and
  // a run duration measured against it would always be zero.
  const startedAtMs = Date.now();
  let runStatus: "ok" | "error" = "error";
  let itemCount = 0;

  let handle: SilpoGatewayHandle | undefined;
  try {
    handle = await deps.openGateway({ mode: input.mode, userId: input.userId });
    // Applied here rather than at gateway construction so no route changes,
    // and so every consumer is covered — including `resolveProducts`, which
    // issues most of a run's Silpo calls.
    const gateway = withTracedGateway(handle.gateway, {
      logger,
      correlationId,
      mode: input.mode,
    });
```

Delete the now-redundant `const { gateway } = handle;` line that followed it.

Set the outcome immediately before the success return:

```ts
    const saved = await deps.repository.save(input.userId, draft);
    runStatus = "ok";
    itemCount = saved.items.length;

    return ok({
```

Extend the existing `finally` block:

```ts
  } finally {
    // A failure to close never masks the run's own outcome.
    await handle?.close().catch(() => {});
    // Nor does a failure to trace: `toolCall` cannot reject.
    await logger.toolCall({
      correlationId,
      toolName: "draft_run",
      mode: input.mode,
      durationMs: Date.now() - startedAtMs,
      retryCount: 0,
      predictionVersion: PREDICTION_ALGORITHM_VERSION,
      status: runStatus,
      metadata: { itemCount },
    });
  }
```

- [ ] **Step 4: Run the draft-service test to verify it passes**

Run: `pnpm vitest run src/features/drafts/service.test.ts`
Expected: PASS, including every pre-existing case unchanged.

- [ ] **Step 5: Write the failing commit-service test**

Append to `src/features/cart/commit-service.test.ts`, reusing that file's existing fixture helpers. Add the same `collectingLogger` helper and the `sanitizeTrace` / `Logger` / `ToolTrace` imports from `@/lib/logger`:

```ts
describe("commitApprovedDraft tracing", () => {
  it("A17-28 emits one commit trace whose status follows the terminal outcome", async () => {
    const { logger, traces } = collectingLogger();
    const scenario = await verifiedCommitScenario();

    const result = await commitApprovedDraft(scenario.input, { ...scenario.deps, logger });

    expect(result.ok).toBe(true);
    const runTraces = traces.filter((entry) => entry.toolName === "cart_commit");
    expect(runTraces).toHaveLength(1);
    expect(runTraces[0]).toMatchObject({ status: "ok", retryCount: 0 });
  });

  it("A17-29 reports a retry as attempt one", async () => {
    const { logger, traces } = collectingLogger();
    const scenario = await verifiedCommitScenario();

    await commitApprovedDraft(scenario.input, { ...scenario.deps, logger });
    await commitApprovedDraft(scenario.input, { ...scenario.deps, logger });

    const runTraces = traces.filter((entry) => entry.toolName === "cart_commit");
    expect(runTraces.map((entry) => entry.retryCount)).toEqual([0, 1]);
  });

  it("A17-30 traces the cart write itself", async () => {
    const { logger, traces } = collectingLogger();
    const scenario = await verifiedCommitScenario();

    await commitApprovedDraft(scenario.input, { ...scenario.deps, logger });

    expect(traces.map((entry) => entry.toolName)).toContain("setAbsoluteCartQuantities");
  });
});
```

`verifiedCommitScenario()` is a helper this slice adds to that test file, built from the fixtures the file already uses for its verified-commit case: it returns `{ input, deps }` where `deps` is the object the existing tests pass to `commitApprovedDraft`. Extract it from the existing verified-commit test rather than writing a second set of fixtures, and have that test call it too.

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm vitest run src/features/cart/commit-service.test.ts`
Expected: FAIL. TypeScript reports that `logger` is not a member of `CommitApprovedDraftDeps`.

- [ ] **Step 7: Wire tracing into the commit service**

In `src/features/cart/commit-service.ts`, add the imports:

```ts
import { withTracedGateway } from "@/features/diagnostics/traced-gateway";
import { createNoopLogger, type Logger, type TraceStatus } from "@/lib/logger";
```

Add one field to `CommitApprovedDraftDeps`, after `openGateway`:

```ts
  /** Optional so every existing caller and test constructs deps unchanged. */
  logger?: Logger;
```

At the top of `commitApprovedDraft`. `traceMode` starts at `"demo"` and is
replaced by the draft's own mode as soon as the draft loads, because a
request for an unknown draft has no mode to report and must not claim one:

```ts
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? createNoopLogger();
  const startedAtMs = Date.now();
  let traceStatus: TraceStatus = "error";
  let traceMode: DataMode = "demo";
  let itemCount = 0;
  let attempt = 0;
  let handle: SilpoGatewayHandle | undefined;
```

Immediately after the draft loads:

```ts
    const draft = await deps.drafts.get(input.draftId, input.userId);
    if (!draft) return failure("not_found", input.correlationId);
    traceMode = draft.mode;
```

The retry is already known before the gateway opens, because `deps.commits.get` runs first. Replace the gateway opening:

```ts
    // A record that already exists means this request is a retry reusing the
    // persisted absolute targets.
    attempt = existing ? 1 : 0;

    handle = await deps.openGateway();
    const gateway = withTracedGateway(handle.gateway, {
      logger,
      correlationId: input.correlationId,
      mode: traceMode,
      retryCount: attempt,
    });
```

Delete the `const { gateway } = handle;` line that followed it.

Set the outcome at each terminal success. After the empty-targets reconciliation:

```ts
      await recordOutcome(deps, input, blocked.status);
      traceStatus = "blocked";
      itemCount = 0;
      return ok(blocked);
```

And after the post-write reconciliation:

```ts
    await recordOutcome(deps, input, result.status);
    traceStatus = result.status === "verified" ? "ok" : "blocked";
    itemCount = result.items.length;

    return ok(result);
```

The replay branch returns a stored cart without any cart call; set its outcome too:

```ts
      const cart = stored.success ? stored.data.data.cart : null;
      if (cart) {
        traceStatus = "ok";
        itemCount = cart.items.length;
        return ok(cart);
      }
      return failure("unexpected", input.correlationId);
```

Extend the existing `finally` block:

```ts
  } finally {
    // A failure to close never masks the commit's own outcome.
    await handle?.close().catch(() => {});
    await logger.toolCall({
      correlationId: input.correlationId,
      toolName: "cart_commit",
      mode: traceMode,
      durationMs: Date.now() - startedAtMs,
      retryCount: attempt,
      status: traceStatus,
      metadata: { itemCount, attempt },
    });
  }
```

`DataMode` is already imported as a type in this file; if it is not, add it to the existing import from `@/features/shared/contracts`.

- [ ] **Step 8: Run the commit-service test to verify it passes**

Run: `pnpm vitest run src/features/cart/commit-service.test.ts`
Expected: PASS, including every pre-existing case unchanged.

- [ ] **Step 9: Confirm the services still behave identically**

```bash
pnpm vitest run src/features/drafts src/features/cart tests/integration/draft-route.test.ts tests/integration/cart-commit-route.test.ts
```

Expected: PASS. No assertion in those files was edited except the additions above.

---

### 17.6 — Keep the price a replacement decision destroys

**Files:**
- Modify: `src/features/drafts/repository.ts`
- Modify: `src/features/drafts/repository.test.ts`

**Interfaces:**
- Consumes: `DraftItemDecision` from `src/features/drafts/repository.ts`.
- Produces: `replacedFromPriceFor(decision, row): number | null`, exported from `src/features/drafts/repository.ts` and used by the Postgres implementation.

- [ ] **Step 1: Write the failing mapping tests**

Append to `src/features/drafts/repository.test.ts`. Add `replacedFromPriceFor` to the existing import from `./repository`:

```ts
describe("replacedFromPriceFor", () => {
  const row = { price: 42.5, specialPrice: null };
  const replacement = {
    sourceProductId: "water-1",
    expectedVersion: 1,
    decision: "replaced" as const,
    item: {} as never,
  };

  it("A17-31 captures the effective price the replacement overwrites", () => {
    expect(replacedFromPriceFor(replacement, row)).toBe(42.5);
  });

  it("A17-32 prefers the special price, so both sides of the saving compare alike", () => {
    expect(replacedFromPriceFor(replacement, { price: 42.5, specialPrice: 33 })).toBe(33);
  });

  it("A17-33 records nothing for a kept or removed decision", () => {
    expect(replacedFromPriceFor({ ...replacement, decision: "kept" }, row)).toBeNull();
    expect(
      replacedFromPriceFor(
        { sourceProductId: "water-1", expectedVersion: 1, decision: "removed", item: null },
        row,
      ),
    ).toBeNull();
  });

  it("A17-34 records nothing when the stored row carries no price at all", () => {
    expect(replacedFromPriceFor(replacement, { price: null, specialPrice: null })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/features/drafts/repository.test.ts`
Expected: FAIL. `replacedFromPriceFor` is not exported.

- [ ] **Step 3: Implement the mapping and use it in the Postgres write**

In `src/features/drafts/repository.ts`, add above `createInMemoryDraftRepository`:

```ts
/**
 * The effective unit price a `replaced` decision is about to overwrite.
 *
 * Approval rewrites the row in place with the replacement's own price, so
 * this is the last moment the proposed price exists. Without it the
 * accepted-replacement savings metric has no minuend and is permanently
 * uncomputable. `kept` and `removed` change no price and record none.
 */
export function replacedFromPriceFor(
  decision: DraftItemDecision,
  row: { price: number | null; specialPrice: number | null },
): number | null {
  if (decision.decision !== "replaced") return null;
  return row.specialPrice ?? row.price;
}
```

In the Postgres `approveSelection`, inside the non-removed branch, extend the `.set({ ... })` object with one entry, placed after `userDecision`:

```ts
                userDecision: decision.decision,
                replacedFromPrice: replacedFromPriceFor(decision, {
                  price: row.price,
                  specialPrice: row.specialPrice,
                }),
                version: input.approvedDraft.version,
```

The in-memory repository deliberately does not store this field. Nothing on `DraftRepository` reads it back — only `DecisionRepository` does, and its in-memory implementation takes canned totals — so storing it in memory would be a write no test and no caller could observe.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/features/drafts/repository.test.ts`
Expected: PASS, including every pre-existing case unchanged.

- [ ] **Step 5: Confirm the approval path is otherwise untouched**

```bash
pnpm vitest run src/features/drafts/approval-service.test.ts tests/integration/draft-approval.test.ts
```

Expected: PASS. `PersistDraftApprovalInput` did not change, so the approval service, its validation, and its tests see nothing new.

---

### 17.7 — Read the product decisions the metrics need

**Files:**
- Create: `src/features/diagnostics/decision-repository.ts`
- Create: `src/features/diagnostics/decision-repository.test.ts`
- Modify: `src/features/cart/repository.ts`
- Modify: `src/features/cart/commit-service.ts`

**Interfaces:**
- Consumes: `drafts`, `draftItems`, `cartCommits` from `src/db/schema.ts`; `VerifiedCartSchema` from `src/features/shared/contracts.ts`.
- Produces: `LandedReplacement`, `DecisionTotals`, `DecisionRepository`, `createInMemoryDecisionRepository`, `createPostgresDecisionRepository`, and `StoredCommitResultSchema` newly exported from `src/features/cart/repository.ts`.

- [ ] **Step 1: Move the stored-commit shape to the module that owns it**

`src/features/cart/commit-service.ts` declares `StoredCommitResultSchema` privately. The decision repository must parse the same persisted value, and a second declaration would drift. Move it, do not copy it.

In `src/features/cart/repository.ts`, add next to `PlannedCartCommitSchema`:

```ts
/** The shape `saveResult` persists into `cart_commits.result`. */
export const StoredCommitResultSchema = z.object({
  status: z.enum(["verified", "partially_committed", "blocked"]),
  data: z.object({ cart: VerifiedCartSchema }),
});
```

Add `VerifiedCartSchema` to that file's import from `@/features/shared/contracts`. In `src/features/cart/commit-service.ts`, delete the local declaration and import the shared one from `./repository`, where `PlannedCartCommitSchema` is already imported. `VerifiedCartSchema` then has no remaining use in that file: remove it from the contracts import and leave `type VerifiedCart`, or `pnpm lint` fails on an unused binding.

- [ ] **Step 2: Confirm the move changed no behavior**

Run: `pnpm vitest run src/features/cart`
Expected: PASS.

- [ ] **Step 3: Write the failing decision-repository tests**

Create `src/features/diagnostics/decision-repository.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createInMemoryDecisionRepository, EMPTY_DECISION_TOTALS } from "./decision-repository";

describe("createInMemoryDecisionRepository", () => {
  it("A17-35 returns the totals it was given, for any user", async () => {
    const totals = {
      decidedItemCount: 5,
      keptItemCount: 3,
      replacedItemCount: 1,
      landedReplacements: [{ replacedFromPrice: 40, effectivePrice: 30, quantity: 2 }],
    };
    const repo = createInMemoryDecisionRepository(totals);

    expect(await repo.totalsForUser("user-1")).toEqual(totals);
  });

  it("A17-36 exposes an empty total for a visitor with no decisions", () => {
    expect(EMPTY_DECISION_TOTALS).toEqual({
      decidedItemCount: 0,
      keptItemCount: 0,
      replacedItemCount: 0,
      landedReplacements: [],
    });
  });
});
```

The Postgres implementation's behavior — the demo-mode filter, the landed rule, and the null-price case — is proven against a real database in slice 17.11. An in-memory fake of a two-table join would prove only that the fake matches itself.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm vitest run src/features/diagnostics/decision-repository.test.ts`
Expected: FAIL with `Failed to resolve import "./decision-repository"`.

- [ ] **Step 5: Implement both implementations**

Create `src/features/diagnostics/decision-repository.ts`:

```ts
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import type { DbClient } from "@/db/client";
import { cartCommits, draftItems, drafts } from "@/db/schema";
import { StoredCommitResultSchema } from "@/features/cart/repository";

export interface LandedReplacement {
  replacedFromPrice: number;
  effectivePrice: number;
  quantity: number;
}

export interface DecisionTotals {
  decidedItemCount: number;
  keptItemCount: number;
  replacedItemCount: number;
  landedReplacements: LandedReplacement[];
}

export interface DecisionRepository {
  totalsForUser(userId: string): Promise<DecisionTotals>;
}

export const EMPTY_DECISION_TOTALS: DecisionTotals = {
  decidedItemCount: 0,
  keptItemCount: 0,
  replacedItemCount: 0,
  landedReplacements: [],
};

export function createInMemoryDecisionRepository(totals: DecisionTotals): DecisionRepository {
  return {
    async totalsForUser(): Promise<DecisionTotals> {
      return structuredClone(totals);
    },
  };
}

/**
 * Demo-mode product-decision totals for one visitor.
 *
 * A replacement counts toward savings only when it actually reached the
 * cart, which is decided by product-ID membership in the `VerifiedCart`
 * persisted by the commit. That admits `partially_committed` commits, where
 * some lines landed and others did not, instead of discarding them whole.
 *
 * A replaced row whose `replaced_from_price` is null was approved before
 * migration 0005. It counts toward the replacement rate, because the user
 * really did replace it, and never toward savings, because the amount is
 * unknowable and a zero would understate the metric silently.
 */
export function createPostgresDecisionRepository(db: DbClient): DecisionRepository {
  return {
    async totalsForUser(userId: string): Promise<DecisionTotals> {
      const rows = await db
        .select({
          draftId: draftItems.draftId,
          productId: draftItems.productId,
          userDecision: draftItems.userDecision,
          price: draftItems.price,
          specialPrice: draftItems.specialPrice,
          quantity: draftItems.quantity,
          replacedFromPrice: draftItems.replacedFromPrice,
        })
        .from(draftItems)
        .innerJoin(drafts, eq(draftItems.draftId, drafts.id))
        .where(
          and(
            eq(drafts.userId, userId),
            eq(drafts.mode, "demo"),
            isNotNull(draftItems.userDecision),
          ),
        );

      if (rows.length === 0) {
        return structuredClone(EMPTY_DECISION_TOTALS);
      }

      const commitRows = await db
        .select({ draftId: cartCommits.draftId, result: cartCommits.result })
        .from(cartCommits)
        .where(
          and(
            eq(cartCommits.userId, userId),
            inArray(cartCommits.status, ["verified", "partially_committed"]),
          ),
        );

      const landedByDraft = new Map<string, Set<string>>();
      for (const row of commitRows) {
        if (row.draftId === null) continue;
        const parsed = StoredCommitResultSchema.safeParse(row.result);
        if (!parsed.success) continue;
        const productIds = landedByDraft.get(row.draftId) ?? new Set<string>();
        for (const item of parsed.data.data.cart.items) {
          productIds.add(item.productId);
        }
        landedByDraft.set(row.draftId, productIds);
      }

      const totals: DecisionTotals = {
        decidedItemCount: rows.length,
        keptItemCount: 0,
        replacedItemCount: 0,
        landedReplacements: [],
      };

      for (const row of rows) {
        if (row.userDecision === "kept") totals.keptItemCount += 1;
        if (row.userDecision !== "replaced") continue;
        totals.replacedItemCount += 1;

        const effectivePrice = row.specialPrice ?? row.price;
        if (
          row.replacedFromPrice === null ||
          effectivePrice === null ||
          row.quantity === null ||
          row.productId === null ||
          !landedByDraft.get(row.draftId)?.has(row.productId)
        ) {
          continue;
        }
        totals.landedReplacements.push({
          replacedFromPrice: row.replacedFromPrice,
          effectivePrice,
          quantity: row.quantity,
        });
      }

      return totals;
    },
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run src/features/diagnostics/decision-repository.test.ts && pnpm typecheck`
Expected: PASS.

---

### 17.8 — Aggregate the diagnostics report

**Files:**
- Create: `src/features/diagnostics/service.ts`
- Create: `src/features/diagnostics/service.test.ts`

**Interfaces:**
- Consumes: `loadDemoBacktest` from `./backtest-service`; `DecisionRepository`, `EMPTY_DECISION_TOTALS` from `./decision-repository`; `ToolTraceRepository`, `SanitizedTraceRow` from `./trace-repository`; `Logger` from `@/lib/logger`.
- Produces: `DecisionMetrics`, `DiagnosticsReport`, `BuildDiagnosticsDeps`, `buildDiagnostics`, `DIAGNOSTICS_TRACE_LIMIT`.

- [ ] **Step 1: Write the failing service tests**

Create `src/features/diagnostics/service.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { createDemoSilpoGateway } from "@/features/silpo/demo/demo-gateway";
import type { SilpoGateway } from "@/features/shared/contracts";
import { createNoopLogger, sanitizeTrace, type Logger, type ToolTrace } from "@/lib/logger";

import { createInMemoryDecisionRepository, type DecisionTotals } from "./decision-repository";
import { createInMemoryToolTraceRepository } from "./trace-repository";
import { buildDiagnostics, type BuildDiagnosticsDeps } from "./service";

const DEMO_USER = "00000000-0000-4000-8000-0000000000d0";

const totals = (overrides: Partial<DecisionTotals> = {}): DecisionTotals => ({
  decidedItemCount: 0,
  keptItemCount: 0,
  replacedItemCount: 0,
  landedReplacements: [],
  ...overrides,
});

function makeDeps(overrides: Partial<BuildDiagnosticsDeps> = {}): BuildDiagnosticsDeps {
  return {
    gateway: createDemoSilpoGateway(),
    decisions: createInMemoryDecisionRepository(totals()),
    traces: createInMemoryToolTraceRepository(),
    logger: createNoopLogger(),
    correlationId: "corr-1",
    now: () => new Date("2026-09-10T08:00:00.000Z"),
    ...overrides,
  };
}

describe("buildDiagnostics", () => {
  it("A17-37 exposes backtest and product-decision metrics in demo mode", async () => {
    const report = await buildDiagnostics(
      DEMO_USER,
      makeDeps({
        decisions: createInMemoryDecisionRepository(
          totals({
            decidedItemCount: 4,
            keptItemCount: 2,
            replacedItemCount: 1,
            landedReplacements: [{ replacedFromPrice: 40, effectivePrice: 30, quantity: 2 }],
          }),
        ),
      }),
    );

    if (report.backtest === null) throw new Error("expected a backtest report");
    expect(report.backtest.prediction.categoryPrecisionAt3 ?? 0).toBeGreaterThanOrEqual(0);
    expect(report.decisions).toHaveProperty("acceptanceRate");
    expect(report.decisions).toHaveProperty("replacementRate");
    expect(report.decisions).toHaveProperty("acceptedReplacementSavings");
  });

  it("A17-38 counts a replacement as an acceptance", async () => {
    const report = await buildDiagnostics(
      DEMO_USER,
      makeDeps({
        decisions: createInMemoryDecisionRepository(
          totals({ decidedItemCount: 4, keptItemCount: 2, replacedItemCount: 1 }),
        ),
      }),
    );

    // Two kept plus one replaced out of four decided; the fourth was removed.
    expect(report.decisions.acceptanceRate).toBeCloseTo(0.75, 10);
    expect(report.decisions.replacementRate).toBeCloseTo(0.25, 10);
  });

  it("A17-39 sums savings only over replacements that reached the cart", async () => {
    const report = await buildDiagnostics(
      DEMO_USER,
      makeDeps({
        decisions: createInMemoryDecisionRepository(
          totals({
            decidedItemCount: 2,
            replacedItemCount: 2,
            landedReplacements: [
              { replacedFromPrice: 40, effectivePrice: 30, quantity: 2 },
              { replacedFromPrice: 25.5, effectivePrice: 25, quantity: 1 },
            ],
          }),
        ),
      }),
    );

    expect(report.decisions.acceptedReplacementSavings).toBe(20.5);
    expect(report.decisions.landedReplacementCount).toBe(2);
  });

  it("A17-40 reports a net loss when the user chose a costlier replacement", async () => {
    const report = await buildDiagnostics(
      DEMO_USER,
      makeDeps({
        decisions: createInMemoryDecisionRepository(
          totals({
            decidedItemCount: 1,
            replacedItemCount: 1,
            landedReplacements: [{ replacedFromPrice: 20, effectivePrice: 26.4, quantity: 1 }],
          }),
        ),
      }),
    );

    expect(report.decisions.acceptedReplacementSavings).toBe(-6.4);
  });

  it("A17-41 returns null rather than zero when a denominator is absent", async () => {
    const report = await buildDiagnostics(DEMO_USER, makeDeps());

    expect(report.decisions.acceptanceRate).toBeNull();
    expect(report.decisions.replacementRate).toBeNull();
    expect(report.decisions.acceptedReplacementSavings).toBeNull();
  });

  it("A17-42 reports no decisions at all for a visitor with no identity", async () => {
    const decisions = createInMemoryDecisionRepository(totals({ decidedItemCount: 9 }));
    const totalsForUser = vi.spyOn(decisions, "totalsForUser");

    const report = await buildDiagnostics(null, makeDeps({ decisions }));

    expect(totalsForUser).not.toHaveBeenCalled();
    expect(report.decisions.decidedItemCount).toBe(0);
    expect(report.decisions.acceptanceRate).toBeNull();
  });

  it("A17-43 returns a report with a null backtest when the backtest fails", async () => {
    const traces: ToolTrace[] = [];
    const logger: Logger = { async toolCall(input) { traces.push(sanitizeTrace(input)); } };
    const broken: SilpoGateway = {
      ...createDemoSilpoGateway(),
      loadCartContext: async () => { throw new Error("demo snapshot unavailable"); },
    };

    const report = await buildDiagnostics(DEMO_USER, makeDeps({ gateway: broken, logger }));

    expect(report.backtest).toBeNull();
    expect(traces.filter((entry) => entry.toolName === "demo_backtest")).toMatchObject([
      { status: "error", mode: "demo" },
    ]);
  });

  it("A17-44 returns the newest demo traces and nothing that identifies a run", async () => {
    const traceRepo = createInMemoryToolTraceRepository(() => new Date("2026-09-10T07:59:00.000Z"));
    await traceRepo.append(
      sanitizeTrace({
        correlationId: "corr-9",
        toolName: "loadPurchaseHistory",
        mode: "demo",
        durationMs: 812,
        status: "ok",
        metadata: { itemCount: 7 },
      }),
    );

    const report = await buildDiagnostics(DEMO_USER, makeDeps({ traces: traceRepo }));

    expect(report.traces).toEqual([
      {
        toolName: "loadPurchaseHistory",
        durationMs: 812,
        status: "ok",
        at: "2026-09-10T07:59:00.000Z",
      },
    ]);
    expect(JSON.stringify(report.traces)).not.toMatch(/corr-9|itemCount/);
  });

  it("A17-45 stamps the report with the injected clock", async () => {
    const report = await buildDiagnostics(DEMO_USER, makeDeps());

    expect(report.generatedAt).toBe("2026-09-10T08:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/features/diagnostics/service.test.ts`
Expected: FAIL with `Failed to resolve import "./service"`.

- [ ] **Step 3: Implement the aggregation**

Create `src/features/diagnostics/service.ts`:

```ts
import type { BacktestReport } from "@/features/prediction/backtest";
import type { SilpoGateway } from "@/features/shared/contracts";
import type { Logger } from "@/lib/logger";

import { loadDemoBacktest } from "./backtest-service";
import {
  EMPTY_DECISION_TOTALS,
  type DecisionRepository,
  type DecisionTotals,
} from "./decision-repository";
import type { SanitizedTraceRow, ToolTraceRepository } from "./trace-repository";

/** Enough rows for the jury to see a whole run, few enough to stay legible. */
export const DIAGNOSTICS_TRACE_LIMIT = 20;

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
  traces: SanitizedTraceRow[];
}

export interface BuildDiagnosticsDeps {
  gateway: SilpoGateway;
  decisions: DecisionRepository;
  traces: ToolTraceRepository;
  logger: Logger;
  correlationId: string;
  now?: () => Date;
}

/** The repository's existing money rounding, matched exactly. */
const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * A denominator of zero yields `null`, never `0`.
 *
 * The two are different claims: `0` says the users rejected everything, and
 * `null` says nothing has been measured yet. The panel renders the second as
 * «Недостатньо спостережень».
 */
function toDecisionMetrics(totals: DecisionTotals): DecisionMetrics {
  const decided = totals.decidedItemCount;
  const landed = totals.landedReplacements;

  return {
    decidedItemCount: decided,
    // A replacement is an acceptance: the recommendation survived to the
    // cart, even though the exact product changed.
    acceptanceRate: decided === 0 ? null : (totals.keptItemCount + totals.replacedItemCount) / decided,
    replacementRate: decided === 0 ? null : totals.replacedItemCount / decided,
    acceptedReplacementSavings:
      landed.length === 0
        ? null
        : roundMoney(
            landed.reduce(
              (sum, entry) => sum + (entry.replacedFromPrice - entry.effectivePrice) * entry.quantity,
              0,
            ),
          ),
    landedReplacementCount: landed.length,
  };
}

/**
 * The demo diagnostics report.
 *
 * The gateway handed in here is deliberately **not** wrapped in
 * `withTracedGateway`. Opening the panel would otherwise write traces that
 * the panel then displays, and the jury would be reading the diagnostics
 * looking at themselves.
 *
 * A failing backtest degrades to `null` and one `error` trace rather than
 * failing the whole report: a diagnostics panel that returns nothing because
 * a sub-report failed is less useful than one that says it has nothing to
 * show.
 */
export async function buildDiagnostics(
  userId: string | null,
  deps: BuildDiagnosticsDeps,
): Promise<DiagnosticsReport> {
  const now = deps.now ?? (() => new Date());
  const startedAtMs = Date.now();

  const backtestResult = await loadDemoBacktest(deps.gateway, deps.correlationId);
  if (!backtestResult.ok) {
    await deps.logger.toolCall({
      correlationId: deps.correlationId,
      toolName: "demo_backtest",
      mode: "demo",
      durationMs: Date.now() - startedAtMs,
      retryCount: 0,
      status: "error",
    });
  }

  // A visitor with no demo cookie owns no drafts, so there is nothing to
  // query and no reason to touch the database.
  const totals = userId === null
    ? structuredClone(EMPTY_DECISION_TOTALS)
    : await deps.decisions.totalsForUser(userId);

  return {
    generatedAt: now().toISOString(),
    backtest: backtestResult.ok ? backtestResult.value : null,
    decisions: toDecisionMetrics(totals),
    traces: await deps.traces.recent("demo", DIAGNOSTICS_TRACE_LIMIT),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/features/diagnostics/service.test.ts`
Expected: PASS, 9 tests.

---

### 17.9 — Expose the demo-only diagnostics route

**Files:**
- Create: `src/app/api/demo/diagnostics/route.ts`
- Create: `tests/integration/demo-diagnostics-route.test.ts`

**Interfaces:**
- Consumes: `getServerEnv` from `@/lib/env`; `buildDiagnostics` from `@/features/diagnostics/service`; `getDbClient` from `@/db/client`; `demoUserIdFor`, `isDemoHandle`, `DEMO_SESSION_COOKIE` from `@/features/drafts/demo-user`.
- Produces: `GET` for `/api/demo/diagnostics`.

- [ ] **Step 1: Write the failing route tests**

Create `tests/integration/demo-diagnostics-route.test.ts`:

```ts
// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEMO_SESSION_COOKIE, createDemoHandle, demoUserIdFor } from "@/features/drafts/demo-user";
import type { DiagnosticsReport } from "@/features/diagnostics/service";
import type { ServerEnv } from "@/lib/env";

vi.mock("@/lib/env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/features/diagnostics/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/diagnostics/service")>()),
  buildDiagnostics: vi.fn(),
}));

const liveConfig: ServerEnv = {
  NODE_ENV: "test",
  DATA_MODE: "live",
  AGENT_MODEL: "gemini-3.7-flash",
  DATABASE_URL: "postgres://synthetic:synthetic@localhost/synthetic",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  GOOGLE_GENERATIVE_AI_API_KEY: "synthetic-test-key",
  PUBLIC_BASE_URL: "http://localhost:3000",
};
const demoConfig: ServerEnv = { ...liveConfig, DATA_MODE: "demo" };

const report: DiagnosticsReport = {
  generatedAt: "2026-09-10T08:00:00.000Z",
  backtest: null,
  decisions: {
    decidedItemCount: 0,
    acceptanceRate: null,
    replacementRate: null,
    acceptedReplacementSavings: null,
    landedReplacementCount: 0,
  },
  traces: [{ toolName: "loadPurchaseHistory", durationMs: 812, status: "ok", at: "2026-09-10T07:59:00.000Z" }],
};

const DEMO_HANDLE = createDemoHandle();

function request(cookie?: string): NextRequest {
  const req = new NextRequest("http://localhost:3000/api/demo/diagnostics");
  if (cookie !== undefined) req.cookies.set(DEMO_SESSION_COOKIE, cookie);
  return req;
}

describe("GET /api/demo/diagnostics", () => {
  let GET: typeof import("@/app/api/demo/diagnostics/route").GET;
  let getServerEnv: ReturnType<typeof vi.fn>;
  let buildDiagnostics: ReturnType<typeof vi.fn>;
  const dbCalls = { count: 0 };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    dbCalls.count = 0;
    vi.doMock("@/db/client", () => ({
      getDbClient: () => {
        dbCalls.count += 1;
        return {} as never;
      },
    }));
    ({ getServerEnv } = (await import("@/lib/env")) as never);
    ({ buildDiagnostics } = (await import("@/features/diagnostics/service")) as never);
    buildDiagnostics.mockResolvedValue(report);
    ({ GET } = await import("@/app/api/demo/diagnostics/route"));
  });

  it("A17-46 does not exist in live mode", async () => {
    getServerEnv.mockReturnValue(liveConfig);

    const response = await GET(request());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(buildDiagnostics).not.toHaveBeenCalled();
    // The gate returns before the client is built, so live mode never opens
    // a connection to serve a route that does not exist there.
    expect(dbCalls.count).toBe(0);
  });

  it("A17-47 returns the report in demo mode and forbids caching", async () => {
    getServerEnv.mockReturnValue(demoConfig);

    const response = await GET(request(DEMO_HANDLE));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(await response.json()).toEqual({ mode: "demo", report });
  });

  it("A17-48 scopes decisions to the visitor's own demo identity", async () => {
    getServerEnv.mockReturnValue(demoConfig);

    await GET(request(DEMO_HANDLE));

    expect(buildDiagnostics.mock.calls[0][0]).toBe(demoUserIdFor(DEMO_HANDLE));
  });

  it("A17-49 mints no identity for a visitor without a valid handle", async () => {
    getServerEnv.mockReturnValue(demoConfig);

    const withoutCookie = await GET(request());
    const withGarbage = await GET(request("not-a-handle"));

    expect(withoutCookie.status).toBe(200);
    expect(withGarbage.status).toBe(200);
    expect(buildDiagnostics.mock.calls.map((call) => call[0])).toEqual([null, null]);
  });

  it("A17-50 returns a typed error without echoing the cause", async () => {
    getServerEnv.mockReturnValue(demoConfig);
    buildDiagnostics.mockRejectedValue(new Error("postgres://user:pw@host down"));

    const response = await GET(request(DEMO_HANDLE));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("unexpected");
    expect(JSON.stringify(body)).not.toMatch(/postgres|pw@host/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/integration/demo-diagnostics-route.test.ts`
Expected: FAIL. The route module does not exist.

- [ ] **Step 3: Implement the route**

Create `src/app/api/demo/diagnostics/route.ts`:

```ts
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { getDbClient } from "@/db/client";
import { buildDiagnostics } from "@/features/diagnostics/service";
import { createPostgresDecisionRepository } from "@/features/diagnostics/decision-repository";
import { createPostgresToolTraceRepository } from "@/features/diagnostics/trace-repository";
import { DEMO_SESSION_COOKIE, demoUserIdFor, isDemoHandle } from "@/features/drafts/demo-user";
import { getServerEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import type { AppError } from "@/lib/result";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const UNEXPECTED_COPY = "Не вдалося побудувати звіт. Спробуйте ще раз.";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();

  try {
    // Live mode has no diagnostics surface at all, exactly as /api/backtest.
    if (getServerEnv().DATA_MODE === "live") {
      return NextResponse.json({ error: "not_found" }, { status: 404, headers: HEADERS });
    }

    // Read-only: the handle is honoured if present and never issued. A GET
    // that shows a report must not create a `users` row as a side effect.
    const cookieValue = request.cookies.get(DEMO_SESSION_COOKIE)?.value ?? null;
    const userId = isDemoHandle(cookieValue) ? demoUserIdFor(cookieValue) : null;

    const { createDemoSilpoGateway } = await import("@/features/silpo/demo/demo-gateway");
    const db = getDbClient();
    const traces = createPostgresToolTraceRepository(db);

    const report = await buildDiagnostics(userId, {
      gateway: createDemoSilpoGateway(),
      decisions: createPostgresDecisionRepository(db),
      traces,
      logger: createLogger({ sink: traces }),
      correlationId,
    });

    return NextResponse.json({ mode: "demo", report }, { status: 200, headers: HEADERS });
  } catch {
    // Environment, database and wiring faults. The cause is never echoed.
    const error: AppError = {
      code: "unexpected",
      message: UNEXPECTED_COPY,
      correlationId,
      retryAfterMs: null,
    };
    return NextResponse.json({ error }, { status: 500, headers: HEADERS });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/integration/demo-diagnostics-route.test.ts`
Expected: PASS, 5 tests.


---

### 17.10 — Render the collapsed «Як працює прогноз» panel

**Files:**
- Create: `src/components/autopilot/demo-diagnostics.tsx`
- Create: `src/components/autopilot/demo-diagnostics.test.tsx`
- Modify: `src/components/autopilot/draft-dashboard.tsx`
- Modify: `src/components/autopilot/draft-dashboard.test.tsx`
- Modify: `src/app/globals.css`

**Interfaces:**
- Consumes: `DiagnosticsReport` from `@/features/diagnostics/service`; `formatHryvnia` from `./format`.
- Produces: `DemoDiagnostics`, a client component taking no props, rendered by `DraftDashboard` in demo mode only.

- [ ] **Step 1: Write the failing panel tests**

Create `src/components/autopilot/demo-diagnostics.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiagnosticsReport } from "@/features/diagnostics/service";

import { DemoDiagnostics } from "./demo-diagnostics";

const emptyDecisions = {
  decidedItemCount: 0,
  acceptanceRate: null,
  replacementRate: null,
  acceptedReplacementSavings: null,
  landedReplacementCount: 0,
};

const report = (overrides: Partial<DiagnosticsReport> = {}): DiagnosticsReport => ({
  generatedAt: "2026-09-10T08:00:00.000Z",
  backtest: null,
  decisions: emptyDecisions,
  traces: [],
  ...overrides,
});

function stubFetch(body: unknown, ok = true) {
  const fetchMock = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  })) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * jsdom implements `<summary>` activation: the click flips `open` and queues
 * a `toggle` event, which is what React's `onToggle` listens for. The event
 * is asynchronous by specification, so every assertion after an open uses a
 * `findBy*` query rather than `getBy*`.
 */
const openPanel = () => fireEvent.click(screen.getByText("Як працює прогноз"));

describe("DemoDiagnostics", () => {
  it("A17-51 is collapsed and costs no request until it is opened", () => {
    const fetchMock = stubFetch({ mode: "demo", report: report() });

    render(<DemoDiagnostics />);

    expect(screen.getByText("Як працює прогноз")).toBeInTheDocument();
    expect(screen.queryByText("Якість прогнозу")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("A17-52 fetches once on first open and not again on reopen", async () => {
    const fetchMock = stubFetch({ mode: "demo", report: report() });

    render(<DemoDiagnostics />);
    openPanel();
    await screen.findByText("Рішення користувача");
    openPanel();
    openPanel();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/demo/diagnostics", { cache: "no-store" });
  });

  it("A17-53 says there is not enough data rather than showing a zero", async () => {
    stubFetch({ mode: "demo", report: report() });

    render(<DemoDiagnostics />);
    openPanel();

    const items = await screen.findAllByText("Недостатньо спостережень");
    expect(items.length).toBeGreaterThan(0);
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it("A17-54 shows the metrics and trace rows it was given", async () => {
    stubFetch({
      mode: "demo",
      report: report({
        decisions: {
          decidedItemCount: 4,
          acceptanceRate: 0.75,
          replacementRate: 0.25,
          acceptedReplacementSavings: 20.5,
          landedReplacementCount: 1,
        },
        traces: [
          { toolName: "loadPurchaseHistory", durationMs: 812, status: "ok", at: "2026-09-10T07:59:00.000Z" },
          { toolName: "readCart", durationMs: 120, status: "error", at: "2026-09-10T07:58:00.000Z" },
        ],
      }),
    });

    render(<DemoDiagnostics />);
    openPanel();

    expect(await screen.findByText("75%")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByText(/20,50 ₴/)).toBeInTheDocument();
    expect(screen.getByText(/економія/)).toBeInTheDocument();
    expect(screen.getByText("loadPurchaseHistory")).toBeInTheDocument();
    // Status is text, never colour alone.
    expect(screen.getByText("помилка")).toBeInTheDocument();
  });

  it("A17-55 names a negative net as an extra cost, not a negative saving", async () => {
    stubFetch({
      mode: "demo",
      report: report({
        decisions: { ...emptyDecisions, decidedItemCount: 1, acceptedReplacementSavings: -6.4, landedReplacementCount: 1 },
      }),
    });

    render(<DemoDiagnostics />);
    openPanel();

    expect(await screen.findByText(/додаткові витрати/)).toBeInTheDocument();
    expect(screen.getByText(/6,40 ₴/)).toBeInTheDocument();
    expect(screen.queryByText(/-6,40/)).not.toBeInTheDocument();
  });

  it("A17-56 reports a failed fetch as text", async () => {
    stubFetch({ error: { code: "unexpected" } }, false);

    render(<DemoDiagnostics />);
    openPanel();

    expect(await screen.findByText("Не вдалося завантажити діагностику.")).toBeInTheDocument();
  });

  it("A17-57 renders no identifier and no payload", async () => {
    stubFetch({
      mode: "demo",
      report: {
        ...report({ traces: [{ toolName: "readCart", durationMs: 5, status: "ok", at: "2026-09-10T07:58:00.000Z" }] }),
        correlationId: "corr-secret",
      },
    });

    const { container } = render(<DemoDiagnostics />);
    openPanel();
    await screen.findByText("readCart");

    expect(container.textContent).not.toMatch(/corr-secret|2026-09-10T07:58/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/components/autopilot/demo-diagnostics.test.tsx`
Expected: FAIL with `Failed to resolve import "./demo-diagnostics"`.

- [ ] **Step 3: Implement the panel**

Create `src/components/autopilot/demo-diagnostics.tsx`:

```tsx
"use client";

import { useState } from "react";

import type { DiagnosticsReport } from "@/features/diagnostics/service";
import type { TraceStatus } from "@/lib/logger";

import { formatHryvnia } from "./format";

const INSUFFICIENT = "Недостатньо спостережень";
const STATUS_COPY: Record<TraceStatus, string> = {
  ok: "успішно",
  error: "помилка",
  blocked: "потребує уваги",
};

type PanelState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; report: DiagnosticsReport }
  | { kind: "failed" };

const percent = (value: number | null): string =>
  value === null ? INSUFFICIENT : `${Math.round(value * 100)}%`;

const duration = (value: number): string => `${value} мс`;

/**
 * The savings figure is a net delta and may be negative when the user chose
 * a costlier replacement. Colour is never the only signal, so the sign is
 * carried by the words rather than by a red number.
 */
function savingsCopy(value: number | null): string {
  if (value === null) return INSUFFICIENT;
  const label = value < 0 ? "додаткові витрати" : "економія";
  return `${formatHryvnia(Math.abs(value))} — ${label}`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="autopilot-diagnostics-metric">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * Demo-only disclosure for the jury.
 *
 * `<details>` rather than a hand-built toggle: collapsed default, keyboard
 * operation, and screen-reader semantics come from the element. The report
 * is fetched on the first open only, so a panel nobody opens costs one
 * element and no request.
 */
export function DemoDiagnostics() {
  const [state, setState] = useState<PanelState>({ kind: "idle" });

  const load = async (): Promise<void> => {
    setState({ kind: "loading" });
    try {
      const response = await fetch("/api/demo/diagnostics", { cache: "no-store" });
      if (!response.ok) {
        setState({ kind: "failed" });
        return;
      }
      const body = (await response.json()) as { report: DiagnosticsReport };
      setState({ kind: "ready", report: body.report });
    } catch {
      setState({ kind: "failed" });
    }
  };

  const onToggle = (event: React.SyntheticEvent<HTMLDetailsElement>): void => {
    if (event.currentTarget.open && state.kind === "idle") {
      void load();
    }
  };

  return (
    <details className="autopilot-diagnostics" onToggle={onToggle}>
      <summary className="autopilot-diagnostics-summary">Як працює прогноз</summary>
      {state.kind === "loading" && <p>Завантажуємо діагностику…</p>}
      {state.kind === "failed" && <p>Не вдалося завантажити діагностику.</p>}
      {state.kind === "ready" && (
        <>
          <section aria-labelledby="autopilot-diagnostics-backtest">
            <h3 id="autopilot-diagnostics-backtest">Якість прогнозу</h3>
            <dl className="autopilot-diagnostics-metrics">
              <Metric label="Точність за товаром" value={percent(state.report.backtest?.prediction.exactSkuPrecisionAtK ?? null)} />
              <Metric label="Повнота за товаром" value={percent(state.report.backtest?.prediction.exactSkuRecallAtK ?? null)} />
              <Metric label="Точність за категорією" value={percent(state.report.backtest?.prediction.categoryPrecisionAt3 ?? null)} />
              <Metric label="Повнота за категорією" value={percent(state.report.backtest?.prediction.categoryRecallAt3 ?? null)} />
              <Metric label="Влучань у чек" value={percent(state.report.backtest?.prediction.receiptHitRate ?? null)} />
              <Metric label="Покриття" value={percent(state.report.backtest?.prediction.coverage ?? null)} />
            </dl>
          </section>

          <section aria-labelledby="autopilot-diagnostics-decisions">
            <h3 id="autopilot-diagnostics-decisions">Рішення користувача</h3>
            <dl className="autopilot-diagnostics-metrics">
              <Metric label="Прийнято рекомендацій" value={percent(state.report.decisions.acceptanceRate)} />
              <Metric label="Замінено рекомендацій" value={percent(state.report.decisions.replacementRate)} />
              <Metric label="Прийняті заміни" value={savingsCopy(state.report.decisions.acceptedReplacementSavings)} />
            </dl>
          </section>

          <section aria-labelledby="autopilot-diagnostics-traces">
            <h3 id="autopilot-diagnostics-traces">Виклики «Сільпо»</h3>
            {state.report.traces.length === 0 ? (
              <p>{INSUFFICIENT}</p>
            ) : (
              <table className="autopilot-diagnostics-traces">
                <caption>Інструмент, тривалість і статус останніх викликів</caption>
                <thead>
                  <tr>
                    <th scope="col">Інструмент</th>
                    <th scope="col">Тривалість</th>
                    <th scope="col">Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {state.report.traces.map((row, index) => (
                    <tr key={`${row.at}-${row.toolName}-${index}`}>
                      <td>{row.toolName}</td>
                      <td>{duration(row.durationMs)}</td>
                      <td>{STATUS_COPY[row.status]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </details>
  );
}
```

Note what is absent by construction: no correlation ID, no metadata, no raw timestamp, no product or user identifier is rendered anywhere. `SanitizedTraceRow.at` is used only as part of a React key.

- [ ] **Step 4: Add the panel styles**

Append to `src/app/globals.css`, after the `.autopilot-demo-banner` rule:

```css
.autopilot-diagnostics {
  margin-top: var(--autopilot-space-6);
  padding: var(--autopilot-space-4);
  border: 1px solid var(--autopilot-border);
  border-radius: var(--autopilot-radius-lg);
  background: var(--autopilot-surface);
}

.autopilot-diagnostics-summary {
  display: flex;
  align-items: center;
  min-height: 44px;
  font-size: var(--autopilot-font-body);
  font-weight: 600;
  cursor: pointer;
}

.autopilot-diagnostics-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--autopilot-space-3);
  margin: 0;
}

.autopilot-diagnostics-metric dt { color: var(--autopilot-muted); font-size: var(--autopilot-font-label); }
.autopilot-diagnostics-metric dd { margin: 0; font-size: var(--autopilot-font-small); font-variant-numeric: tabular-nums; }

.autopilot-diagnostics-traces { width: 100%; border-collapse: collapse; font-size: var(--autopilot-font-small); }
.autopilot-diagnostics-traces caption { text-align: left; color: var(--autopilot-muted); font-size: var(--autopilot-font-label); }
.autopilot-diagnostics-traces th { text-align: left; }
.autopilot-diagnostics-traces td, .autopilot-diagnostics-traces th { padding: var(--autopilot-space-2) 0; border-bottom: 1px solid var(--autopilot-border); }
```

Confirm the token names against the `:root` block at the top of `globals.css` before writing them; use only tokens that already exist. Do not add a colour literal.

- [ ] **Step 5: Run the panel tests to verify they pass**

Run: `pnpm vitest run src/components/autopilot/demo-diagnostics.test.tsx`
Expected: PASS, 7 tests.

- [ ] **Step 6: Write the failing dashboard placement test**

Append to `src/components/autopilot/draft-dashboard.test.tsx`:

```tsx
describe("DraftDashboard diagnostics placement", () => {
  it("A17-58 shows the diagnostics panel last in demo mode", () => {
    renderDashboard({ phase: { kind: "pending", status: "syncing", mode: "demo" } });

    const panel = screen.getByText("Як працює прогноз");
    expect(panel).toBeInTheDocument();

    // Dashboard order is fixed: diagnostics is item 7, after everything else.
    const main = screen.getByRole("main");
    expect(main.lastElementChild).toContainElement(panel);
  });

  it("A17-59 never shows the diagnostics panel in live mode", () => {
    renderDashboard({ phase: { kind: "pending", status: "syncing", mode: "live" } });

    expect(screen.queryByText("Як працює прогноз")).not.toBeInTheDocument();
  });
});
```

`renderDashboard(...)` is the existing helper at `src/components/autopilot/draft-dashboard.test.tsx:100`, taking `Partial<DraftDashboardProps>`. Reuse it rather than constructing a second one. These two tests also need `fetch` stubbed, because the panel fetches on open — but neither opens it, so a bare `vi.stubGlobal("fetch", vi.fn())` in the block is enough, and A17-58 additionally asserts it was never called.

- [ ] **Step 7: Run the test to verify it fails**

Run: `pnpm vitest run src/components/autopilot/draft-dashboard.test.tsx`
Expected: FAIL. The panel is not rendered.

- [ ] **Step 8: Render the panel from the dashboard**

In `src/components/autopilot/draft-dashboard.tsx`, add the import:

```ts
import { DemoDiagnostics } from "./demo-diagnostics";
```

Add one line as the last child of `<main className="autopilot-main">`, after the `displayedDraft` block:

```tsx
        {mode === "demo" && <DemoDiagnostics />}
```

- [ ] **Step 9: Run the dashboard test to verify it passes**

Run: `pnpm vitest run src/components/autopilot/draft-dashboard.test.tsx src/app/dashboard/page.test.tsx`
Expected: PASS, including every pre-existing case unchanged.

---

### 17.11 — Prove the migration and both new Postgres readers against a real database

**Files:**
- Modify: `vitest.config.ts`
- Create: `tests/integration/diagnostics-postgres.test.ts`

**Interfaces:**
- Consumes: `createPostgresToolTraceRepository`, `createPostgresDecisionRepository`, `createPostgresDraftRepository`, `sanitizeTrace`.
- Produces: the real-database evidence for slices 17.1, 17.3, 17.6, and 17.7.

- [ ] **Step 1: Exclude the gate from the default suite**

In `vitest.config.ts`, generalize the existing single-file mechanism to a list, so a third gate later needs no third branch:

```ts
const postgresTests = [
  "tests/integration/silpo-oauth-postgres.test.ts",
  "tests/integration/diagnostics-postgres.test.ts",
];
const excludedPostgresTests = postgresTests.filter(
  (file) => !process.argv.some((arg) => arg === file || arg.endsWith(`/${file}`)),
);
```

and replace the `...(runOAuthPostgres ? [] : [oauthPostgresTest])` entry in `exclude` with `...excludedPostgresTests`.

- [ ] **Step 2: Confirm the default suite still skips both**

```bash
pnpm vitest list 2>&1 | grep -c "postgres.test.ts"
```

Expected: `0`. `vitest list` enumerates collected files without executing them, so this stays fast and cannot be reported as green by a passing run that silently skipped nothing.

- [ ] **Step 3: Write the failing Postgres gate**

Create `tests/integration/diagnostics-postgres.test.ts`, following the schema-isolation setup in `tests/integration/silpo-oauth-postgres.test.ts` exactly: read every `drizzle/*.sql` file in lexical order, apply them into a randomly named schema, and pin `search_path` on every pooled connection. That gate opens two pooled clients to test concurrency; this one needs a single `db`, so declare one.

Its imports:

```ts
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DbClient } from "@/db/client";
import * as schema from "@/db/schema";
import { cartCommits, draftItems, users } from "@/db/schema";
import { createPostgresDecisionRepository } from "@/features/diagnostics/decision-repository";
import { createPostgresToolTraceRepository } from "@/features/diagnostics/trace-repository";
import { createPostgresDraftRepository } from "@/features/drafts/repository";
import {
  DraftItemSchema,
  DraftSchema,
  ProductCandidateSchema,
  VerifiedCartSchema,
  type Draft,
  type DraftItem,
  type ProductCandidate,
} from "@/features/shared/contracts";
import { sanitizeTrace } from "@/lib/logger";
```

The gate proves five facts no in-memory test can:

```ts
it("A17-60 applies the migration that adds both diagnostics columns", () => {
  const files = MIGRATIONS.filter((file) => {
    const sql = readFileSync(join(DRIZZLE_DIR, file), "utf8");
    return sql.includes('ADD COLUMN "replaced_from_price"') && sql.includes('ADD COLUMN "prediction_version"');
  });
  expect(files).toHaveLength(1);
});

it("A17-61 round-trips a sanitized trace and serves only the requested mode", async () => {
  const repo = createPostgresToolTraceRepository(db);
  await repo.append(sanitizeTrace({ toolName: "listTools", mode: "demo", durationMs: 4, status: "ok" }));
  await repo.append(
    sanitizeTrace({
      toolName: "loadPurchaseHistory",
      mode: "demo",
      durationMs: 812,
      status: "ok",
      predictionVersion: "prediction-v1",
      metadata: { itemCount: 7 },
    }),
  );
  await repo.append(sanitizeTrace({ toolName: "readCart", mode: "live", durationMs: 9, status: "ok" }));

  const rows = await repo.recent("demo", 20);
  // Order is not asserted here: three inserts can share a `created_at`
  // default down to the microsecond, and a tie would make the assertion
  // flaky. Recency ordering is proven deterministically by A17-14.
  expect(rows.map((row) => row.toolName).sort()).toEqual(["listTools", "loadPurchaseHistory"]);
  expect(rows.find((row) => row.toolName === "loadPurchaseHistory")?.durationMs).toBe(812);
  expect(JSON.stringify(await repo.all())).not.toMatch(/Bearer|380000000000/);
});

const candidate = (overrides: Partial<ProductCandidate> = {}): ProductCandidate =>
  ProductCandidateSchema.parse({
    productId: "water-2",
    externalProductId: 202,
    slug: "voda-2",
    name: "Вода негазована 2 л",
    imageUrl: null,
    price: 30,
    specialPrice: null,
    available: true,
    stock: 20,
    step: 1,
    displayRatio: 1,
    nutritionStatus: "insufficient",
    nutrition: null,
    promotions: [],
    ...overrides,
  });

const sourceItem = (overrides: Partial<DraftItem> = {}): DraftItem =>
  DraftItemSchema.parse({
    productId: "water-1",
    externalProductId: 101,
    name: "Вода негазована 1,5 л",
    imageUrl: null,
    displayRatio: 1,
    quantity: 2,
    price: 45,
    specialPrice: 40,
    stock: 10,
    step: 1,
    confidence: 0.8,
    confidenceBand: "high",
    reasonCodes: ["category_repeat"],
    reason: "Купуєте приблизно раз на 7 днів",
    nutritionStatus: "insufficient",
    promotions: [],
    alternatives: [candidate()],
    ...overrides,
  });

const readyDraft = (id: string, items: DraftItem[]): Draft =>
  DraftSchema.parse({
    id,
    mode: "demo",
    status: "ready",
    algorithmVersion: "prediction-v1",
    trainingCutoff: "2026-09-02T00:00:00.000Z",
    summary: "Схоже, вода скоро закінчиться",
    items,
    total: items.reduce((sum, item) => sum + item.quantity * (item.specialPrice ?? item.price), 0),
    version: 1,
  });

/** The replacement the user accepts, at 30 ₴ against a proposed 40 ₴. */
const replacementItem = (source: DraftItem): DraftItem =>
  DraftItemSchema.parse({
    ...source,
    productId: "water-2",
    externalProductId: 202,
    name: "Вода негазована 2 л",
    price: 30,
    specialPrice: null,
    stock: 20,
    alternatives: [],
  });

async function approveWithReplacement(
  db: DbClient,
  userId: string,
  draftId: string,
): Promise<{ replacement: DraftItem; idempotencyKey: string }> {
  const repo = createPostgresDraftRepository(db);
  const source = sourceItem();
  await repo.save(userId, readyDraft(draftId, [source]));

  const replacement = replacementItem(source);
  const idempotencyKey = randomUUID();
  const result = await repo.approveSelection({
    draftId,
    userId,
    expectedDraftVersion: 1,
    approvedDraft: {
      ...readyDraft(draftId, [replacement]),
      status: "confirming",
      version: 2,
    } as Draft & { status: "confirming" },
    decisions: [
      { sourceProductId: "water-1", expectedVersion: 1, decision: "replaced", item: replacement },
    ],
    idempotencyKey,
    approvedAt: new Date("2026-09-10T08:00:00.000Z"),
  });
  expect(result.status).toBe("approved");
  return { replacement, idempotencyKey };
}

it("A17-62 captures the price the replacement overwrites, and only for a replacement", async () => {
  const userId = randomUUID();
  await db.insert(users).values({ id: userId });
  const draftId = randomUUID();

  await approveWithReplacement(db, userId, draftId);

  const [row] = await db
    .select({
      productId: draftItems.productId,
      userDecision: draftItems.userDecision,
      replacedFromPrice: draftItems.replacedFromPrice,
    })
    .from(draftItems)
    .where(eq(draftItems.draftId, draftId));

  // The source line proposed 45 ₴ with a 40 ₴ special price; the effective
  // price is what a saving must be measured against.
  expect(row).toMatchObject({
    productId: "water-2",
    userDecision: "replaced",
    replacedFromPrice: 40,
  });

  // A kept decision changes no price and records none.
  const keptUserId = randomUUID();
  await db.insert(users).values({ id: keptUserId });
  const keptDraftId = randomUUID();
  const repo = createPostgresDraftRepository(db);
  const kept = sourceItem();
  await repo.save(keptUserId, readyDraft(keptDraftId, [kept]));
  await repo.approveSelection({
    draftId: keptDraftId,
    userId: keptUserId,
    expectedDraftVersion: 1,
    approvedDraft: {
      ...readyDraft(keptDraftId, [kept]),
      status: "confirming",
      version: 2,
    } as Draft & { status: "confirming" },
    decisions: [
      { sourceProductId: "water-1", expectedVersion: 1, decision: "kept", item: kept },
    ],
    idempotencyKey: randomUUID(),
    approvedAt: new Date("2026-09-10T08:00:00.000Z"),
  });

  const [keptRow] = await db
    .select({ replacedFromPrice: draftItems.replacedFromPrice })
    .from(draftItems)
    .where(eq(draftItems.draftId, keptDraftId));
  expect(keptRow.replacedFromPrice).toBeNull();
});

it("A17-63 counts only replacements that reached the cart toward savings", async () => {
  const userId = randomUUID();
  await db.insert(users).values({ id: userId });

  const committedDraftId = randomUUID();
  const uncommittedDraftId = randomUUID();
  const committed = await approveWithReplacement(db, userId, committedDraftId);
  const uncommitted = await approveWithReplacement(db, userId, uncommittedDraftId);

  const verifiedCart = VerifiedCartSchema.parse({
    cartId: "cart-1",
    status: "verified",
    items: [{ productId: "water-2", quantity: 2, price: 30, specialPrice: null }],
    total: 60,
    validations: [],
    checkout: { webUrl: null, mobileUrl: null },
  });

  await db.insert(cartCommits).values({
    idempotencyKey: committed.idempotencyKey,
    draftId: committedDraftId,
    userId,
    targetQuantities: { "water-2": 2 },
    status: "verified",
    result: { status: "verified", data: { cart: verifiedCart } },
  });

  // The second draft's commit never left `pending`, so nothing landed.
  await db.insert(cartCommits).values({
    idempotencyKey: uncommitted.idempotencyKey,
    draftId: uncommittedDraftId,
    userId,
    targetQuantities: { "water-2": 2 },
    status: "pending",
    result: null,
  });

  const totals = await createPostgresDecisionRepository(db).totalsForUser(userId);

  expect(totals.decidedItemCount).toBe(2);
  expect(totals.replacedItemCount).toBe(2);
  expect(totals.landedReplacements).toEqual([
    { replacedFromPrice: 40, effectivePrice: 30, quantity: 2 },
  ]);
});
```

```ts
it("A17-64 counts a pre-migration replacement toward the rate but never toward savings", async () => {
  const userId = randomUUID();
  await db.insert(users).values({ id: userId });
  const draftId = randomUUID();
  const approved = await approveWithReplacement(db, userId, draftId);

  // A row approved before migration 0005 has no recoverable proposed price.
  await db
    .update(draftItems)
    .set({ replacedFromPrice: null })
    .where(eq(draftItems.draftId, draftId));

  await db.insert(cartCommits).values({
    idempotencyKey: approved.idempotencyKey,
    draftId,
    userId,
    targetQuantities: { "water-2": 2 },
    status: "verified",
    result: {
      status: "verified",
      data: {
        cart: VerifiedCartSchema.parse({
          cartId: "cart-2",
          status: "verified",
          items: [{ productId: "water-2", quantity: 2, price: 30, specialPrice: null }],
          total: 60,
          validations: [],
          checkout: { webUrl: null, mobileUrl: null },
        }),
      },
    },
  });

  const totals = await createPostgresDecisionRepository(db).totalsForUser(userId);

  // The user really did replace it, so the rate must say so. The amount is
  // unknowable, and a zero would understate the saving silently.
  expect(totals.replacedItemCount).toBe(1);
  expect(totals.landedReplacements).toEqual([]);
});
```

`VerifiedCartSchema` rejects checkout links unless the cart is `verified` with no error validation, so build the cart through the schema rather than as a literal. The same rule applies to `approveSelection`: if it returns `conflict` rather than `approved`, read `validateApprovalInput` in `src/features/drafts/repository.ts` and fix the fixture, never the validation.

- [ ] **Step 4: Start a throwaway cluster and run the gate**

```bash
PGBIN=/opt/homebrew/opt/postgresql@18/bin
SCRATCH="${TMPDIR:-/tmp}/silpo-diagnostics-pg"
mkdir -p "$SCRATCH"
LC_ALL=C "$PGBIN/initdb" -D "$SCRATCH/pgdata" -U silpotest --auth=trust --locale=C --encoding=UTF8
LC_ALL=C "$PGBIN/pg_ctl" -D "$SCRATCH/pgdata" -o "-p 55432 -c unix_socket_directories= -c listen_addresses=127.0.0.1" -l "$SCRATCH/pg.log" start
LC_ALL=C "$PGBIN/createdb" -h 127.0.0.1 -p 55432 -U silpotest silpo_test
DATABASE_URL="postgres://silpotest@127.0.0.1:55432/silpo_test" pnpm vitest run tests/integration/diagnostics-postgres.test.ts
```

`initdb` fails on this machine's locale without `LC_ALL=C --locale=C`, and the scratchpad path exceeds the 103-byte Unix-socket limit, so the server must run TCP-only. Expected: PASS.

- [ ] **Step 5: Stop and delete the cluster**

```bash
PGBIN=/opt/homebrew/opt/postgresql@18/bin
SCRATCH="${TMPDIR:-/tmp}/silpo-diagnostics-pg"
LC_ALL=C "$PGBIN/pg_ctl" -D "$SCRATCH/pgdata" stop -m fast
rm -rf "$SCRATCH"
```

If the gate cannot be run — no local Postgres, or the cluster refuses to start — say so explicitly in the handoff and name it as unverified evidence. Do not claim it passed.

---

### 17.12 — Record the durable decisions and run the gates

**Files:**
- Modify: `docs/project-architecture.md`
- Modify: `docs/tasks.md`

- [ ] **Step 1: Replace architecture section 11 with what is actually emitted**

The current list describes an intention. Replace the body of «## 11. Observability» with:

```markdown
Кожен draft run і кожен cart commit отримує correlation ID. Traces пише `src/lib/logger.ts`; sink — `tool_traces`.

Санітизація структурна, а не за списком заборонених полів:

- невідомі ключі відкидаються схемою, тому `authorization`, `phone`, `address`, raw prompts і raw MCP payloads не мають куди потрапити;
- поля, що лишаються, обмежені патерном або enum: `correlationId`, `toolName`, `mode`, `durationMs`, `retryCount`, `predictionVersion`, `status`;
- `metadata` приймає лише `number`, `boolean` і `null`, тому текст у ній непредставний;
- кожне поле має безпечний fallback, тому `sanitizeTrace` тотальна й ніколи не кидає.

`logger.toolCall` ніколи не кидає й не відхиляється: збій sink або console не може завалити draft run чи cart write. Console отримує той самий санітизований запис, що й persistence.

Traces емітує декоратор `withTracedGateway`, застосований у draft- і commit-сервісах одразу після відкриття gateway. Один запис на кожен виклик `SilpoGateway` в обох режимах, включно з catalog-викликами всередині `resolveProducts`. Оригінальний об'єкт помилки прокидається без змін, бо сервіси класифікують збої через `instanceof`.

`retryCount` — це кількість спроб на рівні сервісу: `0` для першого запуску, `1` для повтору commit із тим самим idempotency key. Внутрішні MCP-повтори з `withBoundedRetry` не видимі на рівні gateway і в MVP не публікуються.

У demo mode користувач може відкрити панель «Як працює прогноз» із backtest summary, product-decision метриками та рядками `tool / duration / status`. Raw inputs, outputs, correlation ID, metadata та user identifiers не відображаються. Traces у панелі не скоуповані на користувача: `tool_traces` навмисно не має колонки користувача, і жодне поле санітизованого рядка не відрізняє відвідувачів.
```

- [ ] **Step 2: Record the report shape in architecture section 5**

Replace the `DiagnosticsService` paragraph's first sentence and append:

```markdown
`buildDiagnostics(userId, deps)` повертає `DiagnosticsReport`: `generatedAt`, `backtest` (`BacktestReport | null`), `decisions` і 20 найновіших demo-traces. Відсутній denominator дає `null`, а не `0`; копію «Недостатньо спостережень» рендерить компонент, а не API. Збій backtest дає `backtest: null`, HTTP 200 і один `error` trace замість 500.

Product-decision метрики рахуються за `draft_items` demo-чернеток цього відвідувача з непорожнім `user_decision`. Заміна зараховується як acceptance. `acceptedReplacementSavings` — це сума `(replaced_from_price − effective price) × quantity` лише для замін, що реально потрапили в кошик, за membership product ID у `VerifiedCart` із `cart_commits.result`. Значення чисте й може бути від'ємним.
```

- [ ] **Step 3: Record the two new columns in architecture section 8**

Add to the persistence list:

```markdown
- `draft_items.replaced_from_price`: effective ціна позиції, яку перезаписує рішення `replaced`; `null` для інших рішень і для рядків до міграції 0005;
- `tool_traces.prediction_version`: версія алгоритму прогнозу; окрема колонка, бо `metadata` навмисно не приймає рядків;
```

- [ ] **Step 4: Update the Task 17 entry in `docs/tasks.md`**

Replace the Task 17 **Files** block with the full list from this plan's File Structure table, tick every step checkbox, and append a completion note in the same style as Task 16's, naming the spec and this plan, the evidence commands, and the carried limitations from spec section 12.

- [ ] **Step 5: Run the focused suites**

```bash
pnpm vitest run \
  src/lib/logger.test.ts \
  src/features/diagnostics/service.test.ts \
  src/features/diagnostics/trace-repository.test.ts \
  src/features/diagnostics/traced-gateway.test.ts \
  src/features/diagnostics/decision-repository.test.ts \
  src/components/autopilot/demo-diagnostics.test.tsx \
  tests/integration/demo-diagnostics-route.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run the cumulative suites and static gates**

```bash
pnpm vitest run
pnpm lint
pnpm typecheck
pnpm build
```

Expected: PASS for all four. Do not proceed on a failure; fix the cause rather than the assertion.

- [ ] **Step 7: Review the diff for scope and safety**

```bash
git status --short && git diff
```

Confirm: no denylist of forbidden key names anywhere; no `console.log`; no secret; no placeholder; no file outside the File Structure table; no weakened pre-existing assertion; no second migration; no user column on `tool_traces`; and no path where a logger failure can reach the caller.

Then confirm the diagnostics route creates no identity:

```bash
grep -n "ensureDemoUser\|insert(users)" src/app/api/demo/diagnostics/route.ts
```

Expected: no match. A read-only GET must not mint a `users` row as a side effect of showing a report.

Then confirm redaction end to end:

```bash
grep -rn "authorization\|Bearer\|phone\|barcode" src/lib/logger.ts src/features/diagnostics/
```

Expected: no match. The redaction is structural, so those words should appear nowhere in the implementation.

- [ ] **Step 8: Commit once**

```bash
git add \
  src/db/schema.ts \
  src/db/schema.test.ts \
  drizzle/0005_diagnostics_trace_fields.sql \
  src/lib/logger.ts \
  src/lib/logger.test.ts \
  src/features/diagnostics/trace-repository.ts \
  src/features/diagnostics/trace-repository.test.ts \
  src/features/diagnostics/traced-gateway.ts \
  src/features/diagnostics/traced-gateway.test.ts \
  src/features/diagnostics/decision-repository.ts \
  src/features/diagnostics/decision-repository.test.ts \
  src/features/diagnostics/service.ts \
  src/features/diagnostics/service.test.ts \
  src/features/drafts/service.ts \
  src/features/drafts/service.test.ts \
  src/features/drafts/repository.ts \
  src/features/drafts/repository.test.ts \
  src/features/cart/commit-service.ts \
  src/features/cart/commit-service.test.ts \
  src/features/cart/repository.ts \
  src/app/api/demo/diagnostics \
  src/app/globals.css \
  src/components/autopilot/demo-diagnostics.tsx \
  src/components/autopilot/demo-diagnostics.test.tsx \
  src/components/autopilot/draft-dashboard.tsx \
  src/components/autopilot/draft-dashboard.test.tsx \
  tests/integration/demo-diagnostics-route.test.ts \
  tests/integration/diagnostics-postgres.test.ts \
  vitest.config.ts \
  docs/project-architecture.md \
  docs/tasks.md
git commit -m "feat: expose sanitized demo diagnostics"
```

- [ ] **Step 9: Report the handoff**

Report changed files, every command run with its fresh output, the commit hash, whether the Postgres gate ran and against what, and every limitation from spec section 12: MCP-internal retries uncounted, gateway-method trace names, demo-global traces, savings blind to pre-migration approvals, and no price history for removals.
