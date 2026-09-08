# Draft Orchestration and API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn an authenticated identity into a persisted, explainable grocery draft, exposed as `POST /api/drafts`.

**Architecture:** A mode-dispatching gateway factory composes the live history, cart-context and catalog gateways over one MCP read session plus a lazily opened write session, or returns the demo gateway; a linear application service owns the order of the run, resolves the active city, calls the deterministic pipeline and the Gemini boundary, assembles a `Draft` and saves it; an injectable route handler resolves identity, maps typed failures to HTTP, and never accepts client input.

**Tech Stack:** TypeScript, Next.js App Router route handlers, Zod 4, Drizzle ORM over Postgres, Vitest, `@modelcontextprotocol/client`.

**Spec:** [docs/superpowers/specs/2026-09-08-draft-orchestration-design.md](../specs/2026-09-08-draft-orchestration-design.md)

## Global Constraints

- Use `pnpm` exclusively. This task adds no production dependency, no migration, no environment variable and no schema change.
- Do not edit any file outside the ownership list below. In particular: `src/features/shared/contracts.ts`, `src/lib/env.ts`, `src/lib/result.ts`, `src/db/schema.ts`, `drizzle/*`, `src/features/agent/*`, `src/features/prediction/*`, `src/features/products/*`, `src/features/purchases/*`, `src/features/drafts/repository.ts`, `src/features/silpo/live/*`, `src/features/silpo/oauth/*`, `src/features/silpo/demo/*`, `src/components/*`, `vitest.config.ts`, `fixtures/demo/silpo-snapshot.json`, `SILPO_MCP.md`.
- `src/features/drafts/service.ts` must not import `@/features/agent/google-model` or any `ai` / `@ai-sdk/*` specifier. Generation arrives as an injected function. A test asserts this.
- `src/features/drafts/assemble.ts` stays pure: contracts, `PREDICTION_ALGORITHM_VERSION`, and the `DraftProposal` type only.
- `service.ts` may import typed error classes from `@/features/silpo/live/*` and `@/features/silpo/schemas/common`; classification by `instanceof` is the repository's boundary idiom.
- No client input reaches the run. `POST /api/drafts` reads no request body and no query parameter; `mode` comes from `env.DATA_MODE`, `userId` from the server-side session or the demo constant.
- Live mode never returns the demo gateway. The draft run performs no cart write beyond the documented cart bootstrap.
- Secrets never leave the server: `GOOGLE_GENERATIVE_AI_API_KEY`, `TOKEN_ENCRYPTION_KEY`, `DATABASE_URL`, MCP tokens and the session handle never appear in a response body, an error message, a log line or a test.
- Raw MCP payloads, raw prompts and raw model output are never logged and never persisted.
- No test calls Google, opens a network socket, or requires a database.
- Ukrainian user-facing copy only, in the register the existing routes use.
- Work on branch `task-13-draft-orchestration`. Each task below ends in its own commit; the controller squashes the branch into one commit titled `feat: orchestrate personal drafts` at integration (Task 6).

## File Structure

| Path | Responsibility |
|---|---|
| `src/features/drafts/assemble.ts` | Pure: `DraftProposal` + `ResolvedNeed[]` → validated `Draft`. |
| `src/features/drafts/assemble.test.ts` | Field mapping, alternative ordering, total rounding, empty draft, unknown id. |
| `src/features/drafts/demo-user.ts` | `DEMO_USER_ID` and its idempotent upsert. |
| `src/features/drafts/demo-user.test.ts` | UUID shape, idempotence, exact Drizzle call. |
| `src/features/silpo/gateway.ts` | Mode dispatch, live composition, lazy write session, disposable handle. |
| `src/features/silpo/gateway.test.ts` | Dispatch, session budget, laziness, `close()`, Task-16 stubs. |
| `src/features/drafts/service.ts` | Run order, active-city rule, typed failures, `DraftRun` envelope. |
| `src/features/drafts/service.test.ts` | Order and write prohibition, `needs_slot`, fallback, persistence, failure table. |
| `src/app/api/drafts/handlers.ts` | Identity, mode gating, status mapping, response shape. |
| `src/app/api/drafts/route.ts` | Production wiring and segment config only. |
| `tests/integration/draft-route.test.ts` | Both modes, every mapped status, headers, no client input. |
| `docs/tasks.md`, `docs/project-architecture.md` | Record the decisions in their owning documents. |

## Verified Fixture Facts

These were measured against `fixtures/demo/silpo-snapshot.json` on 2026-09-08 and are used as exact assertions below. Do not soften them into "greater than zero" checks.

With the clock fixed at `2026-09-08T09:00:00.000Z`, the demo gateway produces:

- 29 normalized receipts, 6 need candidates (`water`, `dairy`, `bread`, `coffee`, `eggs`, `grains`, in that confidence order);
- 3 resolved needs, because the demo catalog has no product for `bread`, `coffee` or `eggs`;
- selected products `demo-water-still-15l` (price 24.9, no special), `demo-milk-25-900g` (47.9, no special), `demo-oatmeal-500g` (49.9, special 42.9), each with `step: 1` and `quantity: 1`;
- a draft total of `115.7` (24.9 + 47.9 + 42.9);
- the demo cart context `demo-cart-ready` in `Київ`, and `loyaltyBonusAvailable: 84.5`.

---

### Task 1: Draft assembly

**Files:**
- Create: `src/features/drafts/assemble.ts`
- Test: `src/features/drafts/assemble.test.ts`

**Interfaces:**
- Consumes: `DraftProposal` from `@/features/agent/draft-output`; `ResolvedNeed`, `Draft`, `DraftItem`, `ProductCandidate`, `DraftSchema`, `effectiveUnitPrice` from `@/features/shared/contracts`; `PREDICTION_ALGORITHM_VERSION` from `@/features/prediction/features`.
- Produces: `assembleDraft(input: AssembleDraftInput): Draft` and `class UnresolvedProposalItemError extends Error`. Task 4 calls both by these names.

- [ ] **Step 1: Write the failing test**

