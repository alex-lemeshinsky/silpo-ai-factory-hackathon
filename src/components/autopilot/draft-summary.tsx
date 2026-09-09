import type { Draft, VerifiedCart } from "@/features/shared/contracts";
import { formatHryvnia, pluralizeUk } from "./format";

export interface DraftSummaryProps {
  draft: Draft;
  cart: VerifiedCart | null;
  itemCount?: number;
  displayTotal?: number;
  onConfirm?: () => void;
  confirmDisabled?: boolean;
  confirmDescription?: string | null;
  confirmPending?: boolean;
}

export function DraftSummary({
  draft,
  cart,
  itemCount,
  displayTotal,
  onConfirm,
  confirmDisabled = false,
  confirmDescription = null,
  confirmPending = false,
}: DraftSummaryProps) {
  const count = itemCount ?? draft.items.length;
  const total = displayTotal ?? draft.total;
  const hasError = cart?.validations.some((validation) => validation.severity === "error") ?? false;
  const links = draft.status === "verified" && cart !== null && !hasError
    ? cart.checkoutLinks
    : null;
  const descriptionId = "autopilot-summary-confirm-description";

  return (
    <section className="autopilot-summary" aria-label="Підсумок чернетки">
      <p className="autopilot-summary-count">
        {count} {pluralizeUk(count, ["позиція", "позиції", "позицій"])}
      </p>
      {count > 0 && <p className="autopilot-summary-total">Разом {formatHryvnia(total)}</p>}
      {draft.status === "ready" && count === 0 && (
        <p className="autopilot-summary-note">Немає що додавати</p>
      )}
      {draft.status === "ready" && count > 0 && (
        <>
          <button
            type="button"
            className="autopilot-cta"
            onClick={onConfirm}
            disabled={confirmDisabled || confirmPending}
            aria-describedby={confirmDescription ? descriptionId : undefined}
          >
            {confirmPending ? "Підтверджуємо…" : "Додати у кошик “Сільпо”"}
          </button>
          {confirmDescription && (
            <p id={descriptionId} className="autopilot-summary-note">
              {confirmDescription}
            </p>
          )}
        </>
      )}
      {links !== null && (
        <p className="autopilot-checkout">
          <a href={links.web}>Оформити на сайті</a>
          <a href={links.mobile}>Оформити в застосунку</a>
        </p>
      )}
    </section>
  );
}
