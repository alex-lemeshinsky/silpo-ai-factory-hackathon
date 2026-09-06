import type { Draft } from "@/features/shared/contracts";
import { PREDICTION_CONFIG } from "@/features/prediction/features";
import { formatDay, formatHryvnia, pluralizeUk } from "./format";

export interface DraftOverviewProps {
  draft: Draft;
  loyaltyBonusAvailable: number | null;
}

export function DraftOverview({ draft, loyaltyBonusAvailable }: DraftOverviewProps) {
  const count = draft.items.length;
  const high = draft.items.filter((entry) => entry.confidenceBand === "high").length;
  const medium = count - high;
  const discount = draft.items.reduce(
    (sum, entry) => entry.specialPrice === null
      ? sum
      : sum + entry.quantity * (entry.price - entry.specialPrice),
    0,
  );

  return (
    <>
      <section className="autopilot-hero">
        {count === 0 ? (
          <h1 className="autopilot-hero-title">Поки що нічого не проситься до кошика</h1>
        ) : (
          <>
            <h1 className="autopilot-hero-title">
              {count}{" "}
              {pluralizeUk(count, [
                "товар уже проситься до кошика",
                "товари уже просяться до кошика",
                "товарів уже просяться до кошика",
              ])}
            </h1>
            <p className="autopilot-hero-total">Разом {formatHryvnia(draft.total)}</p>
          </>
        )}
        {draft.summary !== "" && <p className="autopilot-hero-summary">{draft.summary}</p>}
      </section>
      <div className="autopilot-cards">
        <section className="autopilot-card" aria-labelledby="autopilot-forecast-title">
          <h2 id="autopilot-forecast-title">Прогноз</h2>
          <p>Регулярних потреб: {count}</p>
          <p>Історія за останні {PREDICTION_CONFIG.historyWindowDays} днів</p>
          <p>Висока впевненість: {high}</p>
          <p>Середня впевненість: {medium}</p>
          <p>Дані до {formatDay(draft.trainingCutoff)}</p>
        </section>
        <section className="autopilot-card" aria-labelledby="autopilot-value-title">
          <h2 id="autopilot-value-title">Вигода</h2>
          {discount > 0 ? (
            <>
              <p>Знижки в чернетці: {formatHryvnia(discount)}</p>
              <p>Ціни перевіримо ще раз перед додаванням у кошик</p>
            </>
          ) : (
            <p>Знижок у чернетці немає</p>
          )}
          {loyaltyBonusAvailable !== null && (
            <>
              <p>
                Доступно {loyaltyBonusAvailable}{" "}
                {pluralizeUk(loyaltyBonusAvailable, ["бонус", "бонуси", "бонусів"])}
              </p>
              <p>Бонуси не застосовуються автоматично</p>
            </>
          )}
        </section>
      </div>
    </>
  );
}
