# Task 7.1 and Task 14 Dashboard Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline execution, or superpowers:subagent-driven-development when delegated execution is selected. Steps use checkbox (`- [ ]`) syntax for tracking. Task 7.1 and Task 14 are sequential and must not run in parallel in the same checkout.

**Goal:** Render a serialized `Draft` as the action-first «Автопілот запасів» dashboard, after extending the draft item contract with the four presentation fields the design system requires.

**Architecture:** Task 7.1 extends `DraftItemSchema`, the `draft_items` table, migration `0002`, and both repository implementations together, so no intermediate state can fail a round trip. Task 14 adds six presentational Server Components plus a formatting module under `src/components/autopilot/`, and a `/dashboard` route that renders the shell's first frame. Nothing fetches, mutates, or holds state.

**Tech Stack:** Existing pnpm, TypeScript, Zod, Drizzle, Vitest, Testing Library, and the Next.js App Router. No new dependencies.

**Spec:** [Task 14 Dashboard Shell Specification](../specs/2026-09-04-dashboard-shell-design.md).

**Status:** Ready for review; all implementation checkboxes are intentionally unchecked. This plan authorizes no cart write, no live call, and no claim of feature completion.

## Global Constraints

- Use `pnpm` exclusively; add no dependencies or package/lockfile changes.
- The dashboard is presentational: no fetch, no mutation, no navigation side effect, no state.
- Every displayed value comes from a prop. Components compute only counts, sums over supplied snapshots, and formatting.
- No Task 14 element writes to a cart, approves anything, or implies that it has.
- Live mode renders no demo affordance; demo mode always renders its banner.
- Checkout appears only for a `verified` draft whose supplied cart has links and no error-severity validation.
- The loyalty bonus is shown as available and never subtracted from any total.
- Nutrition is either a known state or «Даних про склад недостатньо»; never inferred.
- Colour is never the only signal: every status, severity, confidence, and mode has text.
- Components use `.autopilot-*` classes only. No inline styles, no colour literals, no Tailwind utility classes.
- WCAG 2.2 AA: one `h1`, semantic headings, keyboard operability, visible focus, 44×44 px targets, reduced-motion support.
- Preserve the unrelated `.gitignore` modification in the working tree.
- Follow red-green-refactor and keep one focused commit per task.

## File ownership and interfaces

| Task | File | Responsibility |
|---|---|---|
| 7.1 | Modify `src/features/shared/contracts.ts` | Four `DraftItem` fields, the `specialPrice` refinement, `effectiveUnitPrice`, and the total rule. |
| 7.1 | Modify `src/features/shared/contracts.test.ts` | Contract behaviour for the new fields and the effective-price total. |
| 7.1 | Modify `src/db/schema.ts` | Four `draft_items` columns. |
| 7.1 | Modify `src/db/schema.test.ts` | Column presence and nullability. |
| 7.1 | Create `drizzle/0002_draft_item_presentation.sql` | Column addition and backfill. |
| 7.1 | Modify `src/features/drafts/repository.ts` | Insert and map the four columns. |
| 7.1 | Modify `src/features/drafts/repository.test.ts` | Round-trip evidence for both implementations. |
| 14 | Create `src/components/autopilot/format.ts` | Currency, date, and Ukrainian plural formatting. |
| 14 | Create `src/components/autopilot/app-header.tsx` | Wordmark, delivery context, slot, cart indicator, data source. |
| 14 | Create `src/components/autopilot/status-panel.tsx` | `StatusPanel` and `ValidationList`. |
| 14 | Create `src/components/autopilot/draft-product-card.tsx` | One recommended product, read-only. |
| 14 | Create `src/components/autopilot/draft-overview.tsx` | Hero, forecast card, value card. |
| 14 | Create `src/components/autopilot/draft-summary.tsx` | Sticky count, total, CTA, checkout links. |
| 14 | Create `src/components/autopilot/draft-dashboard.tsx` | Phase types and section composition. |
| 14 | Create `src/components/autopilot/draft-dashboard.test.tsx` | All Task 14 acceptance behaviour. |
| 14 | Create `src/app/dashboard/page.tsx` | Request-time mode and the pending first frame. |
| 14 | Create `src/app/dashboard/page.test.tsx` | Route behaviour: request-time mode, pending frame, no draft affordances. |
| 14 | Modify `src/app/globals.css` | Tokens, component classes, responsive rules. |

`draft-overview.tsx` and `format.ts` refine the backlog's file list for the reasons in spec §6 D14-01. `ValidationList` ships inside `status-panel.tsx` rather than taking its own file. `page.test.tsx` follows the convention Task 1 set with `src/app/page.test.tsx`; spec §6 D14-02 states behaviour that `pnpm build` cannot prove.

Read-only dependencies: `src/features/prediction/features.ts` (for `PREDICTION_CONFIG`), `src/lib/env.ts`, and `src/db/client.ts`. Do not modify them.

Task 14 exports these interfaces, which Task 15 consumes:

```ts
export type DraftPhase =
  | { kind: "pending"; status: Extract<DraftStatus, "syncing" | "generating">; mode: DataMode }
  | { kind: "draft"; draft: Draft };

export interface DraftDashboardProps {
  phase: DraftPhase;
  cartContext: CartContext | null;
  loyaltyBonusAvailable: number | null;
  cart: VerifiedCart | null;
}
```

`format.ts` exports `formatHryvnia(value: number): string`, `pluralizeUk(count: number, forms: [string, string, string]): string`, `formatDay(iso: string): string`, and `formatSlot(startsAt: string, endsAt: string): string`.

## Execution protocol

For every slice: add the named behavioural test, run the focused command and record its expected failure, implement the minimum behaviour, then rerun until green. A missing module is valid red evidence only for the first slice of a task; later failures must name the behaviour under construction. Refactor only while green, never by weakening an assertion. Test titles carry their requirement ID.

Do not commit each slice. Each task ends in exactly one commit, containing its setup, tests, implementation, and any documentation the behaviour changed.

Testing Library's default text normalizer collapses no-break spaces, so currency assertions compare plain strings such as `"Разом 40,00 ₴"` with no normalization helper.

