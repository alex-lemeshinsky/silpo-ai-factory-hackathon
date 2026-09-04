import type {
  CartContext, DataMode, Draft, DraftStatus, VerifiedCart,
} from "@/features/shared/contracts";
import { AppHeader } from "./app-header";
import { DraftOverview } from "./draft-overview";
import { DraftProductCard } from "./draft-product-card";
import { DraftSummary } from "./draft-summary";
import { StatusPanel, ValidationList, type StatusTone } from "./status-panel";

export type DraftPhase =
  | { kind: "pending"; status: Extract<DraftStatus, "syncing" | "generating">; mode: DataMode }
  | { kind: "draft"; draft: Draft };

export interface DraftDashboardProps {
  phase: DraftPhase;
  cartContext: CartContext | null;
  loyaltyBonusAvailable: number | null;
  cart: VerifiedCart | null;
}

interface PanelCopy {
  title: string;
  description: string;
  tone: StatusTone;
}

const PENDING_PANELS: Record<"syncing" | "generating", PanelCopy> = {
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

const DRAFT_PANELS: Partial<Record<DraftStatus, PanelCopy>> = {
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
  phase, cartContext, loyaltyBonusAvailable, cart,
}: DraftDashboardProps) {
  const mode = phase.kind === "draft" ? phase.draft.mode : phase.mode;
  const panel = phase.kind === "pending"
    ? PENDING_PANELS[phase.status]
    : DRAFT_PANELS[phase.draft.status];

  return (
    <>
      <AppHeader mode={mode} cartContext={cartContext} cart={cart} />
      {mode === "demo" && <p className="autopilot-demo-banner">Демонстраційні дані</p>}
      <main className="autopilot-main">
        {panel && <StatusPanel {...panel} headingLevel={phase.kind === "pending" ? 1 : 2} />}
        {cart !== null && <ValidationList validations={cart.validations} />}
        {phase.kind === "draft" && (
          <>
            <DraftOverview draft={phase.draft} loyaltyBonusAvailable={loyaltyBonusAvailable} />
            <section className="autopilot-products" aria-labelledby="autopilot-products-title">
              <h2 id="autopilot-products-title">Ймовірно закінчується</h2>
              <ul className="autopilot-grid">
                {phase.draft.items.map((entry) => (
                  <DraftProductCard
                    key={entry.productId}
                    item={entry}
                    validations={cart?.validations.filter((validation) => validation.productId === entry.productId) ?? []}
                  />
                ))}
              </ul>
            </section>
            <DraftSummary draft={phase.draft} cart={cart} />
          </>
        )}
      </main>
    </>
  );
}
