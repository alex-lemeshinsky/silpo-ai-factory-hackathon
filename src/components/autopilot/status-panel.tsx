import type { CartValidation } from "@/features/shared/contracts";

export type StatusTone = "progress" | "attention" | "success";

export interface StatusPanelProps {
  title: string;
  description: string;
  tone: StatusTone;
  headingLevel: 1 | 2;
}

export function StatusPanel({ title, description, tone, headingLevel }: StatusPanelProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const live = tone === "attention"
    ? { role: "alert" as const }
    : { role: "status" as const, "aria-live": "polite" as const };

  return (
    <div className={`autopilot-status autopilot-status-${tone}`} {...live}>
      <Heading className="autopilot-status-title">{title}</Heading>
      <p className="autopilot-status-description">{description}</p>
    </div>
  );
}

export function ValidationList({ validations }: { validations: CartValidation[] }) {
  const cartLevel = validations.filter((validation) => validation.productId === null);
  if (cartLevel.length === 0) {
    return null;
  }

  const label = cartLevel.some((validation) => validation.severity === "error")
    ? "Помилки кошика"
    : "Попередження кошика";

  return (
    <ul className="autopilot-validations" aria-label={label}>
      {cartLevel.map((validation, index) => (
        <li key={`${validation.code}-${index}`} className="autopilot-validation">
          <span className="autopilot-validation-severity">
            {validation.severity === "error" ? "Помилка" : "Увага"}
          </span>{" "}
          {validation.message}
        </li>
      ))}
    </ul>
  );
}
