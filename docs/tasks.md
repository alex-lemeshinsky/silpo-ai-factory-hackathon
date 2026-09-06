# «Автопілот запасів» — backlog реалізації MVP

> **Для агентів:** спочатку прочитайте кореневий `AGENTS.md`, потім лише релевантні стабільні документи та одну призначену задачу. Виконуйте checkbox-кроки послідовно; одна задача — один перевірений commit.

**Goal:** Build a web application that generates an explainable personal grocery draft from Silpo purchase history, lets the user edit it, and idempotently commits confirmed products to the real Silpo cart.

**Architecture:** A Next.js modular monolith keeps UI, route handlers, Gemini orchestration, persistence, and MCP integration in one deployable repository. Pure TypeScript modules normalize purchases and score replenishment needs; Gemini 3.7 Flash only explains and ranks server-provided candidates. Live and demo Silpo adapters implement the same typed contracts.

**Tech Stack:** Next.js App Router, TypeScript, React, Tailwind CSS, Vitest, Testing Library, Playwright, Zod, Drizzle ORM, Postgres, Vercel AI SDK, `@ai-sdk/google`, `@ai-sdk/mcp`, `@modelcontextprotocol/client`, Gemini 3.7 Flash.

**Product spec:** [product-spec.md](./product-spec.md)

**Supporting docs:** [project-architecture.md](./project-architecture.md), [agent-architecture.md](./agent-architecture.md), [design-system.md](./design-system.md)

## Global Constraints

- The primary UI is an action-first web dashboard; chat is outside MVP.
- The default model is exactly `gemini-3.7-flash` through Google AI Studio and `@ai-sdk/google`.
- `GOOGLE_GENERATIVE_AI_API_KEY` and MCP tokens are server-only.
- Prediction is category-first and SKU-second.
- Exact-SKU candidates require at least two observations; category candidates require at least three.
- Prediction history is limited to 180 days and uses city weight 1.0 for the active city and 0.35 otherwise.
- Confidence weights are due 0.40, repeat 0.35, and stability 0.25; scores below 0.55 abstain.
- Gemini never invents prices, stock, IDs, nutrition values, or products.
- Gemini sees at most five high-level tools in a step.
- No cart write occurs before explicit, persisted user confirmation.
- Every cart write is followed immediately by cart readback and validation inspection.
- Bags, delivery fees, acceleration fees, and service rows are never recommended or added.
- Live mode never silently falls back to demo mode.
- Demo mode always displays a visible “Демонстраційні дані” banner.
- Checkout links appear only when the verified cart has no error-level validation.
- Use Zod schemas compatible with Google structured output: do not use `z.union` or `z.record` in model output schemas.
- Each task is implemented with TDD and committed separately.

---

## File and ownership map

```text
src/
  app/
    api/auth/silpo/{start,callback}/route.ts
    api/drafts/route.ts
    api/cart/commit/route.ts
    dashboard/page.tsx
    layout.tsx
    page.tsx
  components/autopilot/
    app-header.tsx
    draft-dashboard.tsx
    draft-product-card.tsx
    draft-summary.tsx
    status-panel.tsx
  db/
    client.ts
    schema.ts
  features/
    shared/contracts.ts
    silpo/
      oauth/{provider,token-vault}.ts
      live/{history,cart,catalog}.ts
      demo/demo-gateway.ts
      schemas/{common,history,cart,catalog}.ts
      gateway.ts
    purchases/{deduplicate,normalize,categorize}.ts
    prediction/{features,score,backtest}.ts
    products/resolve-products.ts
    agent/{draft-agent,draft-output,prompt}.ts
    drafts/{service,repository}.ts
    cart/{commit-service,repository}.ts
    diagnostics/{backtest-service,service}.ts
  lib/{env,logger,result}.ts
fixtures/demo/silpo-snapshot.json
tests/{contract,integration,e2e}/
```

Agents own only the files listed in their task. Shared contracts change only in Task 2; later tasks must request a controller-approved contract change rather than editing them independently.

## Dependency and parallelization map

```text
Wave 0:  T1
Wave 1:  T2
Wave 2:  T3      T4      T7
Wave 3:          T5      T8      T14
Wave 4:          T6      T9      T15
Wave 5:                  T10
Wave 6:                  T11     T16
Wave 7:                  T12
Wave 8:                  T13
Wave 9:                  T17
Wave 10:                 T18
```

- One fresh implementation agent per task.
- Tasks in the same wave may run concurrently only when their listed files do not overlap.
- The controller reviews spec compliance first, then code quality, before the next dependent wave.
- Each agent returns changed files, tests run, result, and commit hash.

---

### Task 1: Project shell and test harness

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.json`
- Create: `next.config.ts`
- Create: `eslint.config.mjs`
- Create: `postcss.config.mjs`
- Create: `vitest.config.ts`
- Create: `vitest.setup.ts`
- Create: `playwright.config.ts`
- Create: `src/app/layout.tsx`
- Create: `src/app/page.tsx`
- Create: `src/app/globals.css`
- Test: `src/app/page.test.tsx`

**Interfaces:**
- Consumes: none.
- Produces: runnable Next.js app; commands `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build`.

- [x] **Step 1: Create package and tool configuration**

Use scripts:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test"
  }
}
```

Install runtime dependencies with:

```bash
pnpm add next react react-dom zod
pnpm add -D typescript @types/node @types/react @types/react-dom eslint eslint-config-next tailwindcss @tailwindcss/postcss postcss vitest jsdom @vitejs/plugin-react @testing-library/dom @testing-library/react @testing-library/jest-dom @playwright/test
```

- [x] **Step 2: Write the failing landing-page test**

```tsx
import { render, screen } from "@testing-library/react";
import HomePage from "./page";

it("introduces Inventory Autopilot", () => {
  render(<HomePage />);
  expect(screen.getByRole("heading", { name: "Автопілот запасів" })).toBeVisible();
});
```

- [x] **Step 3: Run the focused test and confirm failure**

Run: `pnpm vitest run src/app/page.test.tsx`
Expected: FAIL because the page has not rendered the required heading.

- [x] **Step 4: Implement the minimum app shell**

```tsx
export default function HomePage() {
  return <main><h1>Автопілот запасів</h1></main>;
}
```

- [x] **Step 5: Verify the project**

Run: `pnpm test && pnpm lint && pnpm typecheck && pnpm build`
Expected: all commands exit 0.

- [x] **Step 6: Commit**