---

## Task 7.1 — Draft item presentation fields

**Prerequisites:** Tasks 1–7 integrated at `b1a22e6` or later. Task 8 touches none of these files and may proceed in parallel in its own worktree.

**Behavior to prove:** A draft item carries its image, package ratio, discounted price, and promotions through the contract, the table, and both repositories, and a discounted draft's total is computed on the price the user actually pays.

**Focused command:** `pnpm vitest run src/features/shared/contracts.test.ts src/db/schema.test.ts src/features/drafts/repository.test.ts`

### 7.1.1 — Confirm dependencies

- [ ] Run `git status --short` and `git log -5 --oneline`. Preserve the `.gitignore` modification; it is the user's.
- [ ] Run the prerequisite gate and record the output:

```bash
pnpm vitest run src/features/shared/contracts.test.ts src/db/schema.test.ts src/features/drafts/repository.test.ts
```

Expected: PASS. This is prerequisite evidence, not progress.

### 7.1.2 — Write the failing contract tests

- [ ] Add these tests to `src/features/shared/contracts.test.ts`, and extend the existing `draft` fixture's single item with `imageUrl: null`, `displayRatio: 1`, `specialPrice: null`, and `promotions: []`.

```ts
it("A7-01 carries presentation fields and prices the total on the effective unit price", () => {
  const discounted = {
    ...draft,
    items: [{ ...draft.items[0], specialPrice: 15, promotions: [{ id: "promo-1", label: "Акція тижня", price: 15 }] }],
    total: 30,
  };

  const parsed = DraftSchema.parse(discounted);
  expect(parsed.items[0].specialPrice).toBe(15);
  expect(parsed.items[0].promotions).toHaveLength(1);
  expect(effectiveUnitPrice(parsed.items[0])).toBe(15);
  expect(effectiveUnitPrice(DraftSchema.parse(draft).items[0])).toBe(20);
});

it("A7-01 rejects a special price above the regular price", () => {
  expect(() => DraftSchema.parse({
    ...draft,
    items: [{ ...draft.items[0], specialPrice: 25 }],
    total: 50,
  })).toThrow();
});

it("A7-01 rejects a total computed on the regular price when a discount exists", () => {
  expect(() => DraftSchema.parse({
    ...draft,
    items: [{ ...draft.items[0], specialPrice: 15 }],
    total: 40,
  })).toThrow();
});

it("A7-01 rejects duplicate promotion identifiers on one item", () => {
  expect(() => DraftSchema.parse({
    ...draft,
    items: [{
      ...draft.items[0],
      promotions: [
        { id: "promo-1", label: "Акція", price: null },
        { id: "promo-1", label: "Друга акція", price: null },
      ],
    }],
  })).toThrow();
});

it("A7-01 rejects a non-URL image and a non-positive display ratio", () => {
  expect(() => DraftSchema.parse({ ...draft, items: [{ ...draft.items[0], imageUrl: "not-a-url" }] })).toThrow();
  expect(() => DraftSchema.parse({ ...draft, items: [{ ...draft.items[0], displayRatio: 0 }] })).toThrow();
});
```

- [ ] Add `effectiveUnitPrice` to the file's existing import from `./contracts`.

### 7.1.3 — Confirm failure

Run: `pnpm vitest run src/features/shared/contracts.test.ts`
Expected: FAIL — `effectiveUnitPrice` is not exported, and the strict schema rejects the four unknown keys.

### 7.1.4 — Extend the contract

- [ ] In `src/features/shared/contracts.ts`, replace the head of `DraftItemSchema`'s object literal so the new fields sit beside their counterparts:

```ts
export const DraftItemSchema = z.object({
  productId: nonEmptyString,
  externalProductId: z.number().int().nonnegative(),
  name: nonEmptyString,
  imageUrl: z.string().url().nullable(),
  displayRatio: finitePositive,
  quantity: finitePositive,
  price: finiteNonNegative,
  specialPrice: finiteNonNegative.nullable(),
  stock: finiteNonNegative,
  step: finitePositive,
  confidence: z.number().finite().min(0.55).max(1),
  confidenceBand: ConfidenceBandSchema,
  reasonCodes: z.array(nonEmptyString).min(1).refine(unique, "reasonCodes must be unique"),
  reason: z.string().trim().min(1).max(160),
  nutritionStatus: NutritionStatusSchema,
  promotions: z.array(PromotionSchema),
  alternatives: z.array(ProductCandidateSchema),
}).strict().superRefine((value, context) => {
```

- [ ] Add these checks inside that existing `superRefine`, before its closing brace:

```ts
  if (value.specialPrice !== null && value.specialPrice > value.price) {
    context.addIssue({ code: "custom", path: ["specialPrice"], message: "specialPrice cannot exceed price" });
  }
  if (!unique(value.promotions.map((promotion) => promotion.id))) {
    context.addIssue({ code: "custom", path: ["promotions"], message: "promotion IDs must be unique" });
  }
```

- [ ] Add the exported helper immediately after `export type DraftItem`:

```ts
export function effectiveUnitPrice(item: DraftItem): number {
  return item.specialPrice ?? item.price;
}
```

- [ ] In `DraftSchema`'s `superRefine`, replace the total calculation:

```ts
  const calculated = value.items.reduce(
    (sum, item) => sum + item.quantity * effectiveUnitPrice(item),
    0,
  );
```

### 7.1.5 — Confirm green, then write the failing schema test

Run: `pnpm vitest run src/features/shared/contracts.test.ts`
Expected: PASS.

- [ ] Add to `src/db/schema.test.ts`:

```ts
describe("draftItems schema", () => {
  it("A7-02 stores product presentation fields", () => {
    const columns = getTableColumns(draftItems);

    expect(columns.imageUrl.name).toBe("image_url");
    expect(columns.displayRatio.name).toBe("display_ratio");
    expect(columns.specialPrice.name).toBe("special_price");
    expect(columns.promotions.name).toBe("promotions");
  });
});
```

- [ ] Add `draftItems` to the file's import from `./schema`.

