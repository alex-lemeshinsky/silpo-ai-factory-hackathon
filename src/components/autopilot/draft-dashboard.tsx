"use client";

import { useEffect, useState } from "react";
import type {
  CartContext, DataMode, Draft, DraftStatus, VerifiedCart,
} from "@/features/shared/contracts";
import { AppHeader } from "./app-header";
import { DraftOverview } from "./draft-overview";
import { DraftProductCard } from "./draft-product-card";
import { DraftSummary } from "./draft-summary";
import {
  DraftEditor,
  type ApproveDraftRequest,
  type ConfirmingDraft,
  type EditableDraft,
} from "./draft-editor";
import { StatusPanel, ValidationList, type StatusTone } from "./status-panel";
import { DemoDiagnostics } from "./demo-diagnostics";

export type PendingStatus = Extract<DraftStatus, "syncing" | "generating">;

/**
 * A draft the user can act on. The two pending statuses describe work that
 * happens before a draft exists, so a draft carrying one has no dashboard to
 * render: excluding them here makes that state unrepresentable rather than
 * silently falling through DRAFT_PANELS to no status panel at all.
 */
export type ActionableDraft = Draft & { status: Exclude<DraftStatus, PendingStatus> };

export type DraftPhase =
  | { kind: "pending"; status: PendingStatus; mode: DataMode }
  | { kind: "draft"; draft: ActionableDraft };

export interface DraftDashboardProps {
  phase: DraftPhase;
  cartContext: CartContext | null;
  loyaltyBonusAvailable: number | null;
  cart: VerifiedCart | null;
  approveDraft?: ApproveDraftRequest;
}

interface ApprovedState {
  idempotencyKey: string;
  draft: ConfirmingDraft;
}

interface PanelCopy {
  title: string;
  description: string;
  tone: StatusTone;
}

const PENDING_PANELS: Record<PendingStatus, PanelCopy> = {
  syncing: {
    title: "Синхронізуємо історію покупок",
    description: "Це займе кілька секунд.",
    tone: "progress",
  },
  generating: {
    title: "Готуємо чернетку",
    description: "Підбираємо товари, які ймовірно закінчуються.",
    tone: "progress",
  },
};

const DRAFT_PANELS: Partial<Record<ActionableDraft["status"], PanelCopy>> = {
  confirming: {
    title: "Перевіряємо ціну та наявність",
    description: "Не закривайте сторінку.",
    tone: "progress",
  },
  partially_committed: {
    title: "Частину товарів потрібно перевірити",
    description: "Не всі позиції потрапили до кошика “Сільпо”.",
    tone: "attention",
  },
  verified: {
    title: "Кошик оновлено",
    description: "Товари додано до кошика “Сільпо”.",
    tone: "success",
  },
  blocked: {
    title: "Кошик потребує уваги",
    description: "Виправте помилки, щоб продовжити.",
    tone: "attention",
  },
};

export function DraftDashboard({
  phase,
  cartContext,
  loyaltyBonusAvailable,
  cart,
  approveDraft,
}: DraftDashboardProps) {
  const [approved, setApproved] = useState<ApprovedState | null>(null);
  const sourceDraft = phase.kind === "draft" ? phase.draft : null;
  const displayedDraft = approved?.draft ?? sourceDraft;

  const phaseDraftId = phase.kind === "draft" ? phase.draft.id : null;
  const phaseDraftVersion = phase.kind === "draft" ? phase.draft.version : null;
  const phaseDraftStatus = phase.kind === "draft" ? phase.draft.status : phase.status;

  useEffect(() => {
    if (phase.kind !== "draft" || phase.draft.status !== "ready") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Task 15.5 specifies resetting approved state in an effect on phase change.
      setApproved(null);
      return;
    }
    setApproved((current) => {
      if (current === null) return null;
      if (
        current.draft.id !== phaseDraftId ||
        current.draft.version !== (phaseDraftVersion ?? 0) + 1
      ) {
        return null;
      }
      return current;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when the draft identity, version, or status changes
  }, [phaseDraftId, phaseDraftVersion, phaseDraftStatus]);

  const mode = displayedDraft?.mode ?? (phase.kind === "pending" ? phase.mode : phase.draft.mode);
  const panel = phase.kind === "pending"
    ? PENDING_PANELS[phase.status]
    : (displayedDraft ? DRAFT_PANELS[displayedDraft.status] : undefined);

  return (
    <>
      <AppHeader mode={mode} cartContext={cartContext} cart={cart} />
      {mode === "demo" && <p className="autopilot-demo-banner">Демонстраційні дані</p>}
      <main className="autopilot-main">
        {panel && <StatusPanel {...panel} headingLevel={phase.kind === "pending" ? 1 : 2} />}
        {cart !== null && <ValidationList validations={cart.validations} />}
        {displayedDraft !== null && (
          <>
            <DraftOverview draft={displayedDraft} loyaltyBonusAvailable={loyaltyBonusAvailable} />
            {displayedDraft.status === "ready" ? (
              <DraftEditor
                draft={displayedDraft as EditableDraft}
                onApproved={setApproved}
                approveDraft={approveDraft}
              />
            ) : (
              <>
                <section className="autopilot-products" aria-labelledby="autopilot-products-title">
                  <h2 id="autopilot-products-title">Ймовірно закінчується</h2>
                  <ul className="autopilot-grid">
                    {displayedDraft.items.map((entry) => (
                      <DraftProductCard
                        key={entry.productId}
                        item={entry}
                        validations={cart?.validations.filter((validation) => validation.productId === entry.productId) ?? []}
                      />
                    ))}
                  </ul>
                </section>
                <DraftSummary draft={displayedDraft} cart={cart} />
              </>
            )}
          </>
        )}
        {mode === "demo" && <DemoDiagnostics />}
      </main>
    </>
  );
}
