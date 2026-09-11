import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  afterEach, beforeEach, describe, expect, it, vi,
} from "vitest";
import {
  CartContextSchema, DraftSchema, effectiveUnitPrice, ProductCandidateSchema, VerifiedCartSchema,
  type CartContext, type Draft, type DraftItem, type ProductCandidate, type VerifiedCart,
} from "@/features/shared/contracts";
import {
  DraftDashboard, type ActionableDraft, type DraftDashboardProps,
} from "./draft-dashboard";

const APPROVAL_KEY = "00000000-0000-4000-8000-0000000000aa";

const item = (overrides: Partial<DraftItem> = {}): DraftItem => ({
  productId: "water-1",
  externalProductId: 101,
  name: "Вода негазована 1,5 л",
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

// Every fixture is parsed by the contract that governs it in production, so a
// test can never assert behaviour for a state the schema forbids. Building an
// out-of-stock item here throws instead of silently exercising dead code.
const draft = (overrides: Partial<Draft> = {}): ActionableDraft => {
  const items = overrides.items ?? [item()];
  const parsed = DraftSchema.parse({
    id: "draft-1",
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

  if (parsed.status === "syncing" || parsed.status === "generating") {
    throw new Error("a draft fixture must carry an actionable status");
  }
  return parsed as ActionableDraft;
};

const cartContext = (overrides: Partial<CartContext> = {}): CartContext => CartContextSchema.parse({
  cartId: "cart-1",
  deliveryType: "delivery",
  city: "Київ",
  branchId: "branch-1",
  slot: {
    id: "slot-1",
    startsAt: "2026-09-05T09:00:00.000Z",
    endsAt: "2026-09-05T12:00:00.000Z",
    available: true,
  },
  ...overrides,
});

const verifiedCart = (overrides: Partial<VerifiedCart> = {}): VerifiedCart => VerifiedCartSchema.parse({
  cartId: "cart-1",
  status: "verified",
  items: [{ productId: "water-1", quantity: 2, unitPrice: 20, available: true }],
  total: 40,
  validations: [],
  checkoutLinks: { web: "https://silpo.ua/cart", mobile: "https://silpo.ua/app/cart" },
  ...overrides,
});

const alternative = (): ProductCandidate => ProductCandidateSchema.parse({
  productId: "water-2",
  externalProductId: 102,
  slug: "water-2",
  name: "Вода негазована 2 л",
  imageUrl: null,
  price: 25,
  specialPrice: null,
  available: true,
  stock: 8,
  step: 1,
  displayRatio: 1,
  nutritionStatus: "insufficient",
  nutrition: null,
  promotions: [],
});

const renderDashboard = (props: Partial<DraftDashboardProps> = {}) =>
  render(
    <DraftDashboard
      phase={{ kind: "draft", draft: draft() }}
      cartContext={null}
      loyaltyBonusAvailable={null}
      cart={null}
      {...props}
    />,
  );

describe("DraftDashboard", () => {
  it("D14-12 labels demo data once and never in live mode", () => {
    const { unmount } = renderDashboard({ phase: { kind: "draft", draft: draft({ mode: "demo" }) } });
    expect(screen.getAllByText("Демонстраційні дані")).toHaveLength(1);
    unmount();

    renderDashboard();
    expect(screen.queryByText("Демонстраційні дані")).toBeNull();
  });

  it("D14-12 keeps the demo banner in blocked and verified states", () => {
    for (const status of ["blocked", "verified"] as const) {
      const { unmount } = renderDashboard({
        phase: { kind: "draft", draft: draft({ mode: "demo", status }) },
      });
      expect(screen.getByText("Демонстраційні дані")).toBeVisible();
      unmount();
    }
  });

  it("D14-03 renders delivery context, slot, cart, and data source", () => {
    renderDashboard({ cartContext: cartContext(), cart: verifiedCart() });

    const header = screen.getByRole("banner");
    expect(within(header).getByText("Автопілот")).toBeVisible();
    expect(within(header).getByText("працює з кошиком “Сільпо”")).toBeVisible();
    expect(within(header).getByText("Доставка")).toBeVisible();
    expect(within(header).getByText("Київ")).toBeVisible();
    expect(within(header).getByText(/12:00–15:00, 5 вересня/)).toBeVisible();
    expect(within(header).getByText("У кошику 1 позиція")).toBeVisible();
    expect(within(header).getByText("Живі дані “Сільпо”")).toBeVisible();
  });

  it("D14-03 renders pickup, a missing city, and the demo source label", () => {
    renderDashboard({
      phase: { kind: "draft", draft: draft({ mode: "demo" }) },
      cartContext: cartContext({ deliveryType: "pickup", city: null }),
    });

    const header = screen.getByRole("banner");
    expect(within(header).getByText("Самовивіз")).toBeVisible();
    expect(within(header).getByText("Місто не вибрано")).toBeVisible();
    expect(within(header).getByText("Демо-режим")).toBeVisible();
    expect(within(header).getByText("Кошик “Сільпо” ще не змінювався")).toBeVisible();
  });

  it("D14-03 falls back when no cart context exists and never renders an identifier", () => {
    const { container } = renderDashboard();

    const header = screen.getByRole("banner");
    expect(within(header).getByText("Кошик “Сільпо” ще не підключено")).toBeVisible();
    expect(within(header).queryByText("Доставка")).toBeNull();
    expect(container.textContent).not.toContain("branch-1");
    expect(container.textContent).not.toContain("cart-1");
  });

  it("D14-04 agrees the headline with the item count", () => {
    const cases: Array<[number, string]> = [
      [1, "1 товар уже проситься до кошика"],
      [3, "3 товари уже просяться до кошика"],
      [5, "5 товарів уже просяться до кошика"],
    ];

    for (const [count, headline] of cases) {
      const items = Array.from({ length: count }, (_, index) =>
        item({ productId: `product-${index}`, externalProductId: 100 + index }));
      const { unmount } = renderDashboard({ phase: { kind: "draft", draft: draft({ items }) } });
      expect(screen.getByRole("heading", { level: 1, name: headline })).toBeVisible();
      unmount();
    }
  });

  it("D14-04 shows the server total and summary", () => {
    const { container } = renderDashboard();

    const hero = within(container.querySelector(".autopilot-hero") as HTMLElement);
    expect(hero.getByText("Разом 40,00 ₴")).toBeVisible();
    expect(hero.getByText("Схоже, вода скоро закінчиться")).toBeVisible();
  });

  it("D14-04 renders its own headline and no total for an empty draft", () => {
    renderDashboard({ phase: { kind: "draft", draft: draft({ items: [], summary: "" }) } });

    expect(screen.getByRole("heading", { level: 1, name: "Поки що нічого не проситься до кошика" })).toBeVisible();
    expect(screen.queryByText(/^Разом/)).toBeNull();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("D14-05 reports needs, window, confidence split, and cutoff", () => {
    renderDashboard({
      phase: {
        kind: "draft",
        draft: draft({
          items: [
            item(),
            item({ productId: "bread-1", externalProductId: 102, confidence: 0.6, confidenceBand: "medium" }),
          ],
        }),
      },
    });

    const forecast = screen.getByRole("region", { name: "Прогноз" });
    expect(within(forecast).getByText("Регулярних потреб: 2")).toBeVisible();
    expect(within(forecast).getByText("Історія за останні 180 днів")).toBeVisible();
    expect(within(forecast).getByText("Висока впевненість: 1")).toBeVisible();
    expect(within(forecast).getByText("Середня впевненість: 1")).toBeVisible();
    expect(within(forecast).getByText("Дані до 2 вересня")).toBeVisible();
  });

  it("D14-06 sums draft discounts without calling them savings", () => {
    renderDashboard({
      phase: {
        kind: "draft",
        draft: draft({
          items: [
            item({ specialPrice: 15 }),
            item({ productId: "bread-1", externalProductId: 102, quantity: 1, price: 30, specialPrice: 24 }),
          ],
        }),
      },
    });

    const value = screen.getByRole("region", { name: "Вигода" });
    expect(within(value).getByText("Знижки в чернетці: 16,00 ₴")).toBeVisible();
    expect(within(value).getByText("Ціни перевіримо ще раз перед додаванням у кошик")).toBeVisible();
    expect(screen.queryByText(/економі/i)).toBeNull();
  });

  it("D14-06 states when the draft has no discounts", () => {
    renderDashboard();

    expect(within(screen.getByRole("region", { name: "Вигода" })).getByText("Знижок у чернетці немає")).toBeVisible();
  });

  it("D14-06 shows the loyalty bonus as available and changes no total", () => {
    renderDashboard({ loyaltyBonusAvailable: 5 });

    const value = screen.getByRole("region", { name: "Вигода" });
    expect(within(value).getByText("Доступно 5 бонусів")).toBeVisible();
    expect(within(value).getByText("Бонуси не застосовуються автоматично")).toBeVisible();
    expect(within(screen.getByRole("region", { name: "Підсумок чернетки" }))
      .getByText("Разом 40,00 ₴")).toBeVisible();
  });

  it("D14-06 renders no bonus row when none is available", () => {
    renderDashboard();

    expect(screen.queryByText(/Доступно/)).toBeNull();
  });

  it("D14-07 renders every required product fact", () => {
    renderDashboard({
      phase: {
        kind: "draft",
        draft: draft({
          status: "confirming",
          items: [item({
            imageUrl: "https://example.test/water.png",
            specialPrice: 15,
            promotions: [{ id: "promo-1", label: "Акція тижня", price: 15 }],
            alternatives: [],
          })],
        }),
      },
    });

    const card = screen.getByRole("heading", { level: 3, name: "Вода негазована 1,5 л" }).closest("li");
    expect(card).not.toBeNull();
    const product = within(card as HTMLElement);
    expect(product.getByAltText("Вода негазована 1,5 л")).toBeVisible();
    expect(product.getByText("Кількість: 2")).toBeVisible();
    expect(product.getByText("Фасування: ×1")).toBeVisible();
    expect(product.getByText("15,00 ₴")).toBeVisible();
    expect(product.getByText("Було 20,00 ₴")).toBeVisible();
    expect(product.getByText("Акція тижня: 15,00 ₴")).toBeVisible();
    expect(product.getByText("В наявності: 10")).toBeVisible();
    expect(product.getByText("Висока впевненість")).toBeVisible();
    expect(product.getByText("Купуєте приблизно раз на 7 днів")).toBeVisible();
    expect(product.getByText("Даних про склад недостатньо")).toBeVisible();
  });

  it("D14-07 reports the stock snapshot and quantity in Ukrainian number format", () => {
    renderDashboard({
      phase: {
        kind: "draft",
        draft: draft({
          status: "confirming",
          items: [item({
            stock: 7.5, quantity: 0.5, step: 0.5, confidence: 0.6, confidenceBand: "medium",
          })],
        }),
      },
    });

    expect(screen.getByText("В наявності: 7,5")).toBeVisible();
    expect(screen.getByText("Кількість: 0,5")).toBeVisible();
    expect(screen.getByText("Середня впевненість")).toBeVisible();
  });

  it("D14-07 cannot build a draft item that is out of stock", () => {
    // DraftItemSchema requires 0 < quantity <= stock, so an unavailable item is
    // unrepresentable. The card therefore never renders an out-of-stock label and
    // the summary never disables its CTA; cart verification surfaces reduced
    // stock as a per-item validation instead. Spec §9 tracks this for Task 16.
    expect(() => draft({ items: [item({ stock: 0 })] })).toThrow();
    expect(() => draft({ items: [item({ stock: 1, quantity: 2 })] })).toThrow();
  });

  it("D14-07 counts alternatives and hides the image when none is supplied", () => {
    renderDashboard({
      phase: { kind: "draft", draft: draft({ items: [item({ alternatives: [alternative()] })] }) },
    });

    expect(screen.getByText("Доступні заміни: 1")).toBeVisible();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("D14-07 offers no stepper, remove, or replace control", () => {
    renderDashboard({ phase: { kind: "draft", draft: draft({ status: "confirming" }) } });

    expect(screen.queryByRole("button", { name: /Прибрати|Замінити|Більше|Менше/ })).toBeNull();
  });

  it("D14-08 renders sections in the order the design system fixes", () => {
    const { container } = renderDashboard({ cartContext: cartContext() });

    const landmarks = Array.from(container.querySelectorAll("header, .autopilot-hero, .autopilot-card, .autopilot-products, .autopilot-summary"))
      .map((element) => element.className.split(" ")[0]);

    expect(landmarks).toEqual([
      "autopilot-header",
      "autopilot-hero",
      "autopilot-card",
      "autopilot-card",
      "autopilot-products",
      "autopilot-summary",
    ]);
  });

  it("D14-08 renders one card per draft item in draft order", () => {
    renderDashboard({
      phase: {
        kind: "draft",
        draft: draft({
          items: [
            item({ productId: "water-1", name: "Вода" }),
            item({ productId: "bread-1", externalProductId: 102, name: "Хліб" }),
          ],
        }),
      },
    });

    const section = screen.getByRole("region", { name: "Ймовірно закінчується" });
    const names = within(section).getAllByRole("heading", { level: 3 }).map((node) => node.textContent);
    expect(names).toEqual(["Вода", "Хліб"]);
  });

  it("D14-08 renders no draft content while pending", () => {
    renderDashboard({ phase: { kind: "pending", status: "syncing", mode: "live" } });

    expect(screen.queryByRole("region", { name: "Ймовірно закінчується" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Прогноз" })).toBeNull();
    expect(screen.queryByText(/^Разом/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("D14-09 shows the count and the server total", () => {
    renderDashboard();

    const summary = screen.getByRole("region", { name: "Підсумок чернетки" });
    expect(within(summary).getByText("1 позиція")).toBeVisible();
    expect(within(summary).getByText("Разом 40,00 ₴")).toBeVisible();
  });

  it("D14-09 enables the CTA only for a ready draft with confirmable items", () => {
    renderDashboard();

    const cta = screen.getByRole("button", { name: "Додати у кошик “Сільпо”" });
    expect(cta).toBeEnabled();
  });

  it("D14-09 leaves the CTA enabled because every draft item is confirmable", () => {
    renderDashboard({
      phase: { kind: "draft", draft: draft({ items: [item({ quantity: 10, stock: 10 })] }) },
    });

    const cta = screen.getByRole("button", { name: "Додати у кошик “Сільпо”" });
    expect(cta).toBeEnabled();
    expect(cta).not.toHaveAccessibleDescription();
  });

  it("D14-09 renders no CTA for an empty draft", () => {
    renderDashboard({ phase: { kind: "draft", draft: draft({ items: [], summary: "" }) } });

    expect(screen.queryByRole("button", { name: "Додати у кошик “Сільпо”" })).toBeNull();
    expect(screen.getByText("Немає що додавати")).toBeVisible();
  });

  it("D14-09 renders no CTA for any status other than ready", () => {
    for (const status of ["confirming", "partially_committed", "verified", "blocked"] as const) {
      const { unmount } = renderDashboard({ phase: { kind: "draft", draft: draft({ status }) } });
      expect(screen.queryByRole("button", { name: "Додати у кошик “Сільпо”" })).toBeNull();
      unmount();
    }
  });

  it("D14-10 shows both checkout links for a verified cart without errors", () => {
    renderDashboard({
      phase: { kind: "draft", draft: draft({ status: "verified" }) },
      cart: verifiedCart(),
    });

    expect(screen.getByRole("link", { name: "Оформити на сайті" })).toHaveAttribute("href", "https://silpo.ua/cart");
    expect(screen.getByRole("link", { name: "Оформити в застосунку" })).toHaveAttribute("href", "https://silpo.ua/app/cart");
  });

  it("D14-10 hides checkout for every status other than verified", () => {
    for (const status of ["syncing", "generating", "ready", "confirming", "partially_committed", "blocked"] as const) {
      const phase: DraftDashboardProps["phase"] = status === "syncing" || status === "generating"
        ? { kind: "pending", status, mode: "live" }
        : { kind: "draft", draft: draft({ status }) };

      const { unmount } = renderDashboard({ phase, cart: verifiedCart() });
      expect(screen.queryByRole("link", { name: /Оформити/ })).toBeNull();
      unmount();
    }
  });

  it("D14-10 hides checkout when a verified cart carries no links", () => {
    renderDashboard({
      phase: { kind: "draft", draft: draft({ status: "verified" }) },
      cart: verifiedCart({ checkoutLinks: null }),
    });

    expect(screen.queryByRole("link", { name: /Оформити/ })).toBeNull();
  });

  it("D14-10 hides checkout when the cart carries an error validation", () => {
    // VerifiedCartSchema already forbids links alongside an error, so a cart
    // that has both is unrepresentable and the component's own error gate is
    // defence in depth rather than the only guard.
    expect(() => verifiedCart({
      validations: [{ severity: "error", code: "out_of_stock", message: "Товару немає", productId: null }],
    })).toThrow();

    renderDashboard({
      phase: { kind: "draft", draft: draft({ status: "verified" }) },
      cart: verifiedCart({
        checkoutLinks: null,
        validations: [{ severity: "error", code: "out_of_stock", message: "Товару немає", productId: null }],
      }),
    });

    expect(screen.queryByRole("link", { name: /Оформити/ })).toBeNull();
    expect(screen.getByRole("list", { name: "Помилки кошика" })).toBeVisible();
  });

  it("D14-11 renders each pending state as the page heading with a polite live region", () => {
    const cases: Array<["syncing" | "generating", string]> = [
      ["syncing", "Синхронізуємо історію покупок"],
      ["generating", "Готуємо чернетку"],
    ];

    for (const [status, title] of cases) {
      const { unmount } = renderDashboard({ phase: { kind: "pending", status, mode: "live" } });
      const panel = screen.getByRole("status");
      expect(within(panel).getByRole("heading", { level: 1, name: title })).toBeVisible();
      expect(panel).toHaveAttribute("aria-live", "polite");
      unmount();
    }
  });

  it("D14-11 renders draft states below the hero heading", () => {
    const cases: Array<[Draft["status"], string, string]> = [
      ["confirming", "Перевіряємо ціну та наявність", "status"],
      ["partially_committed", "Частину товарів потрібно перевірити", "alert"],
      ["verified", "Кошик оновлено", "status"],
      ["blocked", "Кошик потребує уваги", "alert"],
    ];

    for (const [status, title, role] of cases) {
      const { unmount } = renderDashboard({ phase: { kind: "draft", draft: draft({ status }) } });
      const panel = screen.getByRole(role as "status" | "alert");
      expect(within(panel).getByRole("heading", { level: 2, name: title })).toBeVisible();
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      unmount();
    }
  });

  it("D14-11 renders no panel for a ready draft", () => {
    renderDashboard();

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("D14-11 splits cart-level and product-level validations without repeating either", () => {
    renderDashboard({
      phase: { kind: "draft", draft: draft({ status: "blocked" }) },
      cart: verifiedCart({
        status: "blocked",
        checkoutLinks: null,
        validations: [
          { severity: "error", code: "slot_expired", message: "Слот доставки минув", productId: null },
          { severity: "warning", code: "price_changed", message: "Ціна змінилася", productId: "water-1" },
        ],
      }),
    });

    const list = screen.getByRole("list", { name: "Помилки кошика" });
    expect(within(list).getByText("Слот доставки минув")).toBeVisible();
    expect(within(list).queryByText("Ціна змінилася")).toBeNull();
    expect(screen.getAllByText("Слот доставки минув")).toHaveLength(1);

    const card = screen.getByRole("heading", { level: 3, name: "Вода негазована 1,5 л" }).closest("li");
    expect(within(card as HTMLElement).getByText("Ціна змінилася")).toBeVisible();
    expect(within(card as HTMLElement).getByText("Увага")).toBeVisible();
  });

  it("D14-11 labels a warning-only cart list as warnings, not errors", () => {
    renderDashboard({
      phase: { kind: "draft", draft: draft({ status: "partially_committed" }) },
      cart: verifiedCart({
        status: "partially_committed",
        checkoutLinks: null,
        validations: [
          { severity: "warning", code: "slot_soon", message: "Слот скоро завершиться", productId: null },
        ],
      }),
    });

    expect(screen.getByRole("list", { name: "Попередження кошика" })).toBeVisible();
    expect(screen.queryByRole("list", { name: "Помилки кошика" })).toBeNull();
  });

  it("D14-01S keeps brand colour out of components", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const { URL: NodeURL } = await import("node:url");
    const directory = new NodeURL(".", import.meta.url);
    const files = (await readdir(directory)).filter((name) => name.endsWith(".tsx") || name.endsWith(".ts"));

    for (const name of files.filter((file) => !file.endsWith(".test.tsx"))) {
      const source = await readFile(new NodeURL(name, directory), "utf8");
      expect(source, `${name} must not hard-code colour`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
      expect(source, `${name} must not use inline styles`).not.toContain("style={{");
      if (
        name !== "draft-dashboard.tsx" &&
        name !== "draft-editor.tsx" &&
        name !== "demo-diagnostics.tsx"
      ) {
        expect(source, `${name} must stay a Server Component`).not.toContain("use client");
      }
    }
  });

  it("D14-13 keeps one h1, ordered headings, and labelled landmarks", () => {
    renderDashboard({ cartContext: cartContext() });

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("banner")).toBeVisible();
    expect(screen.getByRole("main")).toBeVisible();
    expect(screen.getByRole("region", { name: "Підсумок чернетки" })).toBeVisible();
    expect(screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent))
      .toEqual(["Прогноз", "Вигода", "Ймовірно закінчується"]);
  });

  it("D14-13 hides the placeholder from assistive technology and names real images", () => {
    const { container } = renderDashboard({
      phase: { kind: "draft", draft: draft({ items: [item({ imageUrl: "https://example.test/water.png" })] }) },
    });

    expect(screen.getByRole("img", { name: "Вода негазована 1,5 л" })).toBeVisible();
    expect(container.querySelector(".autopilot-product-placeholder")).toBeNull();
  });

  it("D14-13 marks the wordmark as text rather than a heading", () => {
    renderDashboard();

    expect(screen.queryByRole("heading", { name: "Автопілот" })).toBeNull();
  });

  it("T15-09 replaces the editor with confirming state after approval", async () => {
    const approveDraft = vi.fn(async () => ({ idempotencyKey: APPROVAL_KEY }));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderDashboard({ approveDraft });

    fireEvent.click(screen.getByRole("button", { name: "Додати у кошик “Сільпо”" }));

    expect(await screen.findByRole("heading", {
      level: 2,
      name: "Перевіряємо ціну та наявність",
    })).toBeVisible();
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.queryByRole("link", { name: /Оформити/ })).toBeNull();
    expect(approveDraft).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("DraftDashboard diagnostics placement", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("A17-58 shows the diagnostics panel last in demo mode", () => {
    renderDashboard({ phase: { kind: "pending", status: "syncing", mode: "demo" } });

    const panel = screen.getByText("Як працює прогноз");
    expect(panel).toBeInTheDocument();

    // Dashboard order is fixed: diagnostics is item 7, after everything else.
    const main = screen.getByRole("main");
    expect(main.lastElementChild).toContainElement(panel);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("A17-59 never shows the diagnostics panel in live mode", () => {
    renderDashboard({ phase: { kind: "pending", status: "syncing", mode: "live" } });

    expect(screen.queryByText("Як працює прогноз")).not.toBeInTheDocument();
  });
});