Run: `pnpm vitest run src/db/schema.test.ts`
Expected: FAIL — `draftItems` has no `imageUrl` column.

### 7.1.6 — Add the columns and the migration

- [ ] In `src/db/schema.ts`, add to `draftItems` after `name`:

```ts
  imageUrl: text("image_url"),
  displayRatio: doublePrecision("display_ratio"),
```

and after `price`:

```ts
  specialPrice: doublePrecision("special_price"),
```

and after `alternatives`:

```ts
  promotions: jsonb("promotions").$type<Promotion[]>(),
```

- [ ] Import the `Promotion` type at the top of `src/db/schema.ts`:

```ts
import type { Promotion } from "@/features/shared/contracts";
```

- [ ] Generate the migration:

```bash
pnpm db:generate
```

- [ ] Rename the generated file to `drizzle/0002_draft_item_presentation.sql`, update the matching `tag` in `drizzle/meta/_journal.json`, and append the backfill so existing rows satisfy the non-nullable contract fields:

```sql
UPDATE "draft_items" SET "display_ratio" = 1 WHERE "display_ratio" IS NULL;--> statement-breakpoint
UPDATE "draft_items" SET "promotions" = '[]'::jsonb WHERE "promotions" IS NULL;
```

Nothing backfills `image_url` or `special_price`; null is their correct value.

Run: `pnpm vitest run src/db/schema.test.ts`
Expected: PASS.

### 7.1.7 — Write the failing repository test

- [ ] In `src/features/drafts/repository.test.ts`, extend the existing `draftFixture` item with `imageUrl: null`, `displayRatio: 1`, `specialPrice: null`, and `promotions: []`, then add:

```ts
it("A7-02 round-trips presentation fields through the in-memory repository", async () => {
  const repo = createInMemoryDraftRepository();
  const discounted: Draft = {
    ...draftFixture,
    items: [{
      ...draftFixture.items[0],
      imageUrl: "https://example.test/water.png",
      displayRatio: 0.5,
      specialPrice: 45,
      promotions: [{ id: "promo-1", label: "Акція тижня", price: 45 }],
    }],
    total: 90,
  };

  await repo.save("user-1", discounted);
  expect(await repo.get(discounted.id, "user-1")).toEqual(discounted);
});

it("A7-02 rejects a stored row missing its display ratio", () => {
  expect(() => DraftSchema.parse({
    ...draftFixture,
    items: [{ ...draftFixture.items[0], displayRatio: null }],
  })).toThrow();
});
```

- [ ] Add a Postgres-side assertion to the `DraftRepository (postgres)` describe block. The existing test mocks the insert without inspecting its payload, so the write path needs its own evidence:

```ts
it("A7-02 writes presentation columns in the item insert", async () => {
  const itemValues = vi.fn(async () => []);
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => []) })),
      })),
    })),
    insert: vi
      .fn()
      .mockImplementationOnce(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => [{ id: "00000000-0000-4000-8000-000000000099" }]),
        })),
      }))
      .mockImplementationOnce(() => ({ values: vi.fn(async () => []) }))
      .mockImplementationOnce(() => ({ values: itemValues })),
  };
  const mockDb = {
    transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<Draft>) => callback(tx)),
  } as unknown as DbClient;

  await createPostgresDraftRepository(mockDb).save("user-1", {
    ...draftFixture,
    items: [{
      ...draftFixture.items[0],
      imageUrl: "https://example.test/milk.png",
      displayRatio: 0.5,
      specialPrice: 45,
      promotions: [{ id: "promo-1", label: "Акція", price: 45 }],
    }],
    total: 90,
  });

  expect(itemValues).toHaveBeenCalledWith([expect.objectContaining({
    imageUrl: "https://example.test/milk.png",
    displayRatio: 0.5,
    specialPrice: 45,
    promotions: [{ id: "promo-1", label: "Акція", price: 45 }],
  })]);
});
```

- [ ] Import `DraftSchema` alongside the existing `Draft` type import.

Run: `pnpm vitest run src/features/drafts/repository.test.ts`
Expected: FAIL — the in-memory repository drops the unknown keys, so the round trip is not equal, and the insert payload carries no presentation columns.

### 7.1.8 — Map the columns in both repositories

- [ ] In `mapStoredDraft`, add to the item mapping, matching the contract's field order:

```ts
      imageUrl: item.imageUrl,
      displayRatio: item.displayRatio,
      specialPrice: item.specialPrice,
      promotions: item.promotions,
```

Pass the values straight through. Do not coalesce; a row missing `display_ratio` must fail `DraftSchema.parse` loudly rather than acquire a fabricated default.

- [ ] In `createPostgresDraftRepository`'s `draftItems` insert values, add the same four fields sourced from `item`.

Run: `pnpm vitest run src/features/drafts/repository.test.ts`
Expected: PASS.

### 7.1.9 — Verify and commit

Run:

```bash
pnpm vitest run src/features/shared/contracts.test.ts src/db/schema.test.ts src/features/drafts/repository.test.ts
pnpm test
pnpm lint
pnpm typecheck
```

Expected: every command exits 0.

- [ ] Review `git diff` for scope, secrets, and drift. The diff must not touch `src/components`, `src/app`, or any prediction module.

```bash
git add src/features/shared/contracts.ts src/features/shared/contracts.test.ts src/db/schema.ts src/db/schema.test.ts src/features/drafts/repository.ts src/features/drafts/repository.test.ts drizzle
git commit -m "feat: carry product presentation fields on draft items"
```

Do not stage `.gitignore`.

---

## Task 14 — Silpo-inspired dashboard shell

**Prerequisites:** Task 7.1 committed and reviewed. Run its focused command once in this checkout before starting; a red prerequisite is a dependency report, not a thing to fix here.

**Behavior to prove:** A serialized draft renders as the ordered, explainable, accessible dashboard, with confirm and checkout gated by status, stock, and validations, and with demo data always labelled.

**Focused command:** `pnpm vitest run src/components/autopilot/draft-dashboard.test.tsx`

### 14.1 — Create the test fixture and prove the shell renders

