import { useRef, useState } from "react";
import {
  DraftItemSchema,
  DraftSchema,
  effectiveUnitPrice,
  type Draft,
  type DraftItem,
  type ProductCandidate,
} from "@/features/shared/contracts";
import {
  DraftApprovalResponseSchema,
  type DraftApprovalInput,
  type DraftApprovalResponse,
} from "@/features/drafts/approval-service";
import { DraftProductCard } from "./draft-product-card";
import { DraftSummary } from "./draft-summary";
import { formatHryvnia, formatNumber } from "./format";

export type EditableDraft = Draft & { status: "ready" };
export type ConfirmingDraft = Draft & { status: "confirming" };

export interface DraftApprovedEvent {
  idempotencyKey: string;
  draft: ConfirmingDraft;
}

export type ApproveDraftRequest = (
  draftId: string,
  input: DraftApprovalInput,
) => Promise<DraftApprovalResponse>;

export interface DraftEditorProps {
  draft: EditableDraft;
  onApproved: (event: DraftApprovedEvent) => void;
  approveDraft?: ApproveDraftRequest;
}

interface EditorRow {
  source: DraftItem;
  selected: DraftItem | ProductCandidate;
  quantityText: string;
  lastFiniteQuantity: number;
  removed: boolean;
  picker: "closed" | "unresolved";
  selectionBeforePicker: DraftItem | ProductCandidate;
}

export class DraftApprovalHttpError extends Error {
  constructor(readonly status: number) {
    super(`draft approval failed with status ${status}`);
    this.name = "DraftApprovalHttpError";
  }
}

export function messageForApprovalError(error: unknown): string {
  if (!(error instanceof DraftApprovalHttpError)) {
    return "Не вдалося підтвердити чернетку. Спробуйте ще раз.";
  }
  if (error.status === 401) {
    return "Не вдалося підтвердити вхід. Увійдіть у «Сільпо» ще раз.";
  }
  if (error.status === 404) return "Чернетку не знайдено. Створіть нову.";
  if (error.status === 409) {
    return "Чернетка змінилася. Оновіть сторінку й перевірте вибір ще раз.";
  }
  if (error.status === 422) return "Перевірте кількість або вибрану заміну.";
  return "Не вдалося підтвердити чернетку. Спробуйте ще раз.";
}