```bash
git add .gitignore package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json next.config.ts eslint.config.mjs postcss.config.mjs vitest.config.ts vitest.setup.ts playwright.config.ts src/app
git commit -m "chore: scaffold inventory autopilot app"
```

---

### Task 2: Shared domain contracts and environment validation

**Files:**
- Create: `src/features/shared/contracts.ts`
- Create: `src/lib/env.ts`
- Create: `src/lib/result.ts`
- Test: `src/features/shared/contracts.test.ts`
- Test: `src/lib/env.test.ts`

**Interfaces:**
- Consumes: Task 1 test harness.
- Produces: `DataMode`, `RawPurchaseReceipt`, `NormalizedReceipt`, `NeedCandidate`, `ProductCandidate`, `ResolvedNeed`, `Draft`, `CartContext`, `VerifiedCart`, `SilpoGateway`, `getServerEnv()`.

- [x] **Step 1: Write failing contract and environment tests**

```ts
import { DraftSchema } from "@/features/shared/contracts";
import { parseServerEnv } from "@/lib/env";

it("rejects a draft item without a source product id", () => {
  expect(() => DraftSchema.parse({
    id: "d1", mode: "demo", status: "ready", items: [{ productId: "" }]
  })).toThrow();
});

it("requires the Gemini key outside tests", () => {
  expect(() => parseServerEnv({ NODE_ENV: "production", DATABASE_URL: "postgres://db" })).toThrow();
});
```

- [x] **Step 2: Run the tests and confirm failure**

Run: `pnpm vitest run src/features/shared/contracts.test.ts src/lib/env.test.ts`
Expected: FAIL because schemas and parsers do not exist.

- [x] **Step 3: Define stable contracts**

```ts
export type DataMode = "live" | "demo";
export type PurchaseChannel = "offline" | "online";

export interface RawPurchaseItem {
  sourceId: string;
  externalProductId: number | null;
  productId: string | null;
  name: string;
  quantity: number;
  unit: string | null;
  unitPrice: number;
}

export interface RawPurchaseReceipt {
  sourceId: string;
  channel: PurchaseChannel;
  purchasedAt: string;
  city: string | null;
  total: number;
  items: RawPurchaseItem[];
}

export interface NeedCandidate {
  categoryKey: string;
  confidence: number;
  confidenceBand: "medium" | "high";
  typicalQuantity: number;
  reasonCodes: string[];
  preferredExternalProductIds: number[];
}
```

Define `SilpoGateway` with these exact methods:

```ts
export interface SilpoGateway {
  listTools(): Promise<string[]>;
  loadCustomerContext(): Promise<CustomerContext>;
  loadCartContext(): Promise<CartContextResult>;
  updateCartContext(input: UpdateCartContextInput): Promise<CartContext>;
  loadPurchaseHistory(context: CartContext): Promise<RawPurchaseReceipt[]>;
  findProducts(context: CartContext, queries: string[]): Promise<ProductSearchResult[]>;
  getPromotions(context: CartContext): Promise<Promotion[]>;
  getProductDetails(context: CartContext, slug: string): Promise<ProductDetails>;
  getSimilarProducts(context: CartContext, slug: string): Promise<ProductCandidate[]>;
  getTimeSlots(context: CartContext): Promise<TimeSlot[]>;
  setAbsoluteCartQuantities(input: SetCartProductsInput): Promise<void>;
  readCart(cartId: string): Promise<VerifiedCart>;
}
```

- [x] **Step 4: Implement server-only env parsing**

Use a Zod object requiring `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, and defaulting `AGENT_MODEL` to `gemini-3.7-flash` and `DATA_MODE` to `live`. Export only `getServerEnv()`; do not export raw `process.env`.

- [x] **Step 5: Verify**

Run: `pnpm vitest run src/features/shared/contracts.test.ts src/lib/env.test.ts && pnpm typecheck`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/features/shared src/lib/env.ts src/lib/env.test.ts src/lib/result.ts
git commit -m "feat: define application contracts"
```

---

### Task 3: Demo snapshot adapter

**Files:**
- Create: `fixtures/demo/silpo-snapshot.json`
- Create: `src/features/silpo/demo/demo-gateway.ts`
- Test: `src/features/silpo/demo/demo-gateway.test.ts`

**Interfaces:**
- Consumes: `SilpoGateway` and domain types from Task 2.
- Produces: `createDemoSilpoGateway(): SilpoGateway`.

- [x] **Step 1: Add an anonymized fixture**

The fixture must include 30 receipts, the current cart context, time slots, promotions, product search results, details, similar products, and both successful and blocked cart states. Replace names, phones, addresses, loyalty IDs, order IDs, and tokens with synthetic values.

- [x] **Step 2: Write failing adapter tests**

```ts
const gateway = createDemoSilpoGateway();

it("implements the complete gateway contract", async () => {
  expect((await gateway.listTools()).length).toBeGreaterThan(0);
  expect((await gateway.loadPurchaseHistory(readyCart)).length).toBe(30);
});

it("returns cloned data so tests cannot mutate the fixture", async () => {
  const first = await gateway.loadPurchaseHistory(readyCart);
  first[0].items.length = 0;
  const second = await gateway.loadPurchaseHistory(readyCart);
  expect(second[0].items.length).toBeGreaterThan(0);
});

it("updates and verifies cart context in memory", async () => {
  const context = await gateway.updateCartContext(selectedSlot);
  expect(context.timeSlotId).toBe(selectedSlot.timeSlotId);
  expect((await gateway.loadCartContext()).status).toBe("ready");
});
```

- [x] **Step 3: Run and confirm failure**

Run: `pnpm vitest run src/features/silpo/demo/demo-gateway.test.ts`
Expected: FAIL because the adapter does not exist.

- [x] **Step 4: Implement the adapter**

Load and validate the JSON once, use `structuredClone` for returned data, and implement cart mutations against in-memory state scoped to one gateway instance.

- [x] **Step 5: Verify and commit**

Run: `pnpm vitest run src/features/silpo/demo/demo-gateway.test.ts`
Expected: PASS.

```bash
git add fixtures/demo src/features/silpo/demo
git commit -m "feat: add anonymized demo gateway"
```

---

### Task 4: Purchase deduplication and normalization

**Files:**
- Create: `src/features/purchases/deduplicate.ts`
- Create: `src/features/purchases/categorize.ts`
- Create: `src/features/purchases/normalize.ts`
- Test: `src/features/purchases/normalize.test.ts`