- [ ] Create `src/components/autopilot/draft-dashboard.test.tsx` with this header. Every later slice adds tests below it and reuses these builders.

```tsx
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  CartContext, Draft, DraftItem, VerifiedCart,
} from "@/features/shared/contracts";
import { DraftDashboard, type DraftDashboardProps } from "./draft-dashboard";

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

const draft = (overrides: Partial<Draft> = {}): Draft => {
  const items = overrides.items ?? [item()];
  return {
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
      ?? items.reduce((sum, entry) => sum + entry.quantity * (entry.specialPrice ?? entry.price), 0),
  };
};

const cartContext = (overrides: Partial<CartContext> = {}): CartContext => ({
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

const verifiedCart = (overrides: Partial<VerifiedCart> = {}): VerifiedCart => ({
  cartId: "cart-1",
  status: "verified",
  items: [{ productId: "water-1", quantity: 2, unitPrice: 20, available: true }],
  total: 40,
  validations: [],
  checkoutLinks: { web: "https://silpo.ua/cart", mobile: "https://silpo.ua/app/cart" },
  ...overrides,
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
});
```

- [ ] Run: `pnpm vitest run src/components/autopilot/draft-dashboard.test.tsx`
Expected: FAIL — `./draft-dashboard` does not exist.

- [ ] Create `src/components/autopilot/format.ts`:

```ts
const KYIV_TIME_ZONE = "Europe/Kyiv";

const hryvnia = new Intl.NumberFormat("uk-UA", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const plural = new Intl.PluralRules("uk-UA");
const day = new Intl.DateTimeFormat("uk-UA", {
  timeZone: KYIV_TIME_ZONE,
  day: "numeric",
  month: "long",
});
const time = new Intl.DateTimeFormat("uk-UA", {
  timeZone: KYIV_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
});

export function formatHryvnia(value: number): string {
  return `${hryvnia.format(value)} ₴`;
}

export function pluralizeUk(count: number, forms: [string, string, string]): string {
  const category = plural.select(count);
  if (category === "one") {
    return forms[0];
  }
  if (category === "few") {
    return forms[1];
  }
  return forms[2];
}

export function formatDay(iso: string): string {
  return day.format(new Date(iso));
}

export function formatSlot(startsAt: string, endsAt: string): string {
  return `${time.format(new Date(startsAt))}–${time.format(new Date(endsAt))}, ${day.format(new Date(startsAt))}`;
}
```

- [ ] Create `src/components/autopilot/draft-dashboard.tsx` with the minimum that satisfies the two tests:

```tsx
import type {
  CartContext, DataMode, Draft, DraftStatus, VerifiedCart,
} from "@/features/shared/contracts";

export type DraftPhase =
  | { kind: "pending"; status: Extract<DraftStatus, "syncing" | "generating">; mode: DataMode }
  | { kind: "draft"; draft: Draft };

export interface DraftDashboardProps {
  phase: DraftPhase;
  cartContext: CartContext | null;
  loyaltyBonusAvailable: number | null;
  cart: VerifiedCart | null;
}

export function DraftDashboard({ phase }: DraftDashboardProps) {
  const mode = phase.kind === "draft" ? phase.draft.mode : phase.mode;

  return (
    <>
      {mode === "demo" && <p className="autopilot-demo-banner">Демонстраційні дані</p>}
      <main className="autopilot-main" />
    </>
  );
}
```

Run the focused command. Expected: PASS.

### 14.2 — Header

- [ ] Add to the test file:

```tsx
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
```

The slot assertion is in Kyiv time: the fixture's `09:00Z` is `12:00` local, which is exactly why `formatSlot` pins the zone.

- [ ] Run the focused command. Expected: FAIL — no `banner` landmark exists.

- [ ] Create `src/components/autopilot/app-header.tsx`:

```tsx
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
```

`branchId` and `cartId` are deliberately absent: the contract offers opaque identifiers, not names.

- [ ] Import it in `draft-dashboard.tsx` and render it above the demo banner:

```tsx
import { AppHeader } from "./app-header";
```

```tsx
      <AppHeader mode={mode} cartContext={cartContext} cart={cart} />
```

Destructure `cartContext` and `cart` from props at the same time.

Run the focused command. Expected: PASS.

### 14.3 — Hero

- [ ] Add to the test file:

```tsx
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
  renderDashboard();

  expect(screen.getByText("Разом 40,00 ₴")).toBeVisible();
  expect(screen.getByText("Схоже, вода скоро закінчиться")).toBeVisible();
});

it("D14-04 renders its own headline and no total for an empty draft", () => {
  renderDashboard({ phase: { kind: "draft", draft: draft({ items: [], summary: "" }) } });

  expect(screen.getByRole("heading", { level: 1, name: "Поки що нічого не проситься до кошика" })).toBeVisible();
  expect(screen.queryByText(/^Разом/)).toBeNull();
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
});
```

- [ ] Run the focused command. Expected: FAIL — no level-1 heading exists.

- [ ] Create `src/components/autopilot/draft-overview.tsx` with the hero only:

```tsx
import type { Draft } from "@/features/shared/contracts";
import { formatHryvnia, pluralizeUk } from "./format";

export interface DraftOverviewProps {
  draft: Draft;
  loyaltyBonusAvailable: number | null;
}

export function DraftOverview({ draft }: DraftOverviewProps) {
  const count = draft.items.length;

  return (
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
  );
}
```

- [ ] Import it in `draft-dashboard.tsx` and render it inside `main` when a draft exists:

```tsx
import { DraftOverview } from "./draft-overview";
```

```tsx
        {phase.kind === "draft" && (
          <DraftOverview draft={phase.draft} loyaltyBonusAvailable={loyaltyBonusAvailable} />
        )}
```

Destructure `loyaltyBonusAvailable` from props at the same time.

Run the focused command. Expected: PASS.

### 14.4 — Forecast and value cards

- [ ] Add to the test file:

```tsx
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
  expect(screen.getByText("Разом 40,00 ₴")).toBeVisible();
});

it("D14-06 renders no bonus row when none is available", () => {
  renderDashboard();

  expect(screen.queryByText(/Доступно/)).toBeNull();
});
```

