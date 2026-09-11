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