**Interfaces:**
- Consumes: `RawPurchaseReceipt[]`.
- Produces: `normalizePurchases(receipts, activeCity, cutoff): NormalizedReceipt[]`.

- [x] **Step 1: Write failing normalization tests**

```ts
it("deduplicates an online order and matching loyalty receipt", () => {
  const result = normalizePurchases([onlineOrder, matchingOfflineReceipt], "Київ", cutoff);
  expect(result).toHaveLength(1);
});

it.each(["Пакет Сільпо", "Послуга доставки", "Доплата за прискорення"])(
  "filters service row %s", name => {
    expect(normalizePurchases([receiptWith(name)], "Київ", cutoff)[0].items).toHaveLength(0);
  }
);

it("assigns weight 0.35 outside the active city", () => {
  expect(normalizePurchases([odesaReceipt], "Київ", cutoff)[0].locationWeight).toBe(0.35);
});
```

- [x] **Step 2: Confirm failure**

Run: `pnpm vitest run src/features/purchases/normalize.test.ts`
Expected: FAIL because `normalizePurchases` does not exist.

- [x] **Step 3: Implement deterministic normalization**

Deduplicate when receipts are within four hours, totals differ by no more than one hryvnia, and at least 70% of external product IDs overlap. Use a category rule table before any LLM fallback. Store unknown category as `uncategorized`; never guess it inside this module.

- [x] **Step 4: Verify**

Run: `pnpm vitest run src/features/purchases/normalize.test.ts`
Expected: PASS for duplicates, exclusions, units, cutoff, and city weighting.

- [x] **Step 5: Commit**

```bash
git add src/features/purchases
git commit -m "feat: normalize purchase history"
```

---

### Task 5: Prediction feature extraction and scoring

**Detailed spec:** [Prediction and backtest specification](./superpowers/specs/2026-09-03-prediction-backtest-design.md)