export async function postDraftApproval(
  draftId: string,
  input: DraftApprovalInput,
): Promise<DraftApprovalResponse> {
  const response = await fetch(`/api/drafts/${encodeURIComponent(draftId)}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new DraftApprovalHttpError(response.status);
  const parsed = DraftApprovalResponseSchema.safeParse(payload);
  if (!parsed.success) throw new DraftApprovalHttpError(500);
  return parsed.data;
}

function decimalPlaces(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const s = String(value);
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

function stepQuantity(value: number, step: number, direction: -1 | 1): number {
  const precision = Math.max(decimalPlaces(value), decimalPlaces(step));
  const factor = 10 ** Math.min(precision, 9);
  return (Math.round(value * factor) + direction * Math.round(step * factor)) / factor;
}

const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

function quantityError(row: EditorRow): string | null {
  const quantity = Number(row.quantityText);
  if (
    row.quantityText.trim() === "" ||
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    quantity > row.selected.stock ||
    Math.abs(quantity / row.selected.step - Math.round(quantity / row.selected.step)) > 1e-9
  ) {
    return `Кількість має відповідати кроку ${formatNumber(row.selected.step)} і не перевищувати запас ${formatNumber(row.selected.stock)}.`;
  }
  return null;
}

function cannotIncrease(row: EditorRow): boolean {
  const q = Number(row.quantityText);
  if (row.quantityText.trim() === "" || !Number.isFinite(q)) return true;
  const next = stepQuantity(q, row.selected.step, 1);
  return next > row.selected.stock + 1e-9;
}

function cannotDecrease(row: EditorRow): boolean {
  const q = Number(row.quantityText);
  if (row.quantityText.trim() === "" || !Number.isFinite(q)) return true;
  const next = stepQuantity(q, row.selected.step, -1);
  return next <= 0 || next < row.selected.step - 1e-9;
}

function availableAlternatives(row: EditorRow): Array<DraftItem | ProductCandidate> {
  const alternatives = row.source.alternatives.filter(
    (candidate) =>
      candidate.available &&
      candidate.stock > 0 &&
      candidate.stock >= candidate.step &&
      candidate.productId !== row.selected.productId,
  );
  return row.selected.productId === row.source.productId
    ? alternatives
    : [row.source, ...alternatives];
}

function displayItem(row: EditorRow): DraftItem {
  if (row.selected === row.source) {
    return row.source;
  }
  const candidate = row.selected as ProductCandidate;
  return {
    productId: candidate.productId,
    externalProductId: candidate.externalProductId,
    name: candidate.name,
    imageUrl: candidate.imageUrl,
    displayRatio: candidate.displayRatio,
    quantity: candidate.step,
    price: candidate.price,
    specialPrice: candidate.specialPrice,
    stock: candidate.stock,
    step: candidate.step,
    confidence: row.source.confidence,
    confidenceBand: row.source.confidenceBand,
    reasonCodes: [...row.source.reasonCodes],
    reason: row.source.reason,
    nutritionStatus: candidate.nutritionStatus,
    promotions: candidate.promotions.map((promotion) => ({ ...promotion })),
    alternatives: row.source.alternatives.filter(
      (alternative) => alternative.productId !== candidate.productId,
    ),
  };
}

function replacementItem(
  source: DraftItem,
  candidate: ProductCandidate,
  quantity: number,
): DraftItem {
  return DraftItemSchema.parse({
    productId: candidate.productId,
    externalProductId: candidate.externalProductId,
    name: candidate.name,
    imageUrl: candidate.imageUrl,
    displayRatio: candidate.displayRatio,
    quantity,
    price: candidate.price,
    specialPrice: candidate.specialPrice,
    stock: candidate.stock,
    step: candidate.step,
    confidence: source.confidence,
    confidenceBand: source.confidenceBand,
    reasonCodes: [...source.reasonCodes],
    reason: source.reason,
    nutritionStatus: candidate.nutritionStatus,
    promotions: candidate.promotions.map((promotion) => ({ ...promotion })),
    alternatives: source.alternatives
      .filter((alternative) => alternative.productId !== candidate.productId)
      .map((alternative) => structuredClone(alternative)),
  });
}

function keptItem(source: DraftItem, quantity: number): DraftItem {
  return DraftItemSchema.parse({
    productId: source.productId,
    externalProductId: source.externalProductId,
    name: source.name,
    imageUrl: source.imageUrl,
    displayRatio: source.displayRatio,
    quantity,
    price: source.price,
    specialPrice: source.specialPrice,
    stock: source.stock,
    step: source.step,
    confidence: source.confidence,
    confidenceBand: source.confidenceBand,
    reasonCodes: [...source.reasonCodes],
    reason: source.reason,
    nutritionStatus: source.nutritionStatus,
    promotions: source.promotions.map((promotion) => ({ ...promotion })),
    alternatives: source.alternatives.map((candidate) => structuredClone(candidate)),
  });
}

function buildRequest(rows: EditorRow[], draftVersion: number): DraftApprovalInput {
  return {
    draftVersion,
    items: rows.map((row) => {
      if (row.removed) {
        return {
          sourceProductId: row.source.productId,
          itemVersion: draftVersion,
          selectedProductId: null,
          quantity: null,
        };
      }
      return {
        sourceProductId: row.source.productId,
        itemVersion: draftVersion,
        selectedProductId: row.selected.productId,
        quantity: Number(row.quantityText),
      };
    }),
  };
}

function buildConfirmingDraft(rows: EditorRow[], draft: EditableDraft): ConfirmingDraft {
  const activeItems: DraftItem[] = [];
  for (const row of rows) {
    if (row.removed) continue;
    const quantity = Number(row.quantityText);
    const item =
      row.selected.productId !== row.source.productId
        ? replacementItem(row.source, row.selected as ProductCandidate, quantity)
        : keptItem(row.source, quantity);
    activeItems.push(item);
  }

  const total = roundMoney(
    activeItems.reduce(
      (sum, item) => sum + item.quantity * effectiveUnitPrice(item),
      0,
    ),
  );

  return DraftSchema.parse({
    ...draft,
    status: "confirming",
    version: draft.version + 1,
    items: activeItems,
    total,
  }) as ConfirmingDraft;
}

function computeDisplayTotal(rows: EditorRow[]): number {
  let total = 0;
  for (const row of rows) {
    if (row.removed) continue;
    const num = Number(row.quantityText);
    const quantity =
      row.quantityText.trim() !== "" && Number.isFinite(num) && num > 0
        ? num
        : row.lastFiniteQuantity;
    const unitPrice = row.selected.specialPrice ?? row.selected.price;
    total += quantity * unitPrice;
  }
  return roundMoney(total);
}

export function DraftEditor({ draft, onApproved, approveDraft }: DraftEditorProps) {
  const [rows, setRows] = useState<EditorRow[]>(() =>
    draft.items.map((item) => ({
      source: item,
      selected: item,
      quantityText: String(item.quantity),
      lastFiniteQuantity: item.quantity,
      removed: false,
      picker: "closed",
      selectionBeforePicker: item,
    })),
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  const activeRows = rows.filter((row) => !row.removed);
  const activeCount = activeRows.length;
  const hasUnresolvedPicker = rows.some((row) => !row.removed && row.picker === "unresolved");
  const firstQuantityError = activeRows
    .map((row) => quantityError(row))
    .find((message): message is string => message !== null) ?? null;
  const hasInvalidQuantity = firstQuantityError !== null;
  const isConfirmDisabled = activeCount === 0 || hasUnresolvedPicker || hasInvalidQuantity;
  const confirmDescription = hasUnresolvedPicker
    ? "Спочатку виберіть заміну або скасуйте вибір."
    : firstQuantityError ?? (submitting ? "Зачекайте, чернетка підтверджується." : null);
  const displayTotal = computeDisplayTotal(rows);

  function changeByStep(sourceProductId: string, direction: -1 | 1) {
    setRows((prev) =>
      prev.map((row) => {
        if (row.source.productId !== sourceProductId) return row;
        const num = Number(row.quantityText);
        const current =
          row.quantityText.trim() !== "" && Number.isFinite(num)
            ? num
            : row.lastFiniteQuantity;
        const next = stepQuantity(current, row.selected.step, direction);
        if (next <= 0 || next > row.selected.stock + 1e-9) return row;
        return {
          ...row,
          quantityText: String(next),
          lastFiniteQuantity: next,
        };
      }),
    );
  }

  function setQuantity(sourceProductId: string, text: string) {
    setRows((prev) =>
      prev.map((row) => {
        if (row.source.productId !== sourceProductId) return row;
        const num = Number(text);
        const isFinitePositive = text.trim() !== "" && Number.isFinite(num) && num > 0;
        return {
          ...row,
          quantityText: text,
          lastFiniteQuantity: isFinitePositive ? num : row.lastFiniteQuantity,
        };
      }),
    );
  }

  function remove(sourceProductId: string) {
    setRows((prev) =>
      prev.map((row) =>
        row.source.productId === sourceProductId
          ? { ...row, removed: true, picker: "closed" }
          : row,
      ),
    );
  }

  function restore(sourceProductId: string) {
    setRows((prev) =>
      prev.map((row) =>
        row.source.productId === sourceProductId
          ? { ...row, removed: false, picker: "closed" }
          : row,
      ),
    );
  }

  function openPicker(sourceProductId: string) {
    setRows((prev) =>
      prev.map((row) =>
        row.source.productId === sourceProductId
          ? { ...row, picker: "unresolved", selectionBeforePicker: row.selected }
          : row,
      ),
    );
  }

  function cancelPicker(sourceProductId: string) {
    setRows((prev) =>
      prev.map((row) =>
        row.source.productId === sourceProductId
          ? { ...row, picker: "closed", selected: row.selectionBeforePicker }
          : row,
      ),
    );
  }

  function selectReplacement(sourceProductId: string, candidateProductId: string) {
    setRows((prev) =>
      prev.map((row) => {
        if (row.source.productId !== sourceProductId) return row;
        const candidate = candidateProductId === row.source.productId
          ? row.source
          : row.source.alternatives.find((alt) => alt.productId === candidateProductId);
        if (!candidate) return row;
        return {
          ...row,
          selected: candidate,
          picker: "closed",
        };
      }),
    );
  }

  async function submit() {
    if (submittingRef.current || isConfirmDisabled) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await (approveDraft ?? postDraftApproval)(
        draft.id,
        buildRequest(rows, draft.version),
      );
      onApproved({
        idempotencyKey: response.idempotencyKey,
        draft: buildConfirmingDraft(rows, draft),
      });
    } catch (error) {
      setSubmitError(messageForApprovalError(error));
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <>
      <section className="autopilot-products autopilot-editor" aria-labelledby="autopilot-products-title">
        <h2 id="autopilot-products-title">Ймовірно закінчується</h2>
        <ul className="autopilot-grid">
          {rows.map((row, index) =>
            row.removed ? (
              <li key={row.source.productId} className="autopilot-product autopilot-product-removed">
                <h3>{row.source.name}</h3>
                <p>Товар прибрано з чернетки</p>
                <button type="button" onClick={() => restore(row.source.productId)} disabled={submitting}>
                  Повернути {row.source.name}
                </button>
              </li>
            ) : (
              <DraftProductCard
                key={row.source.productId}
                item={displayItem(row)}
                validations={[]}
                showQuantity={false}
              >
                <div className="autopilot-quantity">
                  <button
                    type="button"
                    aria-label={`Зменшити кількість ${displayItem(row).name}`}
                    onClick={() => changeByStep(row.source.productId, -1)}
                    disabled={submitting || cannotDecrease(row)}
                  >
                    −
                  </button>
                  <label htmlFor={`quantity-${index}`}>Кількість</label>
                  <input
                    id={`quantity-${index}`}
                    type="number"
                    inputMode="decimal"
                    aria-label={`Кількість для ${displayItem(row).name}`}
                    aria-invalid={quantityError(row) !== null}
                    aria-describedby={quantityError(row) ? `quantity-error-${index}` : undefined}
                    value={row.quantityText}
                    onChange={(event) => setQuantity(row.source.productId, event.currentTarget.value)}
                    disabled={submitting}
                  />
                  <button
                    type="button"
                    aria-label={`Збільшити кількість ${displayItem(row).name}`}
                    onClick={() => changeByStep(row.source.productId, 1)}
                    disabled={submitting || cannotIncrease(row)}
                  >
                    +
                  </button>
                </div>
                {quantityError(row) && (
                  <p id={`quantity-error-${index}`} className="autopilot-quantity-error">
                    {quantityError(row)}
                  </p>
                )}
                <div className="autopilot-editor-actions">
                  <button
                    className="autopilot-editor-button"
                    type="button"
                    onClick={() => remove(row.source.productId)}
                    disabled={submitting}
                  >
                    Прибрати {displayItem(row).name}
                  </button>
                  {availableAlternatives(row).length > 0 && (
                    <button
                      className="autopilot-editor-button"
                      type="button"
                      onClick={() => openPicker(row.source.productId)}
                      disabled={submitting}
                    >
                      Замінити {displayItem(row).name}
                    </button>
                  )}
                </div>
                {row.picker === "unresolved" && (
                  <fieldset className="autopilot-picker" disabled={submitting}>
                    <legend>Виберіть заміну для {row.source.name}</legend>
                    <ul className="autopilot-picker-options">
                      {availableAlternatives(row).map((candidate) => (
                        <li key={candidate.productId}>
                          <label>
                            <input
                              type="radio"
                              name={`replacement-${index}`}
                              value={candidate.productId}
                              onChange={() => selectReplacement(row.source.productId, candidate.productId)}
                            />
                            <span className="autopilot-picker-copy">
                              <strong>
                                {candidate.name} — {formatHryvnia(candidate.specialPrice ?? candidate.price)}
                              </strong>
                              <span>Фасування: ×{formatNumber(candidate.displayRatio)}</span>
                              <span>В наявності: {formatNumber(candidate.stock)}</span>
                              {candidate.promotions.map((promotion) => (
                                <span key={promotion.id}>
                                  {promotion.price === null
                                    ? promotion.label
                                    : `${promotion.label}: ${formatHryvnia(promotion.price)}`}
                                </span>
                              ))}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                    <button
                      className="autopilot-editor-button"
                      type="button"
                      onClick={() => cancelPicker(row.source.productId)}
                      disabled={submitting}
                    >
                      Скасувати заміну
                    </button>
                  </fieldset>
                )}
              </DraftProductCard>
            ),
          )}
        </ul>
      </section>
      {submitError && (
        <p role="alert" className="autopilot-submit-error">
          {submitError}
        </p>
      )}
      <DraftSummary
        draft={draft}
        cart={null}
        itemCount={activeCount}
        displayTotal={displayTotal}
        onConfirm={submit}
        confirmDisabled={isConfirmDisabled}
        confirmDescription={confirmDescription}
        confirmPending={submitting}
      />
    </>
  );
}
