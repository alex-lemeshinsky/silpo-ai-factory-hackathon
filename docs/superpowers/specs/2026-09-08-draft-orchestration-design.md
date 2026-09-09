# Task 13 Draft Orchestration and API Specification

Status: designed on 2026-09-08 against `150c4e3`. The file-ownership expansion in section 3 and the four deviations in section 4 were approved before code work.

## 1. Scope and authority

Refines [Task 13](../../tasks.md#task-13-draft-orchestration-and-api) and is executed through its implementation plan. [AGENTS.md](../../../AGENTS.md), the [product specification](../../product-spec.md), the [project architecture](../../project-architecture.md), the [agent architecture](../../agent-architecture.md), and the read-only [Silpo reference](../../../SILPO_MCP.md) retain precedence.

Build the layer that turns an authenticated identity into a persisted, explainable draft: a mode-dispatching gateway composition with an owned session lifecycle, an application service that owns the order of the run and its typed failures, deterministic assembly of a `DraftProposal` into a `Draft`, and `POST /api/drafts`.

Excluded: the dashboard and its data fetching (Task 14); draft editing, versioning and persisted approval (Task 15); every cart write, verification and checkout link (Task 16); diagnostics traces and metric aggregation (Task 17); end-to-end verification (Task 18). Task 13 performs no cart write, records no approval, and renders nothing.

## 2. Baseline and dependencies

Inspected commit: `150c4e3429680162f0ecd2fabfc791e7046bb841`. The `.gitignore` and `AGENTS.md` modifications in the working tree are user-owned and outside this work.

| Existing evidence | Design consequence |
|---|---|
| Tasks 1–12 are integrated; Task 13 is unchecked | Implement on those boundaries; do not recreate their output. |
| `SilpoGateway` in `src/features/shared/contracts.ts` declares thirteen methods, four of which write or read a cart | `createSilpoGateway` must satisfy the whole interface, but a draft run may call only the read subset. That gap is enforced by a test, not by prose — see T13-04. |
| `createLiveCartContextGateway({ readSession, writeSession })` takes both sessions at construction, and `bootstrapCart` uses `writeSession` for `silpo_create_shopping_cart` | A write session cannot be omitted outright without losing cart bootstrap, so it is supplied lazily — see T13-02. |
| `openReadSession` performs `tools/list` during `connect` and exposes `advertisedTools`; `callTool` throws `UnadvertisedToolError` for anything absent | The gateway's `listTools()` is a cached read, not a second round trip, and an unadvertised tool is already a mechanical failure. |
| `OpenSessionOptions.operationTimeoutMs` defaults to `30_000`, measured from session open | The default was sized for one cart-context operation. A draft run makes dozens of calls through one session, so it must raise the budget explicitly — see T13-10. |
| `McpCallError` carries `status` and `retryAfterHeader`; `InvalidExternalDataError` and `UnadvertisedToolError` are separate types | The route's status mapping is a closed set of typed errors, not string matching. |
| `createDemoSilpoGateway()` is synchronous, holds no session and implements the same interface | Demo composition is a one-line branch and its `close()` is a no-op. |
| `normalizePurchases(receipts, activeCity, cutoff)` and `inferNeeds({ receipts, now, activeCity })` are pure and both require a non-null `activeCity` | `CartContext.city` is nullable, so the run needs a defined resolution rule — see T13-05. |
| `resolveProducts` caps needs at ten, guarantees every candidate is available, in stock, at least one whole package, non-service and dietary-compatible, and returns them in prediction's confidence order | The service never re-checks purchasability and never reorders needs. |
| `validateProposal` already replaces the model's quantity with `executableQuantity`, returns items in `resolvedNeeds` order, and completes and dedupes `alternativeIds` | Assembly is a field mapping, not a second validation pass. |
| `generateDraftWithModel` never rejects for a model or provider fault and returns `{ proposal, source, attempts, normalizations }` | The run has no model-failure branch. `model_invalid_output` never reaches this route. |
| `generateDraft` (the production entry point) lives in `google-model.ts`, the only file importing the AI SDK | `service.ts` must receive generation as an injected function and must not import `google-model.ts`, or the SDK enters the service's module graph — see section 6. |
| `createPostgresDraftRepository(db).save(userId, draft)` inserts a `prediction_runs` row from `draft.algorithmVersion` and `draft.trainingCutoff`, and `drafts.user_id` is a FK to `users` | Persistence needs a real `users` row in both modes — see T13-03. |
| `DraftSchema` caps items at ten, rejects duplicate `productId`, and requires `total` to match the item snapshots within `0.01` | Assembly computes the total from the snapshots it just wrote and rounds to two decimals. |
| `DraftItemSchema` requires `quantity <= stock`, step alignment, a non-empty `reason` of at most 160 characters, and a `confidenceBand` matching `confidence` | Every one of these is already guaranteed upstream; assembly copies rather than derives. |
| `resolveSilpoSession(handle)` returns `{ userId, expiresAt }` and `createSilpoOAuthService.start`/`callback` return 404 in demo mode | Live identity comes from the cookie; demo mode has no session at all and needs its own identity — see T13-03. |
| `/api/cart/context` and `/api/backtest` gate on `env.DATA_MODE` and never accept a mode from the client | `POST /api/drafts` follows the same rule; see T13-08. |
| `src/app/api/auth/silpo/handlers.ts` separates injectable handler factories from `route.ts` | The proven pattern for an integration-testable route; reused rather than reinvented. |
| `src/lib/result.ts` already declares `needs_slot`, `unauthorized`, `rate_limited`, `invalid_external_data`, `cart_validation_error` and `unexpected` | No new `AppErrorCode`. |
| `drizzle/` holds four migrations and the schema already has `users`, `prediction_runs`, `drafts`, `draft_items` | Task 13 adds no migration and no schema change. |
| `vitest.config.ts` sweeps `src/**` and `tests/**` and excludes only the opt-in Postgres suite | No test-configuration change. Task 13's suites run without a database. |

Planning prerequisite evidence: `pnpm vitest run src/features/agent/draft-agent.test.ts src/features/products/resolve-products.test.ts src/features/drafts/repository.test.ts src/features/silpo/demo/demo-gateway.test.ts` must pass before implementation begins. This proves prerequisite behavior only; it proves nothing about Task 13.

## 3. Approved scope resolution

The backlog grants three implementation files and two test files. Three behaviors have no home in that list. The following additions were proposed and approved on 2026-09-08 before code work.

| Paths | Purpose |
|---|---|
| `src/features/drafts/assemble.ts`, `.test.ts` | Pure assembly of `DraftProposal` + `ResolvedNeed[]` into a `Draft`: field mapping, alternative ordering, total. Kept out of the orchestrator the way `fallback.ts` is kept out of `draft-agent.ts`. |
| `src/features/drafts/demo-user.ts`, `.test.ts` | The synthetic demo identity and its idempotent upsert, so no route file imports `@/db/*` directly. |
| `src/app/api/drafts/handlers.ts` | Injectable handler factory; `route.ts` wires production dependencies only. Mirrors `src/app/api/auth/silpo/handlers.ts`. |
| `src/features/silpo/gateway.test.ts` | Mode dispatch, the lazy write session, `close()` semantics and the live-never-falls-back-to-demo guarantee. |
| `docs/tasks.md`, `docs/project-architecture.md` | Record the envelope, the identity decision and this ownership in their owning documents. |

No edit to `src/features/shared/contracts.ts`, `src/lib/env.ts`, `src/lib/result.ts`, `src/db/schema.ts`, `drizzle/*`, `src/features/agent/*`, `src/features/prediction/*`, `src/features/products/*`, `src/features/purchases/*`, `src/features/drafts/repository.ts`, `src/features/silpo/live/*`, `src/features/silpo/oauth/*`, `src/features/silpo/demo/*`, `src/components/*`, `vitest.config.ts`, `fixtures/demo/silpo-snapshot.json` or `SILPO_MCP.md` is required or permitted.

## 4. Approved deviations from the backlog

**D1 — the service returns a run envelope and takes an options object.** The backlog's interface line reads `createDraftForUser(userId, mode): Promise<Draft>`. The run already holds the verified `CartContext` and the loyalty figure that `DraftDashboardProps` requires, and `generateDraft` already returns provenance that Task 17's model-fallback-rate metric needs; none of it is recoverable from a bare `Draft`. `createDraftForUser` therefore takes `({ userId, mode, correlationId }, deps)` and returns `Result<DraftRun, DraftFailure>`. This strengthens compliance rather than weakening it, and it spares Tasks 14–15 a second round of MCP calls for data this run already paid for.

**D2 — `createSilpoGateway` returns a disposable handle, not a bare gateway.** The backlog's step 3 says the factory "returns either the demo implementation or a composition of live history, cart-context, and catalog gateways". A live composition owns MCP sessions that must be closed, and `SilpoGateway` declares no disposal method. Adding one would edit Task 2's contracts file, which this task does not own. The factory therefore returns `SilpoGatewayHandle = { gateway: SilpoGateway; close(): Promise<void> }`. The gateway inside is exactly the `SilpoGateway` the backlog describes.

**D3 — demo mode persists under a synthetic user.** The backlog's step 4 requires the run to persist mode alongside `algorithmVersion` and `trainingCutoff`, and `drafts.user_id` is a foreign key to `users`. Demo mode has no OAuth session and therefore no user. A synthetic user row, ensured idempotently on each demo run, keeps one persistence path for both modes and leaves Tasks 15–16 with nothing to special-case. `DATABASE_URL` is already mandatory in `getServerEnv`, so demo mode already requires a database and this adds no new operational burden. Amended on 2026-09-09: the identity is per visitor rather than a single shared constant — see T13-03 for why.

**D4 — the ordered-call assertion is stated as a prefix plus a prohibition.** The backlog's step 1 asks for ordered calls `listTools → cart context → history → normalize → infer → resolve → Gemini → save`. Agent architecture section 5 places `loadCustomerContext()` third, and `resolveProducts` issues its own `findProducts`, `getProductDetails`, `getSimilarProducts` and `getReplacements` calls that a recording gateway also observes. Asserting one exact sequence would therefore pin the resolver's internal call pattern to this task's test. The test instead asserts that the recorded sequence *begins* with `listTools, loadCartContext, loadCustomerContext, loadPurchaseHistory`, that `findProducts` follows them, and that `getPromotions`, `updateCartContext`, `setAbsoluteCartQuantities` and `readCart` never appear at all. The prohibition is the stronger half and the backlog's list does not contain it.

## 5. Approach and trade-offs

**A linear service function with injected dependencies.** `createDraftForUser` runs the eleven steps in one body and returns a typed `Result`. This is the shape `loadDemoBacktest` already has, so the repository gains no new idiom, every step keeps its own precise types, and the call order is asserted by a recording fake rather than enforced by a framework. A staged pipeline was considered: it would make the order structural and hand Task 17 a free stage trace, but it costs a shared mutable context that loosens every stage's types, and Task 17's trace belongs on the gateway — a `SilpoGateway` decorator produces the same data without the abstraction. Splitting into a pure planner and an IO shell was also considered and does not pay: `resolveProducts` and `generateDraft` are both async IO, so the extractable pure part is `normalize + infer`, which is already pure and already lives in its own modules.

**A lazy write session rather than an eager one or none.** The draft run is read-only in every case except one: a guest with no cart at all needs `silpo_create_shopping_cart`. Opening a write session eagerly would spend a round trip and a live token use on every run for a branch almost none of them take. Omitting it would turn a first-time guest's draft into an error. A proxy `McpSession` that opens the real write session on first `callTool` gives both: an ordinary run opens one session, a bootstrap run opens two, and `close()` closes only what exists. The proxy is roughly twenty-five lines and its laziness is directly testable — "no write session is opened for a run whose cart already exists" is one assertion.

**Assembly as a pure function in its own module.** `validateProposal` already normalized quantity, ordering and alternatives, so assembly is a field mapping over data that is proven consistent. Putting it in `service.ts` would mean the only place `DraftSchema` is constructed sits inside an async function full of IO, and testing a total-rounding edge would require standing up a whole fake gateway. As its own pure function it takes three arguments and its test is a table.

**Identity resolved at the composition root, never in the service.** `handlers.ts` decides who the user is — cookie session in live mode, ensured synthetic row in demo mode — and hands `service.ts` a `userId` it does not question. The service therefore has no mode-dependent identity branch, and the rule that a client can never choose its own `userId` or `mode` is enforced in exactly one file.

**Status mapping at the transport boundary.** The service returns `AppError` and, for `needs_slot`, the available slots; `handlers.ts` maps `error.code` to an HTTP status through one table. `OAuthFailure` carries its own `status` field, which is the older precedent, but project architecture section 5 puts transport mapping in the Route Handler and this task follows the document rather than the wart.

## 6. Global constraints

- Use `pnpm` exclusively. Task 13 adds no production dependency, no migration and no environment variable.
- `src/features/drafts/service.ts` and `assemble.ts` import no React, no Next.js, no AI SDK and no `src/db/*` or `src/components/*` symbol. In particular `service.ts` must not import `@/features/agent/google-model`: generation arrives as an injected function, so the AI SDK never enters the service's module graph. A test asserts this.
- `service.ts` *does* import the typed error classes from `@/features/silpo/live/*` and `@/features/silpo/schemas/common`, which transitively loads the MCP SDK. This is deliberate. Classifying a failure by `instanceof` is the repository's established boundary idiom, and the alternative — matching on `error.name` strings — would turn a compile-time guarantee into a silent one. The purity rule in `AGENTS.md` names `src/features/purchases` and `src/features/prediction`; `src/features/drafts` is an application-service layer whose `repository.ts` already imports Drizzle and `@/db`. Only the AI SDK constraint above is absolute here.
- `assemble.ts` stays pure: contracts, `PREDICTION_ALGORITHM_VERSION`, and the `DraftProposal` type only.
- `src/features/silpo/gateway.ts` imports no React, no Next.js and no `src/db/*` symbol.
- No client input reaches the run. `POST /api/drafts` reads no request body and no query parameter; `mode` comes from `env.DATA_MODE` and `userId` from the server-side session or the demo constant.
- Live mode never returns the demo gateway and never silently substitutes demo data. A live composition failure is a typed error.
- The draft run performs no cart write beyond the documented cart bootstrap, records no approval, and never calls `setAbsoluteCartQuantities`.
- Secrets never leave the server: `GOOGLE_GENERATIVE_AI_API_KEY`, `TOKEN_ENCRYPTION_KEY`, `DATABASE_URL`, MCP tokens and the session handle never appear in a response body, an error message, a log line or a test.
- Raw MCP payloads, raw prompts and raw model output are never logged and never persisted.
- The run is deterministic given an injected clock, an injected id generator and a deterministic model.
- Finish implementation in one focused commit: `feat: orchestrate personal drafts`.

## 7. Requirements

### T13-01 — Gateway composition

`src/features/silpo/gateway.ts` exports:

```ts
export interface SilpoGatewayHandle {
  gateway: SilpoGateway;
  close(): Promise<void>;
}

/** Every seam the test replaces. Each field defaults to the real thing. */
export interface SilpoGatewayDeps {
  createProvider: (userId: string, options: { publicBaseUrl: string }) => Promise<SilpoOAuthProvider>;
  openReadSession: (options: OpenSessionOptions) => Promise<McpSession>;
  openWriteSession: (options: OpenSessionOptions) => Promise<McpSession>;
  createDemoGateway: () => SilpoGateway;
  now: () => Date;
}

export interface CreateSilpoGatewayOptions {
  mode: DataMode;
  userId: string;
  publicBaseUrl: string;
  /** Production defaults; the test injects fakes. */
  deps?: Partial<SilpoGatewayDeps>;
}

export function createSilpoGateway(
  options: CreateSilpoGatewayOptions,
): Promise<SilpoGatewayHandle>;
```

`mode: "demo"` returns `createDemoSilpoGateway()` with a no-op `close()`; `userId` and `publicBaseUrl` are unused on that branch and no session is opened.

`mode: "live"` builds an OAuth provider with `createSilpoOAuthProvider(userId, { publicBaseUrl })`, opens one read session, and composes `createLiveHistoryGateway`, `createLiveCartContextGateway` and `createLiveCatalogGateway` into one object satisfying `SilpoGateway`. The mode is fixed at creation and is never changed afterwards.

The composed `listTools()` returns `[...readSession.advertisedTools]` sorted, which is a cached read of the `tools/list` the session already performed during `connect`. An empty advertised set is a failed handshake, not a valid surface: `listTools()` returns the empty array and the service rejects it under T13-07.

`setAbsoluteCartQuantities` and `readCart` have no gateway of their own until Task 16. They are present on the composition — the interface requires them — and each throws a `NotImplementedForDraftRunError` naming Task 16. The draft run never reaches them, and a test proves the run never calls them, so a throw here can only be a genuine misuse.

### T13-02 — The lazy write session

`createLiveCartContextGateway` takes a `writeSession` at construction, so the composition supplies a proxy:

```ts
function createLazyWriteSession(open: () => Promise<McpSession>, read: McpSession): McpSession
```

The proxy delegates `callTool` to a real write session that it opens on first call and memoizes. `retryEnabled` is the literal `false` that `openWriteSession` always sets, so no session is needed to answer it. `advertisedTools` returns the read session's set: both sessions target the same server URL under the same identity and each performs its own `tools/list`, so the surfaces are identical, and the real write session re-checks the name itself inside `callTool`. `close()` on the handle closes the write session only if it was ever opened.

Consequences that the test pins:

- a run whose cart already exists opens exactly one session;
- a run that bootstraps a cart opens two, and `close()` closes both;
- a concurrent second `callTool` during the first open awaits the same promise rather than opening a second session;
- if the write session fails to open, the error propagates from `callTool` and is mapped by T13-09 like any other MCP failure.

### T13-03 — Demo identity

Amended on 2026-09-09 after review. The original design used one fixed `DEMO_USER_ID` shared by every demo visitor. `DraftRepository.get` scopes by `userId`, so a single shared id made that ownership check meaningless: any demo visitor would load any other's draft from Task 15 onward, and anonymous traffic accumulated rows under one identity with nothing distinguishing them. The persistence decision in D3 stands; only the identity stops being a constant.

`src/features/drafts/demo-user.ts` exports:

```ts
export const DEMO_SESSION_COOKIE = "demo_session";
export const DEMO_SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;
export function createDemoHandle(): string;
export function isDemoHandle(value: string | null | undefined): value is string;
export function demoUserIdFor(handle: string): string;
export async function ensureDemoUser(db: DbClient, cookieValue: string | null): Promise<DemoIdentity>;
```

A handle is 32 random bytes, base64url — the same shape as the OAuth session handle. `ensureDemoUser` accepts the incoming cookie, replaces anything that fails `isDemoHandle` with a freshly minted handle rather than trusting it, derives the user id, inserts `users` with `onConflictDoNothing()` and reports whether it issued a handle.

`demoUserIdFor` is SHA-256 of `silpo-demo:<handle>` truncated to sixteen bytes with the RFC 4122 version and variant bits set. The database key is therefore derived from the handle rather than being the handle, so a client-chosen value never reaches `users.id` and an oversized or malformed cookie cannot shape a row.

`handlers.ts` sets the cookie — `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` in production — on whatever the request returns, success or failure, so a visitor whose run failed is not handed a new identity, and a new `users` row, on every retry. It is only ever called on the demo branch; the service receives a resolved `userId` and cannot tell the two modes apart by identity.

Demo drafts persist through the same `createPostgresDraftRepository`, carry `mode: "demo"`, and are therefore labeled everywhere a draft's mode is read. Every identity here is synthetic and never derived from a real Silpo guest.

### T13-04 — Run ordering and the read-only guarantee

`src/features/drafts/service.ts` exports:

```ts
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

export async function createDraftForUser(
  input: { userId: string; mode: DataMode; correlationId: string },
  deps: CreateDraftDeps,
): Promise<Result<DraftRun, DraftFailure>>;
```

The run, in order:

1. `openGateway({ mode, userId })`.
2. `gateway.listTools()`.
3. `gateway.loadCartContext()` — `needs_slot` stops the run here and the model is never called.
4. `gateway.loadCustomerContext()`.
5. `gateway.loadPurchaseHistory(context)`.
6. `normalizePurchases(receipts, activeCity, runStartedAt)`.
7. `inferNeeds({ receipts: normalized, now: runStartedAt, activeCity })`.
8. `resolveProducts(needs, context, customerContext, gateway)`.
9. `deps.generateDraft({ mode, resolvedNeeds, customerContext })`.
10. `assembleDraft(...)` — see T13-06.
11. `repository.save(userId, draft)`.

`close()` runs in a `finally` and never masks the run's own outcome: a failure to close is swallowed, exactly as `/api/cart/context` already does.

`service.test.ts` drives the run through a recording gateway and asserts that the recorded method sequence begins with `listTools, loadCartContext, loadCustomerContext, loadPurchaseHistory`, that `findProducts` appears after them, and that `getPromotions`, `updateCartContext`, `setAbsoluteCartQuantities` and `readCart` never appear. Discounts come from the product's own fields, as agent architecture section 5 step 7 requires, so `getPromotions` is not merely unused — calling it would be a defect.

### T13-05 — Active city resolution

`CartContext.city` is nullable. The run resolves an active city once, before normalization:

1. `context.city`, when it is non-null;
2. otherwise the `city` of the most recent raw receipt that has one, by `purchasedAt` descending, ties broken by `sourceId` ascending so the rule is total;
3. otherwise the sentinel `"__unknown__"`, which matches no receipt, so every receipt takes the `0.35` other-city weight and the engine abstains more rather than assuming.

The rule is deterministic and has its own test at each of the three branches. It changes only the city weighting; it never invents a city on a receipt, a product or a draft, and the resolved value is not persisted or shown.

### T13-06 — Draft assembly

`src/features/drafts/assemble.ts` exports one pure function:

```ts
export function assembleDraft(input: {
  id: string;
  mode: DataMode;
  trainingCutoff: string;
  proposal: DraftProposal;
  resolvedNeeds: ResolvedNeed[];
}): Draft;
```

Each proposal item is matched to its `ResolvedNeed` by `selected.productId` and mapped field by field:

- `productId`, `externalProductId`, `quantity`, `reason` from the proposal item;
- `name`, `imageUrl`, `displayRatio`, `price`, `specialPrice`, `stock`, `step`, `nutritionStatus`, `promotions` from `resolved.selected`;
- `confidence`, `confidenceBand`, `reasonCodes` from `resolved.need`;
- `alternatives`: the `ProductCandidate` objects of `resolved.alternatives`, ordered by the proposal's `alternativeIds` so the model's surviving ranking is preserved.

`algorithmVersion` is `PREDICTION_ALGORITHM_VERSION`, `status` is `"ready"`, `version` is `1`, and `summary` is the proposal's summary. `total` is `sum(quantity × (specialPrice ?? price))` rounded to two decimals, computed from the snapshots just written so `DraftSchema`'s `0.01` tolerance holds by construction.

The function returns `DraftSchema.parse(...)`. Nothing is spread from a proposal item or a candidate, so a field added to either is excluded by default.

Zero resolved needs is a valid outcome, not a failure: `buildFallbackProposal` supplies the summary «Поки що замало історії покупок, щоб зібрати чернетку.», assembly produces `items: []` and `total: 0`, and the draft is saved with status `ready`. This is the "abstain or empty explained draft" row of agent architecture section 12.

A proposal item whose `productId` is absent from `resolvedNeeds` is unreachable — `validateProposal` rejects it and the fallback builds only from `resolvedNeeds` — so assembly throws rather than skipping it. Silently dropping an item would turn an upstream contract break into a shorter shopping list.

### T13-07 — Typed failures

Every failure the run can produce maps to one `AppErrorCode` and a Ukrainian message safe to render. Provider text, URLs, headers, stack traces and payload fragments never reach the returned `AppError`.

| Condition | Code | `availableSlots` |
|---|---|---|
| `loadCartContext()` returns `needs_slot` | `needs_slot` | the returned slots |
| `NoSavedAddressError` | `cart_validation_error` | `null` |
| `DeliveryTypeUnavailableError` | `cart_validation_error` | `null` |
| `SlotUnavailableError`, `SlotVerificationError` | `needs_slot` | `[]` |

`SlotUnavailableError` and `SlotVerificationError` are raised only by `updateCartContext`, which this run never calls; they are mapped defensively so that a future caller cannot turn a slot problem into an opaque `500`, and the table stays a total function over the error types the composed gateway can throw.
| `McpCallError` with status `401` | `unauthorized` | `null` |
| `McpCallError` with status `429` | `rate_limited` | `null`, `retryAfterMs` from the header |
| `InvalidExternalDataError`, `UnadvertisedToolError`, empty `listTools()` | `invalid_external_data` | `null` |
| a `ZodError` from a contract parse | `invalid_external_data` | `null` |
| anything else, including a repository failure | `unexpected` | `null` |

`model_invalid_output` never occurs: `generateDraftWithModel` does not reject for a model or provider fault, so a Gemini outage costs the guest the model's wording and nothing else. A test drives an always-throwing model and asserts the run still returns `ok` with `generation.source === "fallback"`.

Every returned `AppError` carries the run's `correlationId`.

### T13-08 — The route

`src/app/api/drafts/handlers.ts` exports `createDraftsPostHandler(deps)`; `src/app/api/drafts/route.ts` exports `const POST = createDraftsPostHandler()` plus `dynamic = "force-dynamic"` and `runtime = "nodejs"`.

Every dependency the handler reaches for is a field on `deps` with a production default, because `tests/integration/draft-route.test.ts` runs without a database, without a network and without an API key:

```ts
export interface DraftsHandlerDeps {
  getEnv: () => ServerEnv;
  resolveSession: (handle: string | null) => Promise<Result<{ userId: string }, AppError>>;
  resolveDemoUserId: () => Promise<string>;
  repository: () => DraftRepository;
  openGateway: CreateDraftDeps["openGateway"];
  generateDraft: CreateDraftDeps["generateDraft"];
}
```

`resolveDemoUserId` defaults to `() => ensureDemoUser(getDbClient())` and `repository` to `() => createPostgresDraftRepository(getDbClient())`, so the database client is constructed at call time rather than at module load and the route file never imports `@/db/schema`.

The handler:

1. generates a `correlationId`;
2. reads `env.DATA_MODE`;
3. resolves identity — demo: `ensureDemoUser(db)`; live: `resolveSilpoSession(cookies.silpo_session)`, and a failure is `401` before any session is opened;
4. calls `createDraftForUser`, wiring `openGateway` to `createSilpoGateway` and `generateDraft` to `google-model`'s `generateDraft` with `env.GOOGLE_GENERATIVE_AI_API_KEY` and `env.AGENT_MODEL`;
5. on success returns `200` with `{ mode, draft, cartContext, loyaltyBonusAvailable }`;
6. on failure returns the mapped status with `{ error }`, plus `availableSlots` when the code is `needs_slot`.

`generation` is not on the wire. Nothing in `design-system.md` renders it, and shipping a field on speculation is how a contract acquires dead weight; it stays in the service's return type for Task 17.

Response headers are `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, matching `/api/cart/context`.

The handler reads no request body and no query parameter. A client cannot choose `mode`, `userId`, `algorithmVersion` or `trainingCutoff`. A test posts a body attempting to set `mode: "demo"` against a live environment and asserts the run is live.

### T13-09 — Status mapping

One table in `handlers.ts`, the only place an HTTP status is decided:

| Code | Status |
|---|---|
| `needs_slot` | `409`, with `availableSlots` |
| `cart_validation_error` | `409` |
| `unauthorized` | `401` |
| `rate_limited` | `429`, with `retryAfterMs` |
| `invalid_external_data` | `502` |
| `unexpected` | `500` |

### T13-10 — Timeouts and the run budget

The read and write sessions for a draft run are opened with `operationTimeoutMs: DRAFT_MCP_OPERATION_TIMEOUT_MS = 60_000`, declared in `gateway.ts`. The `30_000` default was sized for one cart-context operation; a draft run makes dozens of calls through a single session whose deadline starts at open, so keeping the default would abort long runs by accident rather than by policy.

Generation keeps `google-model.ts`'s own `30_000` bound. No third clock is introduced: an overall run timer would duplicate two deadlines that already exist and would report a less specific failure than either.

`route.ts` declares `export const maxDuration = 90`, the sum of the two budgets. It has no effect locally and is read only by a serverless deployment; without it a platform default could cut a run below its own timeouts.

### T13-11 — Observability boundary

The service accepts a `correlationId` and puts it on every returned `AppError`. It logs no raw MCP payload, no prompt, no model output, no token, no session handle and no personal field. Structured tracing and metric aggregation belong to Task 17 and are not started here; the `generation` envelope exists so Task 17 can compute a model-fallback rate without changing this signature.

### T13-12 — Test evidence

| Suite | Proves |
|---|---|
| `src/features/silpo/gateway.test.ts` | demo dispatch opens no session; live dispatch never returns the demo gateway; `listTools()` reflects the advertised set; one session for an existing cart, two for a bootstrap; `close()` closes what was opened and tolerates a close failure; a concurrent first write shares one open |
| `src/features/drafts/assemble.test.ts` | field mapping from both sources; alternative ordering follows the proposal; total rounding at a two-decimal edge; the empty draft; an unknown `productId` throws |
| `src/features/drafts/demo-user.test.ts` | the constant is a valid UUID; the ensure is idempotent across repeated calls |
| `src/features/drafts/service.test.ts` | the ordered prefix and the write prohibition; `needs_slot` stops before the model; the model never fires for zero resolved needs; a throwing model still yields a saved draft with `source: "fallback"`; persisted `algorithmVersion`, `trainingCutoff`, `mode`, reason codes and price snapshot; each of the three active-city branches; the failure table; `close()` runs on both the success and the failure path; `service.ts` imports no AI SDK specifier |
| `tests/integration/draft-route.test.ts` | `200` shape in both modes; demo response carries `mode: "demo"`; `401` without a session in live mode, asserted before any session opens; `409` with `availableSlots`; `429` with `retryAfterMs`; `502` for invalid external data; a request body cannot change mode; `no-store` and `no-referrer` headers |

Focused command: `pnpm vitest run src/features/drafts/service.test.ts src/features/drafts/assemble.test.ts src/features/drafts/demo-user.test.ts src/features/silpo/gateway.test.ts tests/integration/draft-route.test.ts`.

Cumulative gates before handoff: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`.

No test calls Google, opens a network socket, or requires a database. `demo-user.test.ts` drives a fake `DbClient` recording the insert.

## 8. Acceptance matrix

| ID | Acceptance boundary | Evidence |
|---|---|---|
| T13-01 | `createSilpoGateway` dispatches on mode and never crosses it | `gateway.test.ts` |
| T13-02 | An ordinary run opens one session; a bootstrap opens two; `close()` matches | `gateway.test.ts` |
| T13-03 | Demo persists under a per-visitor synthetic user, idempotently | `demo-user.test.ts`, `draft-route.test.ts` |
| T13-04 | Documented order holds and no cart write occurs | `service.test.ts` |
| T13-05 | Active city resolves through three deterministic branches | `service.test.ts` |
| T13-06 | Assembly produces a `DraftSchema`-valid draft, including the empty one | `assemble.test.ts` |
| T13-07 | Every failure returns a typed, safe `AppError` | `service.test.ts` |
| T13-08 | The route accepts no client input and labels mode | `draft-route.test.ts` |
| T13-09 | Status mapping is exhaustive | `draft-route.test.ts` |
| T13-10 | The session budget is raised deliberately, not by default | `gateway.test.ts` asserts the value passed to `openReadSession`; `maxDuration` is deployment-only and is confirmed in Task 18 |
| T13-11 | No secret or raw payload leaves the server | `service.test.ts`, `draft-route.test.ts` |
| T13-12 | Focused and cumulative gates pass | command output at handoff |

## 9. Risks

- **Live latency is unmeasured.** The live median target is 12 seconds and a draft run makes dozens of sequential MCP calls, deliberately not overlapped because one `McpSession` shares a single refresh budget and one `Retry-After` observation. Task 18 measures it. If the target is missed, the fix is a concurrency-safe session, not parallel calls over the current one.
- **No live Gemini call has ever run.** Task 12 recorded that no API key was available. `POST /api/drafts` in live mode is the first production path that would call Google, and until a key exists the fallback branch is the only one exercised end to end.
- **`maxDuration` is untested here.** It is a deployment directive with no local effect; Task 18's release readiness is where it is confirmed.

## 10. Completion and handoff

Task 13 is complete when the acceptance matrix is satisfied with fresh command output, `docs/tasks.md` records the run envelope and the demo-identity decision, `docs/project-architecture.md` records the `DraftService` return shape and the gateway handle, and the work lands in one commit titled `feat: orchestrate personal drafts`.

Handoff to Task 14: the dashboard consumes `POST /api/drafts` and renders `{ draft, cartContext, loyaltyBonusAvailable }`; a `409 needs_slot` response carries the slots its slot picker needs. Handoff to Task 15: a draft is saved at `version: 1` with status `ready`, and editing bumps the version through `repository.save` with `expectedVersion`. Handoff to Task 16: `createSilpoGateway` is the factory a commit reuses, and `setAbsoluteCartQuantities` and `readCart` are the two methods it must implement. Handoff to Task 17: `DraftRun.generation` carries the model-fallback signal, and a `SilpoGateway` decorator is the intended seam for a sanitized call trace.
