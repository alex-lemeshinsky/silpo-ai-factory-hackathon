import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DraftSchema,
  ProductCandidateSchema,
  effectiveUnitPrice,
  type Draft,
  type DraftItem,
  type ProductCandidate,
} from "@/features/shared/contracts";
import type {
  DraftApprovalResponse,
} from "@/features/drafts/approval-service";
import {
  DraftEditor,
  type ApproveDraftRequest,
  type DraftApprovedEvent,
  type EditableDraft,
} from "./draft-editor";

const APPROVAL_KEY = "00000000-0000-4000-8000-0000000000aa";

const item = (overrides: Partial<DraftItem> = {}): DraftItem => ({
  productId: "water-1",
  externalProductId: 101,
  name: "Вода",
  imageUrl: null,
  displayRatio: 1,
  quantity: 2,
  price: 20,
  specialPrice: null,
  stock: 10,
  step: 1,
  confidence: 0.8,
  confidenceBand: "high",
  reasonCodes: ["category_repeat"],
  reason: "Купуєте приблизно раз на 7 днів",
  nutritionStatus: "insufficient",
  promotions: [],
  alternatives: [],
  ...overrides,
});

const draft = (overrides: Partial<Draft> = {}): EditableDraft => {
  const items = overrides.items ?? [item()];
  const parsed = DraftSchema.parse({
    id: "00000000-0000-4000-8000-000000000001",
    mode: "live",
    status: "ready",
    algorithmVersion: "prediction-v1",
    trainingCutoff: "2026-09-02T00:00:00.000Z",
    summary: "Схоже, вода скоро закінчиться",
    version: 1,
    ...overrides,
    items,
    total: overrides.total
      ?? items.reduce((sum, entry) => sum + effectiveUnitPrice(entry) * entry.quantity, 0),
  });

  return parsed as EditableDraft;
};

const alternative = (overrides: Partial<ProductCandidate> = {}): ProductCandidate =>
  ProductCandidateSchema.parse({
    productId: "water-2",
    externalProductId: 102,
    slug: "water-2",
    name: "Вода 2 л",
    imageUrl: null,
    price: 20,
    specialPrice: 15,
    available: true,
    stock: 3,
    step: 1,
    displayRatio: 0.9,
    nutritionStatus: "insufficient",
    nutrition: null,
    promotions: [{ id: "promo-1", label: "Акція", price: 15 }],
    ...overrides,
  });

const renderEditor = (
  testDraft: EditableDraft = draft(),
  options: {
    onApproved?: (event: DraftApprovedEvent) => void;
    approveDraft?: ApproveDraftRequest;
  } = {},
) => {
  const onApproved = options.onApproved ?? vi.fn();
  const view = render(
    <DraftEditor
      draft={testDraft}
      onApproved={onApproved}
      approveDraft={options.approveDraft}
    />,
  );
  return { ...view, onApproved };
};