- [ ] Run the focused command. Expected: FAIL — no «Прогноз» region exists.

- [ ] Add the two cards to `draft-overview.tsx`, wrapping the hero and cards in a fragment:

```tsx
import { PREDICTION_CONFIG } from "@/features/prediction/features";
import { formatDay, formatHryvnia, pluralizeUk } from "./format";
```

```tsx
  const high = draft.items.filter((entry) => entry.confidenceBand === "high").length;
  const medium = count - high;
  const discount = draft.items.reduce(
    (sum, entry) => entry.specialPrice === null
      ? sum
      : sum + entry.quantity * (entry.price - entry.specialPrice),
    0,
  );
```

```tsx
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
```

- [ ] Restore `loyaltyBonusAvailable` to the destructured props.

Run the focused command. Expected: PASS.

### 14.5 — Product card

- [ ] Add to the test file:

```tsx
it("D14-07 renders every required product fact", () => {
  renderDashboard({
    phase: {
      kind: "draft",
      draft: draft({
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
  expect(product.getByText("15,00 ₴")).toBeVisible();
  expect(product.getByText("Було 20,00 ₴")).toBeVisible();
  expect(product.getByText("Акція тижня: 15,00 ₴")).toBeVisible();
  expect(product.getByText("В наявності")).toBeVisible();
  expect(product.getByText("Висока впевненість")).toBeVisible();
  expect(product.getByText("Купуєте приблизно раз на 7 днів")).toBeVisible();
  expect(product.getByText("Даних про склад недостатньо")).toBeVisible();
});

it("D14-07 renders each stock branch and the medium confidence label", () => {
  const cases: Array<[Partial<DraftItem>, string]> = [
    [{ stock: 0 }, "Немає в наявності"],
    [{ stock: 1, quantity: 2 }, "Залишилось 1"],
    [{ stock: 10 }, "В наявності"],
  ];

  for (const [overrides, label] of cases) {
    const { unmount } = renderDashboard({
      phase: { kind: "draft", draft: draft({ items: [item({ ...overrides, confidence: 0.6, confidenceBand: "medium" })] }) },
    });
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.getByText("Середня впевненість")).toBeVisible();
    unmount();
  }
});

it("D14-07 counts alternatives and hides the image when none is supplied", () => {
  renderDashboard({
    phase: { kind: "draft", draft: draft({ items: [item({ alternatives: [alternative()] })] }) },
  });

  expect(screen.getByText("Доступні заміни: 1")).toBeVisible();
  expect(screen.queryByRole("img")).toBeNull();
});

it("D14-07 offers no stepper, remove, or replace control", () => {
  renderDashboard();

  expect(screen.queryByRole("button", { name: /Прибрати|Замінити|Більше|Менше/ })).toBeNull();
});
```

- [ ] Add the alternative builder beside the other fixtures:

```tsx
const alternative = (): ProductCandidate => ({
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
```

and add `ProductCandidate` to the type import.

- [ ] Run the focused command. Expected: FAIL — no level-3 heading exists.

- [ ] Create `src/components/autopilot/draft-product-card.tsx`:

```tsx
import type { CartValidation, DraftItem } from "@/features/shared/contracts";
import { formatHryvnia } from "./format";

export interface DraftProductCardProps {
  item: DraftItem;
  validations: CartValidation[];
}

function stockLabel(item: DraftItem): string {
  if (item.stock === 0) {
    return "Немає в наявності";
  }
  if (item.stock < item.quantity) {
    return `Залишилось ${item.stock}`;
  }
  return "В наявності";
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
      <p className="autopilot-product-quantity">Кількість: {item.quantity}</p>
      <p className="autopilot-product-price">
        <span className="autopilot-price-current">
          {formatHryvnia(item.specialPrice ?? item.price)}
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
```

Run the focused command. Expected: FAIL — the cards are not rendered yet. The next slice mounts them.

### 14.6 — Section order and grid

- [ ] Add to the test file:

```tsx
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
```

The order assertion depends on `.autopilot-summary`, which slice 14.7 adds; expect this test to stay red until then.

- [ ] Import the card in `draft-dashboard.tsx`:

```tsx
import { DraftProductCard } from "./draft-product-card";
```

- [ ] Add the product section to `DraftDashboard`, after `DraftOverview`. Wrap the draft branch in a fragment so both siblings render:

```tsx
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
```

Run the focused command. Expected: the D14-07 tests and the two later D14-08 tests PASS; the order test still fails on the missing summary.

### 14.7 — Summary and confirm gating

- [ ] Add to the test file:

```tsx
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

it("D14-09 disables the CTA and explains why when an item is unavailable", () => {
  for (const overrides of [{ stock: 0 }, { stock: 1, quantity: 2 }]) {
    const { unmount } = renderDashboard({
      phase: { kind: "draft", draft: draft({ items: [item(overrides)] }) },
    });

    const cta = screen.getByRole("button", { name: "Додати у кошик “Сільпо”" });
    expect(cta).toBeDisabled();
    expect(cta).toHaveAccessibleDescription("Спочатку розберіться з позиціями, яких немає в наявності");
    unmount();
  }
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
```

- [ ] Run the focused command. Expected: FAIL — no «Підсумок чернетки» region exists.

- [ ] Create `src/components/autopilot/draft-summary.tsx`:

```tsx
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
      <p className="autopilot-summary-total">Разом {formatHryvnia(draft.total)}</p>
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
```

- [ ] Import it in `draft-dashboard.tsx` and render it last inside the draft branch:

```tsx
import { DraftSummary } from "./draft-summary";
```

```tsx
            <DraftSummary draft={phase.draft} cart={cart} />
```

Run the focused command. Expected: PASS, including the D14-08 order test.

### 14.8 — Checkout gating

- [ ] Add to the test file:

