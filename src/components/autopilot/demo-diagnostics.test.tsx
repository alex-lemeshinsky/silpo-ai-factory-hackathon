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
