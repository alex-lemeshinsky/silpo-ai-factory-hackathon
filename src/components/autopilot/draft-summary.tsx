import type { Draft, VerifiedCart } from "@/features/shared/contracts";
import { formatHryvnia, pluralizeUk } from "./format";

export interface DraftSummaryProps {
  draft: Draft;
  cart: VerifiedCart | null;
}

export function DraftSummary({ draft, cart }: DraftSummaryProps) {
  const count = draft.items.length;
  const hasUnavailable = draft.items.some((item) => item.stock === 0 || item.quantity > item.stock);
  const hasError = cart?.validations.some((validation) => validation.severity === "error") ?? false;
  const links = draft.status === "verified" && cart !== null && !hasError
    ? cart.checkoutLinks
    : null;

  return (
    <section className="autopilot-summary" aria-label="Підсумок чернетки">
      <p className="autopilot-summary-count">
        {count} {pluralizeUk(count, ["позиція", "позиції", "позицій"])}
      </p>
      {count > 0 && <p className="autopilot-summary-total">Разом {formatHryvnia(draft.total)}</p>}
      {draft.status === "ready" && count === 0 && (
        <p className="autopilot-summary-note">Немає що додавати</p>
      )}
      {draft.status === "ready" && count > 0 && (
        <>
          <button
            type="button"
            className="autopilot-cta"
            disabled={hasUnavailable}
            aria-describedby={hasUnavailable ? "autopilot-cta-reason" : undefined}
          >
            Додати у кошик “Сільпо”
          </button>
          {hasUnavailable && (
            <p id="autopilot-cta-reason" className="autopilot-summary-note">
              Спочатку розберіться з позиціями, яких немає в наявності
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
