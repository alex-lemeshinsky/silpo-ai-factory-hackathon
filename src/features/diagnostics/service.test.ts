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