```tsx
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

it("D14-10 hides checkout when links are absent or an error validation exists", () => {
  const withoutLinks = renderDashboard({
    phase: { kind: "draft", draft: draft({ status: "verified" }) },
    cart: verifiedCart({ checkoutLinks: null }),
  });
  expect(screen.queryByRole("link", { name: /Оформити/ })).toBeNull();
  withoutLinks.unmount();

  renderDashboard({
    phase: { kind: "draft", draft: draft({ status: "verified" }) },
    cart: verifiedCart({
      validations: [{ severity: "error", code: "out_of_stock", message: "Товару немає", productId: null }],
    }),
  });
  expect(screen.queryByRole("link", { name: /Оформити/ })).toBeNull();
});
```

- [ ] Run the focused command. Expected: PASS. The gating implemented in 14.7 already satisfies these; if any case fails, fix `showCheckout` rather than the test.

This slice is deliberately assertion-only. The rule matters enough that it gets its own independent evidence, and a passing test written after the code still fails if a later refactor loosens the gate.

### 14.9 — Status panel and validations

- [ ] Add to the test file:

```tsx
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
```

- [ ] Run the focused command. Expected: FAIL — no status role is rendered.

- [ ] Create `src/components/autopilot/status-panel.tsx`:

```tsx
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

  return (
    <ul className="autopilot-validations" aria-label="Помилки кошика">
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
```

- [ ] Import the panel in `draft-dashboard.tsx`:

```tsx
import { StatusPanel, ValidationList, type StatusTone } from "./status-panel";
```

- [ ] Add the copy tables above the component:

```tsx
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
```

and inside `main`, before `DraftOverview`:

```tsx
        {panel && <StatusPanel {...panel} headingLevel={phase.kind === "pending" ? 1 : 2} />}
        {cart !== null && <ValidationList validations={cart.validations} />}
```

with the selection above the return:

```tsx
  const panel = phase.kind === "pending"
    ? PENDING_PANELS[phase.status]
    : DRAFT_PANELS[phase.draft.status];
```

Run the focused command. Expected: PASS.

### 14.10 — Dashboard route

- [ ] Create `src/app/dashboard/page.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import DashboardPage from "./page";

const getServerEnv = vi.hoisted(() => vi.fn());
vi.mock("@/lib/env", () => ({ getServerEnv }));

beforeEach(() => {
  getServerEnv.mockReturnValue({ DATA_MODE: "live" });
});

it("D14-02 renders the syncing shell with no draft affordances", () => {
  render(<DashboardPage />);

  expect(screen.getByRole("heading", { level: 1, name: "Синхронізуємо історію покупок" })).toBeVisible();
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("link", { name: /Оформити/ })).toBeNull();
  expect(screen.queryByText(/^Разом/)).toBeNull();
  expect(screen.queryByText("Демонстраційні дані")).toBeNull();
});

it("D14-02 reads the mode on the request path", () => {
  getServerEnv.mockReturnValue({ DATA_MODE: "demo" });

  render(<DashboardPage />);

  expect(getServerEnv).toHaveBeenCalledOnce();
  expect(screen.getByText("Демонстраційні дані")).toBeVisible();
});
```

The mock is asserted per render, which is what proves the read happens at request time rather than at module import: a module-level read would have run before `mockReturnValue` changed.

- [ ] Run: `pnpm vitest run src/app/dashboard/page.test.tsx`
Expected: FAIL — `./page` does not exist.

- [ ] Create `src/app/dashboard/page.tsx`:

```tsx
import { DraftDashboard } from "@/components/autopilot/draft-dashboard";
import { getServerEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  const { DATA_MODE: mode } = getServerEnv();

  return (
    <DraftDashboard
      phase={{ kind: "pending", status: "syncing", mode }}
      cartContext={null}
      loyaltyBonusAvailable={null}
      cart={null}
    />
  );
}
```

The page reads the environment on the request path, never at module import, and never accepts a client-supplied mode. Draft acquisition belongs to Task 13; changing this file to add it needs controller approval, as spec §9 records.

- [ ] Run: `pnpm vitest run src/app/dashboard/page.test.tsx`
Expected: PASS.

- [ ] Run `pnpm build`.
Expected: PASS, with `/dashboard` listed as a dynamic route.

### 14.11 — Tokens and styles

- [ ] Add to the test file:

```tsx
it("D14-01S keeps brand colour out of components", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const directory = new URL(".", import.meta.url);
  const files = (await readdir(directory)).filter((name) => name.endsWith(".tsx") || name.endsWith(".ts"));

  for (const name of files.filter((file) => !file.endsWith(".test.tsx"))) {
    const source = await readFile(new URL(name, directory), "utf8");
    expect(source, `${name} must not hard-code colour`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(source, `${name} must not use inline styles`).not.toContain("style={{");
    expect(source, `${name} must stay a Server Component`).not.toContain("use client");
  }
});
```

- [ ] Run the focused command. Expected: PASS if the components are clean; if it fails, remove the colour from the component rather than relaxing the pattern.

- [ ] Replace the body of `src/app/globals.css` below its Tailwind import with the token block and component rules. Keep `@import "tailwindcss";` as the first line for its reset:

```css
:root {
  --autopilot-orange: #fe8522;
  --autopilot-blue: #2358d1;
  --autopilot-ink: #202124;
  --autopilot-bg: #f5f5fb;
  --autopilot-lilac: #eeeafb;
  --autopilot-green: #c7df9c;
  --autopilot-surface: #ffffff;
  --autopilot-muted: #6b6f76;
  --autopilot-border: #e2e3e8;
  --autopilot-success: #26734d;
  --autopilot-warning: #9a5b00;
  --autopilot-danger: #b42318;
  --autopilot-focus: #0b57d0;

  --autopilot-space-1: 4px;
  --autopilot-space-2: 8px;
  --autopilot-space-3: 12px;
  --autopilot-space-4: 16px;
  --autopilot-space-6: 24px;
  --autopilot-space-8: 32px;
  --autopilot-space-12: 48px;

  --autopilot-radius-sm: 10px;
  --autopilot-radius-md: 16px;
  --autopilot-radius-lg: 24px;
  --autopilot-radius-xl: 32px;
  --autopilot-radius-pill: 999px;

  --autopilot-shadow-raised: 0 12px 32px rgb(32 33 36 / 12%);

  --autopilot-font-display: 34px;
  --autopilot-font-h1: 30px;
  --autopilot-font-h2: 24px;
  --autopilot-font-h3: 18px;
  --autopilot-font-body: 16px;
  --autopilot-font-small: 14px;
  --autopilot-font-label: 13px;
}

@media (min-width: 600px) {
  :root {
    --autopilot-font-display: 48px;
    --autopilot-font-h1: 36px;
    --autopilot-font-h2: 28px;
    --autopilot-font-h3: 20px;
  }
}
```