Create `src/features/drafts/assemble.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { DraftProposal } from "@/features/agent/draft-output";
import { DraftSchema, type NeedFeatures, type ProductCandidate, type ResolvedNeed } from "@/features/shared/contracts";

import { assembleDraft, UnresolvedProposalItemError } from "./assemble";

const features: NeedFeatures = {
  weightedPurchaseCount: 4,
  medianIntervalDays: 7,
  intervalMadDays: 1,
  daysSinceLastPurchase: 8,
  activeCityShare: 1,
  repeatScore: 0.8,
  dueScore: 1,
  stabilityScore: 0.9,
};

function product(overrides: Partial<ProductCandidate> = {}): ProductCandidate {
  return {
    productId: "p-1",
    externalProductId: 101,
    slug: "moloko",
    name: "Молоко 2.5%",
    imageUrl: null,
    price: 45.5,
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

function resolved(
  selected: ProductCandidate,
  alternatives: ProductCandidate[] = [],
  needOverrides: Partial<ResolvedNeed["need"]> = {},
): ResolvedNeed {
  return {
    need: {
      categoryKey: "dairy",
      confidence: 0.82,
      confidenceBand: "high",
      typicalQuantity: 1,
      reasonCodes: ["category_repeat", "cycle_due"],
      preferredExternalProductIds: [101],
      features,
      ...needOverrides,
    },
    selected,
    alternatives,
  };
}

const BASE = {
  id: "00000000-0000-4000-8000-000000000abc",
  mode: "demo" as const,
  trainingCutoff: "2026-09-08T09:00:00.000Z",
};

describe("assembleDraft", () => {
  it("maps product facts from the resolved need and prose from the proposal", () => {
    const selected = product({ promotions: [{ id: "promo-1", label: "-10%", price: 41 }] });
    const proposal: DraftProposal = {
      summary: "Ваш звичний набір",
      items: [{
        productId: "p-1",
        externalProductId: 101,
        quantity: 2,
        reason: "Купуєте приблизно щотижня",
        alternativeIds: [],
      }],
    };

    const draft = assembleDraft({ ...BASE, proposal, resolvedNeeds: [resolved(selected)] });

    expect(draft.items[0]).toMatchObject({
      productId: "p-1",
      name: "Молоко 2.5%",
      price: 45.5,
      step: 1,
      stock: 10,
      quantity: 2,
      reason: "Купуєте приблизно щотижня",
      confidence: 0.82,
      confidenceBand: "high",
      reasonCodes: ["category_repeat", "cycle_due"],
      nutritionStatus: "insufficient",
      promotions: [{ id: "promo-1", label: "-10%", price: 41 }],
    });
    expect(draft.algorithmVersion).toBe("prediction-v1");
    expect(draft.status).toBe("ready");
    expect(draft.version).toBe(1);
    expect(draft.mode).toBe("demo");
    expect(draft.trainingCutoff).toBe("2026-09-08T09:00:00.000Z");
    expect(DraftSchema.parse(draft)).toEqual(draft);
  });

  it("orders alternatives by the proposal's ranking and appends any it omitted", () => {
    const alternatives = [
      product({ productId: "alt-a", externalProductId: 201, slug: "a" }),
      product({ productId: "alt-b", externalProductId: 202, slug: "b" }),
      product({ productId: "alt-c", externalProductId: 203, slug: "c" }),
    ];
    const proposal: DraftProposal = {
      summary: "Ваш звичний набір",
      items: [{
        productId: "p-1",
        externalProductId: 101,
        quantity: 1,
        reason: "Купуєте приблизно щотижня",
        alternativeIds: ["alt-c", "alt-a"],
      }],
    };

    const draft = assembleDraft({
      ...BASE,
      proposal,
      resolvedNeeds: [resolved(product(), alternatives)],
    });

    expect(draft.items[0].alternatives.map((item) => item.productId)).toEqual(["alt-c", "alt-a", "alt-b"]);
  });

  it("totals the snapshots it wrote, preferring the special price, rounded to two decimals", () => {
    const proposal: DraftProposal = {
      summary: "Ваш звичний набір",
      items: [
        {
          productId: "p-1",
          externalProductId: 101,
          quantity: 3,
          reason: "Купуєте приблизно щотижня",
          alternativeIds: [],
        },
        {
          productId: "p-2",
          externalProductId: 102,
          quantity: 1,
          reason: "Час поповнити запас",
          alternativeIds: [],
        },
      ],
    };

    const draft = assembleDraft({
      ...BASE,
      proposal,
      resolvedNeeds: [
        resolved(product({ price: 10.115, specialPrice: null })),
        resolved(product({ productId: "p-2", externalProductId: 102, slug: "b", price: 49.9, specialPrice: 42.9 })),
      ],
    });

    // 3 × 10.115 = 30.345 → 30.35 after rounding, plus the 42.9 special.
    expect(draft.total).toBe(73.25);
    expect(DraftSchema.parse(draft)).toEqual(draft);
  });

  it("assembles an empty explained draft when nothing resolved", () => {
    const proposal: DraftProposal = {
      summary: "Поки що замало історії покупок, щоб зібрати чернетку.",
      items: [],
    };

    const draft = assembleDraft({ ...BASE, proposal, resolvedNeeds: [] });

    expect(draft.items).toEqual([]);
    expect(draft.total).toBe(0);
    expect(draft.status).toBe("ready");
    expect(draft.summary).toBe("Поки що замало історії покупок, щоб зібрати чернетку.");
  });

  it("throws rather than silently shortening the list for an unknown product id", () => {
    const proposal: DraftProposal = {
      summary: "Ваш звичний набір",
      items: [{
        productId: "ghost",
        externalProductId: 999,
        quantity: 1,
        reason: "Купуєте приблизно щотижня",
        alternativeIds: [],
      }],
    };

    expect(() => assembleDraft({ ...BASE, proposal, resolvedNeeds: [resolved(product())] }))
      .toThrow(UnresolvedProposalItemError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/features/drafts/assemble.test.ts`
Expected: FAIL — `Failed to resolve import "./assemble"`.

- [ ] **Step 3: Write the implementation**

Create `src/features/drafts/assemble.ts`:

```ts
import type { DraftProposal } from "@/features/agent/draft-output";
import { PREDICTION_ALGORITHM_VERSION } from "@/features/prediction/features";
import {
  DraftSchema,
  effectiveUnitPrice,
  type DataMode,
  type Draft,
  type DraftItem,
  type ProductCandidate,
  type ResolvedNeed,
} from "@/features/shared/contracts";

/**
 * A proposal item naming a product that never reached the resolver.
 * Unreachable in production — `validateProposal` rejects an unknown id and
 * the fallback builds only from `resolvedNeeds` — so it is thrown rather
 * than skipped: dropping the item would turn an upstream contract break
 * into a quietly shorter shopping list.
 */
export class UnresolvedProposalItemError extends Error {
  constructor(readonly productId: string) {
    super("proposal item has no resolved need");
    this.name = "UnresolvedProposalItemError";
  }
}

export interface AssembleDraftInput {
  id: string;
  mode: DataMode;
  trainingCutoff: string;
  proposal: DraftProposal;
  resolvedNeeds: ResolvedNeed[];
}

/**
 * The model's surviving ranking first, then anything it did not name, in
 * resolver order. `validateProposal` already completed and deduped the
 * list, so the tail is normally empty; it exists so a proposal built
 * before ranking never costs the guest a swap option.
 */
function orderAlternatives(resolved: ResolvedNeed, rankedIds: string[]): ProductCandidate[] {
  const remaining = new Map(resolved.alternatives.map((product) => [product.productId, product]));
  const ordered: ProductCandidate[] = [];
  for (const id of rankedIds) {
    const product = remaining.get(id);
    if (product !== undefined) {
      ordered.push(product);
      remaining.delete(id);
    }
  }
  return [...ordered, ...remaining.values()];
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Field by field from two sources: prose and quantity from the proposal,
 * every purchasable fact from the resolved need. Nothing is spread, so a
 * field added to either side is excluded by default rather than admitted.
 */
export function assembleDraft(input: AssembleDraftInput): Draft {
  const byProductId = new Map(
    input.resolvedNeeds.map((resolved) => [resolved.selected.productId, resolved]),
  );

  const items: DraftItem[] = input.proposal.items.map((item) => {
    const resolved = byProductId.get(item.productId);
    if (resolved === undefined) {
      throw new UnresolvedProposalItemError(item.productId);
    }
    const product = resolved.selected;
    return {
      productId: item.productId,
      externalProductId: item.externalProductId,
      name: product.name,
      imageUrl: product.imageUrl,
      displayRatio: product.displayRatio,
      quantity: item.quantity,
      price: product.price,
      specialPrice: product.specialPrice,
      stock: product.stock,
      step: product.step,
      confidence: resolved.need.confidence,
      confidenceBand: resolved.need.confidenceBand,
      reasonCodes: [...resolved.need.reasonCodes],
      reason: item.reason,
      nutritionStatus: product.nutritionStatus,
      promotions: product.promotions.map((promotion) => ({ ...promotion })),
      alternatives: orderAlternatives(resolved, item.alternativeIds),
    };
  });

  // Computed from the snapshots just written, so `DraftSchema`'s 0.01
  // tolerance holds by construction rather than by luck.
  const total = roundMoney(
    items.reduce((sum, item) => sum + item.quantity * effectiveUnitPrice(item), 0),
  );

  return DraftSchema.parse({
    id: input.id,
    mode: input.mode,
    status: "ready",
    algorithmVersion: PREDICTION_ALGORITHM_VERSION,
    trainingCutoff: input.trainingCutoff,
    summary: input.proposal.summary,
    items,
    total,
    version: 1,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/features/drafts/assemble.test.ts && pnpm typecheck`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/features/drafts/assemble.ts src/features/drafts/assemble.test.ts
git commit -m "feat: assemble a draft from a validated proposal"
```

---

### Task 2: Demo identity

**Files:**
- Create: `src/features/drafts/demo-user.ts`
- Test: `src/features/drafts/demo-user.test.ts`

**Interfaces:**
- Consumes: `DbClient` from `@/db/client`; `users` from `@/db/schema`.
- Produces: `DEMO_USER_ID: string` and `ensureDemoUser(db: DbClient): Promise<string>`. Task 5 calls both by these names.

- [ ] **Step 1: Write the failing test**

Create `src/features/drafts/demo-user.test.ts`. The fake `DbClient` follows the pattern already used in `src/features/drafts/repository.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import type { DbClient } from "@/db/client";

import { DEMO_USER_ID, ensureDemoUser } from "./demo-user";

function fakeDb() {
  const onConflictDoNothing = vi.fn(async () => []);
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  return { db: { insert } as unknown as DbClient, insert, values, onConflictDoNothing };
}

