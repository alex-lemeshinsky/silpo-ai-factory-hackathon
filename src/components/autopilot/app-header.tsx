import type { CartContext, DataMode, VerifiedCart } from "@/features/shared/contracts";
import { formatSlot, pluralizeUk } from "./format";

export interface AppHeaderProps {
  mode: DataMode;
  cartContext: CartContext | null;
  cart: VerifiedCart | null;
}

export function AppHeader({ mode, cartContext, cart }: AppHeaderProps) {
  const cartLabel = cart === null
    ? "Кошик “Сільпо” ще не змінювався"
    : `У кошику ${cart.items.length} ${pluralizeUk(cart.items.length, ["позиція", "позиції", "позицій"])}`;

  return (
    <header className="autopilot-header">
      <p className="autopilot-wordmark-group">
        <span className="autopilot-wordmark">Автопілот</span>
        <span className="autopilot-wordmark-note">працює з кошиком “Сільпо”</span>
      </p>
      <dl className="autopilot-header-context">
        {cartContext === null ? (
          <div className="autopilot-header-row">
            <dt>Кошик</dt>
            <dd>Кошик “Сільпо” ще не підключено</dd>
          </div>
        ) : (
          <>
            <div className="autopilot-header-row">
              <dt>Спосіб отримання</dt>
              <dd>{cartContext.deliveryType === "delivery" ? "Доставка" : "Самовивіз"}</dd>
            </div>
            <div className="autopilot-header-row">
              <dt>Місто</dt>
              <dd>{cartContext.city ?? "Місто не вибрано"}</dd>
            </div>
            <div className="autopilot-header-row">
              <dt>Слот</dt>
              <dd>{formatSlot(cartContext.slot.startsAt, cartContext.slot.endsAt)}</dd>
            </div>
          </>
        )}
        <div className="autopilot-header-row">
          <dt>Кошик “Сільпо”</dt>
          <dd>{cartLabel}</dd>
        </div>
        <div className="autopilot-header-row">
          <dt>Джерело даних</dt>
          <dd>{mode === "live" ? "Живі дані “Сільпо”" : "Демо-режим"}</dd>
        </div>
      </dl>
    </header>
  );
}