- [ ] Add the component rules. Every colour reference is a token; the grid uses the design system's fixed column counts; the summary is sticky with matching page padding:

```css
body {
  background: var(--autopilot-bg);
  color: var(--autopilot-ink);
}

main.autopilot-main {
  display: block;
  place-items: normal;
  min-height: auto;
  max-width: 1280px;
  margin: 0 auto;
  padding: var(--autopilot-space-4) var(--autopilot-space-4) 160px;
}

@media (min-width: 600px) {
  main.autopilot-main { padding-inline: var(--autopilot-space-6); }
}

@media (min-width: 1024px) {
  main.autopilot-main { padding-inline: var(--autopilot-space-8); }
}

.autopilot-header {
  display: flex;
  flex-wrap: wrap;
  gap: var(--autopilot-space-4);
  align-items: baseline;
  max-width: 1280px;
  margin: 0 auto;
  padding: var(--autopilot-space-4);
  background: var(--autopilot-surface);
}

.autopilot-wordmark { font-size: var(--autopilot-font-h3); font-weight: 700; }
.autopilot-wordmark-note { margin-left: var(--autopilot-space-2); color: var(--autopilot-muted); font-size: var(--autopilot-font-small); }
.autopilot-header-context { display: flex; flex-wrap: wrap; gap: var(--autopilot-space-4); margin: 0; }
.autopilot-header-row dt { color: var(--autopilot-muted); font-size: var(--autopilot-font-label); }
.autopilot-header-row dd { margin: 0; font-size: var(--autopilot-font-small); }

.autopilot-demo-banner {
  max-width: 1280px;
  margin: 0 auto;
  padding: var(--autopilot-space-3) var(--autopilot-space-4);
  border-radius: var(--autopilot-radius-pill);
  background: var(--autopilot-lilac);
  font-size: var(--autopilot-font-small);
}

.autopilot-status {
  padding: var(--autopilot-space-4);
  border-radius: var(--autopilot-radius-lg);
  background: var(--autopilot-surface);
}

.autopilot-status-attention { border: 2px solid var(--autopilot-danger); }
.autopilot-status-success { border: 2px solid var(--autopilot-success); }
.autopilot-status-title { margin: 0 0 var(--autopilot-space-2); font-size: var(--autopilot-font-h2); }

.autopilot-validations { margin: var(--autopilot-space-4) 0; padding: 0; list-style: none; }
.autopilot-validation { padding: var(--autopilot-space-2) 0; }
.autopilot-validation-severity { font-weight: 600; }

.autopilot-hero {
  margin-top: var(--autopilot-space-6);
  padding: var(--autopilot-space-8);
  border-radius: var(--autopilot-radius-xl);
  background: var(--autopilot-surface);
}

.autopilot-hero-title { margin: 0; font-size: var(--autopilot-font-display); line-height: 1.05; }
.autopilot-hero-total { font-size: var(--autopilot-font-h2); font-variant-numeric: tabular-nums; }

.autopilot-cards { display: grid; gap: var(--autopilot-space-4); margin-top: var(--autopilot-space-6); }

@media (min-width: 600px) {
  .autopilot-cards { grid-template-columns: repeat(2, 1fr); }
}

.autopilot-card {
  padding: var(--autopilot-space-6);
  border-radius: var(--autopilot-radius-lg);
  background: var(--autopilot-lilac);
}

.autopilot-card h2 { margin-top: 0; font-size: var(--autopilot-font-h2); }
.autopilot-products { margin-top: var(--autopilot-space-8); }
.autopilot-products h2 { font-size: var(--autopilot-font-h2); }
.autopilot-grid { display: grid; gap: var(--autopilot-space-4); padding: 0; list-style: none; }

@media (min-width: 600px) { .autopilot-grid { grid-template-columns: repeat(2, minmax(260px, 1fr)); } }
@media (min-width: 900px) { .autopilot-grid { grid-template-columns: repeat(3, minmax(260px, 1fr)); } }
@media (min-width: 1200px) { .autopilot-grid { grid-template-columns: repeat(4, minmax(260px, 1fr)); } }

.autopilot-product {
  display: flex;
  flex-direction: column;
  gap: var(--autopilot-space-2);
  padding: var(--autopilot-space-4);
  border-radius: var(--autopilot-radius-md);
  background: var(--autopilot-surface);
}

.autopilot-product p { margin: 0; font-size: var(--autopilot-font-small); }
.autopilot-product-name { margin: 0; font-size: var(--autopilot-font-h3); }
.autopilot-product-image { aspect-ratio: 1; background: var(--autopilot-bg); border-radius: var(--autopilot-radius-sm); }
.autopilot-product-image img { width: 100%; height: 100%; object-fit: contain; }
.autopilot-product-placeholder { display: block; width: 100%; height: 100%; }
.autopilot-price-current { font-size: var(--autopilot-font-h3); font-variant-numeric: tabular-nums; }
.autopilot-price-previous { margin-left: var(--autopilot-space-2); color: var(--autopilot-muted); }
.autopilot-product-promotions { margin: 0; padding: 0; list-style: none; color: var(--autopilot-success); font-size: var(--autopilot-font-small); }
.autopilot-product-confidence { display: inline-block; padding: var(--autopilot-space-1) var(--autopilot-space-3); border-radius: var(--autopilot-radius-pill); background: var(--autopilot-lilac); }
.autopilot-product-validations { margin: 0; padding: 0; list-style: none; font-size: var(--autopilot-font-small); }

.autopilot-summary {
  position: sticky;
  bottom: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--autopilot-space-4);
  align-items: center;
  margin-top: var(--autopilot-space-8);
  padding: var(--autopilot-space-4);
  border-radius: var(--autopilot-radius-lg);
  background: var(--autopilot-surface);
  box-shadow: var(--autopilot-shadow-raised);
}

.autopilot-summary p { margin: 0; }
.autopilot-summary-total { font-size: var(--autopilot-font-h3); font-variant-numeric: tabular-nums; }
.autopilot-summary-note { color: var(--autopilot-muted); font-size: var(--autopilot-font-small); }

.autopilot-cta {
  min-width: 44px;
  min-height: 44px;
  padding: var(--autopilot-space-3) var(--autopilot-space-6);
  border: 0;
  border-radius: var(--autopilot-radius-pill);
  background: var(--autopilot-blue);
  color: var(--autopilot-surface);
  font-size: var(--autopilot-font-body);
  cursor: pointer;
}

.autopilot-cta:disabled { background: var(--autopilot-muted); cursor: not-allowed; }

.autopilot-checkout { display: flex; gap: var(--autopilot-space-4); }
.autopilot-checkout a { display: inline-flex; align-items: center; min-height: 44px; color: var(--autopilot-blue); }

:focus-visible { outline: 2px solid var(--autopilot-focus); outline-offset: 2px; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
```

