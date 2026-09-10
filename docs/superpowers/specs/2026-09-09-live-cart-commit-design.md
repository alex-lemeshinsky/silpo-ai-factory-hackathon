# Task 16 Idempotent Live Cart Commit and Verification Design

Status: approved design, implemented and revised after code review on 2026-09-10

## 1. Scope and authority

This specification refines [Task 16](../../tasks.md#task-16-idempotent-live-cart-commit-and-verification). It defines the only path from a persisted approval to a real Silpo cart write, and the verification that decides whether checkout becomes visible. [AGENTS.md](../../../AGENTS.md), the [product specification](../../product-spec.md), the [project architecture](../../project-architecture.md), and [SILPO_MCP.md](../../../SILPO_MCP.md) retain precedence.

Task 16 owns:

- the live cart gateway that maps `silpo_get_shopping_cart_by_id` and `silpo_add_or_update_cart_products`;
- the pure commit arithmetic that turns an approved draft plus a current cart into absolute target quantities;
- the pure reconciliation that turns a post-write readback into a `verified`, `partially_committed`, or `blocked` result;
- the commit application service and its idempotent retry protocol;
- `POST /api/cart/commit`;
- the narrow persistence of the terminal draft status.

Task 16 does not own any user interface, checkout redirect, loyalty-bonus application, order placement, coupon handling, or draft regeneration. It does not add a cart-write live smoke run: per AGENTS.md a write smoke requires fresh manual confirmation for that run and is therefore outside an unattended task.

The approved scope expands the original task file list. Every expansion is named and justified in section 12; none of them is discretionary polish.

## 2. Baseline and dependency evidence

Inspected baseline: `ec7310b` (`chore: add local development configuration`). The working tree is clean.

The required implementation is present:

- Task 2 supplies `SetCartProductsInput`, `CartValidation`, `VerifiedCartItem`, `CheckoutLinks`, and `VerifiedCart`, including the refinement that forbids checkout links unless the cart is `verified` with no error validation.
- Task 7 supplies `cart_commits` with a unique idempotency key, `CartCommitRepository.start` / `get` / `saveResult`, and both Postgres and in-memory implementations.
- Task 10 supplies `openWriteSession`, the read/write session split, the bounded read-only retry policy, and `createLiveCartContextGateway` as the mapping precedent this task follows.
- Task 11 supplies `findProducts` over `silpo_find_products_batch`.
- Task 15 supplies `draft_approvals`, `DraftRepository.getApproval`, and the `confirming` draft that this task consumes.

Fresh prerequisite evidence on 2026-09-09:

```text
pnpm vitest run src/features/cart/repository.test.ts src/features/drafts/approval-service.test.ts
Test Files  2 passed (2)
Tests      37 passed (37)
```

No database migration, package change, or shared-contract change is required. No network access is required: every test in this task is fixture- or fake-driven.

## 3. Known gap this task deliberately does not close

`src/app/dashboard/page.tsx` still renders a static `syncing` shell. No task in the backlog fetches a draft into the browser or triggers a commit from it, yet Task 18's end-to-end specimen expects a click on «Додати у кошик» to reveal «Оформити на сайті».

Task 16 stays backend-only, as its file list declares. Wiring a commit button into a dashboard that never receives a draft would produce a path no test could exercise. The missing client story — draft fetch, commit trigger, and terminal-state rendering — belongs to a separate task that must land before Task 18. This section is the durable record of that gap; the handoff repeats it.

One product rule is unreachable because of the same gap. The product specification requires a changed price or stock to be shown *before* the write. With no interface in scope, the commit reports both as warning validations in its result, which is after the write. The rule is satisfied only once the client story lands, and the follow-up task inherits it.

## 4. Governing design decisions

| Decision | Selected approach and consequence |
|---|---|
| Write authority | A cart write happens only after the service has read a persisted approval whose idempotency key equals the submitted key. No other precondition substitutes for it. |
| Target arithmetic | The absolute target for a product is its current cart quantity plus the approved quantity, computed exactly once and persisted before the write. |
| Retry safety | A retry reuses the persisted targets verbatim and never recomputes them from a cart that the first attempt may already have changed. With `addQuantity=false`, repeating the same absolute quantities is a no-op. |
| Refresh on retry | The catalog refresh runs on every attempt but is privileged only on the first, where it feeds the target computation. On a retry it contributes only the validations that do not depend on the cart's current quantity — availability and price. A re-derived cap or step alignment is discarded, because the retry is not recomputing the target it writes and would otherwise invent a warning that was never true of it. |
| Product refresh key | `DraftItem` carries no slug, and every other catalog port is slug-keyed. The refresh is one `findProducts` batch over item names, matched strictly by `productId` across every returned product. The match never joins on `ProductSearchResult.query`, which is the term the server echoes back: joining on that text would make the whole commit depend on Silpo not normalizing it. A name that returns no matching `productId` is unresolvable, never a fuzzy match. |
| Outcome authority | The service derives the terminal status from persisted targets, pre-write adjustments, and readback validations. It never re-emits the gateway's own status verbatim, so live and demo produce identical outcomes from identical facts. |
| Pure arithmetic | Target planning and outcome reconciliation are pure functions in their own modules, unit-tested without gateway fakes. |
| Severity mapping | Silpo severities map `warning` to warning and everything else, including unknown or missing values, to error. An unrecognized severity never silently becomes non-blocking. |
| Adjustment taxonomy | Stock cap, step alignment, price drift, and line exclusion are warnings that never block the write; only error validations block. Of these, only the three that changed a quantity keep a commit out of `verified`. A price change is reported and does not hide checkout: the approval was for a product and a quantity, the readback carries the real total, and a price that merely fell must not strand a correct cart. |
| Service rows | Targets contain only approved product IDs. A bag, delivery fee, or acceleration row already in the cart is never written and never has its quantity modified; it remains visible in the readback. |
| Never write downwards | A target is never below the product's current cart quantity. When capping or flooring lands at or below it there is nothing to add, so the line is dropped from the targets and the existing quantity is left untouched. The approval authorizes adding, never removing, and a stock drop must not delete units the user put in the cart themselves. |
| Slot | A valid slot is mandatory before every write attempt, including retries. `needs_slot` returns available slots and writes nothing. |
| Error channel | The service returns `Result<VerifiedCart, CartCommitFailure>` rather than throwing, matching the approval service and the OAuth service. |
| Draft terminal state | A narrow repository method updates only `drafts.status`. It does not bump the version and does not touch `draft_items`, so Task 15's removal tombstones survive. |
| No migration | `cart_commits.target_quantities` and `cart_commits.result` already carry everything the protocol persists. |

### 4.1 Deviation from the task's specimen test

`docs/tasks.md` sketches the first safety test as `rejects.toThrow("approval required")`. This specification realizes that behavior as `ok: false` with code `approval_required`. The safety assertion the specimen exists to make — `setAbsoluteCartQuantities` was not called — is preserved verbatim.

The change is an error-channel convention, not a weakened requirement. Every established application service in this repository returns a typed `Result` with a correlation ID and safe user copy; throwing here would create a second way to report the same class of failure and would strip the correlation ID that the error policy requires.

## 5. Commit protocol

Ordered, and identical in live and demo mode:

1. Resolve identity and load the owned draft. An unknown or unowned draft yields `not_found`.
2. Load the approval for that draft and user. A missing approval, or one whose persisted key differs from the submitted key, yields `approval_required`.
3. Load the commit record for the key. A record whose status is `verified`, `partially_committed`, or `blocked` is terminal: parse its stored result through `VerifiedCartSchema` and return it without any cart call.
4. Open the gateway handle for the resolved mode.
5. Load the cart context. A `needs_slot` result returns the available slots and writes nothing.
6. Read the cart to obtain current line quantities.
7. Refresh the approved products with one `findProducts` batch against the context loaded in step 5.
8. On the first attempt only, compute the plan and persist key, absolute targets, and `pending` before any write. On a retry, take the targets from the persisted record.
9. Write once with `addQuantity=false`. A cart write is never retried automatically.
10. Read the cart back immediately.
11. Reconcile, persist the terminal result, record the terminal draft status, and return.

The approved selection is the stored draft's active items. The service applies no draft-status gate beyond ownership: the approval record is the authorization, it exists only for a draft that Task 15 moved to `confirming`, and a second commit after a terminal status is already guarded by step 3.

A failure between steps 8 and 10 leaves the record `pending` and returns `commit_uncertain`. The client retries with the same key, which re-enters at step 4 and reuses the persisted targets.

The gateway handle is closed in a `finally` block on every path, matching the draft service.

## 6. Pure commit arithmetic

`src/features/cart/plan.ts`:

```ts
export interface CommitAdjustment {
  productId: string;
  code: "unavailable_product" | "stock_capped" | "step_adjusted" | "price_changed";
  message: string;
}

export interface PlanCommitInput {
  approvedItems: DraftItem[];
  currentQuantities: Record<string, number>;
  refreshed: Record<string, ProductCandidate>;
}

export interface CommitPlan {
  targets: Record<string, number>;
  adjustments: CommitAdjustment[];
}

export function planCommit(input: PlanCommitInput): CommitPlan;
```

Per approved item, in order:

- an item absent from `refreshed`, unavailable, or with `stock < step` is excluded and reported as `unavailable_product`;
- the desired quantity is `currentQuantities[productId] ?? 0` plus the approved quantity;
- a desired quantity above the refreshed stock is capped and reported as `stock_capped`;
- a quantity that is not a whole multiple of the refreshed step is floored to the nearest multiple and reported as `step_adjusted`;
- a quantity that falls below one step after capping or flooring becomes an exclusion, reported as `unavailable_product`;
- a quantity that lands at or below the product's current cart quantity is dropped from the targets, keeping the adjustments that explain why, because nothing can be added and the existing line must survive untouched;
- a refreshed `price` or `specialPrice` that differs from the draft snapshot by more than `0.01` is reported as `price_changed` and does not change the target.

Step comparison uses the same `1e-9` relative tolerance as the shared contracts, so floating-point representation never manufactures a `step_adjusted` warning.

An approved draft whose every line is excluded produces an empty target map. No commit record is persisted in that case, because `cart_commits.target_quantities` rejects an empty map by schema; the service reconciles the pre-write readback into a `blocked` result, records the terminal draft status, and returns without a write. A retry with the same key repeats that work and reaches the same conclusion, which is safe precisely because nothing was ever written.

`src/features/cart/reconcile.ts`:

```ts
export interface ReconcileCommitInput {
  targets: Record<string, number>;
  adjustments: CommitAdjustment[];
  readback: VerifiedCart;
}

export function reconcileCommit(input: ReconcileCommitInput): VerifiedCart;
```

Rules, evaluated in order:

- validations are the readback's validations plus one warning per adjustment, each carrying its `productId`;
- an empty target map yields `blocked` with `checkoutLinks: null`, because nothing from this draft can reach a checkout;
- any error validation yields `blocked` with `checkoutLinks: null`;
- otherwise any adjustment that changed a quantity (`unavailable_product`, `stock_capped`, `step_adjusted`), any target whose product is missing from the readback, and any target whose readback quantity is below the target yields `partially_committed` with `checkoutLinks: null`. A `price_changed` warning alone does not;
- otherwise the result is `verified` and the readback's checkout links are returned unchanged.

The reconciler never recomputes the cart total. The readback's total is the server's own arithmetic and is reported as received.

## 7. Application service

`src/features/cart/commit-service.ts`:

```ts
export interface CommitApprovedDraftInput {
  draftId: string;
  userId: string;
  idempotencyKey: string;
  correlationId: string;
}

export type CartCommitFailureCode =
  | "not_found"
  | "approval_required"
  | "needs_slot"
  | "unauthorized"
  | "commit_uncertain"
  | "unexpected";

export interface CartCommitFailure {
  code: CartCommitFailureCode;
  message: string;
  correlationId: string;
  availableSlots?: TimeSlot[];
}

export interface CommitApprovedDraftDeps {
  drafts: DraftRepository;
  commits: CartCommitRepository;
  openGateway: () => Promise<SilpoGatewayHandle>;
  now?: () => Date;
}

export function commitApprovedDraft(
  input: CommitApprovedDraftInput,
  deps: CommitApprovedDraftDeps,
): Promise<Result<VerifiedCart, CartCommitFailure>>;
```

A gateway failure is classified before it is reported. An expired token becomes `unauthorized`, never `commit_uncertain`: the server rejected the call, so nothing was written, and inviting a retry would loop forever on credentials that only reauthorization can renew. A cart that carries no branch becomes `unexpected` for the same reason — every retry would re-read the same cart.

`availableSlots` is present only on `needs_slot`. Every failure carries safe Ukrainian copy and the correlation ID; no failure carries a URL, header, token, tool argument, or stack trace.

The service never constructs a `SilpoGateway` itself. `openGateway` is the seam the tests replace and the route binds to `createSilpoGateway`.

## 8. Live cart gateway

`src/features/silpo/live/cart.ts` exposes exactly the two ports the shared gateway still leaves unimplemented:

```ts
export interface LiveCartGateway {
  setAbsoluteCartQuantities(input: SetCartProductsInput): Promise<void>;
  readCart(cartId: string): Promise<VerifiedCart>;
}
```

`setAbsoluteCartQuantities` validates its input, reads the cart through the read session to obtain `branchId`, and raises `MissingCartBranchError` before writing anything when that branch is absent, since the tool documents it as required. It then calls `silpo_add_or_update_cart_products` through the write session with `cartId`, `branchId`, the product targets, and `addQuantity: false`. `companyId` is omitted because the server supplies `SILPO_DEFAULT_COMPANY_ID`. The read is required because `SetCartProductsInput` carries no branch and the tool does; it is a read-only call and therefore retryable, while the write itself has no retry path at all.

The write response is validated with `AcknowledgedWriteSchema`. Proof of effect is the readback, not the acknowledgement body.

`readCart` calls `silpo_get_shopping_cart_by_id` through the read session and maps:

- each cart line to `{ productId, quantity, unitPrice, available }`, where `unitPrice` is the effective per-unit price the cart reports: its special price when one is present, otherwise its price;
- the cart total as received;
- each validation with the severity mapping from section 4;
- checkout links only when no error validation is present and both URLs parse as HTTPS; otherwise `null`. An empty URL string is normalized to `null` rather than failing the parse, because this readback runs after the write and a rejection there would hide a commit that actually succeeded.

Because `VerifiedCartSchema` forbids checkout links on a non-`verified` cart, the gateway reports `blocked` when an error validation is present and `verified` otherwise. It has no knowledge of targets, so it can never report `partially_committed`; only the reconciler can.

`src/features/silpo/schemas/cart.ts` gains a cart-line schema and a checkout schema, and `ShoppingCartSchema` gains `products` and `checkout`, both defaulted so an absent field is not an outage. The file's existing doctrine holds: these schemas are deliberately not `.strict()`, and the field names follow SILPO_MCP.md and must be reconciled against a live `tools/list` once credentials exist.

`src/features/silpo/gateway.ts` binds both methods to the live cart gateway and deletes `NotImplementedForDraftRunError`, whose only purpose was to keep a draft run away from an unimplemented write.

## 9. Repository contract

`DraftRepository` gains one method:

```ts
recordCommitOutcome(input: {
  draftId: string;
  userId: string;
  status: "verified" | "partially_committed" | "blocked";
}): Promise<"updated" | "not_found" | "conflict">;
```

It updates `drafts.status` and `updated_at` for the owning user only. It does not change `version`, does not touch `draft_items`, and does not write `prediction_runs`. A draft that is not in `confirming` or already in a terminal commit status returns `conflict`; an unknown or unowned draft returns `not_found`.

Recording the outcome is the last step of a successful commit and never changes the value the service returns. A `conflict` or `not_found` here is logged and swallowed: the cart has already been written and verified, and failing the response would tell the user the opposite of what happened.

`CartCommitRepository` is unchanged. `start` is already idempotent by key and returns the existing record when one is present, which is exactly the retry semantics the protocol needs.

## 10. Route and identity

`POST /api/cart/commit` accepts:

```ts
{ draftId: string /* uuid */, idempotencyKey: string /* uuid */ }
```

Unknown keys are rejected. The route never accepts a user ID, cart ID, product ID, quantity, price, or mode; every one of those is server-owned.

Identity resolution matches the approve route exactly: in demo mode the demo cookie identity, otherwise the `silpo_session` handle, with the demo cookie re-issued on the response when it was minted during the request.

| Outcome | Status | Body |
|---|---|---|
| success | 200 | `VerifiedCart` |
| malformed body or ID | 400 | `invalid_request` |
| unresolved live session | 401 | `unauthorized` |
| unknown or unowned draft | 404 | `not_found` |
| missing or mismatched approval | 409 | `approval_required` |
| no valid slot | 409 | `needs_slot` with `availableSlots` |
| expired credentials | 401 | `unauthorized` |
| uncertain write result | 502 | `commit_uncertain` |
| anything else | 500 | `unexpected` |

`502` is reserved for the one case where the client should retry with the same key. Every response carries `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

`route.ts` stays a three-line binding; `handlers.ts` exports the factory with overridable dependencies so the integration test can inject fakes without a network, a database, or an MCP server.

## 11. Failure and consistency guarantees

- No cart write occurs without a persisted approval whose key matches the request.
- No cart write occurs without a validated slot, on first attempt or retry.
- A cart write is never retried automatically; only a fresh client request with the same key retries it.
- A retry writes the same absolute quantities as the first attempt, so a product can never be added twice.
- A terminal commit record is never rewritten; its stored result is replayed.
- An excluded, capped, or step-adjusted line can never yield `verified`.
- Checkout links are returned only for a `verified` cart with no error validation, enforced both by the reconciler and by `VerifiedCartSchema`.
- A row the user never approved is never written, and its quantity is never modified.
- Live mode never falls back to demo mode; a live failure surfaces as a typed failure.
- Every gateway handle is closed on success and on failure.

## 12. File ownership

Declared in the task:

- Create `src/features/silpo/live/cart.ts`
- Create `src/features/cart/commit-service.ts`
- Create `src/app/api/cart/commit/route.ts`
- Test `src/features/cart/commit-service.test.ts`
- Test `tests/integration/cart-commit-route.test.ts`

Approved expansions:

| File | Why the declared list is insufficient |
|---|---|
| Create `src/app/api/cart/commit/handlers.ts` | The declared integration test cannot inject fakes into a bare route export. This is the established pattern from the approve route. |
| Create `src/features/cart/plan.ts` + test | Target arithmetic is pure and branchy. Testing it only through gateway fakes would leave capping, step flooring, and exclusion undertested. |
| Create `src/features/cart/reconcile.ts` + test | Outcome derivation is the rule that gates checkout. It is pure and belongs outside the I/O path, and it is what makes live and demo parity mechanical. |
| Modify `src/features/silpo/schemas/cart.ts` | `ShoppingCartSchema` has no cart lines and no checkout links today, so steps 10 and 11 of the protocol cannot be built against it. |
| Modify `src/features/silpo/gateway.ts` | `setAbsoluteCartQuantities` and `readCart` currently throw `NotImplementedForDraftRunError`. Task 16 is the task that removes it. |
| Modify `src/features/drafts/repository.ts` + test | The terminal draft status needs a narrow update that preserves versions and removal tombstones. |
| Create `src/features/silpo/live/cart.test.ts` | The write arguments, the `addQuantity=false` literal, the absence of write retry, and the severity mapping are safety behavior and need direct tests. |
| Create `tests/contract/silpo-cart-write.test.ts` | Fixture-driven external mapping, matching the Task 10 and Task 11 contract-test pattern. |
| Modify `docs/project-architecture.md` | Section 7.5 gains the retry-refresh rule, the warning taxonomy, the severity mapping, and the branch read; section 9 gains `commit_uncertain`. |
| Modify `docs/tasks.md` | File list, checkboxes, and the completion note. |

## 13. Test strategy and acceptance matrix

| Behavior | Test |
|---|---|
| No approval yields `approval_required` and no write | `commit-service.test.ts` |
| Key mismatch yields `approval_required` and no write | `commit-service.test.ts` |
| Unknown or unowned draft yields `not_found` and no write | `commit-service.test.ts` |
| `needs_slot` returns slots and writes nothing, on first attempt and retry | `commit-service.test.ts` |
| Absolute target equals current quantity plus approved quantity | `commit-service.test.ts`, `plan.test.ts` |
| An uncertain first attempt leaves `pending`, and the retry writes the same quantities | `commit-service.test.ts` |
| A terminal record replays its stored result with no second write | `commit-service.test.ts` |
| Stock cap floors to a step multiple, warns, and forbids `verified` | `plan.test.ts`, `commit-service.test.ts` |
| Step misalignment floors, warns, and forbids `verified` | `plan.test.ts` |
| An unavailable line is excluded, warned, and never written | `plan.test.ts`, `commit-service.test.ts` |
| A price change warns without changing the target | `plan.test.ts` |
| A draft whose every line is excluded is `blocked` with no write | `commit-service.test.ts` |
| A bag row is absent from write arguments and unchanged in the readback | `commit-service.test.ts` |
| An error validation yields `blocked` and hides checkout | `reconcile.test.ts`, `commit-service.test.ts` |
| A short or missing target yields `partially_committed` and hides checkout | `reconcile.test.ts` |
| A clean commit yields `verified` with checkout links | `reconcile.test.ts`, `commit-service.test.ts` |
| An unknown severity is treated as an error | `reconcile.test.ts`, `live/cart.test.ts` |
| The gateway handle closes on success and on failure | `commit-service.test.ts` |
| The write sends `addQuantity: false` with the cart's branch, through the write session, with no retry | `live/cart.test.ts` |
| The readback maps lines, total, validations, and HTTPS-only checkout links | `live/cart.test.ts`, `silpo-cart-write.test.ts` |
| `recordCommitOutcome` changes status only and preserves version and tombstones | `repository.test.ts` |
| Route status codes, identity, replay, and `no-store` headers | `cart-commit-route.test.ts` |
| Demo and live produce the same outcome from the same facts | `commit-service.test.ts` |

Every test runs offline against fakes or fixtures. No test performs a real cart write.

## 14. Documentation and handoff

The same commit updates `docs/project-architecture.md` and `docs/tasks.md`. The handoff reports changed files, the exact commands run with fresh output, the commit hash, and two carried risks:

1. the Silpo cart-line and checkout field names are taken from SILPO_MCP.md and are unverified against a live `tools/list`;
2. the client story described in section 3 is unowned and blocks Task 18.

## 15. Definition of done

- Every behavior in section 13 is implemented and covered.
- `pnpm vitest run` passes for the focused commit, plan, reconcile, gateway, repository, contract, and route suites.
- Cumulative suites for drafts, silpo, and cart pass unchanged.
- `pnpm lint`, `pnpm typecheck`, and `pnpm build` pass.
- No cart-write path bypasses approval, the idempotency key, slot validation, readback, or checkout gating.
- Live and demo return identical outcomes from identical facts.
- The diff contains no unrelated change, no placeholder, and no secret.
- `docs/project-architecture.md` and `docs/tasks.md` match the resulting behavior.