describe("ensureDemoUser", () => {
  it("uses a well-formed UUID that is not the repository test's draft id", () => {
    expect(DEMO_USER_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(DEMO_USER_ID).not.toBe("00000000-0000-4000-8000-000000000001");
  });

  it("inserts the synthetic user and returns its id", async () => {
    const { db, values, onConflictDoNothing } = fakeDb();

    await expect(ensureDemoUser(db)).resolves.toBe(DEMO_USER_ID);

    expect(values).toHaveBeenCalledWith({ id: DEMO_USER_ID });
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it("is safe to call on every demo run", async () => {
    const { db, onConflictDoNothing } = fakeDb();

    await ensureDemoUser(db);
    await ensureDemoUser(db);

    expect(onConflictDoNothing).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/features/drafts/demo-user.test.ts`
Expected: FAIL — `Failed to resolve import "./demo-user"`.

- [ ] **Step 3: Write the implementation**

Create `src/features/drafts/demo-user.ts`:

```ts
import type { DbClient } from "@/db/client";
import { users } from "@/db/schema";

/**
 * A synthetic identity, never a real «Сільпо» guest and never derived from
 * one. Demo drafts persist under it so live and demo share exactly one
 * persistence path and Tasks 15–16 need no demo special case.
 */
export const DEMO_USER_ID = "00000000-0000-4000-8000-00000000de10";

/**
 * Idempotent by design: called on every demo run, adds no migration
 * because the row is data rather than schema.
 */
export async function ensureDemoUser(db: DbClient): Promise<string> {
  await db.insert(users).values({ id: DEMO_USER_ID }).onConflictDoNothing();
  return DEMO_USER_ID;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/features/drafts/demo-user.test.ts && pnpm typecheck`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/features/drafts/demo-user.ts src/features/drafts/demo-user.test.ts
git commit -m "feat: add the synthetic demo identity"
```

---

### Task 3: Gateway composition and the lazy write session

**Files:**
- Create: `src/features/silpo/gateway.ts`
- Test: `src/features/silpo/gateway.test.ts`

**Interfaces:**
- Consumes: `createDemoSilpoGateway` from `./demo/demo-gateway`; `createLiveHistoryGateway` from `./live/history`; `createLiveCartContextGateway` from `./live/cart-context`; `createLiveCatalogGateway` from `./live/catalog`; `openReadSession`, `openWriteSession`, `McpSession`, `OpenSessionOptions` from `./live/session`; `createSilpoOAuthProvider` from `./oauth/provider`; `SilpoOAuthProvider` from `./oauth/transport`; `SilpoGateway`, `DataMode` from `@/features/shared/contracts`.
- Produces: `createSilpoGateway(options: CreateSilpoGatewayOptions): Promise<SilpoGatewayHandle>`, `SilpoGatewayHandle`, `SilpoGatewayDeps`, `createLazyWriteSession(open, read): LazyWriteSession`, `DRAFT_MCP_OPERATION_TIMEOUT_MS`, `NotImplementedForDraftRunError`. Tasks 4 and 5 use `createSilpoGateway` and `SilpoGatewayHandle`.

- [ ] **Step 1: Write the failing test**

Create `src/features/silpo/gateway.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import type { SilpoGateway } from "@/features/shared/contracts";

import {
  createLazyWriteSession,
  createSilpoGateway,
  DRAFT_MCP_OPERATION_TIMEOUT_MS,
  NotImplementedForDraftRunError,
  type SilpoGatewayDeps,
} from "./gateway";
import type { McpSession, OpenSessionOptions } from "./live/session";

interface FakeSession extends McpSession {
  readonly calls: string[];
  closeCount: number;
  closeError: Error | null;
}

function fakeSession(tools: string[] = ["silpo_get_my_shopping_cart"]): FakeSession {
  const session: FakeSession = {
    advertisedTools: new Set(tools),
    retryEnabled: true,
    calls: [],
    closeCount: 0,
    closeError: null,
    async callTool<T>(name: string): Promise<T> {
      session.calls.push(name);
      return undefined as T;
    },
    async close(): Promise<void> {
      session.closeCount += 1;
      if (session.closeError !== null) {
        throw session.closeError;
      }
    },
  };
  return session;
}

function liveOptions(overrides: Partial<SilpoGatewayDeps> = {}) {
  const read = fakeSession(["silpo_get_my_shopping_cart", "silpo_get_my_online_orders"]);
  const write = fakeSession();
  // Typed parameters, so `mock.calls[0][0]` below is `OpenSessionOptions`
  // rather than `never`.
  const openReadSession = vi.fn(async (_options: OpenSessionOptions) => read as McpSession);
  const openWriteSession = vi.fn(async (_options: OpenSessionOptions) => write as McpSession);
  const createDemoGateway = vi.fn(() => ({}) as SilpoGateway);
  return {
    read,
    write,
    openReadSession,
    openWriteSession,
    createDemoGateway,
    options: {
      mode: "live" as const,
      userId: "user-1",
      publicBaseUrl: "https://app.example.ua",
      deps: {
        createProvider: vi.fn(async () => ({}) as never),
        openReadSession,
        openWriteSession,
        createDemoGateway,
        ...overrides,
      },
    },
  };
}

describe("createLazyWriteSession", () => {
  it("opens nothing until the first tool call", async () => {
    const read = fakeSession(["a", "b"]);
    const open = vi.fn(async () => fakeSession());

    const lazy = createLazyWriteSession(open, read);

    expect(open).not.toHaveBeenCalled();
    expect(lazy.session.retryEnabled).toBe(false);
    expect([...lazy.session.advertisedTools]).toEqual(["a", "b"]);
  });

  it("opens once and reuses the session across calls", async () => {
    const opened = fakeSession();
    const open = vi.fn(async () => opened as McpSession);
    const lazy = createLazyWriteSession(open, fakeSession());

    await lazy.session.callTool("silpo_create_shopping_cart", {}, undefined as never);
    await lazy.session.callTool("silpo_update_shopping_cart", {}, undefined as never);

    expect(open).toHaveBeenCalledTimes(1);
    expect(opened.calls).toEqual(["silpo_create_shopping_cart", "silpo_update_shopping_cart"]);
  });

  it("shares one open between concurrent first calls", async () => {
    const open = vi.fn(async () => fakeSession() as McpSession);
    const lazy = createLazyWriteSession(open, fakeSession());

    await Promise.all([
      lazy.session.callTool("a", {}, undefined as never),
      lazy.session.callTool("b", {}, undefined as never),
    ]);

    expect(open).toHaveBeenCalledTimes(1);
  });

  it("closes nothing when it never opened, and closes once when it did", async () => {
    const opened = fakeSession();
    const lazy = createLazyWriteSession(async () => opened as McpSession, fakeSession());

    await lazy.close();
    expect(opened.closeCount).toBe(0);

    await lazy.session.callTool("a", {}, undefined as never);
    await lazy.close();
    expect(opened.closeCount).toBe(1);
  });

  it("does not throw from close when the open itself failed", async () => {
    const lazy = createLazyWriteSession(async () => {
      throw new Error("no write session");
    }, fakeSession());

    await expect(lazy.session.callTool("a", {}, undefined as never)).rejects.toThrow("no write session");
    await expect(lazy.close()).resolves.toBeUndefined();
  });
});

describe("createSilpoGateway", () => {
  it("returns the demo gateway without opening any session", async () => {
    const demo = {} as SilpoGateway;
    const createDemoGateway = vi.fn(() => demo);
    const openReadSession = vi.fn();

    const handle = await createSilpoGateway({
      mode: "demo",
      userId: "unused",
      publicBaseUrl: "https://app.example.ua",
      deps: { createDemoGateway, openReadSession },
    });

    expect(handle.gateway).toBe(demo);
    expect(openReadSession).not.toHaveBeenCalled();
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it("never falls back to the demo gateway in live mode", async () => {
    const { options, createDemoGateway } = liveOptions();

    await createSilpoGateway(options);

    expect(createDemoGateway).not.toHaveBeenCalled();
  });

  it("opens the read session with the draft run's raised budget", async () => {
    const { options, openReadSession } = liveOptions();

    await createSilpoGateway(options);

    expect(DRAFT_MCP_OPERATION_TIMEOUT_MS).toBe(60_000);
    expect(openReadSession).toHaveBeenCalledTimes(1);
    expect(openReadSession.mock.calls[0][0]).toMatchObject({
      operationTimeoutMs: DRAFT_MCP_OPERATION_TIMEOUT_MS,
    });
  });

  it("opens no write session while only reading", async () => {
    const { options, openWriteSession } = liveOptions();

    const handle = await createSilpoGateway(options);
    await handle.gateway.listTools();

    expect(openWriteSession).not.toHaveBeenCalled();
  });

  it("reports the advertised surface, sorted", async () => {
    const { options } = liveOptions();

    const handle = await createSilpoGateway(options);

    expect(await handle.gateway.listTools()).toEqual([
      "silpo_get_my_online_orders",
      "silpo_get_my_shopping_cart",
    ]);
  });

  it("closes the read session and survives a failing close", async () => {
    const { options, read } = liveOptions();
    read.closeError = new Error("socket already gone");

    const handle = await createSilpoGateway(options);

    await expect(handle.close()).resolves.toBeUndefined();
    expect(read.closeCount).toBe(1);
  });

  it("refuses the two cart-write methods that belong to Task 16", async () => {
    const { options } = liveOptions();
    const handle = await createSilpoGateway(options);

    await expect(handle.gateway.readCart("cart-1")).rejects.toThrow(NotImplementedForDraftRunError);
    await expect(
      handle.gateway.setAbsoluteCartQuantities({ cartId: "cart-1", items: [{ productId: "p", quantity: 1 }], addQuantity: false }),
    ).rejects.toThrow(NotImplementedForDraftRunError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/features/silpo/gateway.test.ts`
Expected: FAIL — `Failed to resolve import "./gateway"`.

- [ ] **Step 3: Write the implementation**

Create `src/features/silpo/gateway.ts`:

```ts
import type { DataMode, SilpoGateway } from "@/features/shared/contracts";

import { createDemoSilpoGateway } from "./demo/demo-gateway";
import { createLiveCartContextGateway } from "./live/cart-context";
import { createLiveCatalogGateway } from "./live/catalog";
import { createLiveHistoryGateway } from "./live/history";
import {
  openReadSession,
  openWriteSession,
  type McpSession,
  type OpenSessionOptions,
} from "./live/session";
import { createSilpoOAuthProvider } from "./oauth/provider";
import type { SilpoOAuthProvider } from "./oauth/transport";

/**
 * `openReadSession` defaults to 30 s measured from session open, which was
 * sized for a single cart-context operation. A draft run makes dozens of
 * calls through one session, so the budget is raised deliberately here
 * rather than letting long runs abort by accident.
 */
export const DRAFT_MCP_OPERATION_TIMEOUT_MS = 60_000;

/** A cart-write method that has no gateway until Task 16 implements it. */
export class NotImplementedForDraftRunError extends Error {
  constructor(readonly method: string) {
    super(`${method} belongs to Task 16 and is never called by a draft run`);
    this.name = "NotImplementedForDraftRunError";
  }
}

export interface SilpoGatewayHandle {
  gateway: SilpoGateway;
  close(): Promise<void>;
}

/** Every seam the test replaces. Each field defaults to the real thing. */
export interface SilpoGatewayDeps {
  createProvider: (
    userId: string,
    options: { publicBaseUrl: string },
  ) => Promise<SilpoOAuthProvider>;
  openReadSession: (options: OpenSessionOptions) => Promise<McpSession>;
  openWriteSession: (options: OpenSessionOptions) => Promise<McpSession>;
  createDemoGateway: () => SilpoGateway;
  now: () => Date;
}

export interface CreateSilpoGatewayOptions {
  mode: DataMode;
  userId: string;
  publicBaseUrl: string;
  deps?: Partial<SilpoGatewayDeps>;
}

export interface LazyWriteSession {
  session: McpSession;
  close(): Promise<void>;
}

/**
 * A write session that exists only if something writes.
 *
 * `createLiveCartContextGateway` takes both sessions at construction, but
 * the only write a draft run can reach is bootstrapping a cart for a guest
 * who has none. Opening eagerly would spend a round trip and a live token
 * use on every run for a branch almost none of them take.
 *
 * `retryEnabled` is the literal `false` that `openWriteSession` always
 * sets, so answering it needs no session. `advertisedTools` delegates to
 * the read session: both target the same server under the same identity
 * and each performs its own `tools/list`, so the surfaces are identical,
 * and the real write session re-checks the name inside `callTool` anyway.
 */
export function createLazyWriteSession(
  open: () => Promise<McpSession>,
  read: McpSession,
): LazyWriteSession {
  let pending: Promise<McpSession> | null = null;

  const session: McpSession = {
    get advertisedTools() {
      return read.advertisedTools;
    },
    retryEnabled: false,
    async callTool(name, args, schema) {
      pending ??= open();
      const opened = await pending;
      return opened.callTool(name, args, schema);
    },
    async close() {
      if (pending === null) {
        return;
      }
      // A failed open leaves a rejected promise here; closing must not
      // rethrow it and mask the run's own outcome.
      const opened = await pending.catch(() => null);
      await opened?.close().catch(() => {});
    },
  };

  return { session, close: () => session.close() };
}

async function createLiveGatewayHandle(
  options: CreateSilpoGatewayOptions,
  deps: SilpoGatewayDeps,
): Promise<SilpoGatewayHandle> {
  const provider = await deps.createProvider(options.userId, {
    publicBaseUrl: options.publicBaseUrl,
  });
  const sessionOptions: OpenSessionOptions = {
    provider,
    operationTimeoutMs: DRAFT_MCP_OPERATION_TIMEOUT_MS,
  };

  const readSession = await deps.openReadSession(sessionOptions);
  const lazyWrite = createLazyWriteSession(
    () => deps.openWriteSession(sessionOptions),
    readSession,
  );

  const history = createLiveHistoryGateway({ readSession, now: deps.now });
  const cart = createLiveCartContextGateway({
    readSession,
    writeSession: lazyWrite.session,
    now: deps.now,
  });
  const catalog = createLiveCatalogGateway({ readSession });

  const gateway: SilpoGateway = {
    // A cached read of the `tools/list` the session already performed
    // during `connect`, not a second round trip.
    async listTools() {
      return [...readSession.advertisedTools].sort();
    },
    loadCustomerContext: () => history.loadCustomerContext(),
    loadCartContext: () => cart.loadCartContext(),
    updateCartContext: (input) => cart.updateCartContext(input),
    loadPurchaseHistory: (context) => history.loadPurchaseHistory(context),
    findProducts: (context, queries) => catalog.findProducts(context, queries),
    getPromotions: (context) => catalog.getPromotions(context),
    getProductDetails: (context, slug) => catalog.getProductDetails(context, slug),
    getSimilarProducts: (context, slug) => catalog.getSimilarProducts(context, slug),
    getReplacements: (context, slug) => catalog.getReplacements(context, slug),
    getTimeSlots: (context) => cart.getTimeSlots(context),
    async setAbsoluteCartQuantities() {
      throw new NotImplementedForDraftRunError("setAbsoluteCartQuantities");
    },
    async readCart() {
      throw new NotImplementedForDraftRunError("readCart");
    },
  };

  return {
    gateway,
    async close() {
      await lazyWrite.close();
      await readSession.close().catch(() => {});
    },
  };
}

/**
 * The mode is fixed at creation and never changes afterwards. Live mode
 * cannot reach the demo branch, so a live failure surfaces as an error
 * rather than as silently substituted demo data.
 */
export async function createSilpoGateway(
  options: CreateSilpoGatewayOptions,
): Promise<SilpoGatewayHandle> {
  const deps: SilpoGatewayDeps = {
    createProvider: (userId, providerOptions) =>
      createSilpoOAuthProvider(userId, providerOptions),
    openReadSession,
    openWriteSession,
    createDemoGateway: createDemoSilpoGateway,
    now: () => new Date(),
    ...options.deps,
  };

  if (options.mode === "demo") {
    return { gateway: deps.createDemoGateway(), close: async () => {} };
  }

  return createLiveGatewayHandle(options, deps);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/features/silpo/gateway.test.ts && pnpm typecheck`
Expected: PASS, 12 tests (5 for `createLazyWriteSession`, 7 for `createSilpoGateway`).

- [ ] **Step 5: Commit**

```bash
git add src/features/silpo/gateway.ts src/features/silpo/gateway.test.ts
git commit -m "feat: compose the Silpo gateway with an owned session lifecycle"
```

---

### Task 4: The draft service

**Files:**
- Create: `src/features/drafts/service.ts`
- Test: `src/features/drafts/service.test.ts`

**Interfaces:**
- Consumes: `assembleDraft` from `./assemble`; `DraftRepository` from `./repository`; `SilpoGatewayHandle` from `@/features/silpo/gateway`; `normalizePurchases`, `inferNeeds`, `resolveProducts`; `DraftGeneration` from `@/features/agent/draft-agent`; `DraftAgentInput`, `ProposalViolationCode` from `@/features/agent/draft-output`; the error classes listed in the code below; `ok`, `err`, `AppError`, `Result` from `@/lib/result`.
- Produces: `createDraftForUser(input, deps): Promise<Result<DraftRun, DraftFailure>>`, `DraftRun`, `DraftFailure`, `CreateDraftDeps`, `resolveActiveCity`, `UNKNOWN_CITY`. Task 5 uses `createDraftForUser`, `DraftRun`, `DraftFailure` and `CreateDraftDeps`.

- [ ] **Step 1: Write the failing test**

Create `src/features/drafts/service.test.ts`. It drives the real demo gateway through a recording wrapper, so the pipeline runs on real fixture data rather than on hand-built stubs:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { DraftGeneration } from "@/features/agent/draft-agent";
import type { DraftAgentInput } from "@/features/agent/draft-output";
import { buildFallbackProposal } from "@/features/agent/fallback";
import { createInMemoryDraftRepository } from "@/features/drafts/repository";
import type { RawPurchaseReceipt, SilpoGateway } from "@/features/shared/contracts";
import { createDemoSilpoGateway } from "@/features/silpo/demo/demo-gateway";
import type { SilpoGatewayHandle } from "@/features/silpo/gateway";
import { NoSavedAddressError } from "@/features/silpo/live/cart-context";
import { McpCallError } from "@/features/silpo/live/session";
import { InvalidExternalDataError } from "@/features/silpo/schemas/common";

import { createDraftForUser, resolveActiveCity, UNKNOWN_CITY, type CreateDraftDeps } from "./service";

const RUN_AT = new Date("2026-09-08T09:00:00.000Z");

function recording(base: SilpoGateway, calls: string[]): SilpoGateway {
  return {
    async listTools() { calls.push("listTools"); return base.listTools(); },
    async loadCustomerContext() { calls.push("loadCustomerContext"); return base.loadCustomerContext(); },
    async loadCartContext() { calls.push("loadCartContext"); return base.loadCartContext(); },
    async updateCartContext(input) { calls.push("updateCartContext"); return base.updateCartContext(input); },
    async loadPurchaseHistory(context) { calls.push("loadPurchaseHistory"); return base.loadPurchaseHistory(context); },
    async findProducts(context, queries) { calls.push("findProducts"); return base.findProducts(context, queries); },
    async getPromotions(context) { calls.push("getPromotions"); return base.getPromotions(context); },
    async getProductDetails(context, slug) { calls.push("getProductDetails"); return base.getProductDetails(context, slug); },
    async getSimilarProducts(context, slug) { calls.push("getSimilarProducts"); return base.getSimilarProducts(context, slug); },
    async getReplacements(context, slug) { calls.push("getReplacements"); return base.getReplacements(context, slug); },
    async getTimeSlots(context) { calls.push("getTimeSlots"); return base.getTimeSlots(context); },
    async setAbsoluteCartQuantities(input) { calls.push("setAbsoluteCartQuantities"); return base.setAbsoluteCartQuantities(input); },
    async readCart(cartId) { calls.push("readCart"); return base.readCart(cartId); },
  };
}

function deterministicGeneration(input: DraftAgentInput): DraftGeneration {
  return {
    proposal: buildFallbackProposal(input),
    source: "fallback",
    attempts: 0,
    normalizations: [],
  };
}

function makeDeps(overrides: Partial<CreateDraftDeps> = {}) {
  const calls: string[] = [];
  const closed = { count: 0 };
  const gateway = recording(createDemoSilpoGateway(), calls);
  const handle: SilpoGatewayHandle = {
    gateway,
    async close() { closed.count += 1; },
  };
  const deps: CreateDraftDeps = {
    openGateway: async () => handle,
    generateDraft: async (input) => deterministicGeneration(input),
    repository: createInMemoryDraftRepository(),
    now: () => RUN_AT,
    newDraftId: () => "00000000-0000-4000-8000-000000000abc",
    ...overrides,
  };
  return { deps, calls, closed, handle };
}

const RUN = { userId: "user-1", mode: "demo" as const, correlationId: "corr-1" };

describe("createDraftForUser", () => {
  it("runs the documented order and never touches a cart write", async () => {
    const { deps, calls } = makeDeps();

    const result = await createDraftForUser(RUN, deps);

    expect(result.ok).toBe(true);
    expect(calls.slice(0, 4)).toEqual([
      "listTools",
      "loadCartContext",
      "loadCustomerContext",
      "loadPurchaseHistory",
    ]);
    expect(calls.indexOf("findProducts")).toBeGreaterThan(3);
    // Discounts come from the product's own fields, so calling
    // `getPromotions` would be a defect, not merely waste.
    for (const forbidden of ["getPromotions", "updateCartContext", "setAbsoluteCartQuantities", "readCart"]) {
      expect(calls).not.toContain(forbidden);
    }
  });

  it("assembles and persists the demo fixture's draft", async () => {
    const { deps } = makeDeps();

    const result = await createDraftForUser(RUN, deps);

    if (!result.ok) throw new Error("expected a draft");
    const { draft } = result.value;
    expect(draft.items.map((item) => item.productId)).toEqual([
      "demo-water-still-15l",
      "demo-milk-25-900g",
      "demo-oatmeal-500g",
    ]);
    expect(draft.total).toBe(115.7);
    expect(draft.status).toBe("ready");
    expect(draft.mode).toBe("demo");
    expect(draft.algorithmVersion).toBe("prediction-v1");
    expect(draft.trainingCutoff).toBe(RUN_AT.toISOString());
    expect(draft.items[0].reasonCodes).toContain("category_repeat");
    expect(draft.items[2].specialPrice).toBe(42.9);

    await expect(deps.repository.get(draft.id, "user-1")).resolves.toEqual(draft);
  });

  it("returns the cart context and loyalty figure the dashboard needs", async () => {
    const { deps } = makeDeps();

    const result = await createDraftForUser(RUN, deps);

    if (!result.ok) throw new Error("expected a draft");
    expect(result.value.cartContext.cartId).toBe("demo-cart-ready");
    expect(result.value.loyaltyBonusAvailable).toBe(84.5);
    expect(result.value.generation.source).toBe("fallback");
  });

  it("stops before generation when the cart has no usable slot", async () => {
    const generateDraft = vi.fn();
    const base = createDemoSilpoGateway();
    const { deps } = makeDeps({
      generateDraft,
      openGateway: async () => ({
        gateway: {
          ...base,
          async loadCartContext() {
            return {
              status: "needs_slot" as const,
              availableSlots: [{
                id: "slot-1",
                startsAt: "2026-09-09T09:00:00.000Z",
                endsAt: "2026-09-09T11:00:00.000Z",
                available: true,
              }],
            };
          },
        },
        async close() {},
      }),
    });

    const result = await createDraftForUser(RUN, deps);

    if (result.ok) throw new Error("expected needs_slot");
    expect(result.error.error.code).toBe("needs_slot");
    expect(result.error.availableSlots).toHaveLength(1);
    expect(generateDraft).not.toHaveBeenCalled();
  });

  it("reports an injected generation fault as `unexpected`, never as a model error", async () => {
    const { deps } = makeDeps({
      generateDraft: async () => { throw new Error("provider exploded"); },
    });

    const result = await createDraftForUser(RUN, deps);

    // `generateDraftWithModel` absorbs model and provider faults itself and
    // returns a deterministic draft, so a generation function that throws is
    // a wiring fault. It must never surface as `model_invalid_output`.
    if (result.ok) throw new Error("expected a failure");
    expect(result.error.error.code).toBe("unexpected");
    expect(result.error.error.message).not.toContain("provider exploded");
  });

  it("carries the deterministic fallback through to a saved draft", async () => {
    const { deps } = makeDeps({
      generateDraft: async (input) => ({
        proposal: buildFallbackProposal(input),
        source: "fallback",
        attempts: 2,
        normalizations: ["model_unavailable"],
      }),
    });

    const result = await createDraftForUser(RUN, deps);

    if (!result.ok) throw new Error("expected a draft");
    expect(result.value.generation).toEqual({
      source: "fallback",
      attempts: 2,
      normalizations: ["model_unavailable"],
    });
    expect(result.value.draft.items).toHaveLength(3);
  });

  it("closes the gateway on success and on failure", async () => {
    const success = makeDeps();
    await createDraftForUser(RUN, success.deps);
    expect(success.closed.count).toBe(1);

    const failureClosed = { count: 0 };
    const failure = makeDeps({
      openGateway: async () => ({
        gateway: {
          ...createDemoSilpoGateway(),
          async listTools() { throw new McpCallError("tools/list", 401, null); },
        },
        async close() { failureClosed.count += 1; },
      }),
    });
    const result = await createDraftForUser(RUN, failure.deps);
    expect(result.ok).toBe(false);
    expect(failureClosed.count).toBe(1);
  });

  it("maps every boundary failure to a safe typed error", async () => {
    const cases: Array<[unknown, string]> = [
      [new McpCallError("silpo_get_my_shopping_cart", 401, null), "unauthorized"],
      [new McpCallError("silpo_get_my_shopping_cart", 429, "3"), "rate_limited"],
      [new InvalidExternalDataError("silpo_get_my_shopping_cart"), "invalid_external_data"],
      [new NoSavedAddressError(), "cart_validation_error"],
      [new Error("something else"), "unexpected"],
    ];

    for (const [thrown, code] of cases) {
      const { deps } = makeDeps({
        openGateway: async () => ({
          gateway: {
            ...createDemoSilpoGateway(),
            async listTools() { throw thrown; },
          },
          async close() {},
        }),
      });

      const result = await createDraftForUser(RUN, deps);

      if (result.ok) throw new Error(`expected ${code}`);
      expect(result.error.error.code).toBe(code);
      expect(result.error.error.correlationId).toBe("corr-1");
      expect(result.error.error.message).not.toMatch(/silpo_get_my_shopping_cart|Error:/);
    }
  });

  it("reports rate limiting with the server's own retry hint", async () => {
    const { deps } = makeDeps({
      openGateway: async () => ({
        gateway: {
          ...createDemoSilpoGateway(),
          async listTools() { throw new McpCallError("t", 429, "3"); },
        },
        async close() {},
      }),
    });

    const result = await createDraftForUser(RUN, deps);

    if (result.ok) throw new Error("expected rate_limited");
    expect(result.error.error.retryAfterMs).toBe(3000);
  });

  it("rejects an empty advertised tool surface as invalid external data", async () => {
    const { deps } = makeDeps({
      openGateway: async () => ({
        gateway: { ...createDemoSilpoGateway(), async listTools() { return []; } },
        async close() {},
      }),
    });

    const result = await createDraftForUser(RUN, deps);

    if (result.ok) throw new Error("expected invalid_external_data");
    expect(result.error.error.code).toBe("invalid_external_data");
  });

  it("does not import the AI SDK", () => {
    const source = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from "ai"|@ai-sdk\/|google-model/);
  });
});

describe("resolveActiveCity", () => {
  function receipt(sourceId: string, purchasedAt: string, city: string | null): RawPurchaseReceipt {
    return {
      sourceId,
      channel: "online",
      purchasedAt,
      city,
      total: 100,
      items: [{
        sourceId: `${sourceId}-i1`,
        externalProductId: 1,
        productId: "p-1",
        name: "Молоко",
        quantity: 1,
        unit: "шт",
        unitPrice: 100,
      }],
    };
  }

  const context = {
    cartId: "cart-1",
    deliveryType: "delivery" as const,
    city: null,
    branchId: null,
    slot: {
      id: "slot-1",
      startsAt: "2026-09-09T09:00:00.000Z",
      endsAt: "2026-09-09T11:00:00.000Z",
      available: true,
    },
  };

  it("prefers the cart's own city", () => {
    expect(resolveActiveCity({ ...context, city: "Київ" }, [])).toBe("Київ");
  });

  it("falls back to the most recent receipt that has one", () => {
    const receipts = [
      receipt("r-1", "2026-08-01T10:00:00.000Z", "Львів"),
      receipt("r-2", "2026-08-20T10:00:00.000Z", "Київ"),
      receipt("r-3", "2026-08-25T10:00:00.000Z", null),
    ];

    expect(resolveActiveCity(context, receipts)).toBe("Київ");
  });

  it("breaks a tie on sourceId so the rule is total", () => {
    const receipts = [
      receipt("r-b", "2026-08-20T10:00:00.000Z", "Львів"),
      receipt("r-a", "2026-08-20T10:00:00.000Z", "Київ"),
    ];

    expect(resolveActiveCity(context, receipts)).toBe("Київ");
  });

  it("uses a sentinel that matches nothing when no city is known", () => {
    expect(resolveActiveCity(context, [receipt("r-1", "2026-08-01T10:00:00.000Z", null)]))
      .toBe(UNKNOWN_CITY);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/features/drafts/service.test.ts`
Expected: FAIL — `Failed to resolve import "./service"`.

- [ ] **Step 3: Write the implementation**

Create `src/features/drafts/service.ts`:

```ts
import { ZodError } from "zod";

import type { DraftGeneration } from "@/features/agent/draft-agent";
import type { DraftAgentInput, ProposalViolationCode } from "@/features/agent/draft-output";
import { inferNeeds } from "@/features/prediction/score";
import { resolveProducts } from "@/features/products/resolve-products";
import { normalizePurchases } from "@/features/purchases/normalize";
import type {
  CartContext,
  DataMode,
  Draft,
  RawPurchaseReceipt,
  TimeSlot,
} from "@/features/shared/contracts";
import type { SilpoGatewayHandle } from "@/features/silpo/gateway";
import {
  DeliveryTypeUnavailableError,
  NoSavedAddressError,
  SlotUnavailableError,
  SlotVerificationError,
} from "@/features/silpo/live/cart-context";
import { McpCallError, UnadvertisedToolError } from "@/features/silpo/live/session";
import { InvalidExternalDataError } from "@/features/silpo/schemas/common";
import { err, ok, type AppError, type AppErrorCode, type Result } from "@/lib/result";

import { assembleDraft } from "./assemble";
import type { DraftRepository } from "./repository";

/** Matches no receipt, so every purchase takes the other-city weight. */
export const UNKNOWN_CITY = "__unknown__";

const MESSAGES = {
  needs_slot: "Оберіть доступний слот доставки, щоб зібрати чернетку.",
  no_address: "У профілі «Сільпо» немає збереженої адреси доставки. Додайте її та спробуйте ще раз.",
  delivery_unavailable: "Цей спосіб доставки недоступний за вашою адресою.",
  unauthorized: "Не вдалося підтвердити вхід. Увійдіть у «Сільпо» ще раз.",
  rate_limited: "Забагато запитів. Спробуйте трохи пізніше.",
  invalid_external: "«Сільпо» повернуло некоректну відповідь. Спробуйте ще раз.",
  unexpected: "Не вдалося зібрати чернетку. Спробуйте ще раз.",
} as const;

export interface DraftRun {
  draft: Draft;
  cartContext: CartContext;
  loyaltyBonusAvailable: number | null;
  generation: {
    source: "model" | "fallback";
    attempts: number;
    normalizations: readonly ProposalViolationCode[];
  };
}

export interface DraftFailure {
  error: AppError;
  /** Populated only for `needs_slot`; `null` otherwise. */
  availableSlots: TimeSlot[] | null;
}

export interface CreateDraftDeps {
  openGateway: (options: { mode: DataMode; userId: string }) => Promise<SilpoGatewayHandle>;
  generateDraft: (input: DraftAgentInput) => Promise<DraftGeneration>;
  repository: DraftRepository;
  now?: () => Date;
  newDraftId?: () => string;
}

export interface CreateDraftInput {
  userId: string;
  mode: DataMode;
  correlationId: string;
}

/**
 * A second copy of the cart-context route's parser. Two are acceptable;
 * a third should move to a shared module owned by a task that may edit it.
 */
function parseRetryAfterMs(header: string | null): number | null {
  if (header === null || header.trim().length === 0) {
    return null;
  }
  const seconds = Number.parseInt(header.trim(), 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

function appError(
  code: AppErrorCode,
  message: string,
  correlationId: string,
  retryAfterMs: number | null = null,
): AppError {
  return { code, message, correlationId, retryAfterMs };
}

function failure(
  code: AppErrorCode,
  message: string,
  correlationId: string,
  options: { retryAfterMs?: number | null; availableSlots?: TimeSlot[] | null } = {},
): DraftFailure {
  return {
    error: appError(code, message, correlationId, options.retryAfterMs ?? null),
    availableSlots: options.availableSlots ?? null,
  };
}

/**
 * The cart's own city, else the guest's most recent receipt that has one,
 * else a sentinel. Deterministic and total: the tie-break on `sourceId`
 * means two receipts sharing a timestamp cannot reorder between runs.
 *
 * This changes only the city weighting. It never writes a city onto a
 * receipt, a product or the draft, and it is not persisted.
 */
export function resolveActiveCity(
  context: CartContext,
  receipts: RawPurchaseReceipt[],
): string {
  if (context.city !== null) {
    return context.city;
  }
  const withCity = receipts.filter((receipt) => receipt.city !== null);
  if (withCity.length === 0) {
    return UNKNOWN_CITY;
  }
  const newest = [...withCity].sort((a, b) => {
    const byTime = Date.parse(b.purchasedAt) - Date.parse(a.purchasedAt);
    return byTime !== 0 ? byTime : a.sourceId.localeCompare(b.sourceId);
  })[0];
  return newest.city as string;
}

/**
 * `SlotUnavailableError` and `SlotVerificationError` are raised only by
 * `updateCartContext`, which this run never calls. They are mapped anyway
 * so a future caller cannot turn a slot problem into an opaque 500, and so
 * this stays a total function over the gateway's error types.
 */
function toFailure(error: unknown, correlationId: string): DraftFailure {
  if (error instanceof SlotUnavailableError || error instanceof SlotVerificationError) {
    return failure("needs_slot", MESSAGES.needs_slot, correlationId, { availableSlots: [] });
  }
  if (error instanceof NoSavedAddressError) {
    return failure("cart_validation_error", MESSAGES.no_address, correlationId);
  }
  if (error instanceof DeliveryTypeUnavailableError) {
    return failure("cart_validation_error", MESSAGES.delivery_unavailable, correlationId);
  }
  if (error instanceof McpCallError && error.status === 401) {
    return failure("unauthorized", MESSAGES.unauthorized, correlationId);
  }
  if (error instanceof McpCallError && error.status === 429) {
    return failure("rate_limited", MESSAGES.rate_limited, correlationId, {
      retryAfterMs: parseRetryAfterMs(error.retryAfterHeader),
    });
  }
  if (
    error instanceof InvalidExternalDataError ||
    error instanceof UnadvertisedToolError ||
    error instanceof ZodError
  ) {
    return failure("invalid_external_data", MESSAGES.invalid_external, correlationId);
  }
  // Provider text, URLs, headers and stack traces never reach the client.
  return failure("unexpected", MESSAGES.unexpected, correlationId);
}

/**
 * One draft run, in the order agent architecture section 5 fixes. Every
 * step's failure is typed; none of them can produce `model_invalid_output`,
 * because `generateDraftWithModel` absorbs model and provider faults and
 * returns a deterministic draft instead.
 */
export async function createDraftForUser(
  input: CreateDraftInput,
  deps: CreateDraftDeps,
): Promise<Result<DraftRun, DraftFailure>> {
  const now = deps.now ?? (() => new Date());
  const newDraftId = deps.newDraftId ?? (() => crypto.randomUUID());
  const runStartedAt = now();
  const { correlationId } = input;

  let handle: SilpoGatewayHandle | undefined;
  try {
    handle = await deps.openGateway({ mode: input.mode, userId: input.userId });
    const { gateway } = handle;

    // Mandatory first operation: never assume the available tool surface.
    const tools = await gateway.listTools();
    if (tools.length === 0) {
      return err(failure("invalid_external_data", MESSAGES.invalid_external, correlationId));
    }

    const contextResult = await gateway.loadCartContext();
    if (contextResult.status === "needs_slot") {
      return err(failure("needs_slot", MESSAGES.needs_slot, correlationId, {
        availableSlots: contextResult.availableSlots,
      }));
    }
    const context = contextResult.context;

    const customerContext = await gateway.loadCustomerContext();
    const rawHistory = await gateway.loadPurchaseHistory(context);

    const activeCity = resolveActiveCity(context, rawHistory);
    const normalized = normalizePurchases(rawHistory, activeCity, runStartedAt);
    const needs = inferNeeds({ receipts: normalized, now: runStartedAt, activeCity });
    const resolvedNeeds = await resolveProducts(needs, context, customerContext, gateway);

    const generation = await deps.generateDraft({
      mode: input.mode,
      resolvedNeeds,
      customerContext,
    });

    const draft = assembleDraft({
      id: newDraftId(),
      mode: input.mode,
      trainingCutoff: runStartedAt.toISOString(),
      proposal: generation.proposal,
      resolvedNeeds,
    });

    const saved = await deps.repository.save(input.userId, draft);

    return ok({
      draft: saved,
      cartContext: context,
      loyaltyBonusAvailable: customerContext.loyaltyBonusAvailable,
      generation: {
        source: generation.source,
        attempts: generation.attempts,
        normalizations: generation.normalizations,
      },
    });
  } catch (error) {
    return err(toFailure(error, correlationId));
  } finally {
    // A failure to close never masks the run's own outcome.
    await handle?.close().catch(() => {});
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/features/drafts/service.test.ts && pnpm typecheck`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/features/drafts/service.ts src/features/drafts/service.test.ts
git commit -m "feat: orchestrate one draft run"
```

---

### Task 5: The route

**Files:**
- Create: `src/app/api/drafts/handlers.ts`
- Create: `src/app/api/drafts/route.ts`
- Test: `tests/integration/draft-route.test.ts`

**Interfaces:**
- Consumes: `createDraftForUser`, `CreateDraftDeps`, `DraftRun`, `DraftFailure` from `@/features/drafts/service`; `ensureDemoUser` from `@/features/drafts/demo-user`; `createPostgresDraftRepository`, `DraftRepository` from `@/features/drafts/repository`; `createSilpoGateway` from `@/features/silpo/gateway`; `generateDraft` from `@/features/agent/google-model`; `resolveSilpoSession` from `@/features/silpo/oauth/service`; `getServerEnv`, `ServerEnv` from `@/lib/env`; `getDbClient` from `@/db/client`.
- Produces: `createDraftsPostHandler(overrides?: Partial<DraftsHandlerDeps>)` and `DraftsHandlerDeps`.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/draft-route.test.ts`:

```ts
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { buildFallbackProposal } from "@/features/agent/fallback";
import { createInMemoryDraftRepository } from "@/features/drafts/repository";
import { createDemoSilpoGateway } from "@/features/silpo/demo/demo-gateway";
import { McpCallError } from "@/features/silpo/live/session";
import { InvalidExternalDataError } from "@/features/silpo/schemas/common";
import type { ServerEnv } from "@/lib/env";
import { err, ok } from "@/lib/result";

import { createDraftsPostHandler, type DraftsHandlerDeps } from "@/app/api/drafts/handlers";

function makeEnv(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://user:pass@localhost:5432/testdb",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
    GOOGLE_GENERATIVE_AI_API_KEY: "test-api-key",
    AGENT_MODEL: "gemini-3.7-flash",
    DATA_MODE: "demo",
    PUBLIC_BASE_URL: "https://app.silpo-test.ua",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DraftsHandlerDeps> = {}): DraftsHandlerDeps {
  const repository = createInMemoryDraftRepository();
  return {
    getEnv: () => makeEnv(),
    resolveSession: async () => ok({ userId: "live-user" }),
    resolveDemoUserId: async () => "00000000-0000-4000-8000-00000000de10",
    repository: () => repository,
    openGateway: async () => ({ gateway: createDemoSilpoGateway(), async close() {} }),
    generateDraft: async (input) => ({
      proposal: buildFallbackProposal(input),
      source: "fallback",
      attempts: 0,
      normalizations: [],
    }),
    ...overrides,
  };
}

function post(body?: unknown, cookie?: string): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (cookie) {
    headers.set("cookie", `silpo_session=${cookie}`);
  }
  return new NextRequest("https://app.silpo-test.ua/api/drafts", {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("POST /api/drafts", () => {
  it("returns a labeled demo draft with the dashboard's context", async () => {
    const handler = createDraftsPostHandler(makeDeps());

    const response = await handler(post());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(payload.mode).toBe("demo");
    expect(payload.draft.status).toBe("ready");
    expect(payload.draft.items).toHaveLength(3);
    expect(payload.cartContext.cartId).toBe("demo-cart-ready");
    expect(payload.loyaltyBonusAvailable).toBe(84.5);
    expect(payload.generation).toBeUndefined();
  });

  it("requires a session in live mode and opens no gateway without one", async () => {
    const openGateway = vi.fn();
    const handler = createDraftsPostHandler(makeDeps({
      getEnv: () => makeEnv({ DATA_MODE: "live" }),
      resolveSession: async () => err({
        code: "unauthorized" as const,
        message: "no session",
        correlationId: "c",
        retryAfterMs: null,
      }),
      openGateway,
    }));

    const response = await handler(post());
    const payload = await response.json();

    expect(response.status).toBe(401);
    expect(payload.error.code).toBe("unauthorized");
    expect(openGateway).not.toHaveBeenCalled();
  });

  it("cannot be talked into demo mode by a request body", async () => {
    const openGateway = vi.fn(async () => ({
      gateway: createDemoSilpoGateway(),
      async close() {},
    }));
    const handler = createDraftsPostHandler(makeDeps({
      getEnv: () => makeEnv({ DATA_MODE: "live" }),
      openGateway,
    }));

    const response = await handler(post({ mode: "demo", userId: "attacker" }, "session-handle"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.mode).toBe("live");
    expect(openGateway).toHaveBeenCalledWith({ mode: "live", userId: "live-user" });
  });

  it("answers a missing slot with 409 and the slots to choose from", async () => {
    const base = createDemoSilpoGateway();
    const handler = createDraftsPostHandler(makeDeps({
      openGateway: async () => ({
        gateway: {
          ...base,
          async loadCartContext() {
            return {
              status: "needs_slot" as const,
              availableSlots: [{
                id: "slot-1",
                startsAt: "2026-09-09T09:00:00.000Z",
                endsAt: "2026-09-09T11:00:00.000Z",
                available: true,
              }],
            };
          },
        },
        async close() {},
      }),
    }));

    const response = await handler(post());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("needs_slot");
    expect(payload.availableSlots).toHaveLength(1);
  });

  it("passes the rate-limit hint through as 429", async () => {
    const handler = createDraftsPostHandler(makeDeps({
      openGateway: async () => ({
        gateway: {
          ...createDemoSilpoGateway(),
          async listTools() { throw new McpCallError("t", 429, "3"); },
        },
        async close() {},
      }),
    }));

    const response = await handler(post());
    const payload = await response.json();

    expect(response.status).toBe(429);
    expect(payload.error.retryAfterMs).toBe(3000);
  });

  it("reports a malformed Silpo response as 502 without echoing it", async () => {
    const handler = createDraftsPostHandler(makeDeps({
      openGateway: async () => ({
        gateway: {
          ...createDemoSilpoGateway(),
          async listTools() { throw new InvalidExternalDataError("silpo_get_my_shopping_cart"); },
        },
        async close() {},
      }),
    }));

    const response = await handler(post());
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload.error.code).toBe("invalid_external_data");
    expect(JSON.stringify(payload)).not.toContain("silpo_get_my_shopping_cart");
  });

  it("returns 500 with a safe message when the environment is unusable", async () => {
    const handler = createDraftsPostHandler(makeDeps({
      getEnv: () => { throw new Error("Invalid server environment: DATABASE_URL"); },
    }));

    const response = await handler(post());
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload.error.code).toBe("unexpected");
    expect(JSON.stringify(payload)).not.toContain("DATABASE_URL");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/integration/draft-route.test.ts`
Expected: FAIL — `Failed to resolve import "@/app/api/drafts/handlers"`.

- [ ] **Step 3: Write the handler**

Create `src/app/api/drafts/handlers.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { getDbClient } from "@/db/client";
import { generateDraft } from "@/features/agent/google-model";
import { ensureDemoUser } from "@/features/drafts/demo-user";
import { createPostgresDraftRepository, type DraftRepository } from "@/features/drafts/repository";
import { createDraftForUser, type CreateDraftDeps } from "@/features/drafts/service";
import { createSilpoGateway } from "@/features/silpo/gateway";
import { resolveSilpoSession } from "@/features/silpo/oauth/service";
import { getServerEnv, type ServerEnv } from "@/lib/env";
import type { AppError, AppErrorCode, Result } from "@/lib/result";

const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

const MSG_UNAUTHORIZED = "Не вдалося підтвердити вхід. Увійдіть у «Сільпо» ще раз.";
const MSG_UNEXPECTED = "Не вдалося зібрати чернетку. Спробуйте ще раз.";

/** The only place an HTTP status is decided. */
const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  needs_slot: 409,
  cart_validation_error: 409,
  unauthorized: 401,
  rate_limited: 429,
  invalid_external_data: 502,
  unavailable_product: 409,
  partial_commit: 409,
  model_invalid_output: 502,
  unexpected: 500,
};

/**
 * Every dependency is a field with a production default, because the
 * integration test runs without a database, without a network and without
 * an API key. `repository` and `resolveDemoUserId` are thunks so the
 * database client is built at call time rather than at module load.
 */
export interface DraftsHandlerDeps {
  getEnv: () => ServerEnv;
  resolveSession: (handle: string | null) => Promise<Result<{ userId: string }, AppError>>;
  resolveDemoUserId: () => Promise<string>;
  repository: () => DraftRepository;
  openGateway: CreateDraftDeps["openGateway"];
  generateDraft: CreateDraftDeps["generateDraft"];
}

const productionDeps: DraftsHandlerDeps = {
  getEnv: () => getServerEnv(),
  resolveSession: (handle) => resolveSilpoSession(handle),
  resolveDemoUserId: () => ensureDemoUser(getDbClient()),
  repository: () => createPostgresDraftRepository(getDbClient()),
  openGateway: ({ mode, userId }) =>
    createSilpoGateway({ mode, userId, publicBaseUrl: getServerEnv().PUBLIC_BASE_URL }),
  generateDraft: (input) => {
    const env = getServerEnv();
    return generateDraft(input, {
      apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
      model: env.AGENT_MODEL,
    });
  },
};

function fail(status: number, error: AppError, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error, ...extra }, { status, headers });
}

export function createDraftsPostHandler(overrides: Partial<DraftsHandlerDeps> = {}) {
  const deps: DraftsHandlerDeps = { ...productionDeps, ...overrides };

  return async function POST(request: NextRequest): Promise<Response> {
    const correlationId = randomUUID();

    try {
      // The run takes no client input at all: no body is read, no query
      // parameter is consulted. Mode comes from the environment and the
      // identity from the server-side session.
      const env = deps.getEnv();
      const mode = env.DATA_MODE;

      let userId: string;
      if (mode === "demo") {
        userId = await deps.resolveDemoUserId();
      } else {
        const handle = request.cookies.get("silpo_session")?.value ?? null;
        const session = await deps.resolveSession(handle);
        if (!session.ok) {
          return fail(401, {
            code: "unauthorized",
            message: MSG_UNAUTHORIZED,
            correlationId,
            retryAfterMs: null,
          });
        }
        userId = session.value.userId;
      }

      const result = await createDraftForUser(
        { userId, mode, correlationId },
        {
          openGateway: deps.openGateway,
          generateDraft: deps.generateDraft,
          repository: deps.repository(),
        },
      );

      if (!result.ok) {
        const { error, availableSlots } = result.error;
        return fail(
          STATUS_BY_CODE[error.code],
          error,
          availableSlots === null ? {} : { availableSlots },
        );
      }

      const { draft, cartContext, loyaltyBonusAvailable } = result.value;
      return Response.json(
        { mode, draft, cartContext, loyaltyBonusAvailable },
        { status: 200, headers },
      );
    } catch {
      // Environment, database and wiring faults. The cause is never echoed.
      return fail(500, {
        code: "unexpected",
        message: MSG_UNEXPECTED,
        correlationId,
        retryAfterMs: null,
      });
    }
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/integration/draft-route.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the route module**

Create `src/app/api/drafts/route.ts`:

```ts
import { createDraftsPostHandler } from "./handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/**
 * The sum of the two budgets the run already owns: 60 s of MCP work and
 * 30 s of generation. It has no local effect and is read only by a
 * serverless deployment, where a platform default would otherwise cut a
 * run below its own timeouts.
 */
export const maxDuration = 90;

export const POST = createDraftsPostHandler();
```

- [ ] **Step 6: Verify the whole task**

Run: `pnpm vitest run tests/integration/draft-route.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/drafts tests/integration/draft-route.test.ts
git commit -m "feat: expose POST /api/drafts"
```

---

### Task 6: Documentation and integration

**Files:**
- Modify: `docs/tasks.md` (Task 13 section, lines 882–922)
- Modify: `docs/project-architecture.md` (`DraftService` subsection)

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: nothing consumed by later code; the ledger the controller reads.

- [ ] **Step 1: Tick the Task 13 checkboxes**

In `docs/tasks.md`, change each of the five Task 13 steps from `- [ ]` to `- [x]`, and append this line immediately before the `---` that closes the section:

```markdown
Виконано 2026-09-08. Специфікація: [design](./superpowers/specs/2026-09-08-draft-orchestration-design.md), план: [plan](./superpowers/plans/2026-09-08-draft-orchestration.md). Живий MCP-прогін не виконано — немає авторизованої сесії «Сільпо».
```

- [ ] **Step 2: Record the decisions in the architecture document**

In `docs/project-architecture.md`, replace the `### DraftService` paragraph with:

```markdown
### `DraftService`

Оркеструє gateway, normalizer, predictor, resolver, Gemini і repository. Зберігає `algorithmVersion`, `trainingCutoff`, reason codes, price snapshots і data mode.

`createDraftForUser({ userId, mode, correlationId }, deps)` повертає `Result<DraftRun, DraftFailure>`, де `DraftRun` містить `draft`, `cartContext`, `loyaltyBonusAvailable` і sanitized `generation` (`source`, `attempts`, `normalizations`) для метрик Task 17. Кожен запуск створює нову чернетку з `version: 1`; попередні чернетки лишаються рядками історії.

`createSilpoGateway({ mode, userId, publicBaseUrl })` повертає `SilpoGatewayHandle` — `{ gateway, close() }`. Live-композиція відкриває один read session і lazy write session, який створюється лише за потреби bootstrap кошика. Mode фіксується під час створення; live ніколи не повертає demo gateway.

Demo mode персистує чернетки під синтетичним користувачем `DEMO_USER_ID`, який ідемпотентно створюється перед першим запуском. Це зберігає єдиний шлях персистенції для live і demo.

Деталі — у [специфікації Task 13](./superpowers/specs/2026-09-08-draft-orchestration-design.md).
```

- [ ] **Step 3: Run every gate**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
Expected: PASS. Record the exact counts; do not claim success without fresh output.

- [ ] **Step 4: Review the diff for scope**

Run: `git diff main...HEAD --stat`
Confirm only the eleven files in the File Structure table changed, that `.gitignore` and `AGENTS.md` remain untouched by this branch, and that no secret, `TODO` or placeholder is present.

- [ ] **Step 5: Commit the documentation**

```bash
git add docs/tasks.md docs/project-architecture.md
git commit -m "docs: record draft orchestration decisions"
```

- [ ] **Step 6: Integrate as one commit**

This step is the controller's call, not the implementer's. Ask before running it.

```bash
git checkout main
git merge --squash task-13-draft-orchestration
git commit -m "feat: orchestrate personal drafts"
```

Then rerun `pnpm test && pnpm typecheck && pnpm build` in the integrated checkout and report the commit hash.
