import { effectiveUnitPrice, type CartValidation, type DraftItem } from "@/features/shared/contracts";
import { formatHryvnia, formatNumber } from "./format";

export interface DraftProductCardProps {
  item: DraftItem;
  validations: CartValidation[];
}

// DraftItemSchema guarantees 0 < quantity <= stock, so a draft item is always
// available at its snapshot quantity. Reduced or exhausted stock is discovered
// during cart verification and reaches this card as a per-item validation.
function stockLabel(item: DraftItem): string {
  return `В наявності: ${formatNumber(item.stock)}`;
}

export function DraftProductCard({ item, validations }: DraftProductCardProps) {
  return (
    <li className="autopilot-product">
      <div className="autopilot-product-image">
        {item.imageUrl === null ? (
          <span className="autopilot-product-placeholder" aria-hidden="true" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- Product images are third-party Silpo CDN URLs; the host is unknown until Task 11, so images.remotePatterns cannot be configured yet.
          <img src={item.imageUrl} alt={item.name} loading="lazy" />
        )}
      </div>
      <h3 className="autopilot-product-name">{item.name}</h3>
      <p className="autopilot-product-quantity">Кількість: {formatNumber(item.quantity)}</p>
      <p className="autopilot-product-price">
        <span className="autopilot-price-current">
          {formatHryvnia(effectiveUnitPrice(item))}
        </span>
        {item.specialPrice !== null && (
          <s className="autopilot-price-previous">Було {formatHryvnia(item.price)}</s>
        )}
      </p>
      {item.promotions.length > 0 && (
        <ul className="autopilot-product-promotions">
          {item.promotions.map((promotion) => (
            <li key={promotion.id}>
              {promotion.price === null
                ? promotion.label
                : `${promotion.label}: ${formatHryvnia(promotion.price)}`}
            </li>
          ))}
        </ul>
      )}
      <p className="autopilot-product-stock">{stockLabel(item)}</p>
      <p className="autopilot-product-confidence">
        {item.confidenceBand === "high" ? "Висока впевненість" : "Середня впевненість"}
      </p>
      <p className="autopilot-product-reason">{item.reason}</p>
      {item.nutritionStatus === "insufficient" && (
        <p className="autopilot-product-nutrition">Даних про склад недостатньо</p>
      )}
      {item.alternatives.length > 0 && (
        <p className="autopilot-product-alternatives">
          Доступні заміни: {item.alternatives.length}
        </p>
      )}
      {validations.length > 0 && (
        <ul className="autopilot-product-validations">
          {validations.map((validation, index) => (
            <li key={`${validation.code}-${index}`}>
              <span className="autopilot-validation-severity">
                {validation.severity === "error" ? "Помилка" : "Увага"}
              </span>{" "}
              {validation.message}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
