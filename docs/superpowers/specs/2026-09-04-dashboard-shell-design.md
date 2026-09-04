# Task 14 Dashboard Shell Specification

Status: specified for review on 2026-09-04; implementation has not started.

## 1. Scope and authority

This specification refines [Task 14](../../tasks.md#task-14-silpo-inspired-dashboard-shell) and adds the prerequisite contract slice it depends on. It defines observable behavior; the [implementation plan](../plans/2026-09-04-dashboard-shell.md) defines execution and evidence. It does not supersede [AGENTS.md](../../../AGENTS.md), the [product specification](../../product-spec.md), [project architecture](../../project-architecture.md), or the [design system](../../design-system.md).

Task 14 owns one boundary: turning a serialized `Draft` into the action-first dashboard. It renders. It does not fetch, orchestrate, edit, approve, or write.

Task 7.1 is a prerequisite slice defined in section 5. It exists because Task 14 is the first consumer of `DraftItem` and finds four fields missing that the design system requires on every product card. It is separately committed and separately reviewed.

Excluded and owned elsewhere: draft generation and the `POST /api/drafts` route (Task 13), quantity stepping, removal, replacement, and the approval route (Task 15), the cart write, readback, and the real `VerifiedCart` (Task 16), demo diagnostics and the sanitized MCP trace (Task 17), and end-to-end scenarios (Task 18). Task 14 renders states those tasks will supply; it never fabricates their data.

## 2. Repository evidence and dependency gates

Inspected baseline: `298b1f2` (`docs: specify encrypted MCP token vault`). The working tree carried only an unrelated `.gitignore` modification, which must be preserved. Tasks 1–7 are integrated. Task 14 is in Wave 3 and its dependencies are satisfied.

| Existing boundary | Consequence for this work |
|---|---|
| `DraftSchema` and `DraftItemSchema` in `src/features/shared/contracts.ts` | The draft is the single UI input. Section 5 extends `DraftItem` by four fields under controller approval; no other shared contract changes. |
| `CartContextSchema`, `VerifiedCartSchema`, `CartValidationSchema`, `CheckoutLinksSchema` | Header context, post-commit validations, and checkout links reuse these types unchanged. Task 14 introduces no UI-only mirror of them. |
| `CustomerContextSchema.loyaltyBonusAvailable` | The loyalty figure reaches the dashboard as one scalar prop. The dashboard never receives the rest of `CustomerContext`, which carries family size and restriction keys it must not render. |
| `PREDICTION_CONFIG.historyWindowDays` in `src/features/prediction/features.ts` | The forecast card reads the history window from this frozen constant instead of repeating `180`. Importing a pure domain constant does not violate the dependency direction. |
| `mapStoredDraft` in `src/features/drafts/repository.ts` runs `DraftSchema.parse` on `draft_items` rows | New required draft fields must land in the contract, the table, the migration, and the mapper together, or Task 7 breaks on its next round trip. Section 5 keeps them together. |
| `getServerEnv()` in `src/lib/env.ts` | The only environment reader, called on the request path, never at module import. |
| `src/app/globals.css` currently holds a hand-written reset and element selectors; `@import "tailwindcss"` is present but no component uses a utility class | Section 7 establishes semantic CSS as the single styling convention and keeps the import for its reset. |
| `eslint-config-next/core-web-vitals` is active | `@next/next/no-img-element` applies. D14-07 documents the one suppression and why it is temporary. |
| Task 8 (`2026-09-04-mcp-token-vault-design.md`) is specified and states it adds no column, index, or migration | Task 7.1's migration `0002` cannot collide with Task 8. Their file sets are disjoint, so the two may run in parallel worktrees. |

Fresh prerequisite evidence during planning: `pnpm vitest run src/features/shared/contracts.test.ts src/features/drafts/repository.test.ts src/db/schema.test.ts` passed 27 tests in three files. This is prerequisite evidence, not proof that Task 14 is implemented.

## 3. Design decisions

| Decision | Selected approach and trade-off |
|---|---|
| Missing product-card fields | Extend `DraftItem` with `imageUrl`, `displayRatio`, `specialPrice`, and `promotions`, mirroring `ProductCandidate`. A components-layer view model would avoid touching the frozen contract but would create the parallel abstraction AGENTS.md warns against, and every producer would have to populate it anyway. |
| Amendment packaging | A separate Task 7.1 commit carries contract, table, migration, and mapper. Folding it into Task 14 would mix a persistence migration with UI work and silently widen Task 14's declared ownership. |
| Discounted totals | `effectiveUnitPrice(item) = specialPrice ?? price`, used by the `DraftSchema` total refinement. Leaving the total on the regular price would misstate what the user pays the moment a promotion exists. |
| Phase modelling | A discriminated union: either a pending status with no draft, or a draft that carries its own status and mode. A flat `status` prop beside a nullable draft makes "verified with no draft" representable and forces defensive code. |
| Interactivity | Every Task 14 component is a Server Component with no function props. Introducing a client boundary for a CTA that nothing yet handles would ship a half-wired tree; Task 15 owns interaction and introduces `"use client"` where it belongs. |
| Styling | Design tokens as CSS custom properties plus semantic `.autopilot-*` classes in `globals.css`. Tailwind utilities would put arbitrary color values within reach of every component and move the responsive type scale into theme configuration. |
| Savings vocabulary | The value card reports draft-snapshot discounts as «Знижки в чернетці» and never as «економія». Draft prices are catalog snapshots, not verified cart prices, and design-system §12 reserves the savings word for verified figures. |

## 4. Global constraints

- Use `pnpm` exclusively; add no dependencies or package/lockfile changes.
- The dashboard is presentational. It performs no fetch, no mutation, no navigation side effect, and holds no state.
- Every value shown comes from a prop. The dashboard computes only counts, sums over supplied snapshots, and formatting.
- The draft is a proposal. No Task 14 element writes to a cart, approves anything, or implies that it has.
- Live mode never renders demo affordances, and demo mode always renders its banner.
- Checkout appears only for a `verified` draft whose supplied cart has checkout links and no error-severity validation.
- The loyalty bonus is displayed as available and is never subtracted from any total.
- Nutrition is either a known state or «Даних про склад недостатньо»; it is never inferred.
- Colour is never the only signal. Every status, severity, confidence, and mode has text.
- Components use `.autopilot-*` classes only. No inline styles, no colour literals, no utility classes.
- Meet WCAG 2.2 AA: one `h1`, semantic headings, keyboard operability, visible focus, 44×44 px targets, reduced-motion support.
- Follow red-green-refactor and keep one focused commit per slice.

## 5. Task 7.1 requirements — draft item presentation fields

### A7-01 — Contract extension

Add four fields to `DraftItemSchema`, placed to mirror `ProductCandidate`:

```ts
imageUrl: z.string().url().nullable(),
displayRatio: finitePositive,
specialPrice: finiteNonNegative.nullable(),
promotions: z.array(PromotionSchema),
```

Add a refinement rejecting `specialPrice > price`, matching the rule `validateProductFacts` already applies to catalog products. Promotion IDs within one item must be unique.

Export from contracts:

```ts
export function effectiveUnitPrice(item: DraftItem): number;
```

It returns `item.specialPrice ?? item.price`. The `DraftSchema` total refinement uses it in place of `item.price`, keeping the existing `0.01` tolerance. Items without a discount are unaffected, so every draft valid before this change stays valid.

`displayRatio` is carried, not interpreted. Its display semantics belong to Task 15's quantity stepper, and Task 14 must not derive a package amount from it.

### A7-02 — Persistence

Add to `draft_items` in `src/db/schema.ts`: `image_url text`, `display_ratio double precision`, `special_price double precision`, and `promotions jsonb` typed `Promotion[]`. Generate migration `0002` with `pnpm db:generate`, and extend it so existing rows receive `display_ratio = 1` and `promotions = '[]'::jsonb`. Nothing backfills `image_url` or `special_price`; null is their correct value.

`mapStoredDraft` passes all four columns through to `DraftSchema.parse` without coalescing. A row missing a required value must fail loudly rather than acquire a fabricated default. Both repository implementations round-trip the new fields, and the in-memory implementation stays behaviourally identical to the Postgres one.

## 6. Task 14 requirements

### D14-01 — Component boundaries and props

Files under `src/components/autopilot/`:

| File | Responsibility |
|---|---|
| `app-header.tsx` | Wordmark, delivery context, slot, cart indicator, connection status. |
| `draft-overview.tsx` | Hero, forecast card, value card. |
| `draft-product-card.tsx` | One recommended product, read-only. |
| `draft-summary.tsx` | Sticky item count, total, CTA, checkout links. |
| `status-panel.tsx` | Non-ready state messaging and `ValidationList`. |
| `draft-dashboard.tsx` | Composition and section order only. |
| `format.ts` | Currency, date, and Ukrainian plural formatting shared by the components above. |

`draft-overview.tsx` and `format.ts` refine the backlog's file list. Without `draft-overview.tsx`, the composition file would own the hero, two cards, the grid, and the section order at once; with it, `draft-dashboard.tsx` stays small enough to review as one unit and gives Task 15 a stable seam. `format.ts` exists because four of the six components format money, dates, and plurals; putting those helpers in any one component would make its siblings import a peer for an unrelated reason. `ValidationList` is exported from `status-panel.tsx` rather than taking its own file, because cart-level messaging is already that module's subject.

`draft-dashboard.tsx` exports:

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

Mode has exactly one source in each arm: `phase.mode` while pending, `phase.draft.mode` once a draft exists. No prop can contradict the draft. No component accepts a function prop, `children`, or a class-name override, and none declares `"use client"`.

### D14-02 — Page composition

`src/app/dashboard/page.tsx` is an async Server Component with `export const dynamic = "force-dynamic"`. It reads `getServerEnv()` on the request path for `DATA_MODE`, then renders:

```tsx
<DraftDashboard
  phase={{ kind: "pending", status: "syncing", mode }}
  cartContext={null}
  loyaltyBonusAvailable={null}
  cart={null}
/>
```

This is the genuine first frame of the finished flow: no items, no total, no confirm, no checkout, and no claim about data the application does not have. Draft acquisition is Task 13's, and modifying this file to add it requires controller approval because the backlog assigns that change to no task. Section 9 records the gap.

The page must not read `process.env` directly, accept a client-supplied mode, import a fixture, or construct a gateway.

### D14-03 — Header

`AppHeader` renders the wordmark «Автопілот» as a `span`, not a heading, beside the line «працює з кошиком “Сільпо”». It renders no Silpo mark.

| Input | Rendered |
|---|---|
| `cartContext.deliveryType === "delivery"` | «Доставка» |
| `cartContext.deliveryType === "pickup"` | «Самовивіз» |
| `cartContext.city` | The city string; a null city renders «Місто не вибрано» |
| `cartContext.slot` | «Слот: HH:MM–HH:MM, D MMMM» |
| `cartContext === null` | «Кошик “Сільпо” ще не підключено», and no delivery, city, or slot row |
| `cart === null` | «Кошик “Сільпо” ще не змінювався» |
| `cart !== null` | «У кошику N позицій» |
| `mode === "live"` | «Живі дані “Сільпо”» |
| `mode === "demo"` | «Демо-режим» |

`branchId` is not rendered. The contract supplies an opaque identifier, not a branch name, and showing an ID to a user is noise. Addresses, phone numbers, and loyalty identifiers never reach this component.

Slot and date formatting uses `Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv" })` so output does not vary with the host timezone.

The demo connection label deliberately differs from the banner string. Task 18's end-to-end test asserts `getByText("Демонстраційні дані")`, which fails under Playwright strict mode if two elements match.

### D14-04 — Hero

Rendered only when `phase.kind === "draft"`.

The `h1` — the page's only one — reads «N товарів уже просяться до кошика», where the noun agrees with `draft.items.length` through `Intl.PluralRules("uk-UA")`: `one` → «товар», `few` → «товари», everything else → «товарів». An empty draft renders «Поки що нічого не проситься до кошика» and no total.

Below it: the total as «Разом X ₴», and `draft.summary` when it is non-empty. The summary is server copy and is rendered as text, never as markup.

`format.ts` exports `pluralizeUk(count, [one, few, many])`, which selects through `Intl.PluralRules("uk-UA")`, plus `formatHryvnia` and the date helpers. `formatHryvnia(value)` formats with `Intl.NumberFormat("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })` and appends `" ₴"`. Tests normalize ` ` and ` ` to a plain space before asserting, because Intl uses narrow no-break spaces as group separators.

The hero shows no CTA and no checkout; both belong to the summary.

### D14-05 — Forecast card

Heading `h2` «Прогноз». Contents:

- «Знайшли N регулярних потреб», pluralized as in D14-04;
- «Історія за останні {PREDICTION_CONFIG.historyWindowDays} днів»;
- «Висока впевненість: N» and «Середня впевненість: N», counted from `confidenceBand`;
- «Дані до {formatted trainingCutoff}».

The card presents these as measurements of the draft. It makes no claim about accuracy, guarantees nothing, and shows no backtest figure; Task 17 owns diagnostics.

### D14-06 — Value card

Heading `h2` «Вигода».

Discount total is `Σ quantity × (price − specialPrice)` over items where `specialPrice !== null`. Above zero it renders «Знижки в чернетці: X ₴» followed by «Ціни перевіримо ще раз перед додаванням у кошик». At zero it renders «Знижок у чернетці немає». The word «економія» does not appear in any state, because the figure comes from catalog snapshots rather than a verified cart.

When `loyaltyBonusAvailable !== null` the card renders «Доступно N бонусів» and «Бонуси не застосовуються автоматично». When it is null the card renders no bonus row. The bonus is never included in, subtracted from, or compared against any total.

### D14-07 — Product card

Heading `h3` carrying `item.name`. Required content:

| Field | Rendering |
|---|---|
| Image | `imageUrl` non-null renders `<img alt={item.name}>` inside a fixed-ratio container; null renders a neutral placeholder marked `aria-hidden="true"` |
| Quantity | «Кількість: N» from `item.quantity` |
| Price, no discount | «X ₴» from `price` |
| Price, discounted | «X ₴» from `specialPrice`, plus «Було Y ₴» in a `<s>` element |
| Promotions | Each `promotion.label` as text; a promotion with a price also renders it |
| Stock, `stock === 0` | «Немає в наявності» |
| Stock, `stock < quantity` | «Залишилось N» |
| Stock, otherwise | «В наявності» |
| Confidence | «Висока впевненість» or «Середня впевненість», text, never colour alone |
| Reason | `item.reason` as text |
| Nutrition `insufficient` | «Даних про склад недостатньо» |
| Nutrition `known` | No nutrition claim in this task; comparison is Task 15's |
| Alternatives | «Доступні заміни: N» when the list is non-empty; the picker itself is Task 15's |
| Validations | Rows from `cart.validations` whose `productId` matches, prefixed «Помилка» or «Увага» |

The card renders no stepper, no remove control, and no replace control. Task 14 is read-only, and a control that does nothing is worse than an absent one.

The `<img>` element carries a single-line `@next/next/no-img-element` suppression with a comment recording why: product images are third-party CDN URLs whose host is unknown until Task 11, so `images.remotePatterns` cannot be configured honestly yet, and `next.config.ts` is not this task's file. Task 11 or Task 18 may migrate to `next/image`.

### D14-08 — Section order and grid

`draft-dashboard.tsx` renders, in this fixed order: header, demo banner when applicable, status panel when the state calls for one, hero, forecast card, value card, the «Ймовірно закінчується» section, and the sticky summary. The order matches design-system §6 and is asserted by test, not by convention.

The product section renders an `h2` and a list of `DraftProductCard` elements, one per `draft.items` entry, in the order the draft supplies. The dashboard does not sort, filter, cap, or deduplicate; `DraftSchema` already guarantees at most ten unique items.

When `phase.kind === "pending"`, no hero, no cards, no product section, and no summary render.

### D14-09 — Summary and confirm gating

The sticky summary renders when `phase.kind === "draft"`. It shows the item count as «N позиція/позиції/позицій», pluralized by the same helper as D14-04, and «Разом X ₴» from `draft.total`, which is a server snapshot; the component never recomputes the total it displays.

The CTA «Додати у кошик “Сільпо”» renders as `<button type="button">` only when `draft.status === "ready"`. It is disabled, with `aria-disabled="true"` and a visible reason, when any item has `stock === 0` or `quantity > stock`; the reason line reads «Спочатку розберіться з позиціями, яких немає в наявності». An empty draft renders no CTA at all and the line «Немає що додавати», because a disabled control offering nothing is worse than its absence. The button carries no click handler in this task.

For every other status the CTA is absent and the summary shows the status line from D14-11 instead. Nothing in the summary implies a write has occurred.

### D14-10 — Checkout gating

Checkout links render only when all of the following hold: `draft.status === "verified"`, `cart !== null`, `cart.checkoutLinks !== null`, and no entry in `cart.validations` has `severity === "error"`. They render as anchors, not buttons: «Оформити на сайті» to `checkoutLinks.web` and «Оформити в застосунку» to `checkoutLinks.mobile`.

If any condition fails, both links are absent from the document — not hidden by CSS, not disabled. `VerifiedCartSchema` already forbids links on an unverified cart; this rule is the second, independent gate, and the test asserts absence for every non-verified status.

### D14-11 — States and validations

`StatusPanel` takes `{ title, description, tone, headingLevel }` where tone is `"progress" | "attention" | "success"` and `headingLevel` is `1` or `2`. The dashboard passes `1` while pending, when the panel title is the page's only heading of that rank, and `2` once a draft supplies the `h1`. This keeps D14-13's single-`h1` rule true in every state without the panel guessing its context. Progress and success panels use `role="status"` with `aria-live="polite"`; attention panels use `role="alert"`. Titles and descriptions are supplied by the dashboard, so later tasks can render `needs_slot`, reauthorization, and rate-limit states through the same component without a new one.

| State | Title | Tone | Extra |
|---|---|---|---|
| pending `syncing` | «Синхронізуємо історію покупок» | progress | No draft content |
| pending `generating` | «Готуємо чернетку» | progress | No draft content |
| `ready` | No panel | — | Editable-looking content, disabled CTA rules from D14-09 |
| `confirming` | «Перевіряємо ціну та наявність» | progress | No CTA, no checkout |
| `partially_committed` | «Частину товарів потрібно перевірити» | attention | `ValidationList`, no checkout while an error exists |
| `verified` | «Кошик оновлено» | success | `ValidationList` when warnings exist, checkout per D14-10 |
| `blocked` | «Кошик потребує уваги» | attention | `ValidationList`, never checkout |

The blocked title is fixed by Task 18, whose end-to-end test asserts `/потребує уваги/` after a blocked commit.

`ValidationList` renders only cart-level validations — those whose `productId` is null — with the severity word «Помилка» or «Увага» and the message. Validations naming a product belong to that product's card under D14-07, so no validation renders twice. A warning never renders as success, and an error never renders beside a checkout link.

### D14-12 — Demo labelling

When mode is `demo`, the banner renders the exact string «Демонстраційні дані» once per page, above the main content, in every state including `blocked` and `verified`. It has no dismiss control and no error styling.

When mode is `live`, that string appears nowhere in the document. Live mode renders no demo affordance under any status, matching the invariant that live never silently degrades.

### D14-13 — Accessibility

- Exactly one `h1` (the hero, or the pending status title when no draft exists); sections use `h2`; product names use `h3`.
- The wordmark is not a heading.
- Landmarks: `header`, `main`, and the summary in a labelled `section`.
- Interactive elements are `button` for actions and `a` for checkout navigation.
- Product images use the product name as `alt`; placeholder and decorative shapes are `aria-hidden="true"` with empty `alt`.
- Focus is visible through `--autopilot-focus` on `:focus-visible`, never removed.
- Interactive targets are at least 44×44 px.
- Status changes are announced through the live regions in D14-11 without moving focus.
- Disabled controls explain themselves in text associated by `aria-describedby`.

### D14-14 — Responsive behavior

No horizontal overflow at 390 px or 1440 px. The sticky summary spans the viewport bottom on mobile without covering the last card, which the page guarantees with bottom padding at least the summary's height. Product columns follow design-system §6: one below 600 px, two to 899 px, three to 1199 px, four from 1200 px while cards stay at least 260 px wide.

Section 8 records how this is verified and what that verification cannot yet cover.

## 7. Styling requirements

### D14-01S — Tokens

`src/app/globals.css` declares, once, on `:root`: the thirteen colour tokens from design-system §3, the spacing scale, the four radii plus `--autopilot-radius-pill`, `--shadow-raised`, and the font stack. Component classes reference tokens only.

The responsive type scale from design-system §4 is expressed as tokens with a media-query override at 600 px, so components name a role rather than a pixel size. Prices use `font-variant-numeric: tabular-nums`.

### D14-02S — Component classes

Every class is prefixed `autopilot-`. Components carry no inline `style`, no colour literal, and no Tailwind utility class.

The `@import "tailwindcss"` line stays for its reset; removing it would require postcss and package changes this task does not own. Because that leaves an unused dependency reachable by future agents, section 9 records a follow-up.

Grid breakpoints are explicit media queries at 600, 900, and 1200 px rather than `auto-fill`, because design-system §6 fixes the column counts.

`@media (prefers-reduced-motion: reduce)` removes non-essential transitions. Transitions elsewhere stay within design-system §11 durations.

### D14-03S — Mechanical enforcement

A test asserts that no file under `src/components/autopilot/` contains a hex colour literal, an `rgb(`/`hsl(` call, or a `style={{` attribute. Prose cannot keep brand colour out of components; this test can.

## 8. Acceptance and verification map

Each ID is an acceptance obligation. The plan maps it to a red-green step and an exact file. Test titles include the IDs.

| Requirement | Observable evidence |
|---|---|
| A7-01 | Discounted item validates; `specialPrice > price` rejects; duplicate promotion IDs reject; totals computed on the effective price pass and regular-price totals fail; pre-existing drafts stay valid. |
| A7-02 | Both repositories round-trip the four fields; a row missing `display_ratio` fails parsing rather than defaulting; migration `0002` backfills existing rows. |
| D14-01 | Props type rejects a verified phase without a draft at compile time; no component declares `"use client"` or accepts a function prop. |
| D14-02 | Page renders the syncing shell, reads mode at request time, and exposes no items, total, CTA, or checkout. |
| D14-03 | Each header row matches its input; a null cart context and a null cart render their own copy; no `branchId`, address, or identifier appears; demo label differs from the banner string. |
| D14-04 | Singular, few, and many item counts pluralize correctly; empty draft renders its own headline and no total; exactly one `h1`. |
| D14-05 | Need count, history window from `PREDICTION_CONFIG`, both confidence counts, and the formatted cutoff render. |
| D14-06 | Discount sum is correct across mixed items; zero renders its own copy; «економія» appears nowhere; bonus renders as available and changes no total; null bonus renders no row. |
| D14-07 | Every required field renders; discounted price shows both values; each stock branch renders its own text; missing nutrition renders its copy; no stepper, remove, or replace control exists. |
| D14-08 | Section order matches design-system §6; one card per item in draft order; pending phase renders no draft content. |
| D14-09 | CTA present only when ready; absent for an empty draft; disabled with a visible reason for zero-stock and over-stock drafts; total comes from `draft.total`. |
| D14-10 | Checkout absent for every status except verified; absent when links are null; absent when any error validation exists; present and correctly targeted otherwise. |
| D14-11 | Each state renders its title, tone, role, and heading level; blocked contains «потребує уваги»; cart-level validations render once in the list and product-level ones only on their card. |
| D14-12 | Banner renders exactly once in demo across all statuses; the string is absent in live. |
| D14-13 | One `h1`, heading order, landmarks, image alt behavior, and `aria-describedby` on disabled controls are asserted. |
| D14-14 | Verified as described below. |
| D14-01S–03S | Tokens exist once on `:root`; the enforcement test fails on an introduced hex literal. |

Task 7.1 gate: `pnpm vitest run src/features/shared/contracts.test.ts src/features/drafts/repository.test.ts src/db/schema.test.ts`, then `pnpm lint` and `pnpm typecheck`.

Task 14 gate: `pnpm vitest run src/components/autopilot/draft-dashboard.test.tsx`, then the full unit suite, `pnpm lint`, `pnpm typecheck`, and `pnpm build`. The build also proves the `/dashboard` route registers.

Responsive verification is manual in this task and its limits are stated rather than implied. jsdom has no layout engine, and `/dashboard` renders only the syncing state until Task 13, so a committed Playwright spec would have no product grid to measure. The implementer renders the dashboard to static HTML in the scratchpad with representative draft data, opens it at 390 px and 1440 px, confirms no horizontal overflow, no sticky overlap, and the column counts in D14-14, and attaches screenshots to the task report. The harness is not committed. A committed regression test over a populated dashboard belongs to Task 18's end-to-end suite; until it exists, D14-14 has evidence but no automated guard.

Review order remains implementer → spec reviewer → code-quality reviewer → implementer fixes → controller verification and integration. Commit only scoped files, and report commands, results, limitations, and exact hashes. Do not mark the backlog complete during planning.

## 9. Open items for the controller

These are recorded rather than silently resolved.

1. **Draft wiring has no owner.** Task 13 creates `POST /api/drafts` but its file list excludes `src/app/dashboard/page.tsx`, and no later task claims it. Someone must be authorized to replace D14-02's pending phase with real data.
2. **Tailwind is unused.** After this task the dependency remains installed and importable while the convention forbids its utilities. A small harness task should either remove it or record why it stays.
3. **Branch names are unavailable.** `CartContext` carries `branchId` but no human-readable name, so the header omits the branch that design-system §7 lists. Resolving it requires a catalog or context lookup owned by Task 10 or 11.
4. **Post-verification savings are not computable.** `VerifiedCart` carries `unitPrice` but no regular price, so no honest savings figure exists after a commit. Task 16 should decide whether the verified cart needs one.

## 10. Related documents

- [Product specification](../../product-spec.md)
- [Project architecture](../../project-architecture.md)
- [Design system](../../design-system.md)
- [Task backlog](../../tasks.md)
- [Task 8 specification](./2026-09-04-mcp-token-vault-design.md)
