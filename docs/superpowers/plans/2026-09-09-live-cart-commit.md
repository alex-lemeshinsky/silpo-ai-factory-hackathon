# Idempotent Live Cart Commit and Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a persisted draft approval into one idempotent absolute-quantity write to a real Silpo cart, verify the result by immediate readback, and reveal checkout links only for a verified cart with no error validation.

**Architecture:** A live cart gateway maps `silpo_get_shopping_cart_by_id` and `silpo_add_or_update_cart_products` onto the existing `SilpoGateway` ports. Two pure modules own the arithmetic: `planCommit` turns an approved draft plus current cart quantities into absolute targets and warning adjustments, and `reconcileCommit` turns persisted targets plus a post-write readback into a `verified`, `partially_committed`, or `blocked` result. A commit application service sequences approval check, terminal-record replay, slot validation, catalog refresh, target persistence, single write, readback, and outcome persistence. A thin route exposes it as `POST /api/cart/commit`.

**Tech Stack:** TypeScript 5.9, Next.js 16 App Router, Zod 4, Drizzle ORM with Postgres, Model Context Protocol SDK, Vitest 4.

**Spec:** [docs/superpowers/specs/2026-09-09-live-cart-commit-design.md](../specs/2026-09-09-live-cart-commit-design.md)

## Global Constraints

- Use `pnpm` exclusively. This task adds no dependency, no migration, no environment variable, and no change to `src/features/shared/contracts.ts`, `src/db/schema.ts`, `drizzle/*`, package manifests, or lockfiles.
- `SILPO_MCP.md` is a read-only integration contract. Do not edit it.
- Stage files explicitly. Never use `git add .`. Preserve any user-owned working-tree change.
- Work on `main`, which is where this repository integrates tasks, or in an isolated worktree if other agents run in parallel.
- All slices below form one repository backlog task and end in **one** final commit with the message documented in `docs/tasks.md`: `feat: commit verified Silpo carts`.
- Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` before writing the route. This installed Next.js version differs from training data.
- No test in this task performs a real cart write, opens a network connection, or requires a database. Every external boundary is a fake session, an in-memory repository, or a canned response.
- A cart write is never retried automatically. Only a fresh client request carrying the same idempotency key retries it.
- Every cart write sends `addQuantity: false` and absolute target quantities, and is followed immediately by a cart readback.
- `companyId` is never sent; the Silpo server supplies `SILPO_DEFAULT_COMPANY_ID`.
- Quantity step alignment uses the repository's existing tolerance: `Math.abs(quantity / step - Math.round(quantity / step)) <= 1e-9`. Price comparison uses a tolerance of `0.01`.
- Silpo severities map `warning` to warning and every other value, including unknown and missing, to error.
- Checkout links are returned only for a `verified` cart with no error validation. `VerifiedCartSchema` enforces this a second time; do not weaken it.
- Ukrainian user-facing copy is exact as written in this plan. No error message, log line, or response body may contain a URL, header, token, session handle, tool argument, product snapshot, database detail, or stack trace.
- Live mode never falls back to demo mode. Demo and live must produce identical outcomes from identical facts.
- `src/features/purchases` and `src/features/prediction` stay untouched and framework-free.
- Do not add a UI file. The client story is deliberately out of scope; see spec section 3.

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/features/silpo/schemas/cart.ts` | Modify | Add cart product lines and checkout links to the external cart readback schema. |
| `src/features/silpo/schemas/cart.test.ts` | Modify | Prove the new fields default safely, tolerate unknown keys, and reject mistyped required data. |
| `src/features/silpo/live/cart.ts` | Create | Live cart write and readback: branch lookup, `addQuantity=false` write, severity mapping, HTTPS-only checkout links. |
| `src/features/silpo/live/cart.test.ts` | Create | Write arguments, session routing, absence of write retry, and readback mapping. |
| `tests/contract/silpo-cart-write.test.ts` | Create | Fixture-driven external mapping evidence against a fake MCP session. |
| `src/features/silpo/gateway.ts` | Modify | Bind `setAbsoluteCartQuantities` and `readCart` to the live cart gateway; delete `NotImplementedForDraftRunError`. |
| `src/features/silpo/gateway.test.ts` | Modify | Replace the not-implemented assertions with live cart routing evidence. |
| `src/features/cart/plan.ts` | Create | Pure absolute-target arithmetic and the warning adjustment taxonomy. |
| `src/features/cart/plan.test.ts` | Create | Target sum, stock cap, step flooring, exclusion, and price drift. |
| `src/features/cart/reconcile.ts` | Create | Pure terminal-status derivation and checkout gating. |
| `src/features/cart/reconcile.test.ts` | Create | Verified, partially committed, blocked, empty targets, and severity handling. |
| `src/features/drafts/repository.ts` | Modify | Add `recordCommitOutcome` to both implementations without touching versions or item rows. |
| `src/features/drafts/repository.test.ts` | Modify | Status-only update, ownership, conflict, and tombstone preservation. |
| `src/features/cart/commit-service.ts` | Create | The commit protocol: approval gate, replay, slot, refresh, target persistence, single write, readback, outcome. |
| `src/features/cart/commit-service.test.ts` | Create | The full safety matrix from the spec's acceptance table. |
| `src/app/api/cart/commit/handlers.ts` | Create | Dependency-injected identity resolution, body validation, and HTTP mapping. |
| `src/app/api/cart/commit/route.ts` | Create | Next.js segment configuration and the `POST` export only. |
| `tests/integration/cart-commit-route.test.ts` | Create | Route identity, status codes, replay, and response headers. |
| `docs/project-architecture.md` | Modify | Record the retry-refresh rule, adjustment taxonomy, severity mapping, and `commit_uncertain`. |
| `docs/tasks.md` | Modify | Refine the Task 16 file list and record completion evidence. |

## Locked Interfaces

Define these names once and use them unchanged in every later slice.

```ts
// src/features/silpo/schemas/cart.ts
export const CartProductLineSchema: z.ZodType<SilpoCartProductLine>;
export const CartCheckoutSchema: z.ZodType<SilpoCartCheckout>;

export interface SilpoCartProductLine {
  productId: string;
  quantity: number;
  price: number;
  specialPrice: number | null;
  available: boolean;
}

export interface SilpoCartCheckout {
  webUrl: string | null;
  mobileUrl: string | null;
}
// ShoppingCartSchema gains: products (array, default []) and checkout (nullable, default null).
```

```ts
// src/features/silpo/live/cart.ts
export interface LiveCartDeps {
  readSession: McpSession;
  writeSession: McpSession;
}

export interface LiveCartGateway {
  setAbsoluteCartQuantities(input: SetCartProductsInput): Promise<void>;
  readCart(cartId: string): Promise<VerifiedCart>;
}

export function createLiveCartGateway(deps: LiveCartDeps): LiveCartGateway;
export function mapCartValidationSeverity(raw: string): ValidationSeverity;
```

```ts
// src/features/cart/plan.ts
export type CommitAdjustmentCode =
  | "unavailable_product"
  | "stock_capped"
  | "step_adjusted"
  | "price_changed";

export interface CommitAdjustment {
  productId: string;
  code: CommitAdjustmentCode;
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

```ts
// src/features/cart/reconcile.ts
export interface ReconcileCommitInput {
  targets: Record<string, number>;
  adjustments: CommitAdjustment[];
  readback: VerifiedCart;
}

export function reconcileCommit(input: ReconcileCommitInput): VerifiedCart;
```

```ts
// src/features/drafts/repository.ts
export interface RecordCommitOutcomeInput {
  draftId: string;
  userId: string;
  status: "verified" | "partially_committed" | "blocked";
}

export type RecordCommitOutcomeResult = "updated" | "not_found" | "conflict";

// DraftRepository gains exactly one method:
//   recordCommitOutcome(input: RecordCommitOutcomeInput): Promise<RecordCommitOutcomeResult>;
```

```ts
// src/features/cart/commit-service.ts
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

```ts
// src/app/api/cart/commit/handlers.ts
export interface CartCommitRequest {
  draftId: string;
  idempotencyKey: string;
}

export const CartCommitRequestSchema: z.ZodType<CartCommitRequest>;

export interface CartCommitHandlerDeps {
  getEnv: () => ServerEnv;
  resolveSession: (handle: string | null) => Promise<Result<{ userId: string }, AppError>>;
  resolveDemoIdentity: (cookieValue: string | null) => Promise<DemoIdentity>;
  drafts: () => DraftRepository;
  commits: () => CartCommitRepository;
  openGateway: (options: { mode: DataMode; userId: string }) => Promise<SilpoGatewayHandle>;
  commit: typeof commitApprovedDraft;
}

export function createCartCommitPostHandler(
  overrides?: Partial<CartCommitHandlerDeps>,
): (request: NextRequest) => Promise<NextResponse>;
```

### Exact user-facing copy

```ts
// src/features/cart/plan.ts
const UNAVAILABLE_COPY = "Товар зараз недоступний, тому його не додано.";
const STOCK_CAPPED_COPY = "Доступно менше, ніж потрібно: кількість зменшено.";
const STEP_ADJUSTED_COPY = "Кількість вирівняно до кроку пакування.";
const PRICE_CHANGED_COPY = "Ціна змінилася після створення чернетки.";

// src/features/cart/commit-service.ts
const FAILURE_COPY: Record<CartCommitFailureCode, string> = {
  not_found: "Чернетку не знайдено. Створіть нову.",
  approval_required: "Спочатку підтвердьте чернетку.",
  needs_slot: "Оберіть доступний час доставки.",
  commit_uncertain: "Не вдалося підтвердити запис у кошик. Спробуйте ще раз.",
  unexpected: "Не вдалося оновити кошик. Спробуйте ще раз.",
};

// src/app/api/cart/commit/handlers.ts
const INVALID_REQUEST_COPY = "Некоректний запит.";
const UNAUTHORIZED_COPY = "Не вдалося підтвердити вхід. Увійдіть у «Сільпо» ще раз.";
```

---

## Task 16: Idempotent Live Cart Commit and Verification

**Prerequisites:** Commits for Tasks 2, 7, 10, 11, and 15 are integrated. Baseline `ec7310b`; the spec commit `b82b816` sits on top of it.

**Behavior to prove:** An approved draft reaches a real cart exactly once. No approval means no write. A repeated request never adds a product twice. A missing slot writes nothing. Capped, floored, or excluded lines can never look verified. Checkout links appear only for a verified cart with no error validation.

### 16.0 — Confirm dependencies and framework rules

- [ ] Confirm the working tree is clean and the baseline is present:

```bash
git status --short && git log -1 --format='%h %s'
```

- [ ] Confirm the ports this task implements are still unimplemented, and that the cart commit repository already exists:

```bash
pnpm vitest run src/features/cart/repository.test.ts src/features/silpo/gateway.test.ts
```

Expected: PASS. `gateway.test.ts` currently asserts that `readCart` and `setAbsoluteCartQuantities` reject with `NotImplementedForDraftRunError`. Slice 16.2 replaces those two assertions.

