# Task 15 Draft Editing and Persisted Approval Design

Status: approved design for implementation planning on 2026-09-09

## 1. Scope and authority

This specification refines [Task 15](../../tasks.md#task-15-draft-editing-and-persisted-approval). It defines the editable draft boundary and the explicit server-persisted approval that Task 16 must require before any cart write. [AGENTS.md](../../../AGENTS.md), the [product specification](../../product-spec.md), the [project architecture](../../project-architecture.md), and the [design system](../../design-system.md) retain precedence.

Task 15 owns:

- local quantity, removal, undo, replacement, and replacement-cancel interactions for a `ready` draft;
- total and item-count presentation derived from server-provided snapshots;
- a typed approval application service;
- `POST /api/drafts/:draftId/approve`;
- atomic persistence of the edited selection and one explicit approval;
- a stable UUID idempotency key for retries and the later cart commit;
- the UI transition from `ready` to `confirming` after approval.

Task 15 does not fetch or generate a draft, refresh catalog data, call Gemini, call the Silpo MCP, write a cart, verify a cart, or expose checkout links. Task 16 owns every cart-dependent operation after approval.

The approved scope expands the original task file list. The expansion is required to preserve `UI -> Route Handler -> Application Service -> Domain + Ports` and to make the edited-draft write and approval insert atomic. It adds an approval service, extends the existing draft repository, and lets the editor compose the existing product-card and summary components instead of duplicating their presentation.

## 2. Baseline and dependency evidence

Inspected baseline: `0ff115f` (`fix: resolve Task 13 review findings`). The working tree also contains user-owned changes to `.gitignore`, `AGENTS.md`, and `.claude/`; Task 15 must preserve them.

The required implementation is present:

- Task 7 supplies `DraftRepository`, optimistic draft versions, `draft_items.version`, `draft_items.user_decision`, and `draft_approvals`.
- Task 13 saves a new owned draft at `version: 1` and `status: "ready"` and hands versioned editing to Task 15.
- Task 14 supplies the read-only dashboard, product card, sticky summary, state presentation, and CSS tokens. Its implementation and review commits are ancestors of the baseline even though the Task 14 checklist in `docs/tasks.md` has not been marked complete.

Fresh prerequisite evidence on 2026-09-09:

```text
pnpm vitest run src/components/autopilot/draft-dashboard.test.tsx src/features/drafts/repository.test.ts
Test Files  2 passed (2)
Tests      59 passed (59)
```

No shared-contract change, schema migration, package change, MCP change, or external network access is required.

## 3. Governing design decisions

| Decision | Selected approach and consequence |
|---|---|
| Editing lifetime | Edits remain local until explicit confirmation. The MVP needs no chatty save-on-every-click endpoint or recoverable editing session. |
| Approval boundary | One application service validates the complete selection and asks the repository to persist the edited draft and approval atomically. Route-level `save()` followed by `approve()` is rejected because a failure between calls leaves ambiguous state. |
| Client authority | The browser submits only source/selected IDs, versions, and quantity intent. Product facts and totals are reconstructed from persisted snapshots. |
| Selection completeness | The request names every original item exactly once. Removal is explicit rather than inferred from omission, so every item version participates in conflict detection. |
| Replacement trust | A replacement must be present in that source item's persisted alternative allowlist. Arbitrary product IDs are rejected. |
| Removal persistence | Removed database rows remain as `userDecision: "removed"` tombstones for Task 17 metrics, but normal draft reads exclude them. |
| Versioning | Approval advances the draft and every decision row from version `N` to `N + 1`; stale draft or item versions cannot overwrite newer state. |
| Approved state | The persisted draft and client dashboard move to `confirming`. The editor locks; Task 16 consumes the key and owns the next transition. |
| Idempotency | The server generates a UUID. One draft has one approval; retries and concurrent duplicate submissions return its persisted key. |
| Nutrition | Task 15 does not invent a comparison. `DraftItem` retains only the original nutrition status, not its facts, so numeric original-versus-alternative comparison is unavailable. |
| No migration | Existing `draft_items.user_decision`, item/draft versions, and `draft_approvals` are sufficient. |

## 4. Public approval input

The route validates this feature-local schema before calling the service:

```ts
interface DraftApprovalInput {
  draftVersion: number;
  items: Array<{
    sourceProductId: string;
    itemVersion: number;
    selectedProductId: string | null;
    quantity: number | null;
  }>;
}
```

Structural rules:

- `draftVersion` and every `itemVersion` are positive integers.
- IDs are trimmed, non-empty strings when present.
- `sourceProductId` values are unique.
- removal is exactly `selectedProductId: null` plus `quantity: null`;
- an active selection is exactly a non-null `selectedProductId` plus a finite positive `quantity`;
- unknown keys are rejected;
- the array is bounded by the domain maximum of ten source items.

The route never accepts a user ID, mode, price, special price, stock, step, display ratio, name, image URL, promotion, nutrition value, reason, confidence, or total. These remain server-owned facts.

`DraftItem` deliberately has no public item-version field. Task 7 persists every source row at the same version as its containing draft, so the editor copies the serialized `draft.version` into every initial `itemVersion`. The repository still compares each submitted value against the corresponding stored row; keeping row versions aligned with the draft does not replace that per-row check.

The service applies semantic rules against the stored draft:

- the request covers every original source item exactly once and contains no extra source item;
- each submitted item version equals its persisted source-row version;
- `selectedProductId` is either the source product or one of that source item's alternatives;
- every active result is unique by selected product ID;
- at least one item remains active;
- quantity is finite, positive, no greater than the selected snapshot's stock, and aligned to its `step` within the same `1e-9` tolerance as `DraftItemSchema`;
- a replacement still has `available === true`, `stock > 0`, and `stock >= step` in the persisted snapshot. Task 16 later refreshes those facts before writing.

The successful response is exactly:

```ts
interface DraftApprovalResponse {
  idempotencyKey: string;
}
```

## 5. Application service

Create `src/features/drafts/approval-service.ts`. It owns selection validation and reconstruction without importing React, Next.js, a database client, an MCP client, or an AI provider.

Its public shape is:

```ts
interface ApproveDraftInput {
  draftId: string;
  userId: string;
  selection: DraftApprovalInput;
  correlationId: string;
}

interface ApproveDraftDeps {
  repository: DraftRepository;
  newIdempotencyKey?: () => string;
  now?: () => Date;
}

async function approveDraftSelection(
  input: ApproveDraftInput,
  deps: ApproveDraftDeps,
): Promise<Result<DraftApprovalResponse, DraftApprovalFailure>>;
```

`DraftApprovalFailure` is feature-local and discriminates `not_found`, `conflict`, `invalid_selection`, and `unexpected`. Messages are safe Ukrainian user copy and carry the supplied correlation ID. No exception string, database value, request body, session handle, or raw product object reaches the response.

The service sequence is:

1. Ask for an approval scoped by both `draftId` and `userId`. Return its key immediately when present.
2. Load the owned draft. A missing or differently owned draft produces the same `not_found` result.
3. Require `status: "ready"` and the submitted draft version.
4. Validate exact source-item coverage and item versions.
5. Resolve each active product from the source item or its persisted alternatives.
6. Validate selected-product uniqueness and quantities.
7. Reconstruct active `DraftItem` objects by explicit field mapping from stored facts.
8. Preserve the source need's confidence, confidence band, reason codes, and reason when replacing its SKU. Replace product identity, presentation, effective prices, stock, step, display ratio, nutrition status, and promotions from the selected persisted candidate. Keep only the source item's other persisted alternatives, excluding the newly selected product; do not synthesize the original product as a `ProductCandidate` because its draft snapshot does not contain the candidate-only slug and nutrition facts.
9. Produce one decision for every source row: `kept`, `replaced`, or `removed`.
10. Compute the active total as `quantity * (specialPrice ?? price)`, round to two decimal places, and parse the result through `DraftSchema` with `status: "confirming"` and `version: N + 1`.
11. Generate a UUID through the injected function and call the repository's atomic operation.
12. Map a repository conflict to the typed service result. If a concurrent winner already persisted approval, return that winner's key.

Selecting a replacement preserves the currently entered numeric quantity. If the new snapshot has a different step or lower stock, the editor and service reject that quantity until the user explicitly adjusts it; neither layer silently rounds or caps it.

## 6. Repository contract and atomicity

Extend `DraftRepository` without changing the database schema:

```ts
getApproval(draftId: string, userId: string): Promise<DraftApprovalRecord | null>;

approveSelection(input: PersistDraftApprovalInput): Promise<
  | { status: "approved"; idempotencyKey: string }
  | { status: "already_approved"; idempotencyKey: string }
  | { status: "not_found" }
  | { status: "conflict" }
>;
```

`PersistDraftApprovalInput` contains the user and draft IDs, expected draft version, a decision for every source row with its expected item version, the fully reconstructed next draft, the proposed UUID, and the timestamp. It never contains a browser-supplied product snapshot.

The PostgreSQL implementation uses one transaction:

1. Select and lock the owned draft row.
2. If no owned row exists, return `not_found` without revealing another owner's row.
3. Check `draft_approvals` inside the lock. If one exists for this owner and draft, return its stored key without modifying the draft.
4. Require the locked draft's version and `ready` status.
5. Load all source item rows and require exact source-ID coverage and expected item versions.
6. Update the draft's total, status, and version using the same expected-version condition.
7. Apply every item decision. A kept or replaced row receives the reconstructed active snapshot and new version. A removed row retains its product snapshot, receives `userDecision: "removed"`, and advances to the new version.
8. Insert the approval with the proposed UUID.
9. Commit and return `approved`.

Locking the draft serializes concurrent approval attempts. A waiter observes the committed approval and returns its key, so one click, a lost response retry, and simultaneous duplicate requests all converge on one approval.

The in-memory repository implements the same observable contract without a database. `DraftRepository.get()` excludes rows whose decision is `removed`; therefore an approved draft round-trips with exactly its active items and recomputed total. `getApproval()` becomes owner-scoped everywhere, including Task 16 consumers, so an idempotency key is never disclosed through a draft ID alone.

Repository validation is defence in depth. It does not repeat product-ranking logic, but it rejects mismatched next-draft identity/version, incomplete decisions, stale item versions, and a next draft whose active rows do not match the supplied decisions.

## 7. Route and identity

Create the dependency-injected handler factory in `src/app/api/drafts/[draftId]/approve/handlers.ts` for integration tests. Keep `route.ts` as a Next.js-valid entrypoint that exports only the Node.js/dynamic segment configuration and `POST` handler. The response is non-cacheable.

The handler:

1. creates a correlation ID;
2. validates the dynamic `draftId` and JSON body;
3. reads mode only from `getServerEnv()`;
4. in live mode, resolves the existing `silpo_session` and returns `401` when it is absent, expired, or revoked;
5. in demo mode, resolves the existing isolated `demo_session` identity through the same helper as draft generation and sets a newly issued HttpOnly cookie on the response when necessary;
6. constructs `createPostgresDraftRepository(getDbClient())` lazily;
7. calls `approveDraftSelection`;
8. maps the typed result to HTTP without implementing validation or persistence rules in the route.

Response headers always include `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

HTTP mapping:

| Status | Condition | Safe client action |
|---|---|---|
| `200` | New approval or an idempotent replay | Continue with the returned key. |
| `400` | Invalid path/body shape or unreadable JSON | Correct the request; no mutation occurred. |
| `401` | Live session cannot be resolved | Sign in to Silpo again. |
| `404` | Draft is absent or not owned | Generate or open an owned draft. |
| `409` | Draft/item version is stale or the draft is not `ready` | Refresh and review the current draft. |
| `422` | Selection is incomplete, empty, duplicated, misaligned, over stock, or outside the alternative allowlist | Correct the selection; no mutation occurred. |
| `500` | Unexpected environment, database, or wiring failure | Retry using the correlation ID for support. |

The route does not instantiate `SilpoGateway`, call a model, or call any cart method. Live mode never falls back to demo mode.

## 8. Client editor state

Create `src/components/autopilot/draft-editor.tsx` as a client component. It receives a `ready` draft and an approval callback. Its state is keyed by each original `sourceProductId` and retains:

- the original item and version;
- the currently selected product snapshot;
- the numeric cart quantity;
- `active` or `removed` decision state;
- closed or unresolved replacement-picker state;
- a local validation message when present.

The original item is a valid selectable product even though it does not appear in its own alternatives array. Alternatives are defensively filtered to persisted candidates with `available === true`, `stock > 0`, and `stock >= step`.

Quantity controls use the selected snapshot's cart-native `step` and `stock`. `displayRatio` remains server-provided package metadata and is displayed with the product/package information; it is not used as a price multiplier or as a substitute for `step`. The decrement and increment buttons change quantity by exactly `step` using decimal-safe normalization, while the numeric input permits typing so invalid intermediate values can receive inline feedback. Buttons disable at the minimum and stock cap. Every control has an accessible product-specific name.

Opening «Замінити» makes that row unresolved and disables confirmation. The inline picker exposes only the source item's filtered alternatives, with snapshot price, package ratio, promotion, and stock. Choosing one closes the unresolved state and changes the card, limits, and total. «Скасувати» restores the selection that was active before the picker opened.

«Прибрати» changes the card to a compact, visibly removed state and excludes it from count and total. The card remains in its original order and exposes «Повернути». Restoring it reinstates its last product and quantity selection rather than resetting edits.

Task 15 never renders a numeric nutrition comparison. If the source or selected product has `nutritionStatus: "insufficient"`, it renders the required insufficient-data copy. Known alternative facts may not be presented as a comparison because the draft does not retain the original facts needed for both sides.

## 9. Dashboard and submission behavior

`DraftDashboard` becomes the client coordinator for an actionable draft. For a `ready` draft it renders `DraftEditor`; later states continue to use the existing read-only presentation. The editor composes `DraftProductCard` and `DraftSummary` through narrow interaction props or slots, keeping one product-card and summary implementation.

The sticky summary derives its active item count and total from editor state and rounds currency to kopecks. It shows no confirm action when all items are removed. It disables confirmation and provides an accessible explanation when any picker is unresolved, any active quantity is invalid, or a request is in flight.

Confirmation sends one request containing the complete intent payload. The first submit synchronously locks all editing controls before awaiting `fetch`; subsequent clicks while pending do nothing. There is no optimistic approval or optimistic cart success.

On `200`, the editor calls the dashboard with both the returned key and its locally reconstructed approved draft. The dashboard sets that draft to `confirming`, preserves the key for Task 16's continuation, displays «Перевіряємо ціну та наявність», and leaves every editor control locked. It does not call the cart endpoint in Task 15.

On failure, retryable controls unlock and an assertive live region shows safe copy:

- stale state: «Чернетка змінилася. Оновіть сторінку й перевірте вибір ще раз.»;
- invalid selection: «Перевірте кількість або вибрану заміну.»;
- missing draft: «Чернетку не знайдено. Створіть нову.»;
- unexpected failure: «Не вдалося підтвердити чернетку. Спробуйте ще раз.»

An authorization failure uses the existing reconnect language and never offers demo fallback.

## 10. Presentation and accessibility

`src/app/globals.css` adds semantic `.autopilot-*` styles using only existing design tokens. No new brand color is hard-coded.

Required behavior:

- 44 by 44 pixel minimum targets for stepper, remove, undo, replace, picker, and confirm controls;
- visible focus rings through `--autopilot-focus`;
- product-specific accessible names for increment and decrement;
- `aria-describedby` from invalid quantity inputs and disabled confirmation to their explanations;
- an assertive live region for approval failures and a polite status region for `confirming`;
- no focus stealing after removal, undo, replacement, or async completion;
- keyboard-operable picker choices and actions;
- text labels in addition to color for removed, invalid, unresolved, pending, and error states;
- reduced-motion behavior inherited from the dashboard rules;
- no horizontal overflow or sticky-summary overlap at 390 px and 1440 px.

## 11. Failure and consistency guarantees

- Structural validation happens before identity-dependent persistence work.
- Ownership is checked at both service lookup and the locked repository mutation.
- A stale request performs no partial item update and inserts no approval.
- A repository or approval-insert failure rolls back item and draft updates.
- A response lost after commit is safe to retry and returns the stored key.
- An existing approval wins over a newly proposed key and cannot be replaced.
- The approved selection cannot contain a product not already supplied by the server for that source need.
- Client arithmetic is presentation only; the service recomputes and validates the authoritative persisted total.
- The approval creates authorization for Task 16 to begin validation. It is not itself a cart write authorization bypass: Task 16 must still require the matching owned approval and run every pre-write check.

## 12. File ownership

Create:

- `src/features/drafts/approval-service.ts`
- `src/features/drafts/approval-service.test.ts`
- `src/components/autopilot/draft-editor.tsx`
- `src/components/autopilot/draft-editor.test.tsx`
- `src/app/api/drafts/[draftId]/approve/handlers.ts`
- `src/app/api/drafts/[draftId]/approve/route.ts`
- `tests/integration/draft-approval.test.ts`

Modify:

- `src/features/drafts/repository.ts`
- `src/features/drafts/repository.test.ts`
- `src/components/autopilot/draft-dashboard.tsx`
- `src/components/autopilot/draft-dashboard.test.tsx`
- `src/components/autopilot/draft-product-card.tsx`
- `src/components/autopilot/draft-summary.tsx`
- `src/app/globals.css`
- `docs/project-architecture.md`
- `docs/tasks.md`

The implementation must not modify `src/features/shared/contracts.ts`, `src/db/schema.ts`, migrations, package manifests, lockfiles, `SILPO_MCP.md`, or cart-write modules.

## 13. Test strategy and acceptance matrix

Implementation follows red-green-refactor. Tests assert public behavior, not private DOM structure or exact SQL call order beyond the atomicity boundary.

| ID | Observable evidence |
|---|---|
| T15-01 | Increment and decrement use the selected snapshot's exact step, including fractional steps; the control cannot decrement below one step or increment past stock. |
| T15-02 | Typed zero, non-finite, misaligned, and over-stock quantities show an associated error and disable confirmation. |
| T15-03 | Remove changes a card to a compact state, count and total exclude it, and undo restores its prior selection and quantity in the original order. |
| T15-04 | Opening replacement disables confirmation; cancel restores the prior selection; choosing an available allowlisted alternative updates presentation, limits, and total. |
| T15-05 | An alternative with insufficient nutrition data never produces a comparison, and no comparison is invented when original facts are unavailable. |
| T15-06 | Total and request data use effective prices from persisted item/alternative snapshots; the browser sends no price, stock, promotion, nutrition, reason, confidence, mode, user ID, or total. |
| T15-07 | Empty selection has no confirm action; invalid or unresolved selection exposes the reason confirmation is unavailable. |
| T15-08 | A deferred request proves that rapid repeated activation sends one POST, locks controls, and produces no optimistic success. |
| T15-09 | A successful POST returns one UUID key, calls the approval callback once, and moves the dashboard to `confirming` without calling a cart API. |
| T15-10 | Service tests reject non-owned, non-ready, stale, incomplete, extra, duplicated, invalid-quantity, and non-allowlisted selections with the documented typed result. |
| T15-11 | Service reconstruction maps replacement snapshots explicitly, preserves need explanation/confidence, recalculates total, and proposes version `N + 1`. |
| T15-12 | Both repository implementations atomically persist active edits, removed tombstones, versions, status, and one approval; normal reads exclude removed rows. |
| T15-13 | A transaction failure leaves the original ready draft and no approval. Concurrent or repeated approvals converge on the first stored key. |
| T15-14 | Integration tests prove live/demo identity resolution, owner isolation, safe 400/401/404/409/422/500 mapping, non-cache headers, and absence of MCP/cart calls. |
| T15-15 | Existing dashboard state, checkout gating, validation rendering, demo banner, and responsive semantics remain green. |

Focused verification:

```bash
pnpm vitest run \
  src/features/drafts/approval-service.test.ts \
  src/features/drafts/repository.test.ts \
  src/components/autopilot/draft-editor.test.tsx \
  src/components/autopilot/draft-dashboard.test.tsx \
  tests/integration/draft-approval.test.ts
```

Completion gates:

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

The UI is also inspected at 390 px and 1440 px for overflow, focus visibility, target size, and sticky-summary overlap. Task 18 remains the owner of full Playwright end-to-end coverage.

## 14. Documentation and handoff

The implementation commit updates `docs/project-architecture.md` with the `DraftApprovalService` and refined repository ownership boundary. It updates the Task 15 checklist and records focused verification in `docs/tasks.md`. No product or design rule changes; this design implements the current normative behavior.

Task 16 receives:

- an owned persisted approval keyed by UUID;
- a `confirming` draft containing only active approved items from normal repository reads;
- quantity, product identity, and effective price snapshots persisted at one version;
- removed/replaced/kept decisions retained for later diagnostics;
- a guarantee that no cart write has occurred.

The Task 15 implementation ends in one focused commit:

```text
feat: edit and approve draft baskets
```

## 15. Definition of done

Task 15 is complete when all T15 acceptance rows pass, the approval transaction is atomic in both repository implementations, no browser-supplied product fact enters persistence, version and ownership conflicts are enforced, duplicate submits return one key, the dashboard reaches `confirming` without a cart call, accessibility and responsive checks pass, cumulative static/build/test gates are green, normative docs match the behavior, and the implementation diff contains no unrelated user-owned changes.