**Implementation plan:** [Tasks 5–6 execution plan](./superpowers/plans/2026-09-03-prediction-backtest.md#task-5--prediction-feature-extraction-and-scoring)

**Dependencies:** Tasks 1, 2, and 4 must be integrated before implementation. Planning is complete; implementation remains pending.

**Files:**
- Create: `src/features/prediction/features.ts`
- Create: `src/features/prediction/score.ts`
- Test: `src/features/prediction/score.test.ts`

**Interfaces:**
- Consumes: `NormalizedReceipt[]`, active date, active city.
- Produces: `inferNeeds({ receipts, now, activeCity }): NeedCandidate[]`, `scoreNeed`, `toConfidenceBand`, pure observation/feature helpers, and versioned prediction configuration. See the detailed spec for exact signatures and formulas; shared contracts remain unchanged.

- [x] **Step 1: Write failing scoring tests**

```ts
it("abstains below three category observations", () => {
  expect(inferNeeds({ receipts: twoWaterReceipts, now, activeCity: "Київ" })).toEqual([]);
});

it("uses the agreed confidence weights", () => {
  expect(scoreNeed({ due: 1, repeat: 0.5, stability: 0.25 })).toBeCloseTo(0.6375);
});

it("labels 0.75 as high confidence", () => {
  expect(toConfidenceBand(0.75)).toBe("high");
});
```

- [x] **Step 2: Confirm failure**

Run: `pnpm vitest run src/features/prediction/score.test.ts`
Expected: FAIL because scoring functions do not exist.

- [x] **Step 3: Implement features and score**

Use median interval, median absolute deviation, weighted count, days since last purchase, and typical quantity. Clamp the due/repeat/stability score components to 0–1, without clamping counts or intervals. Filter history older than 180 days, future receipts, and results below 0.55. Sort by descending confidence and then category key for deterministic ties. Implement P5-01 through P5-07 in the detailed spec, including observation support, compatible quantities, reason codes, and runtime validation.

- [x] **Step 4: Verify and commit**

Run: `pnpm vitest run src/features/prediction/score.test.ts && pnpm typecheck`
Expected: PASS.

```bash
git add src/features/prediction/features.ts src/features/prediction/score.ts src/features/prediction/score.test.ts
git commit -m "feat: score replenishment needs"
```

---

### Task 6: Rolling backtest evaluator

**Detailed spec:** [Prediction and backtest specification](./superpowers/specs/2026-09-03-prediction-backtest-design.md#6-task-6-domain-requirements)

**Implementation plan:** [Task 6 execution plan](./superpowers/plans/2026-09-03-prediction-backtest.md#task-6--rolling-backtest-and-demo-endpoint)

**Dependencies:** Tasks 2, 3, 4, and the reviewed Task 5 commit must be integrated. Task 6 runs after Task 5, not concurrently with it.

**Files:**
- Create: `src/features/prediction/backtest.ts`
- Create: `src/features/prediction/backtest.test.ts`
- Create: `src/features/diagnostics/backtest-service.ts`
- Test: `src/features/diagnostics/backtest-service.test.ts`
- Create: `src/app/api/backtest/route.ts`
- Test: `src/app/api/backtest/route.test.ts`

The application service and route test refine the original file list to preserve the Route Handler → Application Service → Domain boundary. Task 17 remains the owner of the separate diagnostics aggregation service and UI.

**Interfaces:**
- Consumes: `NormalizedReceipt[]`, explicit `activeCity`, `inferNeeds`, and the demo `SilpoGateway` through an injected application-service port.
- Produces: `runRollingBacktest(receipts, { activeCity }): BacktestReport`, feature-local `BacktestReportSchema`, `loadDemoBacktest(gateway, correlationId): Promise<Result<BacktestReport, AppError>>`, and demo-only `GET /api/backtest`.

The required city refines the earlier one-argument sketch; deriving it from future receipts or old location weights is not permitted. No frozen shared contract changes are required.

- [x] **Step 1: Write the failing no-leakage test**

```ts
it("never trains on the receipt being predicted", () => {
  const report = runRollingBacktest(chronologicalReceipts, { activeCity: "Київ" });
  expect(report.windows.every(w => Date.parse(w.trainingCutoff) < Date.parse(w.testDate))).toBe(true);
});
```

Also assert actual predictor input timestamps, equal-time exclusion, and future-poisoning invariance; cutoff metadata alone is insufficient evidence.

- [x] **Step 2: Confirm failure**

Run: `pnpm vitest run src/features/prediction/backtest.test.ts`
Expected: FAIL because the evaluator does not exist.

- [x] **Step 3: Implement metrics**

Return exact-SKU precision/recall, category precision@3, category recall@3, hit rate, coverage, confidence buckets, and the 90-day most-frequent baseline. Follow B6-01 through B6-10 for fixed-K macro denominators, cold starts, explicit nulls, corpus validation, calibration, and report versioning. The application service loads and validates synthetic history; the thin route returns 404 in live mode and a labeled, non-cacheable report in demo mode. Do not perform live, model, database, or cart-write operations.

- [x] **Step 4: Verify and commit**

Run: `pnpm vitest run src/features/prediction/backtest.test.ts src/features/diagnostics/backtest-service.test.ts src/app/api/backtest/route.test.ts`
Expected: PASS with finite numeric metrics in 0–1 and `null` when a denominator is missing. Then run the cumulative/static/build gates in the implementation plan.

```bash
git add src/features/prediction/backtest.ts src/features/prediction/backtest.test.ts src/features/diagnostics/backtest-service.ts src/features/diagnostics/backtest-service.test.ts src/app/api/backtest/route.ts src/app/api/backtest/route.test.ts
git commit -m "feat: add rolling prediction backtest"
```

---

### Task 7: Database schema and repositories

**Files:**
- Create: `drizzle.config.ts`
- Create: `src/db/client.ts`
- Create: `src/db/schema.ts`
- Create: `src/features/drafts/repository.ts`
- Create: `src/features/cart/repository.ts`
- Test: `src/features/drafts/repository.test.ts`
- Test: `src/features/cart/repository.test.ts`

**Interfaces:**
- Consumes: Task 2 contracts.
- Produces: `DraftRepository.save(userId, draft, { expectedVersion? })`, `DraftRepository.get(draftId, userId)`, approval persistence, `CartCommitRepository`, and migrations for all tables in spec section 10. Draft save/update persists its prediction-run metadata and ordered item snapshots in one transaction; updates use optimistic version checks, and repository reads validate database rows before returning trusted domain values.

- [x] **Step 1: Install persistence dependencies**

Run: `pnpm add drizzle-orm postgres && pnpm add -D drizzle-kit`.

- [x] **Step 2: Write failing repository tests against in-memory fakes**

```ts
it("persists explicit draft approval once", async () => {
  const repo = createInMemoryDraftRepository();
  await repo.approve("draft-1", "user-1", "key-1");
  await expect(repo.approve("draft-1", "user-1", "key-2")).rejects.toThrow("already approved");
});

it("reuses persisted absolute quantities for a retry", async () => {
  const repo = createInMemoryCartCommitRepository();
  await repo.start({ key: "k1", targetQuantities: { p1: 3 } });
  expect((await repo.get("k1"))?.targetQuantities).toEqual({ p1: 3 });
});
```

- [x] **Step 3: Define schema and repository interfaces**

Use UUID primary keys, UTC timestamps, unique `purchase_receipts.external_fingerprint`, unique `cart_commits.idempotency_key`, JSONB only for sanitized features/trace metadata, and foreign keys with explicit delete behavior. Store the MCP token ciphertext, 12-byte IV, and authentication tag in separate columns. Keep the legacy ciphertext column during the compatible migration, and use a partial unique index to permit only one new-format envelope per user so Task 8 can implement `TokenVault.get(userId)` unambiguously without destroying older rows.

- [x] **Step 4: Implement Postgres and in-memory repositories**

The application uses Postgres repositories; unit tests use fakes with identical interfaces.

- [x] **Step 5: Generate migration and verify**

Run: `pnpm drizzle-kit generate && pnpm vitest run src/features/drafts/repository.test.ts src/features/cart/repository.test.ts && pnpm typecheck`
Expected: migration generated and tests pass.

- [x] **Step 6: Commit**

```bash
git add drizzle.config.ts drizzle src/db src/features/drafts/repository.ts src/features/drafts/repository.test.ts src/features/cart/repository.ts src/features/cart/repository.test.ts package.json pnpm-lock.yaml
git commit -m "feat: persist drafts and cart commits"
```

---

### Task 8: Encrypted MCP token vault

**Files:**
- Create: `src/features/silpo/oauth/token-vault.ts`
- Test: `src/features/silpo/oauth/token-vault.test.ts`

**Interfaces:**
- Consumes: `TOKEN_ENCRYPTION_KEY`, `mcp_connections`.
- Produces: `TokenVault.get(userId)`, `TokenVault.put(userId, tokens)`, `TokenVault.clear(userId)`.

- [x] **Step 1: Write failing encryption tests**

```ts
it("does not store access or refresh tokens as plaintext", async () => {
  await vault.put("u1", { accessToken: "access-secret", refreshToken: "refresh-secret", expiresAt });
  const row = await storage.raw("u1");
  expect(JSON.stringify(row)).not.toContain("secret");
  expect(await vault.get("u1")).toMatchObject({ accessToken: "access-secret" });
});
```

- [x] **Step 2: Confirm failure**

Run: `pnpm vitest run src/features/silpo/oauth/token-vault.test.ts`
Expected: FAIL because `TokenVault` does not exist.

- [x] **Step 3: Implement encryption**

Use AES-256-GCM with a random 12-byte IV per write, authenticated tag, and a base64-decoded 32-byte key. Store ciphertext, IV, tag, expiry, and OAuth client metadata separately. Never log token values.

- [x] **Step 4: Verify and commit**

Run: `pnpm vitest run src/features/silpo/oauth/token-vault.test.ts`
Expected: PASS, including wrong-key and tampered-ciphertext cases.

```bash
git add src/features/silpo/oauth
git commit -m "feat: encrypt Silpo OAuth tokens"
```

---

### Task 9: Silpo OAuth start and callback

**Planning:** [Specification](./superpowers/specs/2026-09-06-silpo-oauth-design.md) · [Implementation plan](./superpowers/plans/2026-09-06-silpo-oauth.md). Scope and storage expansion approved per spec section 3.

**Files:**
- Modify: `docs/tasks.md`
- Modify: `docs/project-architecture.md`
- Modify: `package.json`, `pnpm-lock.yaml`
- Create: `src/features/silpo/oauth/envelope.ts`
- Test: `src/features/silpo/oauth/envelope.test.ts`
- Modify: `src/features/silpo/oauth/token-vault.ts` (shared envelope helper extraction only)
- Create: `src/features/silpo/oauth/auth-repository.ts`
- Test: `src/features/silpo/oauth/auth-repository.test.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/schema.test.ts`
- Create: `drizzle/0003_silpo_oauth.sql`, `drizzle/meta/0003_snapshot.json`, `drizzle/meta/_journal.json`
- Create: `src/features/silpo/oauth/provider.ts`
- Test: `src/features/silpo/oauth/provider.test.ts`
- Create: `src/features/silpo/oauth/transport.ts`
- Test: `src/features/silpo/oauth/transport.test.ts`
- Create: `src/features/silpo/oauth/service.ts`
- Test: `src/features/silpo/oauth/service.test.ts`
- Create: `src/app/api/auth/silpo/start/route.ts`
- Create: `src/app/api/auth/silpo/callback/route.ts`
- Create: `tests/integration/silpo-oauth.test.ts`
- Create: `tests/integration/silpo-oauth-postgres.test.ts`
- Modify: `vitest.config.ts`

**Interfaces:**
- Consumes: `TokenVault`, `DbClient`, `getServerEnv()`, `@ai-sdk/mcp`, `@modelcontextprotocol/client`.
- Produces: `createSilpoOAuthProvider(userId)`, `createSilpoOAuthService()`, `resolveSilpoSession(handle)`, `auth_sessions` and `silpo_oauth_states` persistence, start redirect, callback completion.

- [x] **Step 1: Install MCP clients**

Run: `pnpm add @ai-sdk/mcp @modelcontextprotocol/client`.

- [x] **Step 2: Write failing OAuth tests**

Assert that start persists PKCE verifier and state, callback rejects a state mismatch, callback passes the authorization code to `transport.finishAuth(code)`, and a 401 triggers one refresh attempt before reauthorization.

- [x] **Step 3: Confirm failure**

Run: `pnpm vitest run src/features/silpo/oauth/provider.test.ts tests/integration/silpo-oauth.test.ts`
Expected: FAIL because routes and provider do not exist.

- [x] **Step 4: Implement the provider**

Implement the official `OAuthClientProvider` contract for `https://mcp.silpo.ua/mcp`. Store client registration, PKCE verifier, state, and tokens server-side. Set the browser session cookie `HttpOnly`, `Secure` in production, `SameSite=Lax`, and with a bounded lifetime.

- [x] **Step 5: Verify and commit**

Run: `pnpm vitest run src/features/silpo/oauth/provider.test.ts tests/integration/silpo-oauth.test.ts && pnpm typecheck`
Expected: PASS.

```bash
git add src/features/silpo/oauth/provider.ts src/app/api/auth/silpo tests/integration/silpo-oauth.test.ts package.json pnpm-lock.yaml
git commit -m "feat: add Silpo OAuth flow"
```

---

### Task 10: Live history and cart-context gateway

**Files:**
- Create: `src/features/silpo/schemas/common.ts`
- Create: `src/features/silpo/schemas/history.ts`
- Create: `src/features/silpo/schemas/cart.ts`
- Create: `src/features/silpo/live/history.ts`
- Create: `src/features/silpo/live/cart-context.ts`
- Create: `src/features/silpo/live/retry.ts`
- Create: `src/app/api/cart/context/route.ts`
- Test: `tests/contract/silpo-history.test.ts`
- Test: `tests/contract/silpo-cart-context.test.ts`

**Interfaces:**
- Consumes: OAuth provider; shared contracts.
- Produces: `LiveHistoryGateway`, `LiveCartContextGateway`.

- [ ] **Step 1: Write fixture-driven contract tests**

Cover `tools/list`, family, restrictions, loyalty, online orders, offline orders, active cart, expired slot, no cart, available delivery types, cart creation, selected-slot updates, immediate readback validation, `429` retry exhaustion, and the rule that writes are never retried automatically.

- [ ] **Step 2: Confirm failure**

Run: `pnpm vitest run tests/contract/silpo-history.test.ts tests/contract/silpo-cart-context.test.ts`
Expected: FAIL because schemas and gateways do not exist.

- [ ] **Step 3: Implement cart bootstrap**

The exact sequence is:

```text
get_my_shopping_cart
→ when present: get_shopping_cart_by_id → get_time_slots
→ when absent: find_address → get_available_delivery_types
  → optional list_branches → get_time_slots → create_shopping_cart
  → get_shopping_cart_by_id → get_time_slots
```

An expired slot returns `{ status: "needs_slot", availableSlots }`; do not continue with cart-dependent reads until the caller selects a slot.

`POST /api/cart/context` accepts a selected available slot, copies the current address and shipments exactly from the cart readback, calls `silpo_update_shopping_cart`, then immediately reads the cart and validates the new slot. It returns the verified `CartContext`.

- [ ] **Step 4: Implement history reads and mapping**

Use the verified cart context for offline orders. Map `lagerId` to `externalProductId`. Convert online UTC timestamps before display but preserve ISO UTC internally. Do not store phone, address, loyalty barcode, or full profile.

- [ ] **Step 5: Implement bounded retry behavior**

Retry read-only calls after `429` at most three times using server-provided retry metadata when present, otherwise delays of 250 ms, 500 ms, and 1,000 ms plus jitter. Do not automatically retry cart writes. Delegate `401` to the OAuth provider for one refresh attempt.

- [ ] **Step 6: Verify and commit**

Run: `pnpm vitest run tests/contract/silpo-history.test.ts tests/contract/silpo-cart-context.test.ts && pnpm typecheck`
Expected: PASS.

```bash
git add src/features/silpo/schemas src/features/silpo/live/history.ts src/features/silpo/live/cart-context.ts src/features/silpo/live/retry.ts src/app/api/cart/context tests/contract
git commit -m "feat: read live Silpo purchase context"
```

---

### Task 11: Live catalog gateway and product resolver

**Files:**
- Create: `src/features/silpo/schemas/catalog.ts`
- Create: `src/features/silpo/live/catalog.ts`
- Create: `src/features/products/resolve-products.ts`
- Test: `tests/contract/silpo-catalog.test.ts`
- Test: `src/features/products/resolve-products.test.ts`

**Interfaces:**
- Consumes: `NeedCandidate[]`, verified `CartContext`.
- Produces: `resolveProducts(needs, context, gateway): ResolvedNeed[]`.

- [ ] **Step 1: Write failing tests**

Test exact numeric article search first, unavailable exact SKU fallback, stock filtering, package step, promotions, same-budget sorting, missing nutrition attributes, and plastic-bag exclusion.

- [ ] **Step 2: Confirm failure**

Run: `pnpm vitest run tests/contract/silpo-catalog.test.ts src/features/products/resolve-products.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement catalog schemas and gateway**

Map `find_products_batch`, `get_promotions`, `get_product_details`, `get_similar_products`, and `get_replacements`. A product is selectable only when `available=true`, `stock>0`, and both company and branch IDs exist.

- [ ] **Step 4: Implement resolver policy**

Rank exact familiar SKU first. Otherwise rank alternatives by dietary compatibility, within-budget price, active discount, and package-size distance. Return explicit `nutritionStatus: "known" | "insufficient"`; never derive missing nutrients.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run tests/contract/silpo-catalog.test.ts src/features/products/resolve-products.test.ts && pnpm typecheck`
Expected: PASS.

```bash
git add src/features/silpo/schemas/catalog.ts src/features/silpo/live/catalog.ts src/features/products tests/contract/silpo-catalog.test.ts
git commit -m "feat: resolve live product candidates"
```

---

### Task 12: Gemini draft agent

**Files:**
- Create: `src/features/agent/draft-output.ts`
- Create: `src/features/agent/prompt.ts`
- Create: `src/features/agent/draft-agent.ts`
- Test: `src/features/agent/draft-agent.test.ts`

**Interfaces:**
- Consumes: `ResolvedNeed[]`, sanitized `CustomerContext`.
- Produces: `generateDraft(input): Promise<DraftProposal>`.

- [ ] **Step 1: Install AI SDK provider**

Run: `pnpm add ai @ai-sdk/google`.

- [ ] **Step 2: Write failing model-adapter tests**

```ts
it("rejects a product id absent from resolved candidates", async () => {
  await expect(generateDraftWithModel(fakeModelReturningUnknownId, input)).rejects.toThrow("unknown product");
});

it("does not pass personal fields to the model", async () => {
  await generateDraftWithModel(spyModel, inputWithPrivateFields);
  expect(spyModel.lastPrompt).not.toMatch(/phone|address|barcode/i);
});
```

- [ ] **Step 3: Confirm failure**

Run: `pnpm vitest run src/features/agent/draft-agent.test.ts`
Expected: FAIL.

- [ ] **Step 4: Define a Gemini-compatible output schema**

Use objects and arrays only; avoid unions and records:

```ts
export const DraftProposalSchema = z.object({
  summary: z.string().max(180),
  items: z.array(z.object({
    productId: z.string().min(1),
    externalProductId: z.number().int(),
    quantity: z.number().positive(),
    reason: z.string().max(160),
    alternativeIds: z.array(z.string())
  })).max(10)
});
```

- [ ] **Step 5: Implement generation and post-validation**

Use `google(env.AGENT_MODEL)`, `thinking: low`, low randomness, and structured output. Post-validate IDs, quantities, prices, and alternatives against resolver input. If Gemini fails twice, build a deterministic explanation from reason codes rather than returning no draft.

- [ ] **Step 6: Verify and commit**

Run: `pnpm vitest run src/features/agent/draft-agent.test.ts && pnpm typecheck`
Expected: PASS.

```bash
git add src/features/agent package.json pnpm-lock.yaml
git commit -m "feat: generate drafts with Gemini"
```

---

### Task 13: Draft orchestration and API

**Files:**
- Create: `src/features/silpo/gateway.ts`
- Create: `src/features/drafts/service.ts`
- Create: `src/app/api/drafts/route.ts`
- Test: `src/features/drafts/service.test.ts`
- Test: `tests/integration/draft-route.test.ts`

**Interfaces:**
- Consumes: Tasks 3–12.
- Produces: `createDraftForUser(userId, mode): Promise<Draft>`; `POST /api/drafts`.

- [ ] **Step 1: Write failing orchestration tests**

Assert ordered calls `listTools → cart context → history → normalize → infer → resolve → Gemini → save`; demo banner state; live mode no fallback; expired-slot response; and deterministic fallback after model failure.

- [ ] **Step 2: Confirm failure**

Run: `pnpm vitest run src/features/drafts/service.test.ts tests/integration/draft-route.test.ts`
Expected: FAIL.

- [ ] **Step 3: Compose gateways**

`createSilpoGateway({ mode, userId })` returns either the demo implementation or a composition of live history, cart-context, and catalog gateways. It never changes mode after creation.

- [ ] **Step 4: Implement the service and route**

Persist `algorithmVersion`, `trainingCutoff`, normalized reason codes, product price snapshot, and mode. Return HTTP 409 with available slots for `needs_slot`, 401 for reauthorization, and 429 with retry metadata for rate limiting.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run src/features/drafts/service.test.ts tests/integration/draft-route.test.ts && pnpm typecheck`
Expected: PASS.

```bash
git add src/features/silpo/gateway.ts src/features/drafts/service.ts src/app/api/drafts tests/integration/draft-route.test.ts
git commit -m "feat: orchestrate personal drafts"
```

---

### Task 14: Silpo-inspired dashboard shell

**Files:**
- Create: `src/app/dashboard/page.tsx`
- Modify: `src/app/globals.css`
- Create: `src/components/autopilot/app-header.tsx`
- Create: `src/components/autopilot/draft-dashboard.tsx`
- Create: `src/components/autopilot/draft-product-card.tsx`
- Create: `src/components/autopilot/draft-summary.tsx`
- Create: `src/components/autopilot/status-panel.tsx`
- Test: `src/components/autopilot/draft-dashboard.test.tsx`

**Interfaces:**
- Consumes: serialized `Draft`.
- Produces: responsive action-first dashboard.

- [ ] **Step 1: Write failing component tests**

Verify the hero summary, confidence label, price, stock, explanation, available loyalty bonus, demo banner, insufficient-nutrition copy, and absence of checkout while draft status is not `verified`. The bonus is informational only in this task: it must never be applied automatically or presented as already deducted from the total.

- [ ] **Step 2: Confirm failure**

Run: `pnpm vitest run src/components/autopilot/draft-dashboard.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement design tokens**

Define CSS variables `--autopilot-orange:#FE8522`, `--autopilot-blue:#2358D1`, `--autopilot-ink:#202124`, `--autopilot-bg:#F5F5FB`, `--autopilot-lilac:#EEEAFB`, and `--autopilot-green:#C7DF9C`. Use pill controls, white rounded sections, playful shapes, and a distinct “Автопілот” wordmark without copying the Silpo logo.

- [ ] **Step 4: Implement the dashboard**

Order: header → hero → forecast/value cards → “Ймовірно закінчується” product grid → sticky summary. Support loading, generating, ready, partial, blocked, verified, and demo states.

- [ ] **Step 5: Verify responsive behavior**

Run: `pnpm vitest run src/components/autopilot/draft-dashboard.test.tsx && pnpm build`
Expected: PASS; no horizontal overflow at 390px and 1440px.

- [ ] **Step 6: Commit**

```bash
git add src/app/dashboard src/app/globals.css src/components/autopilot
git commit -m "feat: add action-first draft dashboard"
```

---

### Task 15: Draft editing and persisted approval

**Files:**
- Create: `src/components/autopilot/draft-editor.tsx`
- Create: `src/app/api/drafts/[draftId]/approve/route.ts`
- Modify: `src/components/autopilot/draft-dashboard.tsx`
- Test: `src/components/autopilot/draft-editor.test.tsx`
- Test: `tests/integration/draft-approval.test.ts`

**Interfaces:**
- Consumes: `DraftRepository`.
- Produces: quantity/remove/replace interactions and `POST /api/drafts/:draftId/approve` returning `{ idempotencyKey }`.

- [ ] **Step 1: Write failing interaction tests**

Test quantity step, stock cap, removal, alternative selection, changed total, double-submit prevention, and approval ownership.

- [ ] **Step 2: Confirm failure**

Run: `pnpm vitest run src/components/autopilot/draft-editor.test.tsx tests/integration/draft-approval.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement editing**

All totals are computed from server-provided price snapshots. Disable confirm while a replacement is unresolved or quantity violates step/stock. Never display a nutrition comparison when either side is `insufficient`.

- [ ] **Step 4: Implement approval route**

Validate session ownership, current draft version, and selected item version. Persist one approval and generate one UUID idempotency key. Repeated requests return the same key.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run src/components/autopilot/draft-editor.test.tsx tests/integration/draft-approval.test.ts && pnpm typecheck`
Expected: PASS.

```bash
git add src/components/autopilot/draft-editor.tsx src/components/autopilot/draft-dashboard.tsx src/app/api/drafts tests/integration/draft-approval.test.ts
git commit -m "feat: edit and approve draft baskets"
```

---

### Task 16: Idempotent live cart commit and verification

**Files:**
- Create: `src/features/silpo/live/cart.ts`
- Create: `src/features/cart/commit-service.ts`
- Create: `src/app/api/cart/commit/route.ts`
- Test: `src/features/cart/commit-service.test.ts`
- Test: `tests/integration/cart-commit-route.test.ts`

**Interfaces:**
- Consumes: approved draft and idempotency key.
- Produces: `commitApprovedDraft(input): Promise<VerifiedCart>`; `POST /api/cart/commit`.

- [ ] **Step 1: Write failing safety tests**

```ts
it("does not write without persisted approval", async () => {
  await expect(service.commit({ draftId: "d1", key: "unknown" })).rejects.toThrow("approval required");
  expect(gateway.setAbsoluteCartQuantities).not.toHaveBeenCalled();
});

it("does not double-add after an uncertain first result", async () => {
  await service.commit({ draftId: "d1", key: "k1" }).catch(() => undefined);
  await service.commit({ draftId: "d1", key: "k1" });
  expect(gateway.setAbsoluteCartQuantities).toHaveBeenNthCalledWith(
    2, expect.objectContaining({ quantities: { productA: 3 } })
  );
});
```

Also test mandatory slot validation, stock cap with warning, package step, bag exclusion, partial validation failure, and hidden checkout on errors.

- [ ] **Step 2: Confirm failure**

Run: `pnpm vitest run src/features/cart/commit-service.test.ts tests/integration/cart-commit-route.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the live cart gateway**

Map `get_shopping_cart_by_id`, `get_time_slots`, and `add_or_update_cart_products`. Use `addQuantity=false`. Immediately call cart readback after every write and map all validations.

- [ ] **Step 4: Implement commit protocol**

Order: validate approval → load/reuse commit record → read cart → validate slot → refresh products → calculate and persist absolute targets → write → read cart → save verified/blocked result. A retry uses persisted targets. Return web and mobile checkout links only when error validations are empty.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run src/features/cart/commit-service.test.ts tests/integration/cart-commit-route.test.ts && pnpm typecheck`
Expected: PASS.

```bash
git add src/features/silpo/live/cart.ts src/features/cart/commit-service.ts src/features/cart/commit-service.test.ts src/app/api/cart/commit tests/integration/cart-commit-route.test.ts
git commit -m "feat: commit verified Silpo carts"
```

---

### Task 17: Demo diagnostics and sanitized MCP trace

**Files:**
- Create: `src/lib/logger.ts`
- Create: `src/features/diagnostics/service.ts`
- Create: `src/app/api/demo/diagnostics/route.ts`
- Create: `src/components/autopilot/demo-diagnostics.tsx`
- Modify: `src/features/drafts/service.ts`
- Modify: `src/features/cart/commit-service.ts`
- Modify: `src/components/autopilot/draft-dashboard.tsx`
- Test: `src/lib/logger.test.ts`
- Test: `src/features/diagnostics/service.test.ts`
- Test: `src/components/autopilot/demo-diagnostics.test.tsx`
- Test: `tests/integration/demo-diagnostics-route.test.ts`

**Interfaces:**
- Consumes: complete application.
- Produces: sanitized persisted traces and a demo-only diagnostics panel for the jury.

- [ ] **Step 1: Write failing diagnostics tests**

```ts
it("redacts secrets and personal fields before persisting a trace", async () => {
  await logger.toolCall({
    toolName: "silpo_get_offline_orders",
    authorization: "Bearer secret",
    phone: "+380000000000",
    address: "private",
  });
  expect(JSON.stringify(await traceRepo.all())).not.toMatch(/secret|380000000000|private/);
});

it("exposes backtest and product-decision metrics in demo mode", async () => {
  const report = await diagnostics.build(demoUserId);
  expect(report.backtest.categoryPrecisionAt3).toBeGreaterThanOrEqual(0);
  expect(report).toHaveProperty("acceptanceRate");
  expect(report).toHaveProperty("replacementRate");
  expect(report).toHaveProperty("acceptedReplacementSavings");
});
```

- [ ] **Step 2: Confirm failure**

Run: `pnpm vitest run src/lib/logger.test.ts src/features/diagnostics/service.test.ts src/components/autopilot/demo-diagnostics.test.tsx tests/integration/demo-diagnostics-route.test.ts`
Expected: FAIL because diagnostics do not exist.

- [ ] **Step 3: Add sanitized structured tracing**

Log correlation ID, mode, tool name, duration, retry count, prediction version, item count, and result status to `tool_traces`. Explicitly redact authorization headers, tokens, phone, email, address, barcode, profile IDs, raw prompts, and raw MCP payloads before both persistence and console output.

- [ ] **Step 4: Implement demo metrics and panel**

The demo-only route combines `runRollingBacktest` with persisted draft decisions and verified commits. Return exact-SKU precision/recall, category precision/recall@3, hit rate, coverage, confidence buckets, acceptance rate, replacement rate, and accepted-replacement savings. Return `null` plus “Недостатньо спостережень” for product-decision metrics without a denominator. Return 404 in live mode.

Add a collapsed “Як працює прогноз” panel to the demo dashboard. It shows the backtest summary and sanitized MCP trace rows (tool, duration, status) without raw inputs, outputs, or identifiers.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run src/lib/logger.test.ts src/features/diagnostics/service.test.ts src/components/autopilot/demo-diagnostics.test.tsx tests/integration/demo-diagnostics-route.test.ts && pnpm typecheck`
Expected: PASS.

```bash
git add src/lib/logger.ts src/lib/logger.test.ts src/features/diagnostics src/features/drafts/service.ts src/features/cart/commit-service.ts src/app/api/demo/diagnostics src/components/autopilot/demo-diagnostics.tsx src/components/autopilot/demo-diagnostics.test.tsx src/components/autopilot/draft-dashboard.tsx tests/integration/demo-diagnostics-route.test.ts
git commit -m "feat: expose sanitized demo diagnostics"
```

---

### Task 18: Full-story verification and release readiness

**Files:**
- Create: `tests/e2e/demo-draft.spec.ts`
- Create: `tests/e2e/blocked-cart.spec.ts`
- Create: `tests/e2e/live-smoke.spec.ts`
- Create: `tests/contract/gateway-parity.test.ts`
- Create: `.env.example`
- Create: `README.md`

**Interfaces:**
- Consumes: complete application.
- Produces: repeatable demo, setup instructions, adapter parity, and final verification evidence.

- [ ] **Step 1: Write end-to-end tests**

```ts
test("demo user reaches a verified checkout", async ({ page }) => {
  await page.goto("/dashboard?mode=demo");
  await expect(page.getByText("Демонстраційні дані")).toBeVisible();
  await page.getByRole("button", { name: /Додати у кошик/ }).click();
  await expect(page.getByRole("link", { name: "Оформити на сайті" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Оформити в застосунку" })).toBeVisible();
});

test("blocked cart never shows checkout", async ({ page }) => {
  await page.goto("/dashboard?mode=demo&scenario=blocked");
  await page.getByRole("button", { name: /Додати у кошик/ }).click();
  await expect(page.getByText(/потребує уваги/)).toBeVisible();
  await expect(page.getByRole("link", { name: /Оформити/ })).toHaveCount(0);
});
```

The automated live smoke is read-only by default. A write path must be skipped unless a dedicated test flag and a fresh manual confirmation are both present.

- [ ] **Step 2: Verify live/demo contract parity**

Run the same fixture-driven assertions against the demo gateway and mocked live gateway: method availability, normalized return types, missing-field behavior, cart validation mapping, and checkout-link mapping. Neither adapter may add mode-specific fields to shared domain objects.

Run: `pnpm vitest run tests/contract/gateway-parity.test.ts`
Expected: PASS for both adapters using the same assertion suite.

- [ ] **Step 3: Document setup**

`.env.example` contains names but no values for `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `AGENT_MODEL`, `DATA_MODE`, and public base URL. README documents Google AI Studio key creation, Silpo OAuth redirect URL, migration, demo start, live start, tests, and deployment.

- [ ] **Step 4: Run the complete verification suite**

Run:

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm test:e2e
```

Expected: every command exits 0. Save command output in the task report, not in the repository.

- [ ] **Step 5: Measure the agreed latency targets**

Run the complete demo draft flow 20 times after a warm build and assert p95 ≤ 2 seconds. Run the live read-only draft flow 10 times without interactive OAuth or rate-limit backoff and assert median ≤ 12 seconds. Record raw durations and calculated percentiles in the task report.

- [ ] **Step 6: Perform manual live smoke**

Read-only sequence: OAuth → `tools/list` → cart context → valid slot → history → draft. Run cart write only after a fresh manual confirmation, then immediately verify the cart. Record tool names, sanitized statuses, and checkout availability.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e tests/contract/gateway-parity.test.ts .env.example README.md
git commit -m "test: verify inventory autopilot MVP"
```

---

## Agent review protocol

For every task:

1. Implementation agent works only in listed files and runs focused tests.
2. Spec reviewer checks the task against this plan and the design spec.
3. Code-quality reviewer checks maintainability, security, tests, and unintended scope.
4. The original implementation agent fixes review findings.
5. The controller reruns focused tests and the cumulative suite.
6. Only then may dependent tasks start.

Parallel agents never edit shared contracts, package manifests, lockfiles, migrations, or the same feature directory at the same time. Tasks that add dependencies run sequentially through the controller to avoid lockfile conflicts.

## Recommended execution batches

- Batch A, sequential: Tasks 1–2.
- Batch B, parallel after Task 2: Tasks 3, 4, and 7.
- Batch C, parallel after Batch B: Tasks 5, 8, and 14.
- Batch D, parallel after Batch C: Tasks 6, 9, and 15.
- Batch E, sequential dependency: Task 10.
- Batch F, parallel after Task 10: Tasks 11 and 16.
- Batch G, sequential dependency: Task 12.
- Batch H, sequential integration: Task 13.
- Batch I: Task 17.
- Batch J: Task 18.

Before a parallel batch, the controller invokes `superpowers:using-git-worktrees` and gives each implementation agent an isolated worktree and branch. Agents commit only inside their assigned worktree; the controller reviews and integrates commits in dependency order. Never run parallel implementation agents in the same checkout.

The controller should keep one concurrency slot free for reviews and integration checks. With four available slots, dispatch at most three implementation agents simultaneously.