- [ ] Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`. `POST /api/cart/commit` has no dynamic segment, so it takes only a `NextRequest`, but the segment config conventions still apply.

- [ ] Read spec section 3. Do not add a dashboard file, a commit button, or a fetch call from a component in this task.

### 16.1 — Extend the external cart schema for lines and checkout

**Files:**
- Modify: `src/features/silpo/schemas/cart.ts`
- Modify: `src/features/silpo/schemas/cart.test.ts`

**Interfaces:**
- Consumes: `nonEmptyString`, `money` from `src/features/silpo/schemas/common.ts`.
- Produces: `CartProductLineSchema`, `CartCheckoutSchema`, and a `ShoppingCartSchema` that carries `products` and `checkout`.

- [ ] **Step 1: Write the failing schema tests**

Append to `src/features/silpo/schemas/cart.test.ts`:

```ts
const cartWithLines = {
  id: "cart-1",
  branchId: "branch-1",
  deliveryType: "DeliveryHome",
  timeslot: { id: "slot-1", start: "2026-09-09T10:00:00Z", end: "2026-09-09T12:00:00Z" },
  address: null,
  shipments: [],
  total: 124.4,
  validations: [],
  products: [
    { productId: "p-1", quantity: 2, price: 24.9, specialPrice: 19.9, available: true },
    { productId: "p-2", quantity: 1, price: 74.6 },
  ],
  checkout: { webUrl: "https://silpo.ua/cart/cart-1", mobileUrl: "https://silpo.ua/app/cart/cart-1" },
};