`main.autopilot-main` overrides the existing element-level `main` rule that centres the landing page, so `src/app/page.tsx` keeps its current layout without being modified.

- [ ] Run the focused command and `pnpm build`. Expected: PASS.

### 14.12 — Accessibility assertions

- [ ] Add to the test file:

```tsx
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
```

- [ ] Run the focused command. Expected: PASS if the markup follows the slices above; if the heading order assertion fails, fix the markup, not the expectation.

### 14.13 — Responsive verification, full gate, and commit

- [ ] Create a throwaway harness at `src/components/autopilot/responsive-harness.test.tsx`. It runs under the existing Vitest setup, so no build step or path-alias shim is needed. **Delete it before committing.**

```tsx
import { writeFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { it } from "vitest";
import type { Draft, DraftItem } from "@/features/shared/contracts";
import { DraftDashboard } from "./draft-dashboard";

const OUTPUT = "/tmp/dashboard-responsive.html";

const product = (index: number, overrides: Partial<DraftItem> = {}): DraftItem => ({
  productId: `product-${index}`,
  externalProductId: 100 + index,
  name: `Товар з достатньо довгою назвою ${index}`,
  imageUrl: null,
  displayRatio: 1,
  quantity: 2,
  price: 42.5,
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

it("writes a responsive review page", async () => {
  const items = [
    product(1, { specialPrice: 35, promotions: [{ id: "p1", label: "Акція тижня", price: 35 }] }),
    product(2, { stock: 0 }),
    product(3, { confidence: 0.6, confidenceBand: "medium" }),
    product(4),
  ];
  const draft: Draft = {
    id: "draft-1",
    mode: "demo",
    status: "ready",
    algorithmVersion: "prediction-v1",
    trainingCutoff: "2026-09-02T00:00:00.000Z",
    summary: "Схоже, кілька регулярних позицій скоро закінчаться",
    items,
    total: items.reduce((sum, entry) => sum + entry.quantity * (entry.specialPrice ?? entry.price), 0),
    version: 1,
  };

  const css = await import("node:fs/promises")
    .then((fs) => fs.readFile("src/app/globals.css", "utf8"))
    .then((source) => source.replace('@import "tailwindcss";', ""));

  const body = renderToStaticMarkup(
    <DraftDashboard
      phase={{ kind: "draft", draft }}
      cartContext={{
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
      }}
      loyaltyBonusAvailable={12}
      cart={null}
    />,
  );

  writeFileSync(
    OUTPUT,
    `<!doctype html><html lang="uk"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<style>${css}</style></head><body>${body}</body></html>`,
  );
});
```

The Tailwind import is stripped because the harness inlines raw CSS with no PostCSS pass; every rule under review is hand-written and unaffected.

- [ ] Run it, then open the output file:

```bash
pnpm vitest run src/components/autopilot/responsive-harness.test.tsx
```

- [ ] Open that file at 390 px and at 1440 px. Confirm and screenshot:
  - no horizontal overflow — `document.documentElement.scrollWidth <= window.innerWidth` at both widths;
  - the sticky summary does not cover the last product card;
  - one column at 390 px and four at 1440 px;
  - the demo banner and validations remain visible at 390 px.

- [ ] Record the screenshots and the measured values in the task report. State plainly that this evidence is manual and that the committed regression test for a populated dashboard arrives with Task 18.

- [ ] Delete the harness before running the gate:

```bash
rm src/components/autopilot/responsive-harness.test.tsx
```

- [ ] Run the full gate:

```bash
pnpm vitest run src/components/autopilot/draft-dashboard.test.tsx
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

Expected: every command exits 0.

- [ ] Review `git diff` for scope, secrets, guessed shapes, dead code, and drift. The diff must not touch contracts, the database, prediction, or the Silpo adapters.

```bash
git add src/app/dashboard src/app/globals.css src/components/autopilot
git commit -m "feat: add action-first draft dashboard"
```

Do not stage `.gitignore`.

- [ ] Report changed files, commands run, results, the manual responsive evidence, remaining risks, and the exact commit hash. Leave the `docs/tasks.md` checkboxes for the controller.

---

## Verification map

| Requirement | Slice |
|---|---|
| A7-01 | 7.1.2, 7.1.4 |
| A7-02 | 7.1.5, 7.1.6, 7.1.7, 7.1.8 |
| D14-01 | 14.1 |
| D14-02 | 14.10, including `page.test.tsx` |
| D14-03 | 14.2 |
| D14-04 | 14.3 |
| D14-05 | 14.4 |
| D14-06 | 14.4 |
| D14-07 | 14.5 |
| D14-08 | 14.6 |
| D14-09 | 14.7 |
| D14-10 | 14.8 |
| D14-11 | 14.9 |
| D14-12 | 14.1 |
| D14-13 | 14.12 |
| D14-14 | 14.13 |
| D14-01S–03S | 14.11 |
