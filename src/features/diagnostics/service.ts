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