describe("ShoppingCartSchema cart lines", () => {
  it("parses product lines and defaults optional line fields", () => {
    const parsed = ShoppingCartSchema.parse(cartWithLines);
    expect(parsed.products).toEqual([
      { productId: "p-1", quantity: 2, price: 24.9, specialPrice: 19.9, available: true },
      { productId: "p-2", quantity: 1, price: 74.6, specialPrice: null, available: true },
    ]);
  });

  it("defaults an absent product list and checkout to empty rather than failing", () => {
    const { products, checkout, ...withoutNewFields } = cartWithLines;
    const parsed = ShoppingCartSchema.parse(withoutNewFields);
    expect(parsed.products).toEqual([]);
    expect(parsed.checkout).toBeNull();
  });

  it("parses checkout links verbatim without judging their scheme", () => {
    const parsed = ShoppingCartSchema.parse(cartWithLines);
    expect(parsed.checkout).toEqual({
      webUrl: "https://silpo.ua/cart/cart-1",
      mobileUrl: "https://silpo.ua/app/cart/cart-1",
    });
  });

  it("rejects a mistyped line quantity rather than coercing it", () => {
    const broken = { ...cartWithLines, products: [{ productId: "p-1", quantity: "2", price: 24.9 }] };
    expect(() => ShoppingCartSchema.parse(broken)).toThrow();
  });

  it("rejects a line without a product ID rather than guessing", () => {
    const broken = { ...cartWithLines, products: [{ quantity: 2, price: 24.9 }] };
    expect(() => ShoppingCartSchema.parse(broken)).toThrow();
  });

  it("tolerates unknown keys inside a product line", () => {
    const extended = {
      ...cartWithLines,
      products: [{ productId: "p-1", quantity: 2, price: 24.9, loyaltyLabel: "нове" }],
    };
    expect(ShoppingCartSchema.parse(extended).products[0].productId).toBe("p-1");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run src/features/silpo/schemas/cart.test.ts
```

Expected: FAIL, because `ShoppingCartSchema` strips `products` and `checkout` and the parsed values are `undefined`.

- [ ] **Step 3: Add the schemas**

In `src/features/silpo/schemas/cart.ts`, add above `ShoppingCartSchema`:

```ts
export const CartProductLineSchema = z.object({
  productId: nonEmptyString,
  quantity: z.number().finite().nonnegative(),
  price: money,
  specialPrice: money.nullable().default(null),
  available: z.boolean().default(true),
});
export type SilpoCartProductLine = z.infer<typeof CartProductLineSchema>;

/**
 * Checkout targets are copied verbatim. Whether a link may be shown is a
 * domain rule enforced by `VerifiedCartSchema`, not a parsing rule.
 */
export const CartCheckoutSchema = z.object({
  webUrl: nonEmptyString.nullable().default(null),
  mobileUrl: nonEmptyString.nullable().default(null),
});
export type SilpoCartCheckout = z.infer<typeof CartCheckoutSchema>;
```

Then add these two fields to the `ShoppingCartSchema` object, keeping the file's deliberate non-`.strict()` doctrine:

```ts
  products: z.array(CartProductLineSchema).default([]),
  checkout: CartCheckoutSchema.nullable().default(null),
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run src/features/silpo/schemas/cart.test.ts
```

Expected: PASS.

### 16.2 — Implement the live cart gateway and wire it into the shared gateway

**Files:**
- Create: `src/features/silpo/live/cart.ts`
- Create: `src/features/silpo/live/cart.test.ts`
- Create: `tests/contract/silpo-cart-write.test.ts`
- Modify: `src/features/silpo/gateway.ts`
- Modify: `src/features/silpo/gateway.test.ts`

**Interfaces:**
- Consumes: `McpSession`, `ShoppingCartSchema`, `AcknowledgedWriteSchema`, `SetCartProductsInputSchema`, `VerifiedCartSchema`, `CartValidationSchema`, `CheckoutLinksSchema`.
- Produces: `createLiveCartGateway(deps): LiveCartGateway` and `mapCartValidationSeverity(raw): ValidationSeverity`.

- [ ] **Step 1: Write the failing gateway tests**

Create `src/features/silpo/live/cart.test.ts`. Reuse the fake-session shape already used by `tests/contract/silpo-cart-context.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import { createLiveCartGateway, mapCartValidationSeverity } from "@/features/silpo/live/cart";
import { UnadvertisedToolError, type McpSession } from "@/features/silpo/live/session";

const READ_TOOLS = ["silpo_get_shopping_cart_by_id"];
const WRITE_TOOLS = ["silpo_add_or_update_cart_products"];

function createFakeSession(
  tools: string[],
  handlers: Record<string, (args: Record<string, unknown>) => unknown>,
  retryEnabled = true,
): McpSession & { calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const advertisedTools = new Set(tools);
  return {
    calls,
    advertisedTools,
    retryEnabled,
    async callTool<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
      if (!advertisedTools.has(name)) throw new UnadvertisedToolError(name);
      calls.push({ name, args });
      const handler = handlers[name];
      if (!handler) throw new Error(`unexpected tool ${name}`);
      return schema.parse(handler(args));
    },
    async close() {},
  };
}

const baseCart = {
  id: "cart-1",
  branchId: "branch-7",
  deliveryType: "DeliveryHome",
  timeslot: { id: "slot-1", start: "2026-09-09T10:00:00Z", end: "2026-09-09T12:00:00Z" },
  address: null,
  shipments: [],
  total: 49.8,
  validations: [],
  products: [{ productId: "p-1", quantity: 2, price: 24.9, specialPrice: null, available: true }],
  checkout: { webUrl: "https://silpo.ua/cart/cart-1", mobileUrl: "https://silpo.ua/app/cart/cart-1" },
};
```

Then the behaviors:

```ts
describe("createLiveCartGateway.setAbsoluteCartQuantities", () => {
  it("sends absolute quantities with the cart's branch and addQuantity false", async () => {
    const readSession = createFakeSession(READ_TOOLS, {
      silpo_get_shopping_cart_by_id: () => ({ structuredContent: baseCart }),
    });
    const writeSession = createFakeSession(WRITE_TOOLS, {
      silpo_add_or_update_cart_products: () => ({ structuredContent: { ok: true } }),
    }, false);
    const gateway = createLiveCartGateway({ readSession, writeSession });

    await gateway.setAbsoluteCartQuantities({
      cartId: "cart-1",
      items: [{ productId: "p-1", quantity: 3 }],
      addQuantity: false,
    });

    expect(writeSession.calls).toHaveLength(1);
    expect(writeSession.calls[0].args).toEqual({
      cartId: "cart-1",
      branchId: "branch-7",
      products: [{ productId: "p-1", quantity: 3 }],
      addQuantity: false,
    });
  });

  it("never sends companyId, because the server supplies it", async () => {
    // build sessions as above, call the write, then:
    expect(Object.keys(writeSession.calls[0].args)).not.toContain("companyId");
  });

  it("uses the write session for the write and the read session for the branch lookup", async () => {
    // after the call:
    expect(readSession.calls.map((call) => call.name)).toEqual(["silpo_get_shopping_cart_by_id"]);
    expect(writeSession.calls.map((call) => call.name)).toEqual(["silpo_add_or_update_cart_products"]);
    expect(writeSession.retryEnabled).toBe(false);
  });

  it("does not retry a failed write", async () => {
    const write = vi.fn(() => { throw new Error("boom"); });
    const writeSession = createFakeSession(WRITE_TOOLS, { silpo_add_or_update_cart_products: write }, false);
    // read session as above
    const gateway = createLiveCartGateway({ readSession, writeSession });

    await expect(gateway.setAbsoluteCartQuantities({
      cartId: "cart-1",
      items: [{ productId: "p-1", quantity: 3 }],
      addQuantity: false,
    })).rejects.toThrow("boom");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("rejects an input that does not carry addQuantity false", async () => {
    await expect(gateway.setAbsoluteCartQuantities({
      cartId: "cart-1",
      items: [{ productId: "p-1", quantity: 3 }],
      addQuantity: true as unknown as false,
    })).rejects.toThrow();
    expect(writeSession.calls).toHaveLength(0);
  });
});

describe("createLiveCartGateway.readCart", () => {
  it("maps lines, total, and HTTPS checkout links for a clean cart", async () => {
    const cart = await gateway.readCart("cart-1");
    expect(cart).toEqual({
      cartId: "cart-1",
      status: "verified",
      items: [{ productId: "p-1", quantity: 2, unitPrice: 24.9, available: true }],
      total: 49.8,
      validations: [],
      checkoutLinks: {
        web: "https://silpo.ua/cart/cart-1",
        mobile: "https://silpo.ua/app/cart/cart-1",
      },
    });
  });

  it("prefers a special price as the effective unit price", async () => {
    // line: { productId: "p-1", quantity: 2, price: 24.9, specialPrice: 19.9, available: true }
    expect((await gateway.readCart("cart-1")).items[0].unitPrice).toBe(19.9);
  });

  it("drops a zero-quantity line rather than failing the whole readback", async () => {
    // line quantity 0 is valid for Silpo and invalid for VerifiedCartItemSchema
    expect((await gateway.readCart("cart-1")).items).toEqual([]);
  });

  it("blocks the cart and hides checkout when an error validation is present", async () => {
    // validations: [{ severity: "error", code: "out_of_stock", message: "Немає в наявності", productId: "p-1" }]
    const cart = await gateway.readCart("cart-1");
    expect(cart.status).toBe("blocked");
    expect(cart.checkoutLinks).toBeNull();
  });

  it("keeps a warning non-blocking", async () => {
    // validations: [{ severity: "warning", code: "slot_soon", message: "Слот скоро завершиться", productId: null }]
    const cart = await gateway.readCart("cart-1");
    expect(cart.status).toBe("verified");
    expect(cart.validations[0].severity).toBe("warning");
  });

  it("treats an unknown severity as an error", async () => {
    // validations: [{ severity: "notice", code: "unknown_thing", message: "?", productId: null }]
    expect((await gateway.readCart("cart-1")).status).toBe("blocked");
  });

  it("falls back to the validation code when Silpo sends an empty message", async () => {
    // validations: [{ severity: "warning", code: "slot_soon", message: "", productId: null }]
    expect((await gateway.readCart("cart-1")).validations[0].message).toBe("slot_soon");
  });

  it("drops non-HTTPS or incomplete checkout links", async () => {
    // checkout: { webUrl: "http://silpo.ua/cart/cart-1", mobileUrl: "https://silpo.ua/app/cart/cart-1" }
    expect((await gateway.readCart("cart-1")).checkoutLinks).toBeNull();
  });
});

describe("mapCartValidationSeverity", () => {
  it.each([
    ["warning", "warning"],
    ["WARNING", "warning"],
    ["error", "error"],
    ["notice", "error"],
    ["", "error"],
  ])("maps %s to %s", (raw, expected) => {
    expect(mapCartValidationSeverity(raw)).toBe(expected);
  });
});
```

Fill each commented fixture in as a complete literal; do not leave a test that reads a variable no line defines.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run src/features/silpo/live/cart.test.ts
```

Expected: FAIL with a module-not-found error for `@/features/silpo/live/cart`.

- [ ] **Step 3: Implement the live cart gateway**

Create `src/features/silpo/live/cart.ts`:

```ts
import {
  CartValidationSchema,
  CheckoutLinksSchema,
  SetCartProductsInputSchema,
  VerifiedCartSchema,
  type CheckoutLinks,
  type SetCartProductsInput,
  type ValidationSeverity,
  type VerifiedCart,
} from "@/features/shared/contracts";

import { nonEmptyString } from "../schemas/common";
import {
  AcknowledgedWriteSchema,
  ShoppingCartSchema,
  type SilpoCartCheckout,
} from "../schemas/cart";
import type { McpSession } from "./session";

export interface LiveCartDeps {
  readSession: McpSession;
  writeSession: McpSession;
}

export interface LiveCartGateway {
  setAbsoluteCartQuantities(input: SetCartProductsInput): Promise<void>;
  readCart(cartId: string): Promise<VerifiedCart>;
}

/**
 * Silpo's severity vocabulary is not part of a validated enum, so an
 * unrecognized value must never become the permissive branch: anything that
 * is not an explicit warning blocks the cart.
 */
export function mapCartValidationSeverity(raw: string): ValidationSeverity {
  return raw.trim().toLowerCase() === "warning" ? "warning" : "error";
}

function toCheckoutLinks(checkout: SilpoCartCheckout | null): CheckoutLinks | null {
  if (!checkout?.webUrl || !checkout.mobileUrl) return null;
  const parsed = CheckoutLinksSchema.safeParse({
    web: checkout.webUrl,
    mobile: checkout.mobileUrl,
  });
  return parsed.success ? parsed.data : null;
}

export function createLiveCartGateway(deps: LiveCartDeps): LiveCartGateway {
  const { readSession, writeSession } = deps;

  const readRawCart = (cartId: string) =>
    readSession.callTool("silpo_get_shopping_cart_by_id", { cartId }, ShoppingCartSchema);

  return {
    async setAbsoluteCartQuantities(input: SetCartProductsInput): Promise<void> {
      const parsed = SetCartProductsInputSchema.parse(input);

      // `SetCartProductsInput` carries no branch and the tool requires one.
      // This read is retryable; the write below deliberately is not.
      const cart = await readRawCart(parsed.cartId);

      await writeSession.callTool(
        "silpo_add_or_update_cart_products",
        {
          cartId: parsed.cartId,
          branchId: cart.branchId,
          products: parsed.items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
          })),
          addQuantity: false,
        },
        AcknowledgedWriteSchema,
      );
    },

    async readCart(cartId: string): Promise<VerifiedCart> {
      const cart = await readRawCart(nonEmptyString.parse(cartId));

      const validations = cart.validations.map((validation) =>
        CartValidationSchema.parse({
          severity: mapCartValidationSeverity(validation.severity),
          code: validation.code,
          // The domain contract requires a non-empty message; the code is the
          // only safe substitute that carries no external free text.
          message: validation.message.trim() || validation.code,
          productId: validation.productId,
        }),
      );

      const hasError = validations.some((validation) => validation.severity === "error");

      return VerifiedCartSchema.parse({
        cartId: cart.id,
        status: hasError ? "blocked" : "verified",
        // A zero-quantity line is valid for Silpo and meaningless here.
        items: cart.products
          .filter((line) => line.quantity > 0)
          .map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            unitPrice: line.specialPrice ?? line.price,
            available: line.available,
          })),
        total: cart.total,
        validations,
        checkoutLinks: hasError ? null : toCheckoutLinks(cart.checkout),
      });
    },
  };
}
```

- [ ] **Step 4: Run the gateway test to verify it passes**

```bash
pnpm vitest run src/features/silpo/live/cart.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the failing contract test**

Create `tests/contract/silpo-cart-write.test.ts` using the same fake-session helper. It proves the external mapping end to end for one realistic payload:

```ts
it("maps a realistic Silpo cart readback into the domain contract", async () => {
  const readSession = createFakeSession(["silpo_get_shopping_cart_by_id"], {
    silpo_get_shopping_cart_by_id: () => ({
      structuredContent: {
        id: "cart-42",
        branchId: "branch-7",
        deliveryType: "DeliveryHome",
        timeslot: { id: "slot-9", start: "2026-09-09T10:00:00Z", end: "2026-09-09T12:00:00Z" },
        address: { city: "Київ", street: "Хрещатик", house: "1", district: null, latitude: 50.45, longitude: 30.52, addressType: "house" },
        shipments: [],
        total: 118.7,
        validations: [
          { severity: "warning", code: "slot_soon", message: "Слот скоро завершиться", productId: null },
        ],
        products: [
          { productId: "p-water", quantity: 3, price: 24.9, specialPrice: 19.9, available: true },
          { productId: "p-bag", quantity: 1, price: 5.0, available: true },
        ],
        checkout: { webUrl: "https://silpo.ua/cart/cart-42", mobileUrl: "https://silpo.ua/app/cart/cart-42" },
      },
    }),
  });

  const cart = await createLiveCartGateway({ readSession, writeSession: readSession }).readCart("cart-42");

  expect(cart.status).toBe("verified");
  expect(cart.items).toEqual([
    { productId: "p-water", quantity: 3, unitPrice: 19.9, available: true },
    { productId: "p-bag", quantity: 1, unitPrice: 5.0, available: true },
  ]);
  expect(cart.checkoutLinks?.web).toBe("https://silpo.ua/cart/cart-42");
});

it("rejects a readback whose required field is missing instead of guessing a shape", async () => {
  const readSession = createFakeSession(["silpo_get_shopping_cart_by_id"], {
    silpo_get_shopping_cart_by_id: () => ({ structuredContent: { branchId: "branch-7", total: 1 } }),
  });
  await expect(
    createLiveCartGateway({ readSession, writeSession: readSession }).readCart("cart-42"),
  ).rejects.toThrow();
});
```

- [ ] **Step 6: Run the contract test**

```bash
pnpm vitest run tests/contract/silpo-cart-write.test.ts
```

Expected: PASS, because slice step 3 already implemented the mapping. If it fails, the mapping is wrong, not the test.

- [ ] **Step 7: Wire the live cart into the shared gateway**

In `src/features/silpo/gateway.ts`:

1. Delete the `NotImplementedForDraftRunError` class and its export.
2. Import `createLiveCartGateway`.
3. Inside `createLiveGatewayHandle`, after the `catalog` line, add:

```ts
  const cartWrite = createLiveCartGateway({
    readSession,
    writeSession: lazyWrite.session,
  });
```

4. Replace the two throwing methods with:

```ts
    setAbsoluteCartQuantities: (input) => cartWrite.setAbsoluteCartQuantities(input),
    readCart: (cartId) => cartWrite.readCart(cartId),
```

5. Update the `createLazyWriteSession` doc comment. It currently claims the only reachable write is cart bootstrapping; after this task a cart commit also uses it. Replace that sentence with: "The writes a session can reach are cart bootstrapping and the cart commit, and neither happens on most draft runs, so the session is still opened lazily."

- [ ] **Step 8: Replace the not-implemented assertions**

In `src/features/silpo/gateway.test.ts`, remove the `NotImplementedForDraftRunError` import and replace the assertion at the two lines that expect a rejection with routing evidence:

```ts
it("routes cart writes and readbacks to the live cart gateway", async () => {
  const cart = await handle.gateway.readCart("cart-1");
  expect(cart.cartId).toBe("cart-1");

  await handle.gateway.setAbsoluteCartQuantities({
    cartId: "cart-1",
    items: [{ productId: "p-1", quantity: 2 }],
    addQuantity: false,
  });
  expect(writeSession.calls.map((call) => call.name)).toContain("silpo_add_or_update_cart_products");
});
```

Extend the existing fake sessions in that file so `silpo_get_shopping_cart_by_id` and `silpo_add_or_update_cart_products` are advertised and answered.

- [ ] **Step 9: Run the silpo suite**

```bash
pnpm vitest run src/features/silpo tests/contract
```

Expected: PASS with no reference to `NotImplementedForDraftRunError` remaining:

```bash
grep -rn "NotImplementedForDraftRunError" src tests
```

Expected: no output.

### 16.3 — Implement pure target planning

**Files:**
- Create: `src/features/cart/plan.ts`
- Create: `src/features/cart/plan.test.ts`

**Interfaces:**
- Consumes: `DraftItem`, `ProductCandidate` from `@/features/shared/contracts`.
- Produces: `planCommit(input: PlanCommitInput): CommitPlan`, `CommitAdjustment`, `CommitAdjustmentCode`.

- [ ] **Step 1: Write the failing planning tests**

Create `src/features/cart/plan.test.ts`. Define one helper per fixture kind so each test reads as data, not setup:

```ts
import { describe, expect, it } from "vitest";

import { planCommit } from "@/features/cart/plan";
import type { DraftItem, ProductCandidate } from "@/features/shared/contracts";

function item(overrides: Partial<DraftItem> = {}): DraftItem {
  return {
    productId: "p-1",
    externalProductId: 1,
    name: "Вода негазована 1.5 л",
    imageUrl: null,
    displayRatio: 1,
    quantity: 2,
    price: 24.9,
    specialPrice: null,
    stock: 10,
    step: 1,
    confidence: 0.8,
    confidenceBand: "high",
    reasonCodes: ["regular_purchase"],
    reason: "Зазвичай купуєте щотижня.",
    nutritionStatus: "insufficient",
    promotions: [],
    alternatives: [],
    ...overrides,
  };
}

function product(overrides: Partial<ProductCandidate> = {}): ProductCandidate {
  return {
    productId: "p-1",
    externalProductId: 1,
    slug: "voda-1-5",
    name: "Вода негазована 1.5 л",
    imageUrl: null,
    price: 24.9,
    specialPrice: null,
    available: true,
    stock: 10,
    step: 1,
    displayRatio: 1,
    nutritionStatus: "insufficient",
    nutrition: null,
    promotions: [],
    ...overrides,
  };
}
```

Then the behaviors:

```ts
describe("planCommit", () => {
  it("adds the approved quantity to what the cart already holds", () => {
    const plan = planCommit({
      approvedItems: [item({ quantity: 2 })],
      currentQuantities: { "p-1": 1 },
      refreshed: { "p-1": product() },
    });
    expect(plan).toEqual({ targets: { "p-1": 3 }, adjustments: [] });
  });

  it("treats an absent cart line as zero", () => {
    const plan = planCommit({
      approvedItems: [item({ quantity: 2 })],
      currentQuantities: {},
      refreshed: { "p-1": product() },
    });
    expect(plan.targets).toEqual({ "p-1": 2 });
  });

  it("caps a target at refreshed stock and warns", () => {
    const plan = planCommit({
      approvedItems: [item({ quantity: 4 })],
      currentQuantities: { "p-1": 2 },
      refreshed: { "p-1": product({ stock: 5 }) },
    });
    expect(plan.targets).toEqual({ "p-1": 5 });
    expect(plan.adjustments).toEqual([
      { productId: "p-1", code: "stock_capped", message: "Доступно менше, ніж потрібно: кількість зменшено." },
    ]);
  });

  it("floors a target to the package step and warns", () => {
    const plan = planCommit({
      approvedItems: [item({ quantity: 1, step: 0.5 })],
      currentQuantities: { "p-1": 0.7 },
      refreshed: { "p-1": product({ step: 0.5, stock: 10 }) },
    });
    expect(plan.targets).toEqual({ "p-1": 1.5 });
    expect(plan.adjustments).toEqual([
      { productId: "p-1", code: "step_adjusted", message: "Кількість вирівняно до кроку пакування." },
    ]);
  });

  it("does not invent a step warning for exact floating-point multiples", () => {
    const plan = planCommit({
      approvedItems: [item({ quantity: 0.1, step: 0.1 })],
      currentQuantities: { "p-1": 0.2 },
      refreshed: { "p-1": product({ step: 0.1, stock: 10 }) },
    });
    expect(plan.targets).toEqual({ "p-1": 0.3 });
    expect(plan.adjustments).toEqual([]);
  });

  it("excludes a product missing from the refresh", () => {
    const plan = planCommit({
      approvedItems: [item()],
      currentQuantities: {},
      refreshed: {},
    });
    expect(plan.targets).toEqual({});
    expect(plan.adjustments).toEqual([
      { productId: "p-1", code: "unavailable_product", message: "Товар зараз недоступний, тому його не додано." },
    ]);
  });

  it("excludes an unavailable product and one whose stock is below a single step", () => {
    expect(planCommit({
      approvedItems: [item()],
      currentQuantities: {},
      refreshed: { "p-1": product({ available: false }) },
    }).targets).toEqual({});

    expect(planCommit({
      approvedItems: [item()],
      currentQuantities: {},
      refreshed: { "p-1": product({ stock: 0.4, step: 0.5 }) },
    }).targets).toEqual({});
  });

  it("reports one exclusion, not a cap plus an exclusion, when flooring empties a line", () => {
    const plan = planCommit({
      approvedItems: [item({ quantity: 1, step: 2 })],
      currentQuantities: {},
      refreshed: { "p-1": product({ step: 2, stock: 1.5 }) },
    });
    expect(plan.targets).toEqual({});
    expect(plan.adjustments).toEqual([
      { productId: "p-1", code: "unavailable_product", message: "Товар зараз недоступний, тому його не додано." },
    ]);
  });

  it("warns about a price change without changing the target", () => {
    const plan = planCommit({
      approvedItems: [item({ quantity: 2, price: 24.9 })],
      currentQuantities: {},
      refreshed: { "p-1": product({ price: 29.9 }) },
    });
    expect(plan.targets).toEqual({ "p-1": 2 });
    expect(plan.adjustments).toEqual([
      { productId: "p-1", code: "price_changed", message: "Ціна змінилася після створення чернетки." },
    ]);
  });

  it("ignores a price difference within one kopiyka", () => {
    const plan = planCommit({
      approvedItems: [item({ price: 24.9 })],
      currentQuantities: {},
      refreshed: { "p-1": product({ price: 24.9 + 0.004 }) },
    });
    expect(plan.adjustments).toEqual([]);
  });

  it("detects a special price change too", () => {
    const plan = planCommit({
      approvedItems: [item({ price: 24.9, specialPrice: 19.9 })],
      currentQuantities: {},
      refreshed: { "p-1": product({ price: 24.9, specialPrice: 22.9 }) },
    });
    expect(plan.adjustments.map((entry) => entry.code)).toEqual(["price_changed"]);
  });

  it("plans several items independently", () => {
    const plan = planCommit({
      approvedItems: [item(), item({ productId: "p-2", name: "Молоко", quantity: 1 })],
      currentQuantities: { "p-1": 1 },
      refreshed: { "p-1": product(), "p-2": product({ productId: "p-2", name: "Молоко", stock: 3 }) },
    });
    expect(plan.targets).toEqual({ "p-1": 3, "p-2": 1 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run src/features/cart/plan.test.ts
```

Expected: FAIL with a module-not-found error for `@/features/cart/plan`.

- [ ] **Step 3: Implement the planner**

Create `src/features/cart/plan.ts`:

```ts
import type { DraftItem, ProductCandidate } from "@/features/shared/contracts";

export type CommitAdjustmentCode =
  | "unavailable_product"
  | "stock_capped"
  | "step_adjusted"
  | "price_changed";

export interface CommitAdjustment {
  productId: string;
  code: CommitAdjustmentCode;
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

const UNAVAILABLE_COPY = "Товар зараз недоступний, тому його не додано.";
const STOCK_CAPPED_COPY = "Доступно менше, ніж потрібно: кількість зменшено.";
const STEP_ADJUSTED_COPY = "Кількість вирівняно до кроку пакування.";
const PRICE_CHANGED_COPY = "Ціна змінилася після створення чернетки.";

/** The tolerance the shared contracts already use for step alignment. */
const STEP_TOLERANCE = 1e-9;
/** One kopiyka: below this, a price difference is representation, not news. */
const PRICE_TOLERANCE = 0.01;

const alignedToStep = (quantity: number, step: number) =>
  Math.abs(quantity / step - Math.round(quantity / step)) <= STEP_TOLERANCE;

const floorToStep = (quantity: number, step: number) =>
  Math.floor(quantity / step + STEP_TOLERANCE) * step;

/** Keeps 0.1 + 0.2 from persisting as 0.30000000000000004. */
const roundQuantity = (quantity: number) => Math.round(quantity * 1e6) / 1e6;

const priceChanged = (item: DraftItem, product: ProductCandidate) =>
  Math.abs(product.price - item.price) > PRICE_TOLERANCE ||
  Math.abs((product.specialPrice ?? product.price) - (item.specialPrice ?? item.price)) > PRICE_TOLERANCE;

/**
 * Computes the absolute quantity each approved product should end at.
 *
 * The target is the cart's current quantity plus the approved quantity, so a
 * write with `addQuantity=false` is idempotent: repeating it cannot add the
 * same product twice. Every adjustment is a warning; none of them blocks the
 * write, but any of them forbids a `verified` outcome.
 */
export function planCommit(input: PlanCommitInput): CommitPlan {
  const targets: Record<string, number> = {};
  const adjustments: CommitAdjustment[] = [];

  const exclude = (productId: string) => {
    adjustments.push({ productId, code: "unavailable_product", message: UNAVAILABLE_COPY });
  };

  for (const item of input.approvedItems) {
    const product = input.refreshed[item.productId];
    if (!product || !product.available || product.stock < product.step) {
      exclude(item.productId);
      continue;
    }

    // Collected per item so an exclusion can discard capping noise and report
    // one clear cause instead of three.
    const pending: CommitAdjustment[] = [];

    if (priceChanged(item, product)) {
      pending.push({ productId: item.productId, code: "price_changed", message: PRICE_CHANGED_COPY });
    }

    let target = (input.currentQuantities[item.productId] ?? 0) + item.quantity;

    if (target > product.stock) {
      target = product.stock;
      pending.push({ productId: item.productId, code: "stock_capped", message: STOCK_CAPPED_COPY });
    }

    if (!alignedToStep(target, product.step)) {
      target = floorToStep(target, product.step);
      pending.push({ productId: item.productId, code: "step_adjusted", message: STEP_ADJUSTED_COPY });
    }

    if (target < product.step) {
      exclude(item.productId);
      continue;
    }

    targets[item.productId] = roundQuantity(target);
    adjustments.push(...pending);
  }

  return { targets, adjustments };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run src/features/cart/plan.test.ts
```

Expected: PASS.

### 16.4 — Implement pure reconciliation

**Files:**
- Create: `src/features/cart/reconcile.ts`
- Create: `src/features/cart/reconcile.test.ts`

**Interfaces:**
- Consumes: `CommitAdjustment` from `@/features/cart/plan`, `VerifiedCart` and `VerifiedCartSchema` from `@/features/shared/contracts`.
- Produces: `reconcileCommit(input: ReconcileCommitInput): VerifiedCart`.

- [ ] **Step 1: Write the failing reconciliation tests**

Create `src/features/cart/reconcile.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { reconcileCommit } from "@/features/cart/reconcile";
import type { VerifiedCart } from "@/features/shared/contracts";

const links = {
  web: "https://silpo.ua/cart/cart-1",
  mobile: "https://silpo.ua/app/cart/cart-1",
};

function readback(overrides: Partial<VerifiedCart> = {}): VerifiedCart {
  return {
    cartId: "cart-1",
    status: "verified",
    items: [{ productId: "p-1", quantity: 3, unitPrice: 24.9, available: true }],
    total: 74.7,
    validations: [],
    checkoutLinks: links,
    ...overrides,
  };
}

describe("reconcileCommit", () => {
  it("verifies a cart that met every target with no adjustment", () => {
    const result = reconcileCommit({ targets: { "p-1": 3 }, adjustments: [], readback: readback() });
    expect(result.status).toBe("verified");
    expect(result.checkoutLinks).toEqual(links);
  });

  it("blocks and hides checkout when an error validation is present", () => {
    const result = reconcileCommit({
      targets: { "p-1": 3 },
      adjustments: [],
      readback: readback({
        status: "blocked",
        checkoutLinks: null,
        validations: [{ severity: "error", code: "out_of_stock", message: "Немає в наявності", productId: "p-1" }],
      }),
    });
    expect(result.status).toBe("blocked");
    expect(result.checkoutLinks).toBeNull();
  });

  it("blocks when nothing could be targeted at all", () => {
    const result = reconcileCommit({
      targets: {},
      adjustments: [{ productId: "p-1", code: "unavailable_product", message: "Товар зараз недоступний, тому його не додано." }],
      readback: readback({ items: [], total: 0 }),
    });
    expect(result.status).toBe("blocked");
    expect(result.checkoutLinks).toBeNull();
  });

  it("reports partially committed when a target is missing from the cart", () => {
    const result = reconcileCommit({
      targets: { "p-1": 3, "p-2": 1 },
      adjustments: [],
      readback: readback(),
    });
    expect(result.status).toBe("partially_committed");
    expect(result.checkoutLinks).toBeNull();
  });

  it("reports partially committed when a line landed short of its target", () => {
    const result = reconcileCommit({
      targets: { "p-1": 5 },
      adjustments: [],
      readback: readback(),
    });
    expect(result.status).toBe("partially_committed");
  });

  it("reports partially committed when an adjustment was applied, even with a clean cart", () => {
    const result = reconcileCommit({
      targets: { "p-1": 3 },
      adjustments: [{ productId: "p-1", code: "stock_capped", message: "Доступно менше, ніж потрібно: кількість зменшено." }],
      readback: readback(),
    });
    expect(result.status).toBe("partially_committed");
    expect(result.checkoutLinks).toBeNull();
  });

  it("appends each adjustment as a warning carrying its product ID", () => {
    const result = reconcileCommit({
      targets: { "p-1": 3 },
      adjustments: [{ productId: "p-1", code: "price_changed", message: "Ціна змінилася після створення чернетки." }],
      readback: readback({
        validations: [{ severity: "warning", code: "slot_soon", message: "Слот скоро завершиться", productId: null }],
      }),
    });
    expect(result.validations).toEqual([
      { severity: "warning", code: "slot_soon", message: "Слот скоро завершиться", productId: null },
      { severity: "warning", code: "price_changed", message: "Ціна змінилася після створення чернетки.", productId: "p-1" },
    ]);
  });

  it("keeps a cart verified when the only validation is a warning", () => {
    const result = reconcileCommit({
      targets: { "p-1": 3 },
      adjustments: [],
      readback: readback({
        validations: [{ severity: "warning", code: "demo_data", message: "Кошик використовує демонстраційні дані", productId: null }],
      }),
    });
    expect(result.status).toBe("verified");
    expect(result.checkoutLinks).toEqual(links);
  });

  it("reports the server's total without recomputing it", () => {
    const result = reconcileCommit({ targets: { "p-1": 3 }, adjustments: [], readback: readback({ total: 71.2 }) });
    expect(result.total).toBe(71.2);
  });

  it("does not treat floating-point noise as a short line", () => {
    const result = reconcileCommit({
      targets: { "p-1": 0.3 },
      adjustments: [],
      readback: readback({ items: [{ productId: "p-1", quantity: 0.1 + 0.2, unitPrice: 24.9, available: true }] }),
    });
    expect(result.status).toBe("verified");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run src/features/cart/reconcile.test.ts
```

Expected: FAIL with a module-not-found error for `@/features/cart/reconcile`.

- [ ] **Step 3: Implement the reconciler**

Create `src/features/cart/reconcile.ts`:

```ts
import {
  VerifiedCartSchema,
  type CartValidation,
  type VerifiedCart,
} from "@/features/shared/contracts";

import type { CommitAdjustment } from "./plan";

export interface ReconcileCommitInput {
  targets: Record<string, number>;
  adjustments: CommitAdjustment[];
  readback: VerifiedCart;
}

/** Matches the quantity tolerance used everywhere else in the domain. */
const QUANTITY_TOLERANCE = 1e-9;

/**
 * Decides the terminal outcome of a commit.
 *
 * The gateway cannot make this call: it does not know what was approved, so
 * it can only say `verified` or `blocked`. Only this function sees the
 * persisted targets and the pre-write adjustments, which is what separates a
 * cart that got everything from one that got part of it.
 */
export function reconcileCommit(input: ReconcileCommitInput): VerifiedCart {
  const validations: CartValidation[] = [
    ...input.readback.validations,
    ...input.adjustments.map((adjustment) => ({
      severity: "warning" as const,
      code: adjustment.code,
      message: adjustment.message,
      productId: adjustment.productId,
    })),
  ];

  const hasError = validations.some((validation) => validation.severity === "error");
  const targetIds = Object.keys(input.targets);
  const quantityById = new Map(
    input.readback.items.map((item) => [item.productId, item.quantity]),
  );
  const unmet = targetIds.some((productId) => {
    const quantity = quantityById.get(productId);
    return quantity === undefined || quantity + QUANTITY_TOLERANCE < input.targets[productId];
  });

  const status = hasError || targetIds.length === 0
    ? "blocked"
    : unmet || input.adjustments.length > 0
      ? "partially_committed"
      : "verified";

  return VerifiedCartSchema.parse({
    cartId: input.readback.cartId,
    status,
    items: input.readback.items,
    // The server's arithmetic is the authority; recomputing it here would
    // invent a second source of truth for money.
    total: input.readback.total,
    validations,
    checkoutLinks: status === "verified" ? input.readback.checkoutLinks : null,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run src/features/cart/reconcile.test.ts
```

Expected: PASS.

### 16.5 — Record the terminal draft status without disturbing versions or tombstones

**Files:**
- Modify: `src/features/drafts/repository.ts`
- Modify: `src/features/drafts/repository.test.ts`

**Interfaces:**
- Consumes: existing `drafts` table and `MemoryDraftRow` store.
- Produces: `DraftRepository.recordCommitOutcome(input): Promise<RecordCommitOutcomeResult>`.

- [ ] **Step 1: Write the failing repository tests**

Append to `src/features/drafts/repository.test.ts`. Run every case against the in-memory implementation, and mirror the ownership and conflict cases in the existing Postgres describe block so both implementations stay in parity:

```ts
describe("recordCommitOutcome", () => {
  it("moves a confirming draft to a terminal status without changing its version", async () => {
    const repository = createInMemoryDraftRepository();
    await repository.save(USER, readyDraft);
    await repository.approveSelection(approvalInputFor(readyDraft));

    const outcome = await repository.recordCommitOutcome({
      draftId: readyDraft.id,
      userId: USER,
      status: "verified",
    });

    expect(outcome).toBe("updated");
    const stored = await repository.get(readyDraft.id, USER);
    expect(stored?.status).toBe("verified");
    expect(stored?.version).toBe(readyDraft.version + 1);
  });

  it("keeps removed decisions as tombstones", async () => {
    // approve a selection that removes one of two items, then record the outcome
    await repository.recordCommitOutcome({ draftId: readyDraft.id, userId: USER, status: "blocked" });
    const stored = await repository.get(readyDraft.id, USER);
    expect(stored?.items.map((entry) => entry.productId)).toEqual(["p-1"]);
    // the tombstone is invisible to a normal read but must still exist for diagnostics
    expect(await repository.getApproval(readyDraft.id, USER)).not.toBeNull();
  });

  it("does not change item quantities or prices", async () => {
    const before = await repository.get(readyDraft.id, USER);
    await repository.recordCommitOutcome({ draftId: readyDraft.id, userId: USER, status: "partially_committed" });
    const after = await repository.get(readyDraft.id, USER);
    expect(after?.items).toEqual(before?.items);
    expect(after?.total).toBe(before?.total);
  });

  it("returns not_found for an unknown draft", async () => {
    await expect(repository.recordCommitOutcome({
      draftId: "11111111-1111-4111-8111-111111111111",
      userId: USER,
      status: "verified",
    })).resolves.toBe("not_found");
  });

  it("returns not_found for a draft owned by someone else", async () => {
    await expect(repository.recordCommitOutcome({
      draftId: readyDraft.id,
      userId: "another-user",
      status: "verified",
    })).resolves.toBe("not_found");
  });

  it("returns conflict for a draft that was never approved", async () => {
    const repository = createInMemoryDraftRepository();
    await repository.save(USER, readyDraft);
    await expect(repository.recordCommitOutcome({
      draftId: readyDraft.id,
      userId: USER,
      status: "verified",
    })).resolves.toBe("conflict");
  });

  it("is idempotent across repeated identical outcomes", async () => {
    await repository.recordCommitOutcome({ draftId: readyDraft.id, userId: USER, status: "verified" });
    await expect(repository.recordCommitOutcome({
      draftId: readyDraft.id,
      userId: USER,
      status: "verified",
    })).resolves.toBe("updated");
  });

  it("rejects a status that is not a terminal commit status", async () => {
    await expect(repository.recordCommitOutcome({
      draftId: readyDraft.id,
      userId: USER,
      status: "ready" as unknown as "verified",
    })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run src/features/drafts/repository.test.ts
```

Expected: FAIL, because `recordCommitOutcome` is not a function.

- [ ] **Step 3: Add the types and the interface method**

In `src/features/drafts/repository.ts`, next to the other exported types:

```ts
export interface RecordCommitOutcomeInput {
  draftId: string;
  userId: string;
  status: "verified" | "partially_committed" | "blocked";
}

export type RecordCommitOutcomeResult = "updated" | "not_found" | "conflict";

const recordCommitOutcomeInputSchema = z.object({
  draftId: nonEmptyString,
  userId: nonEmptyString,
  status: z.enum(["verified", "partially_committed", "blocked"]),
}).strict();

/**
 * A commit outcome may only land on a draft that was approved. Allowing the
 * terminal statuses too keeps a replayed commit from reporting a conflict for
 * work that already succeeded.
 */
const COMMITTABLE_STATUSES = new Set([
  "confirming",
  "verified",
  "partially_committed",
  "blocked",
]);
```

Add to the `DraftRepository` interface:

```ts
  recordCommitOutcome(input: RecordCommitOutcomeInput): Promise<RecordCommitOutcomeResult>;
```

- [ ] **Step 4: Implement it in the in-memory repository**

Inside `createInMemoryDraftRepository`'s returned object:

```ts
    async recordCommitOutcome(input: RecordCommitOutcomeInput): Promise<RecordCommitOutcomeResult> {
      const parsed = recordCommitOutcomeInputSchema.parse(input);
      const row = draftsById.get(parsed.draftId);
      if (!row || row.userId !== parsed.userId) {
        return "not_found";
      }
      if (!COMMITTABLE_STATUSES.has(row.draft.status)) {
        return "conflict";
      }
      // Status only: version, items, and decision tombstones are untouched.
      row.draft = { ...row.draft, status: parsed.status };
      return "updated";
    },
```

- [ ] **Step 5: Implement it in the Postgres repository**

Inside `createPostgresDraftRepository`'s returned object:

```ts
    async recordCommitOutcome(input: RecordCommitOutcomeInput): Promise<RecordCommitOutcomeResult> {
      const parsed = recordCommitOutcomeInputSchema.parse(input);

      const [existing] = await db
        .select({ status: drafts.status })
        .from(drafts)
        .where(and(eq(drafts.id, parsed.draftId), eq(drafts.userId, parsed.userId)))
        .limit(1);

      if (!existing) {
        return "not_found";
      }
      if (!COMMITTABLE_STATUSES.has(existing.status ?? "")) {
        return "conflict";
      }

      // No version bump and no `draft_items` write: Task 15's removed-decision
      // rows must survive a commit outcome.
      await db
        .update(drafts)
        .set({ status: parsed.status, updatedAt: new Date() })
        .where(and(eq(drafts.id, parsed.draftId), eq(drafts.userId, parsed.userId)));

      return "updated";
    },
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
pnpm vitest run src/features/drafts/repository.test.ts
```

Expected: PASS.

### 16.6 — Implement the commit application service

**Files:**
- Create: `src/features/cart/commit-service.ts`
- Create: `src/features/cart/commit-service.test.ts`

**Interfaces:**
- Consumes: `DraftRepository`, `CartCommitRepository`, `SilpoGatewayHandle`, `planCommit`, `reconcileCommit`.
- Produces: `commitApprovedDraft(input, deps): Promise<Result<VerifiedCart, CartCommitFailure>>`.

- [ ] **Step 1: Write the failing safety tests**

Create `src/features/cart/commit-service.test.ts`. Build a fake gateway whose every method is a `vi.fn`, so a test can assert both what was called and what was not:

```ts
import { describe, expect, it, vi } from "vitest";

import { commitApprovedDraft } from "@/features/cart/commit-service";
import { createInMemoryCartCommitRepository } from "@/features/cart/repository";
import { createInMemoryDraftRepository } from "@/features/drafts/repository";
import type { SilpoGateway } from "@/features/shared/contracts";

const USER = "00000000-0000-4000-8000-000000000001";
const DRAFT_ID = "00000000-0000-4000-8000-000000000016";
const KEY = "00000000-0000-4000-8000-000000000a16";
const CART_ID = "cart-1";
const CONTEXT = {
  cartId: CART_ID,
  deliveryType: "delivery" as const,
  city: "Київ",
  branchId: "branch-7",
  slot: {
    id: "slot-1",
    startsAt: "2026-09-09T10:00:00.000+03:00",
    endsAt: "2026-09-09T12:00:00.000+03:00",
    available: true,
  },
};

function makeGateway(overrides: Partial<SilpoGateway> = {}) {
  const gateway = {
    listTools: vi.fn(async () => []),
    loadCustomerContext: vi.fn(),
    loadCartContext: vi.fn(async () => ({ status: "ready" as const, context: CONTEXT })),
    updateCartContext: vi.fn(),
    loadPurchaseHistory: vi.fn(),
    findProducts: vi.fn(async (_context, queries: string[]) =>
      queries.map((query) => ({ query, products: [productFor(query)] })),
    ),
    getPromotions: vi.fn(),
    getProductDetails: vi.fn(),
    getSimilarProducts: vi.fn(),
    getReplacements: vi.fn(),
    getTimeSlots: vi.fn(),
    setAbsoluteCartQuantities: vi.fn(async () => {}),
    readCart: vi.fn(async () => cartAfterWrite()),
    ...overrides,
  };
  const close = vi.fn(async () => {});
  return { gateway, close, handle: { gateway, close } };
}
```

Add one runner so no test in this file calls an undefined helper:

```ts
function runCommit(
  deps: { drafts: DraftRepository; commits: CartCommitRepository; handle: SilpoGatewayHandle },
  overrides: Partial<CommitApprovedDraftInput> = {},
) {
  return commitApprovedDraft(
    { draftId: DRAFT_ID, userId: USER, idempotencyKey: KEY, correlationId: "c1", ...overrides },
    { drafts: deps.drafts, commits: deps.commits, openGateway: async () => deps.handle },
  );
}
```

Write these behaviors. **Every sketch below is abbreviated for reading, not for typing:** each `// comment` marks a fixture you must write out as a complete literal, and every `result`, `commits`, `drafts`, `gateway`, `handle`, `SLOT`, `DRAFT_ID`, and `confirmingDraft` must be defined in the file before it is used. A test that references an undefined binding is a plan failure, not a shortcut. `productFor` returns a `ProductCandidate` matching the draft item's `productId`, and `cartAfterWrite` returns a `VerifiedCart`.

```ts
it("T16-01 refuses to write without a persisted approval", async () => {
  const { gateway, handle } = makeGateway();
  const drafts = createInMemoryDraftRepository();
  await drafts.save(USER, confirmingDraft);

  const result = await commitApprovedDraft(
    { draftId: confirmingDraft.id, userId: USER, idempotencyKey: KEY, correlationId: "c1" },
    { drafts, commits: createInMemoryCartCommitRepository(), openGateway: async () => handle },
  );

  expect(result).toEqual({
    ok: false,
    error: { code: "approval_required", message: "Спочатку підтвердьте чернетку.", correlationId: "c1" },
  });
  expect(gateway.setAbsoluteCartQuantities).not.toHaveBeenCalled();
});

it("T16-02 refuses to write when the submitted key is not the approved key", async () => {
  // approve to obtain the real key, then commit with a different UUID
  expect(result.ok).toBe(false);
  expect(gateway.setAbsoluteCartQuantities).not.toHaveBeenCalled();
});

it("T16-03 returns not_found for an unknown or unowned draft", async () => {
  expect((result as { error: { code: string } }).error.code).toBe("not_found");
  expect(gateway.setAbsoluteCartQuantities).not.toHaveBeenCalled();
});

it("T16-04 refuses to write when the cart has no valid slot and returns the offered slots", async () => {
  const { gateway, handle } = makeGateway({
    loadCartContext: vi.fn(async () => ({ status: "needs_slot" as const, availableSlots: [SLOT] })),
  });
  const result = await commit(...);
  expect(result).toEqual({
    ok: false,
    error: {
      code: "needs_slot",
      message: "Оберіть доступний час доставки.",
      correlationId: "c1",
      availableSlots: [SLOT],
    },
  });
  expect(gateway.setAbsoluteCartQuantities).not.toHaveBeenCalled();
});

it("T16-04b refuses to write on a retry whose slot has since expired", async () => {
  // a pending record already holds targets { "p-1": 3 } for this key
  const { gateway, handle } = makeGateway({
    loadCartContext: vi.fn(async () => ({ status: "needs_slot" as const, availableSlots: [SLOT] })),
  });
  const result = await runCommit({ drafts, commits: commitsWithPendingRecord, handle });

  expect(result).toMatchObject({ ok: false, error: { code: "needs_slot" } });
  expect(gateway.setAbsoluteCartQuantities).not.toHaveBeenCalled();
});

it("T16-05 writes the cart's current quantity plus the approved quantity", async () => {
  // cart already holds 1 of p-1; the approved draft asks for 2
  expect(gateway.setAbsoluteCartQuantities).toHaveBeenCalledWith({
    cartId: CART_ID,
    items: [{ productId: "p-1", quantity: 3 }],
    addQuantity: false,
  });
});

it("T16-06 does not double-add after an uncertain first result", async () => {
  const setAbsoluteCartQuantities = vi.fn()
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce(undefined);
  // first attempt: the cart holds 1 of p-1 and the write fails
  const first = await commit(...);
  expect(first).toMatchObject({ ok: false, error: { code: "commit_uncertain" } });

  // the cart now holds 3 of p-1, because the write may in fact have landed
  const second = await commit(...);

  expect(setAbsoluteCartQuantities).toHaveBeenNthCalledWith(2, expect.objectContaining({
    items: [{ productId: "p-1", quantity: 3 }],
    addQuantity: false,
  }));
  expect(second.ok).toBe(true);
});

it("T16-07 leaves the commit record pending after an uncertain result", async () => {
  await expect(commits.get(KEY)).resolves.toMatchObject({
    status: "pending",
    targetQuantities: { "p-1": 3 },
  });
});

it("T16-07b still reports pre-write warnings on a retry, without recomputing targets", async () => {
  // a pending record holds targets { "p-1": 3 }; the refresh now caps stock at 2
  const result = await runCommit({ drafts, commits: commitsWithPendingRecord, handle });

  // The persisted target is written unchanged...
  expect(gateway.setAbsoluteCartQuantities).toHaveBeenCalledWith(expect.objectContaining({
    items: [{ productId: "p-1", quantity: 3 }],
  }));
  // ...but the retry still reports what the refresh found.
  expect(result.value.validations.map((entry) => entry.code)).toContain("stock_capped");
  expect(result.value.status).toBe("partially_committed");
});

it("T16-08 replays a terminal record without touching the cart", async () => {
  const first = await commit(...);
  gateway.setAbsoluteCartQuantities.mockClear();
  gateway.readCart.mockClear();

  const second = await commit(...);

  expect(second).toEqual(first);
  expect(gateway.setAbsoluteCartQuantities).not.toHaveBeenCalled();
  expect(gateway.readCart).not.toHaveBeenCalled();
});

it("T16-09 caps an approved quantity at stock, warns, and cannot report verified", async () => {
  // refreshed stock 2 while the plan wanted 3
  expect(gateway.setAbsoluteCartQuantities).toHaveBeenCalledWith(expect.objectContaining({
    items: [{ productId: "p-1", quantity: 2 }],
  }));
  expect(result.value.status).toBe("partially_committed");
  expect(result.value.checkoutLinks).toBeNull();
});

it("T16-10 never writes a product it did not resolve by ID", async () => {
  // findProducts returns a same-named product with a different productId
  expect(gateway.setAbsoluteCartQuantities).not.toHaveBeenCalled();
  expect(result.value.status).toBe("blocked");
});

it("T16-11 blocks without a write when every approved line is excluded", async () => {
  const { gateway } = makeGateway({ findProducts: vi.fn(async (_c, queries) => queries.map((query) => ({ query, products: [] }))) });
  expect(gateway.setAbsoluteCartQuantities).not.toHaveBeenCalled();
  expect(result.value.status).toBe("blocked");
  await expect(commits.get(KEY)).resolves.toBeNull();
});

it("T16-12 never writes or modifies a service row the user did not approve", async () => {
  // the pre-write cart holds a bag line "p-bag" that is not in the draft
  const written = gateway.setAbsoluteCartQuantities.mock.calls[0][0];
  expect(written.items.map((item) => item.productId)).toEqual(["p-1"]);
  expect(result.value.items.find((item) => item.productId === "p-bag")?.quantity).toBe(1);
});

it("T16-13 blocks and hides checkout when the readback carries an error validation", async () => {
  expect(result.value.status).toBe("blocked");
  expect(result.value.checkoutLinks).toBeNull();
  await expect(commits.get(KEY)).resolves.toMatchObject({ status: "blocked" });
});

it("T16-14 returns checkout links and records the draft outcome for a clean commit", async () => {
  expect(result.value.status).toBe("verified");
  expect(result.value.checkoutLinks).toEqual({
    web: "https://silpo.ua/cart/cart-1",
    mobile: "https://silpo.ua/app/cart/cart-1",
  });
  await expect(drafts.get(confirmingDraft.id, USER)).resolves.toMatchObject({ status: "verified" });
});

it("T16-15 still returns a successful commit when recording the draft outcome fails", async () => {
  const drafts = { ...inMemory, recordCommitOutcome: vi.fn(async () => { throw new Error("db down"); }) };
  expect(result.ok).toBe(true);
});

it("T16-16 closes the gateway handle on success and on failure", async () => {
  const { close } = makeGateway();
  await commit(...);
  expect(close).toHaveBeenCalledTimes(1);

  // and again with loadCartContext rejecting
  expect(close).toHaveBeenCalledTimes(1);
});

it("T16-17 reports an unexpected failure without leaking the cause", async () => {
  const { handle } = makeGateway({ readCart: vi.fn(async () => { throw new Error("https://mcp.silpo.ua secret-token"); }) });
  const result = await commit(...);
  expect(result).toEqual({
    ok: false,
    error: { code: "unexpected", message: "Не вдалося оновити кошик. Спробуйте ще раз.", correlationId: "c1" },
  });
  expect(JSON.stringify(result)).not.toContain("secret-token");
});

it("T16-18 produces the same outcome in demo mode as in live mode from the same facts", async () => {
  // run the identical fixtures through a gateway built from the demo snapshot
  expect(demoResult.value.status).toBe(liveResult.value.status);
  expect(demoResult.value.validations).toEqual(liveResult.value.validations);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run src/features/cart/commit-service.test.ts
```

Expected: FAIL with a module-not-found error for `@/features/cart/commit-service`.

- [ ] **Step 3: Implement the service**

Create `src/features/cart/commit-service.ts`:

```ts
import { z } from "zod";

import {
  VerifiedCartSchema,
  type CartContext,
  type DraftItem,
  type ProductCandidate,
  type ProductSearchResult,
  type TimeSlot,
  type VerifiedCart,
} from "@/features/shared/contracts";
import type { DraftRepository } from "@/features/drafts/repository";
import type { SilpoGatewayHandle } from "@/features/silpo/gateway";
import { err, ok, type Result } from "@/lib/result";

import { planCommit } from "./plan";
import { reconcileCommit } from "./reconcile";
import type { CartCommitRepository } from "./repository";

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

const FAILURE_COPY: Record<CartCommitFailureCode, string> = {
  not_found: "Чернетку не знайдено. Створіть нову.",
  approval_required: "Спочатку підтвердьте чернетку.",
  needs_slot: "Оберіть доступний час доставки.",
  commit_uncertain: "Не вдалося підтвердити запис у кошик. Спробуйте ще раз.",
  unexpected: "Не вдалося оновити кошик. Спробуйте ще раз.",
};

/** The shape `CartCommitRepository.saveResult` persists. */
const StoredCommitResultSchema = z.object({
  status: z.enum(["verified", "partially_committed", "blocked"]),
  data: z.object({ cart: VerifiedCartSchema }),
});

function failure(code: CartCommitFailureCode, correlationId: string) {
  return err<CartCommitFailure>({ code, message: FAILURE_COPY[code], correlationId });
}

/**
 * Matches each approved item to its refreshed catalog entry by product ID
 * only. A same-named product with a different ID is not the approved
 * product, and silently substituting one would write something the user
 * never confirmed.
 */
function indexRefreshed(
  items: DraftItem[],
  searches: ProductSearchResult[],
): Record<string, ProductCandidate> {
  const productsByQuery = new Map(searches.map((result) => [result.query, result.products]));
  const refreshed: Record<string, ProductCandidate> = {};
  for (const item of items) {
    const match = productsByQuery
      .get(item.name)
      ?.find((candidate) => candidate.productId === item.productId);
    if (match) {
      refreshed[item.productId] = match;
    }
  }
  return refreshed;
}

const currentQuantitiesOf = (cart: VerifiedCart): Record<string, number> =>
  Object.fromEntries(cart.items.map((item) => [item.productId, item.quantity]));

const toTargetItems = (targets: Record<string, number>) =>
  Object.entries(targets).map(([productId, quantity]) => ({ productId, quantity }));

/**
 * The cart is already written by the time this runs. A failure to note the
 * outcome on the draft must never turn a successful commit into an error.
 */
async function recordOutcome(
  deps: CommitApprovedDraftDeps,
  input: CommitApprovedDraftInput,
  status: "verified" | "partially_committed" | "blocked",
): Promise<void> {
  try {
    await deps.drafts.recordCommitOutcome({
      draftId: input.draftId,
      userId: input.userId,
      status,
    });
  } catch {
    // Intentionally swallowed; see the comment above.
  }
}

export async function commitApprovedDraft(
  input: CommitApprovedDraftInput,
  deps: CommitApprovedDraftDeps,
): Promise<Result<VerifiedCart, CartCommitFailure>> {
  const now = deps.now ?? (() => new Date());
  let handle: SilpoGatewayHandle | undefined;

  try {
    const draft = await deps.drafts.get(input.draftId, input.userId);
    if (!draft) return failure("not_found", input.correlationId);

    // The approval record is the only authorization for a cart write.
    const approval = await deps.drafts.getApproval(input.draftId, input.userId);
    if (!approval || approval.idempotencyKey !== input.idempotencyKey) {
      return failure("approval_required", input.correlationId);
    }

    const existing = await deps.commits.get(input.idempotencyKey);
    if (existing && existing.status !== "pending") {
      const stored = StoredCommitResultSchema.safeParse(existing.result);
      return stored.success ? ok(stored.data.cart) : failure("unexpected", input.correlationId);
    }

    handle = await deps.openGateway();
    const { gateway } = handle;

    const context = await gateway.loadCartContext();
    if (context.status !== "ready") {
      return err<CartCommitFailure>({
        code: "needs_slot",
        message: FAILURE_COPY.needs_slot,
        correlationId: input.correlationId,
        availableSlots: context.availableSlots,
      });
    }
    const cartContext: CartContext = context.context;

    const before = await gateway.readCart(cartContext.cartId);
    const searches = await gateway.findProducts(
      cartContext,
      draft.items.map((item) => item.name),
    );

    // The refresh runs on every attempt, but only the first one is allowed to
    // decide quantities. On a retry it contributes validations alone, so the
    // reported outcome stays faithful without ever recomputing a target from
    // a cart the first attempt may already have changed.
    const plan = planCommit({
      approvedItems: draft.items,
      currentQuantities: currentQuantitiesOf(before),
      refreshed: indexRefreshed(draft.items, searches),
    });

    let targets: Record<string, number>;
    if (existing) {
      targets = existing.targetQuantities;
    } else if (Object.keys(plan.targets).length === 0) {
      // `cart_commits.target_quantities` rejects an empty map, so there is no
      // record to persist and nothing to write.
      const blocked = reconcileCommit({
        targets: {},
        adjustments: plan.adjustments,
        readback: before,
      });
      await recordOutcome(deps, input, blocked.status);
      return ok(blocked);
    } else {
      const started = await deps.commits.start({
        key: input.idempotencyKey,
        targetQuantities: plan.targets,
        userId: input.userId,
        draftId: input.draftId,
        confirmationTimestamp: now(),
      });
      targets = started.targetQuantities;
    }

    try {
      await gateway.setAbsoluteCartQuantities({
        cartId: cartContext.cartId,
        items: toTargetItems(targets),
        addQuantity: false,
      });
    } catch {
      // Never retried here. The record stays `pending`, so the next request
      // with this key reuses the same absolute targets.
      return failure("commit_uncertain", input.correlationId);
    }

    const after = await gateway.readCart(cartContext.cartId);
    const result = reconcileCommit({
      targets,
      adjustments: plan.adjustments,
      readback: after,
    });

    await deps.commits.saveResult(input.idempotencyKey, {
      status: result.status,
      data: { cart: result },
    });
    await recordOutcome(deps, input, result.status);

    return ok(result);
  } catch {
    return failure("unexpected", input.correlationId);
  } finally {
    // A failure to close never masks the commit's own outcome.
    await handle?.close().catch(() => {});
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run src/features/cart/commit-service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the whole cart and drafts surface**

```bash
pnpm vitest run src/features/cart src/features/drafts
```

Expected: PASS.

### 16.7 — Expose the commit as an owned route

**Files:**
- Create: `src/app/api/cart/commit/handlers.ts`
- Create: `src/app/api/cart/commit/route.ts`
- Create: `tests/integration/cart-commit-route.test.ts`

**Interfaces:**
- Consumes: `commitApprovedDraft`, `resolveSilpoSession`, `ensureDemoUser`, `createPostgresDraftRepository`, `createPostgresCartCommitRepository`, `createSilpoGateway`.
- Produces: `createCartCommitPostHandler(overrides): (request) => Promise<NextResponse>` and `CartCommitRequestSchema`.

- [ ] **Step 1: Write the failing route tests**

Create `tests/integration/cart-commit-route.test.ts`, following the request helper already used by `tests/integration/draft-approval.test.ts`. This route has no dynamic segment, so the handler takes only a request:

```ts
function post(body: unknown, cookies: Record<string, string> = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  const cookie = Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join("; ");
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest("https://app.silpo-test.ua/api/cart/commit", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function makeDeps(overrides: Partial<CartCommitHandlerDeps> = {}): CartCommitHandlerDeps {
  return {
    getEnv: () => makeEnv({ DATA_MODE: "demo" }),
    resolveSession: async () => ok({ userId: "live-user" }),
    resolveDemoIdentity: async (handle) => ({
      userId: handle ? demoUserIdFor(handle) : "00000000-0000-4000-8000-00000000de15",
      handle: handle ?? DEMO_HANDLE,
      issued: handle === null,
    }),
    drafts: () => draftRepository,
    commits: () => commitRepository,
    openGateway: async () => gatewayHandle,
    commit: commitApprovedDraft,
    ...overrides,
  };
}
```

Behaviors:

```ts
it("T16-19 returns the verified cart for an approved demo draft", async () => {
  const response = await handler(post({ draftId: DRAFT_ID, idempotencyKey: KEY }, { demo_session: handle }));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    cartId: "cart-1",
    status: "verified",
    checkoutLinks: { web: expect.stringContaining("https://") },
  });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
});

it("T16-20 replays the stored result for a repeated POST without a second write", async () => {
  const first = await handler(post({ draftId: DRAFT_ID, idempotencyKey: KEY }, cookies));
  const second = await handler(post({ draftId: DRAFT_ID, idempotencyKey: KEY }, cookies));
  expect(await second.json()).toEqual(await first.json());
  expect(gateway.setAbsoluteCartQuantities).toHaveBeenCalledTimes(1);
});

it.each([
  ["a malformed JSON body", "not json", 400],
  ["a non-UUID draft ID", { draftId: "abc", idempotencyKey: KEY }, 400],
  ["a non-UUID key", { draftId: DRAFT_ID, idempotencyKey: "abc" }, 400],
  ["an unknown extra field", { draftId: DRAFT_ID, idempotencyKey: KEY, quantity: 99 }, 400],
])("T16-21 rejects %s with %i", async (_label, body, status) => {
  expect((await handler(post(body, cookies))).status).toBe(status);
});

it("T16-22 returns 401 when a live session cannot be resolved", async () => {
  const handler = createCartCommitPostHandler(makeDeps({
    getEnv: () => makeEnv({ DATA_MODE: "live" }),
    resolveSession: async () => err({ code: "unauthorized", message: "x", correlationId: "c", retryAfterMs: null }),
  }));
  expect((await handler(post({ draftId: DRAFT_ID, idempotencyKey: KEY }))).status).toBe(401);
});

it("T16-23 maps every service failure code to its status", async () => {
  // 404 not_found, 409 approval_required, 409 needs_slot, 502 commit_uncertain, 500 unexpected
  expect(statusFor("not_found")).toBe(404);
  expect(statusFor("approval_required")).toBe(409);
  expect(statusFor("needs_slot")).toBe(409);
  expect(statusFor("commit_uncertain")).toBe(502);
  expect(statusFor("unexpected")).toBe(500);
});

it("T16-24 returns the offered slots in the needs_slot body", async () => {
  const body = await response.json();
  expect(body.error).toMatchObject({ code: "needs_slot", availableSlots: [SLOT] });
});

it("T16-25 ignores a client-supplied user ID and mode", async () => {
  const handler = createCartCommitPostHandler(makeDeps({ getEnv: () => makeEnv({ DATA_MODE: "demo" }) }));
  const response = await handler(post({
    draftId: DRAFT_ID, idempotencyKey: KEY, userId: "someone-else", mode: "live",
  }, cookies));
  expect(response.status).toBe(400);
});

it("T16-26 never calls resolveSession in demo mode and never reads the demo cookie in live mode", async () => {
  expect(resolveSession).not.toHaveBeenCalled();
  // and in live mode:
  expect(resolveDemoIdentity).not.toHaveBeenCalled();
});

it("T16-27 issues the demo cookie with the same policy as draft creation", async () => {
  const cookie = response.cookies.get("demo_session");
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
});

it("T16-28 never leaks a cause into an error body", async () => {
  const body = JSON.stringify(await response.json());
  expect(body).toContain("correlationId");
  expect(body).not.toMatch(/https?:\/\//);
  expect(body).not.toContain("token");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run tests/integration/cart-commit-route.test.ts
```

Expected: FAIL with a module-not-found error for the handler factory.

- [ ] **Step 3: Implement the handler factory**

Create `src/app/api/cart/commit/handlers.ts`:

```ts
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getDbClient } from "@/db/client";
import {
  commitApprovedDraft,
  type CartCommitFailureCode,
} from "@/features/cart/commit-service";
import {
  createPostgresCartCommitRepository,
  type CartCommitRepository,
} from "@/features/cart/repository";
import {
  DEMO_SESSION_COOKIE,
  DEMO_SESSION_MAX_AGE_SECONDS,
  ensureDemoUser,
  type DemoIdentity,
} from "@/features/drafts/demo-user";
import {
  createPostgresDraftRepository,
  type DraftRepository,
} from "@/features/drafts/repository";
import type { DataMode } from "@/features/shared/contracts";
import { createSilpoGateway, type SilpoGatewayHandle } from "@/features/silpo/gateway";
import { resolveSilpoSession } from "@/features/silpo/oauth/service";
import { getServerEnv, type ServerEnv } from "@/lib/env";
import type { AppError, Result } from "@/lib/result";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

const INVALID_REQUEST_COPY = "Некоректний запит.";
const UNAUTHORIZED_COPY = "Не вдалося підтвердити вхід. Увійдіть у «Сільпо» ще раз.";
const UNEXPECTED_COPY = "Не вдалося оновити кошик. Спробуйте ще раз.";

export interface CartCommitRequest {
  draftId: string;
  idempotencyKey: string;
}

export const CartCommitRequestSchema: z.ZodType<CartCommitRequest> = z.object({
  draftId: z.uuid(),
  idempotencyKey: z.uuid(),
}).strict();

export interface CartCommitHandlerDeps {
  getEnv: () => ServerEnv;
  resolveSession: (handle: string | null) => Promise<Result<{ userId: string }, AppError>>;
  resolveDemoIdentity: (cookieValue: string | null) => Promise<DemoIdentity>;
  drafts: () => DraftRepository;
  commits: () => CartCommitRepository;
  openGateway: (options: { mode: DataMode; userId: string }) => Promise<SilpoGatewayHandle>;
  commit: typeof commitApprovedDraft;
}

const STATUS_BY_CODE: Record<CartCommitFailureCode, number> = {
  not_found: 404,
  approval_required: 409,
  needs_slot: 409,
  // The one retryable failure: the client repeats the request with the same
  // key and the service reuses the persisted absolute targets.
  commit_uncertain: 502,
  unexpected: 500,
};

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: RESPONSE_HEADERS });
}

function invalidRequest(correlationId: string): NextResponse {
  return json({ error: { code: "invalid_request", message: INVALID_REQUEST_COPY, correlationId } }, 400);
}

function unauthorized(correlationId: string): NextResponse {
  return json({ error: { code: "unauthorized", message: UNAUTHORIZED_COPY, correlationId } }, 401);
}

function unexpected(correlationId: string): NextResponse {
  return json({ error: { code: "unexpected", message: UNEXPECTED_COPY, correlationId } }, 500);
}

function setDemoCookie(response: NextResponse, identity: DemoIdentity, env: ServerEnv): void {
  response.cookies.set(DEMO_SESSION_COOKIE, identity.handle, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: env.NODE_ENV === "production",
    maxAge: DEMO_SESSION_MAX_AGE_SECONDS,
  });
}

export function createCartCommitPostHandler(overrides: Partial<CartCommitHandlerDeps> = {}) {
  const getEnv = overrides.getEnv ?? (() => getServerEnv());
  const deps: CartCommitHandlerDeps = {
    getEnv,
    resolveSession: (handle) => resolveSilpoSession(handle),
    resolveDemoIdentity: (cookie) => ensureDemoUser(getDbClient(), cookie),
    drafts: () => createPostgresDraftRepository(getDbClient()),
    commits: () => createPostgresCartCommitRepository(getDbClient()),
    openGateway: ({ mode, userId }) =>
      createSilpoGateway({ mode, userId, publicBaseUrl: getEnv().PUBLIC_BASE_URL }),
    commit: commitApprovedDraft,
    ...overrides,
  };

  return async function POST(request: NextRequest) {
    const correlationId = randomUUID();

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return invalidRequest(correlationId);
    }
    const parsed = CartCommitRequestSchema.safeParse(body);
    if (!parsed.success) return invalidRequest(correlationId);

    let env: ServerEnv | null = null;
    let demoIdentity: DemoIdentity | null = null;
    try {
      env = deps.getEnv();
      let userId: string;
      if (env.DATA_MODE === "demo") {
        demoIdentity = await deps.resolveDemoIdentity(
          request.cookies.get(DEMO_SESSION_COOKIE)?.value ?? null,
        );
        userId = demoIdentity.userId;
      } else {
        const session = await deps.resolveSession(
          request.cookies.get("silpo_session")?.value ?? null,
        );
        if (!session.ok) return unauthorized(correlationId);
        userId = session.value.userId;
      }

      const mode = env.DATA_MODE;
      const result = await deps.commit(
        {
          draftId: parsed.data.draftId,
          userId,
          idempotencyKey: parsed.data.idempotencyKey,
          correlationId,
        },
        {
          drafts: deps.drafts(),
          commits: deps.commits(),
          openGateway: () => deps.openGateway({ mode, userId }),
        },
      );

      const response = result.ok
        ? json(result.value, 200)
        : json({ error: result.error }, STATUS_BY_CODE[result.error.code]);
      if (demoIdentity?.issued) setDemoCookie(response, demoIdentity, env);
      return response;
    } catch {
      const response = unexpected(correlationId);
      if (demoIdentity?.issued && env) setDemoCookie(response, demoIdentity, env);
      return response;
    }
  };
}
```

- [ ] **Step 4: Add the thin route**

Create `src/app/api/cart/commit/route.ts`:

```ts
import { createCartCommitPostHandler } from "./handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const POST = createCartCommitPostHandler();
```

- [ ] **Step 5: Run the route test to verify it passes**

```bash
pnpm vitest run tests/integration/cart-commit-route.test.ts
```

Expected: PASS.

### 16.8 — Update durable documentation and run the final gates

**Files:**
- Modify: `docs/project-architecture.md`
- Modify: `docs/tasks.md`

- [ ] **Step 1: Refine architecture section 7.5**

The numbered protocol stays. Append these four bullets under it, because they are rules this task discovered and a future agent cannot recover from the code alone:

```markdown
- Каталожне оновлення виконується на кожній спробі, але лише перша визначає absolute targets. На повторі targets беруться з persisted record, а оновлення дає тільки validations.
- Пре-write коригування (`unavailable_product`, `stock_capped`, `step_adjusted`, `price_changed`) є warning-ами: вони не блокують write, але унеможливлюють статус `verified`.
- Severity з Silpo мапиться так: `warning` — попередження, будь-яке інше або невідоме значення — помилка.
- `silpo_add_or_update_cart_products` потребує `branchId`, якого немає в `SetCartProductsInput`, тому gateway спершу читає кошик. Це read-only виклик; сам write не має retry.
- Чернетка, у якій жодну позицію не вдалося підтвердити, дає `blocked` без write і без commit record, оскільки `cart_commits.target_quantities` не приймає порожню мапу.
```

- [ ] **Step 2: Add the new error category to architecture section 9**

Add one line to the normalized error list:

```markdown
- `commit_uncertain`: результат запису невідомий; повтор із тим самим ключем використовує збережені absolute targets;
```

- [ ] **Step 3: Update the Task 16 entry in `docs/tasks.md`**

Replace the Task 16 **Files** block with the full list from this plan's File Structure table, tick every step checkbox, and append a completion note in the same style as Task 15's, naming the spec and this plan, the evidence commands, and the two carried risks: unverified Silpo cart-line and checkout field names, and the unowned client story that blocks Task 18.

- [ ] **Step 4: Run the focused suites**

```bash
pnpm vitest run \
  src/features/cart/plan.test.ts \
  src/features/cart/reconcile.test.ts \
  src/features/cart/commit-service.test.ts \
  src/features/cart/repository.test.ts \
  src/features/silpo/live/cart.test.ts \
  src/features/silpo/schemas/cart.test.ts \
  src/features/silpo/gateway.test.ts \
  src/features/drafts/repository.test.ts \
  tests/contract/silpo-cart-write.test.ts \
  tests/integration/cart-commit-route.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the cumulative suites and static gates**

```bash
pnpm vitest run
pnpm lint
pnpm typecheck
pnpm build
```

Expected: PASS for all four. Do not proceed on a failure; fix the cause rather than the assertion.

- [ ] **Step 6: Review the diff for scope and safety**

```bash
git status --short && git diff
```

Confirm: no UI file, no `SILPO_MCP.md` change, no migration, no lockfile change, no `NotImplementedForDraftRunError` reference, no secret, no placeholder, and no cart-write path that skips approval, slot validation, readback, or checkout gating.

- [ ] **Step 7: Commit once**

```bash
git add \
  src/features/silpo/schemas/cart.ts \
  src/features/silpo/schemas/cart.test.ts \
  src/features/silpo/live/cart.ts \
  src/features/silpo/live/cart.test.ts \
  src/features/silpo/gateway.ts \
  src/features/silpo/gateway.test.ts \
  src/features/cart/plan.ts \
  src/features/cart/plan.test.ts \
  src/features/cart/reconcile.ts \
  src/features/cart/reconcile.test.ts \
  src/features/cart/commit-service.ts \
  src/features/cart/commit-service.test.ts \
  src/features/drafts/repository.ts \
  src/features/drafts/repository.test.ts \
  src/app/api/cart/commit \
  tests/contract/silpo-cart-write.test.ts \
  tests/integration/cart-commit-route.test.ts \
  docs/project-architecture.md \
  docs/tasks.md
git commit -m "feat: commit verified Silpo carts"
```

- [ ] **Step 8: Report the handoff**

Report changed files, every command run with its fresh output, the commit hash, and the two carried risks from spec section 14. State explicitly that no live cart write was performed: a write smoke requires fresh manual confirmation and is outside this task.