describe("DraftEditor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("T15-01 changes fractional quantity by the selected step and respects stock", () => {
    renderEditor(draft({ items: [item({ quantity: 0.5, step: 0.5, stock: 1.5 })] }));
    const input = screen.getByRole("spinbutton", { name: "Кількість для Вода" });

    fireEvent.click(screen.getByRole("button", { name: "Збільшити кількість Вода" }));
    expect(input).toHaveValue(1);
    fireEvent.click(screen.getByRole("button", { name: "Збільшити кількість Вода" }));
    expect(input).toHaveValue(1.5);
    expect(screen.getByRole("button", { name: "Збільшити кількість Вода" })).toBeDisabled();
  });

  it("T15-02 associates invalid typed quantity and disables confirmation", () => {
    renderEditor(draft());
    const input = screen.getByRole("spinbutton", { name: "Кількість для Вода" });
    fireEvent.change(input, { target: { value: "1.25" } });

    expect(input).toBeInvalid();
    expect(input).toHaveAccessibleDescription("Кількість має відповідати кроку 1 і не перевищувати запас 10.");
    const confirm = screen.getByRole("button", { name: "Додати у кошик “Сільпо”" });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAccessibleDescription(
      "Кількість має відповідати кроку 1 і не перевищувати запас 10.",
    );
  });

  it("T15-02 disables confirmation for empty input", () => {
    renderEditor(draft());
    const input = screen.getByRole("spinbutton", { name: "Кількість для Вода" });
    fireEvent.change(input, { target: { value: "" } });

    expect(input).toBeInvalid();
    expect(input).toHaveAccessibleDescription("Кількість має відповідати кроку 1 і не перевищувати запас 10.");
    expect(screen.getByRole("button", { name: "Додати у кошик “Сільпо”" })).toBeDisabled();
  });

  it("T15-02 disables confirmation for zero input", () => {
    renderEditor(draft());
    const input = screen.getByRole("spinbutton", { name: "Кількість для Вода" });
    fireEvent.change(input, { target: { value: "0" } });

    expect(input).toBeInvalid();
    expect(input).toHaveAccessibleDescription("Кількість має відповідати кроку 1 і не перевищувати запас 10.");
    expect(screen.getByRole("button", { name: "Додати у кошик “Сільпо”" })).toBeDisabled();
  });

  it("T15-02 disables confirmation for Infinity-like text input", () => {
    renderEditor(draft());
    const input = screen.getByRole("spinbutton", { name: "Кількість для Вода" });
    fireEvent.change(input, { target: { value: "Infinity" } });

    expect(input).toBeInvalid();
    expect(input).toHaveAccessibleDescription("Кількість має відповідати кроку 1 і не перевищувати запас 10.");
    expect(screen.getByRole("button", { name: "Додати у кошик “Сільпо”" })).toBeDisabled();
  });

  it("T15-02 disables confirmation for over-stock input", () => {
    renderEditor(draft());
    const input = screen.getByRole("spinbutton", { name: "Кількість для Вода" });
    fireEvent.change(input, { target: { value: "15" } });

    expect(input).toBeInvalid();
    expect(input).toHaveAccessibleDescription("Кількість має відповідати кроку 1 і не перевищувати запас 10.");
    expect(screen.getByRole("button", { name: "Додати у кошик “Сільпо”" })).toBeDisabled();
  });

  it("T15-02 retains raw input string for display and submits parsed valid number", async () => {
    const approveDraft = vi.fn(async () => ({ idempotencyKey: APPROVAL_KEY }));
    renderEditor(draft(), { approveDraft });
    const input = screen.getByRole("spinbutton", { name: "Кількість для Вода" });

    fireEvent.change(input, { target: { value: "1.25" } });
    expect(input).toHaveValue(1.25);
    expect(screen.getByRole("button", { name: "Додати у кошик “Сільпо”" })).toBeDisabled();

    fireEvent.change(input, { target: { value: "3" } });
    expect(input).toHaveValue(3);
    const confirm = screen.getByRole("button", { name: "Додати у кошик “Сільпо”" });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(approveDraft).toHaveBeenCalledOnce());
    expect(approveDraft).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001", {
      draftVersion: 1,
      items: [{
        sourceProductId: "water-1",
        itemVersion: 1,
        selectedProductId: "water-1",
        quantity: 3,
      }],
    });
  });

  it("T15-03 removes from count and total, then restores the edited row", () => {
    renderEditor(draft());
    const quantity = screen.getByRole("spinbutton", { name: "Кількість для Вода" });
    fireEvent.change(quantity, { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Прибрати Вода" }));

    expect(screen.getByText("Товар прибрано з чернетки")).toBeVisible();
    expect(screen.getByText("Немає що додавати")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Додати у кошик “Сільпо”" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Повернути Вода" }));
    expect(screen.getByRole("spinbutton", { name: "Кількість для Вода" })).toHaveValue(3);
    expect(screen.getByText("Разом 60,00 ₴")).toBeVisible();
  });

  it("T15-04 disables confirm while replacement is unresolved and updates snapshot total", () => {
    renderEditor(draft({ items: [item({ alternatives: [alternative()] })] }));
    fireEvent.click(screen.getByRole("button", { name: "Замінити Вода" }));

    expect(screen.getByRole("button", { name: "Додати у кошик “Сільпо”" })).toBeDisabled();
    expect(screen.getByText("Спочатку виберіть заміну або скасуйте вибір.")).toBeVisible();
    const picker = screen.getByRole("group", { name: "Виберіть заміну для Вода" });
    expect(within(picker).getByText("Фасування: ×0,9")).toBeVisible();
    expect(within(picker).getByText("В наявності: 3")).toBeVisible();
    expect(within(picker).getByText("Акція: 15,00 ₴")).toBeVisible();
    fireEvent.click(screen.getByRole("radio", { name: /Вода 2 л/ }));

    expect(screen.getByRole("heading", { level: 3, name: "Вода 2 л" })).toBeVisible();
    expect(screen.getByText("Фасування: ×0,9")).toBeVisible();
    expect(screen.getByText("В наявності: 3")).toBeVisible();
    expect(screen.getByText("Акція: 15,00 ₴")).toBeVisible();
    expect(screen.getByText("Разом 30,00 ₴")).toBeVisible();
    expect(screen.getByRole("button", { name: "Додати у кошик “Сільпо”" })).toBeEnabled();
    expect(screen.queryByText(/калор|білк|жир|вуглев/i)).toBeNull();
  });

  it("T15-04 cancel picker preserves pre-picker product and quantity", () => {
    renderEditor(draft({ items: [item({ alternatives: [alternative()] })] }));
    const input = screen.getByRole("spinbutton", { name: "Кількість для Вода" });
    fireEvent.change(input, { target: { value: "3" } });

    fireEvent.click(screen.getByRole("button", { name: "Замінити Вода" }));
    expect(screen.getByRole("group", { name: "Виберіть заміну для Вода" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Скасувати заміну" }));
    expect(screen.queryByRole("group", { name: "Виберіть заміну для Вода" })).toBeNull();
    expect(screen.getByRole("heading", { level: 3, name: "Вода" })).toBeVisible();
    expect(screen.getByRole("spinbutton", { name: "Кількість для Вода" })).toHaveValue(3);
    expect(screen.getByText("Разом 60,00 ₴")).toBeVisible();
    expect(screen.getByRole("button", { name: "Додати у кошик “Сільпо”" })).toBeEnabled();
  });

  it("T15-04 allows a selected replacement to be changed back to the original item", () => {
    renderEditor(draft({ items: [item({ alternatives: [alternative()] })] }));

    fireEvent.click(screen.getByRole("button", { name: "Замінити Вода" }));
    fireEvent.click(screen.getByRole("radio", { name: /Вода 2 л/ }));
    expect(screen.getByRole("heading", { level: 3, name: "Вода 2 л" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Замінити Вода 2 л" }));
    fireEvent.click(screen.getByRole("radio", { name: /Вода — 20,00 ₴/ }));

    expect(screen.getByRole("heading", { level: 3, name: "Вода" })).toBeVisible();
    expect(screen.getByText("Разом 40,00 ₴")).toBeVisible();
  });

  it("T15-04 replacement with lower stock does not silently cap quantity and disables confirm until adjusted", () => {
    renderEditor(draft({
      items: [item({
        quantity: 5,
        stock: 10,
        alternatives: [alternative({ stock: 3 })],
      })],
    }));

    fireEvent.click(screen.getByRole("button", { name: "Замінити Вода" }));
    fireEvent.click(screen.getByRole("radio", { name: /Вода 2 л/ }));

    expect(screen.getByRole("heading", { level: 3, name: "Вода 2 л" })).toBeVisible();
    const input = screen.getByRole("spinbutton", { name: "Кількість для Вода 2 л" });
    expect(input).toHaveValue(5);
    expect(input).toBeInvalid();
    expect(input).toHaveAccessibleDescription("Кількість має відповідати кроку 1 і не перевищувати запас 3.");
    expect(screen.getByRole("button", { name: "Додати у кошик “Сільпо”" })).toBeDisabled();

    fireEvent.change(input, { target: { value: "3" } });
    expect(input).toBeValid();
    expect(screen.getByRole("button", { name: "Додати у кошик “Сільпо”" })).toBeEnabled();
  });

  it("T15-04 filters out unavailable, zero-stock, and stock < step alternatives", () => {
    renderEditor(draft({
      items: [item({
        alternatives: [
          alternative({ productId: "alt-unavailable", name: "Недоступна вода", available: false, stock: 5, step: 1 }),
          alternative({ productId: "alt-zero-stock", name: "Вода з нульовим запасом", available: true, stock: 0, step: 1 }),
          alternative({ productId: "alt-low-stock", name: "Вода з недостатнім запасом", available: true, stock: 0.5, step: 1 }),
          alternative({ productId: "alt-valid", name: "Доступна вода", available: true, stock: 5, step: 1 }),
        ],
      })],
    }));

    fireEvent.click(screen.getByRole("button", { name: "Замінити Вода" }));
    const picker = screen.getByRole("group", { name: "Виберіть заміну для Вода" });

    expect(within(picker).getByRole("radio", { name: /Доступна вода/ })).toBeVisible();
    expect(within(picker).queryByRole("radio", { name: /Недоступна вода/ })).toBeNull();
    expect(within(picker).queryByRole("radio", { name: /Вода з нульовим запасом/ })).toBeNull();
    expect(within(picker).queryByRole("radio", { name: /Вода з недостатнім запасом/ })).toBeNull();
  });

  it("T15-05 never invents a nutrition comparison without facts on both sides", () => {
    renderEditor(draft({ items: [item({ alternatives: [alternative()] })] }));
    fireEvent.click(screen.getByRole("button", { name: "Замінити Вода" }));

    expect(screen.getByText("Даних про склад недостатньо")).toBeVisible();
    expect(screen.queryByText(/калор|білк|жир|вуглев|здоровіш/i)).toBeNull();
  });

  it("T15-06 sends only IDs, versions, and quantity intent", async () => {
    const approveDraft = vi.fn(async () => ({ idempotencyKey: APPROVAL_KEY }));
    renderEditor(draft(), { approveDraft });
    fireEvent.click(screen.getByRole("button", { name: "Додати у кошик “Сільпо”" }));

    await waitFor(() => expect(approveDraft).toHaveBeenCalledOnce());
    expect(approveDraft).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001", {
      draftVersion: 1,
      items: [{
        sourceProductId: "water-1",
        itemVersion: 1,
        selectedProductId: "water-1",
        quantity: 2,
      }],
    });
    expect(JSON.stringify(approveDraft.mock.calls[0])).not.toMatch(/price|stock|total|reason|confidence|mode/);
  });

  it("T15-07 exposes no confirmation action when every row is removed", () => {
    renderEditor(draft());
    fireEvent.click(screen.getByRole("button", { name: "Прибрати Вода" }));

    expect(screen.getByText("Немає що додавати")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Додати у кошик “Сільпо”" })).toBeNull();
    expect(screen.getByRole("button", { name: "Повернути Вода" })).toBeEnabled();
  });

  it("T15-08 locks synchronously and sends one request for rapid clicks", async () => {
    let resolve!: (value: DraftApprovalResponse) => void;
    const approveDraft = vi.fn(() => new Promise<DraftApprovalResponse>((done) => { resolve = done; }));
    const { onApproved } = renderEditor(draft(), { approveDraft });
    const confirm = screen.getByRole("button", { name: "Додати у кошик “Сільпо”" });

    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(approveDraft).toHaveBeenCalledOnce();
    expect(confirm).toBeDisabled();
    expect(screen.getByRole("spinbutton")).toBeDisabled();

    resolve({ idempotencyKey: APPROVAL_KEY });
    await waitFor(() => expect(onApproved).toHaveBeenCalledOnce());
  });

  it("displays 401 error message, sets role='alert', unlocks controls, and avoids demo fallback", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );

    renderEditor(draft());
    const confirm = screen.getByRole("button", { name: "Додати у кошик “Сільпо”" });
    fireEvent.click(confirm);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Не вдалося підтвердити вхід. Увійдіть у «Сільпо» ще раз.");
    expect(confirm).toBeEnabled();
    expect(screen.getByRole("spinbutton")).toBeEnabled();
    expect(screen.queryByText("Демонстраційні дані")).toBeNull();
  });

  it("displays 404 error message and unlocks controls", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    );

    renderEditor(draft());
    const confirm = screen.getByRole("button", { name: "Додати у кошик “Сільпо”" });
    fireEvent.click(confirm);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Чернетку не знайдено. Створіть нову.");
    expect(confirm).toBeEnabled();
  });

  it("displays 409 error message and unlocks controls", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "conflict" }), { status: 409 }),
    );

    renderEditor(draft());
    const confirm = screen.getByRole("button", { name: "Додати у кошик “Сільпо”" });
    fireEvent.click(confirm);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Чернетка змінилася. Оновіть сторінку й перевірте вибір ще раз.");
    expect(confirm).toBeEnabled();
  });

  it("displays 422 error message and unlocks controls", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "unprocessable" }), { status: 422 }),
    );

    renderEditor(draft());
    const confirm = screen.getByRole("button", { name: "Додати у кошик “Сільпо”" });
    fireEvent.click(confirm);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Перевірте кількість або вибрану заміну.");
    expect(confirm).toBeEnabled();
  });

  it("displays fallback error message on malformed JSON response and unlocks controls", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ unexpected: "payload" }), { status: 200 }),
    );

    renderEditor(draft());
    const confirm = screen.getByRole("button", { name: "Додати у кошик “Сільпо”" });
    fireEvent.click(confirm);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Не вдалося підтвердити чернетку. Спробуйте ще раз.");
    expect(confirm).toBeEnabled();
  });

  it("displays fallback error message on network failure and unlocks controls", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("Failed to fetch"));

    renderEditor(draft());
    const confirm = screen.getByRole("button", { name: "Додати у кошик “Сільпо”" });
    fireEvent.click(confirm);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Не вдалося підтвердити чернетку. Спробуйте ще раз.");
    expect(confirm).toBeEnabled();
  });

  describe("T15-16 Structural & Accessibility Invariants", () => {
    it("ensures every editor button and input has an explicit accessible role and name across states", () => {
      renderEditor(draft({ items: [item({ alternatives: [alternative()] })] }));

      // Ready state controls
      expect(screen.getByRole("button", { name: "Зменшити кількість Вода" })).toBeVisible();
      expect(screen.getByRole("spinbutton", { name: "Кількість для Вода" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Збільшити кількість Вода" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Прибрати Вода" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Замінити Вода" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Додати у кошик “Сільпо”" })).toBeVisible();

      // Open alternative picker
      fireEvent.click(screen.getByRole("button", { name: "Замінити Вода" }));
      expect(screen.getByRole("group", { name: "Виберіть заміну для Вода" })).toBeVisible();
      expect(screen.getByRole("radio", { name: /Вода 2 л/ })).toBeVisible();
      expect(screen.getByRole("button", { name: "Скасувати заміну" })).toBeVisible();

      // Cancel picker, then remove product
      fireEvent.click(screen.getByRole("button", { name: "Скасувати заміну" }));
      fireEvent.click(screen.getByRole("button", { name: "Прибрати Вода" }));
      expect(screen.getByRole("button", { name: "Повернути Вода" })).toBeVisible();
    });

    it("associates invalid quantity input with aria-describedby pointing to error element and clears when valid", () => {
      renderEditor(draft());
      const input = screen.getByRole("spinbutton", { name: "Кількість для Вода" });

      // Initially valid
      expect(input).not.toHaveAttribute("aria-describedby");
      expect(input).toBeValid();

      // Type invalid value
      fireEvent.change(input, { target: { value: "1.25" } });
      expect(input).toBeInvalid();
      const describedById = input.getAttribute("aria-describedby");
      expect(describedById).toBeTruthy();
      const errorEl = document.getElementById(describedById!);
      expect(errorEl).not.toBeNull();
      expect(errorEl).toHaveTextContent("Кількість має відповідати кроку 1 і не перевищувати запас 10.");
      expect(errorEl).toHaveClass("autopilot-quantity-error");

      // Restore to valid
      fireEvent.change(input, { target: { value: "3" } });
      expect(input).toBeValid();
      expect(input).not.toHaveAttribute("aria-describedby");
      expect(document.getElementById(describedById!)).toBeNull();
    });

    it("displays submit failure with role='alert'", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "conflict" }), { status: 409 }),
      );

      renderEditor(draft());
      const confirm = screen.getByRole("button", { name: "Додати у кошик “Сільпо”" });
      fireEvent.click(confirm);

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Чернетка змінилася. Оновіть сторінку й перевірте вибір ще раз.");
      expect(alert).toHaveClass("autopilot-submit-error");
    });

    it("exposes status text during pending confirmation and announces in-flight state", async () => {
      let resolvePromise!: (value: DraftApprovalResponse) => void;
      const approveDraft = vi.fn(() => new Promise<DraftApprovalResponse>((resolve) => {
        resolvePromise = resolve;
      }));
      renderEditor(draft(), { approveDraft });

      const confirm = screen.getByRole("button", { name: "Додати у кошик “Сільпо”" });
      fireEvent.click(confirm);

      expect(screen.getByRole("button", { name: "Підтверджуємо…" })).toBeVisible();
      expect(screen.getByText("Підтверджуємо…")).toBeVisible();
      expect(confirm).toBeDisabled();
      expect(confirm).toHaveAccessibleDescription("Зачекайте, чернетка підтверджується.");

      resolvePromise({ idempotencyKey: APPROVAL_KEY });
      await waitFor(() => expect(approveDraft).toHaveBeenCalledOnce());
    });

    it("conveys removed, unresolved, and pending states via textual labels independent of CSS", async () => {
      let resolvePromise!: (value: DraftApprovalResponse) => void;
      const approveDraft = vi.fn(() => new Promise<DraftApprovalResponse>((resolve) => {
        resolvePromise = resolve;
      }));

      renderEditor(draft({
        items: [
          item({ productId: "water-1", name: "Вода", alternatives: [alternative()] }),
          item({ productId: "bread-1", name: "Хліб" }),
        ],
      }), { approveDraft });

      // 1. Unresolved replacement state contains descriptive text labels
      fireEvent.click(screen.getByRole("button", { name: "Замінити Вода" }));
      expect(screen.getByText("Спочатку виберіть заміну або скасуйте вибір.")).toBeVisible();
      expect(screen.getByText("Виберіть заміну для Вода")).toBeVisible();
      expect(screen.getByRole("button", { name: "Скасувати заміну" })).toBeVisible();

      // Cancel picker
      fireEvent.click(screen.getByRole("button", { name: "Скасувати заміну" }));

      // 2. Removed state contains explicit textual labels
      fireEvent.click(screen.getByRole("button", { name: "Прибрати Вода" }));
      expect(screen.getByText("Товар прибрано з чернетки")).toBeVisible();
      expect(screen.getByRole("button", { name: "Повернути Вода" })).toBeVisible();

      // When all items removed
      fireEvent.click(screen.getByRole("button", { name: "Прибрати Хліб" }));
      expect(screen.getByText("Немає що додавати")).toBeVisible();
      expect(screen.getByRole("button", { name: "Повернути Хліб" })).toBeVisible();

      // Restore both
      fireEvent.click(screen.getByRole("button", { name: "Повернути Вода" }));
      fireEvent.click(screen.getByRole("button", { name: "Повернути Хліб" }));

      // 3. Pending state exposes textual status label
      const confirm = screen.getByRole("button", { name: "Додати у кошик “Сільпо”" });
      fireEvent.click(confirm);
      expect(screen.getByRole("button", { name: "Підтверджуємо…" })).toBeVisible();
      expect(screen.getByText("Підтверджуємо…")).toBeVisible();

      resolvePromise({ idempotencyKey: APPROVAL_KEY });
      await waitFor(() => expect(approveDraft).toHaveBeenCalledOnce());
    });
  });
});
