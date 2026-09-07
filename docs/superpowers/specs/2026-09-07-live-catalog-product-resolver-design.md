# Task 11 Live Catalog Gateway and Product Resolver Specification

Status: proposed on 2026-09-07. Documentation only; implementation has not started. The file-ownership expansion in section 3 requires controller or user approval before execution.

## 1. Scope and authority

Refines [Task 11](../../tasks.md#task-11-live-catalog-gateway-and-product-resolver) and is executed through the implementation plan that follows this document. [AGENTS.md](../../../AGENTS.md), the [product specification](../../product-spec.md), the [project architecture](../../project-architecture.md), the [agent architecture](../../agent-architecture.md), and the read-only [Silpo reference](../../../SILPO_MCP.md) retain precedence.

Build the read-only catalog surface over `https://mcp.silpo.ua/mcp` and the deterministic product resolver that turns `NeedCandidate[]` into `ResolvedNeed[]`: Zod parsers for the five catalog tools, a live catalog gateway that maps them to the existing shared contracts, a category query vocabulary, and the selection and ranking policy that hands Gemini only verified candidates.

Excluded: the Gemini draft agent and its prompt (Task 12), draft orchestration and persistence (Task 13), draft editing and approval (Task 15), cart writes and verification (Task 16), diagnostics traces (Task 17), any UI work, and any live smoke. Task 11 performs no cart write and opens no write session.

## 2. Baseline and dependencies

Inspected commit: `5faf2ddb8a7d3d2d21298a7e49ae5d5b6ab9bc53`. The existing `.gitignore` and `AGENTS.md` modifications in the working tree are user-owned and outside this work.

| Existing evidence | Design consequence |
|---|---|
| Tasks 1–10 are integrated; Task 11 is unchecked | Implement on those boundaries; do not recreate their output. |
| `ProductCandidate`, `ProductSearchResult`, `ProductDetails`, `Promotion`, `NutritionFacts` and `ResolvedNeed` already exist in `src/features/shared/contracts.ts` | The resolver's output types are fixed. No new domain type is introduced. |
| `SilpoGateway` declares `findProducts`, `getPromotions`, `getProductDetails`, `getSimilarProducts` — but no `getReplacements` | Task 11 step 3 requires mapping `silpo_get_replacements`. The port must grow one method; see section 3. |
| `ProductCandidate` has no `companyId` or `branchId` field | The backlog's selectability rule cannot be satisfied by carrying those IDs into the domain type. It is enforced at the mapping boundary instead; see L11-02. |
| `NeedCandidate` carries `categoryKey` (English slug) and `preferredExternalProductIds` (numeric `lagerId`s), and no product name | The resolver has no Silpo-searchable text unless one is supplied. A category query vocabulary is required; see L11-04. |
| `openReadSession` in `live/session.ts` provides `tools/list` gating, `callTool(name, args, schema)`, bounded `429` retry and one-attempt `401` refresh | Task 11 consumes it unchanged and adds no transport, no retry policy and no session variant. |
| `parseToolResult` and `InvalidExternalDataError` in `schemas/common.ts` own the `structuredContent` envelope | Catalog schemas plug into that helper; the external boundary keeps exactly one parser. |
| `isServiceItem` in `features/purchases/categorize.ts` already encodes the bag, delivery, acceleration and service-fee patterns | Plastic-bag exclusion reuses it. A second pattern list would be a parallel abstraction. |
| `createDemoSilpoGateway()` implements every current `SilpoGateway` method from `fixtures/demo/silpo-snapshot.json` | Adding a port method obliges a demo implementation in the same commit, or live and demo stop being interchangeable. |
| The demo snapshot's `productSearchResults` are keyed by the Ukrainian queries `вода`, `молоко`, `вівсяні пластівці`, `яйця`, and contain no article-number key | The category vocabulary's values for `water`, `dairy`, `grains` and `eggs` are pinned by the fixture. Exact-article search returns nothing in demo mode and must not be the only path to a candidate. |
| Draft items are capped at ten by `DraftSchema`; `silpo_find_products_batch` searches up to 30 items | The run budget is ten needs × three queries = 30, exactly the documented batch maximum. |
| `tests/contract/` exists and runs in the ordinary `pnpm test` sweep | No `vitest.config.ts` change. |

Planning prerequisite evidence: `pnpm vitest run src/features/silpo/live/session.test.ts src/features/silpo/demo/demo-gateway.test.ts src/features/shared/contracts.test.ts` — **3 files, 35 tests passed** on 2026-09-07. This proves prerequisite behavior only; it proves nothing about Task 11.

## 3. Proposed scope resolution

The backlog grants three implementation files and two test files. Two required behaviors have no home in that list.

Propose adding the following to Task 11's approved ownership before code work:

| Paths | Purpose |
|---|---|
| `src/features/shared/contracts.ts` | Add `getReplacements(context, slug): Promise<ProductCandidate[]>` to `SilpoGateway`. One method, no type change. |
| `src/features/silpo/demo/demo-gateway.ts`, `.test.ts` | Implement `getReplacements` from the existing `similarProducts` fixture entries filtered to selectable products, and cover it. No fixture change. |
| `src/features/products/category-queries.ts`, `.test.ts` | The `categoryKey → Ukrainian query` vocabulary and the tests that pin it to `categorize.ts` and to the demo fixture. |
| `src/features/products/dietary.ts`, `.test.ts` | The `restrictionKey → exclusion pattern` vocabulary, kept out of the resolver so each file holds one responsibility. |
| `docs/tasks.md`, `docs/agent-architecture.md` | Record the approved ownership and the resolved ranking, budget and enrichment policy in their owning documents. |

No edit to `src/features/silpo/live/session.ts`, `src/features/silpo/oauth/*`, `src/features/purchases/*`, `src/features/prediction/*`, `src/lib/env.ts`, `src/db/schema.ts`, `vitest.config.ts`, `package.json`, `fixtures/demo/silpo-snapshot.json` or `SILPO_MCP.md` is required. Task 12 and Task 13 consume `resolveProducts` and the enlarged port, so review that handoff before approving the expansion.

This is a concrete proposal, not permission to edit those files. Approval must be recorded in the backlog before implementation.

## 4. Approach and trade-offs

**Thin adapter, pure policy.** `live/catalog.ts` maps external shapes to contracts and nothing else; `products/resolve-products.ts` holds every selection and ranking decision and imports no MCP type, no external schema and no session type. It depends on a narrow structural port satisfied by both the live and demo gateways.

Alternatives considered:

- A gateway that searches *and* ranks would put catalog ranking inside an infrastructure adapter, which architecture §2 forbids, and would make the policy untestable without an MCP fake.
- A single resolver module calling `callTool` directly would invert the dependency direction and could not run in demo mode at all.

**`getReplacements` joins the port rather than becoming optional.** An optional method on a narrow resolver-local port would avoid touching Task 2 and Task 3 files, but live and demo would then differ in capability behind one port — a prose invariant where a structural one is available, and a resolver branch that is permanently dead in demo mode. Dropping `silpo_get_replacements` entirely was rejected because the backlog names it and because it is Silpo's purpose-built substitute list for unavailable items, which is precisely the fallback case.

**A static category vocabulary rather than a contract change.** Extending `NeedCandidate` with a representative history name would search in the user's own vocabulary and need no second table, but it edits `contracts.ts` *and* `features/prediction`, and it strips the demo fixture of every matching query until Task 3's fixture is rewritten. Resolving purely from `preferredExternalProductIds` needs no vocabulary at all, but the demo fixture has no article-keyed search result, so demo mode would resolve zero products. The static map keeps demo resolving today and is pinned by tests in both directions.

**Dietary compatibility as a filter, not a ranking key.** The agent architecture lists it first in the ranking chain. Making it a hard exclusion is strictly stronger: a product that violates a declared restriction is never offered, not merely ranked last. The cost is that an over-broad restriction pattern can empty a pool; the need is then dropped rather than resolved with a violation.

**Enrichment for the selected product only.** Fetching details for alternatives too would give every swap target real nutrition data instead of «даних недостатньо», but it triples the enrichment round trips and puts the median-≤12-second live draft budget at risk on a cold cart. Skipping details altogether drops a tool the backlog names and would leave the draft with no nutrition facts anywhere, weakening Task 12's input contract.

## 5. Global constraints

- Use `pnpm` exclusively. Task 11 adds no production or development dependency.
- Do not edit `SILPO_MCP.md`, `fixtures/demo/silpo-snapshot.json`, or any Task 9 or Task 10 module.
- Task 11 is read-only: it uses `openReadSession` only, performs no cart write, and opens no write session.
- Every catalog call goes through `McpSession.callTool`, so `tools/list` gating, the bounded `429` ladder and the single `401` refresh are inherited unchanged. Task 11 defines no retry policy of its own.
- Runtime-validate every MCP response before use; never proceed on a guessed shape.
- Never invent or derive a price, stock level, promotion, package step, product ID or nutrition value.
- Bags, delivery fees, acceleration fees and other service rows are never recommended.
- Live and demo return the same domain types through the same port; live never silently falls back to demo.
- The resolver is a pure module: no React, Next.js, MCP SDK, AI SDK or database import.
- Resolver output is deterministic — the same inputs produce the same `ResolvedNeed[]` in the same order.
- Finish implementation in one focused commit: `feat: resolve live product candidates`.

## 6. Requirements

### L11-01 — Catalog schema boundary

`schemas/catalog.ts` parses `silpo_find_products_batch`, `silpo_get_promotions`, `silpo_get_product_details`, `silpo_get_similar_products` and `silpo_get_replacements` through the existing `parseToolResult` helper.

Schemas are **not** `.strict()`, for the same reason as Task 10's cart and history schemas: Zod strips unknown keys, so a field Silpo adds is additive rather than an outage. Required fields stay validated — a missing or wrongly typed one raises `InvalidExternalDataError` and the flow stops.

The raw product schema parses `companyId` and `branchId` as nullable identifiers so the boundary can act on their absence, and parses nutrition as an optional block of independently nullable numbers. Field names follow `SILPO_MCP.md` and must be reconciled against a live `tools/list` once credentials exist.

### L11-02 — Live catalog gateway

`createLiveCatalogGateway({ readSession })` exposes `findProducts(context, queries)`, `getPromotions(context)`, `getProductDetails(context, slug)`, `getSimilarProducts(context, slug)` and `getReplacements(context, slug)`. Every method requires a verified `CartContext` and passes the cart's `branchId` to the cart-scoped tools.

Mappers construct contract objects field by field. No raw payload is spread into a returned object.

A product is **dropped at the mapping boundary** when it cannot be represented as a valid `ProductCandidate`: its payload lacks `companyId` or `branchId`, or the mapped object fails `ProductCandidateSchema` (a special price above the list price, for example). A product missing those IDs could never be committed by Task 16, and `ProductCandidate` has nowhere to carry them, so absence is enforced here rather than travelling into the domain as an unusable candidate. Dropping rather than throwing keeps one malformed row from failing an entire search; a malformed *envelope* still raises `InvalidExternalDataError` under L11-01.

`getProductDetails` is the exception: it returns a single required object, so an unrepresentable product there raises `InvalidExternalDataError`. It is only ever called for a product that already passed this rule, so the case is genuinely anomalous — and L11-08 makes a details failure non-fatal anyway.

Everything else is mapped faithfully, `available` and `stock` included. The gateway does not filter on availability, stock, service rows or dietary restrictions: those are domain policy and belong to the resolver, so that live and demo receive identical treatment from one implementation.

`nutritionStatus` is `"known"` only when the payload carries a nutrition block with at least one finite value; otherwise it is `"insufficient"` with `null` nutrition. No value is ever derived from a partial block.

### L11-03 — Replacements on the shared port

`SilpoGateway` gains `getReplacements(context: CartContext, slug: string): Promise<ProductCandidate[]>`.

`createDemoSilpoGateway()` implements it from the snapshot's existing `similarProducts` entries for that slug, filtered to products with `available === true` and `stock > 0`, since replacements are by definition offered in place of something unavailable. An unknown slug returns an empty array, matching the existing `getSimilarProducts` behavior. The fixture file is not modified.

### L11-04 — Category query vocabulary

`products/category-queries.ts` exports a frozen `categoryKey → Ukrainian query` map and a `queryForCategory(key)` accessor returning `string | null`.

Two tests pin it mechanically:

- every `categoryKey` produced by `categorizeItem` except `uncategorized` has exactly one query, so a category added to `categorize.ts` cannot silently lose its search path;
- the entries for `water`, `dairy`, `grains` and `eggs` equal the demo snapshot's `productSearchResults` queries exactly, so demo resolution cannot break through drift in either file.

The `grains` entry is `вівсяні пластівці` because the fixture pins it; the value is narrower than the category it serves. This is recorded as a known limitation for a later fixture broadening, not silently accepted.

### L11-05 — Candidate pool and filters

`resolveProducts(needs, context, customerContext, gateway)` takes `CustomerContext` as a fourth input. The backlog's interface line names `NeedCandidate[]` and a verified `CartContext`; the ranking policy in the agent architecture puts dietary compatibility first, which is unreachable without `restrictionKeys`. This is a refinement that strengthens compliance, not a weakening.

The resolver processes at most the first ten needs, matching `DraftSchema`'s ten-item cap, and issues one `findProducts` batch containing, per need, up to two article queries for the top two `preferredExternalProductIds` plus one category query — at most 30 queries, the documented batch maximum. An article query is the numeric `lagerId` rendered as a decimal string. Queries are deduplicated before the call and results are matched back to needs by query string, so two categories sharing a query cost one search rather than two.

Per need, the pool is the union of that need's article hits and category hits, filtered in order:

1. not a service row, by `isServiceItem` on the product name;
2. selectable — `available === true`, `stock > 0`, and `stock >= step`, so at least one whole package can be bought;
3. dietary-compatible against `customerContext.restrictionKeys`.

Dietary compatibility is a hard exclusion, not a ranking key, and lives in `products/dietary.ts` as a `restrictionKey → exclusion pattern` table. When it empties a pool, the need is dropped; an incompatible product is never offered. A restriction key absent from the table excludes nothing and is not an error — guessing a meaning would be worse than ignoring one — and the vocabulary joins the schema field names as something to reconcile against a live `silpo_get_my_food_restrictions` once credentials exist.

One fallback call per need, at most, when the filtered pool is empty or contains no familiar SKU:

- the familiar SKU was found but is not selectable → `getReplacements(context, itsSlug)`;
- the pool is empty and some hit supplied a slug → `getSimilarProducts(context, thatSlug)`.

Fallback results pass through the same three filters. A need with an empty pool after fallback is omitted from the output. The resolver never fabricates a product to fill a need.

### L11-06 — Ranking and selection

The reference point is the familiar SKU's effective price and `displayRatio` when the article search found it — available or not, because it expresses the habit rather than the current offer. Otherwise it is the pool's median effective price and median `displayRatio`, taking the lower of the two middle values for an even-sized pool so the reference is itself deterministic.

Effective price is `specialPrice ?? price`.

Surviving candidates sort by, in order:

1. within budget — `effectivePrice <= referencePrice`, true first;
2. active discount — `specialPrice !== null || promotions.length > 0`, true first;
3. package distance — `|displayRatio − referenceRatio|`, ascending;
4. effective price, ascending;
5. `productId`, ascending.

The final key makes equal-budget candidates order identically on every run; without it the output would depend on Silpo's response order.

Selection: a selectable preferred SKU wins outright, taken in `preferredExternalProductIds` order, which `features.ts` has already sorted by weighted observation count and recency. Otherwise the top-ranked pool entry is selected.

Alternatives are the next three ranked entries, excluding the selected product and deduplicated by `productId`; `ResolvedNeedSchema` rejects a duplicate ID. Output preserves the input need order, which prediction already sorted by confidence.

Every returned `ResolvedNeed` is parsed through `ResolvedNeedSchema` before it leaves the resolver.

### L11-07 — Nutrition enrichment

After selection, the resolver calls `getProductDetails(context, selected.slug)` once per resolved need — at most ten calls per run — and replaces the selected product's `nutritionStatus` and `nutrition` with the details result under the L11-02 rule.

Alternatives keep the nutrition status their search result carried. Nothing is ever derived for a missing nutrient; the UI labels an insufficient status «даних недостатньо».

### L11-08 — Error and degradation policy

A `findProducts` failure is fatal and propagates unchanged as `McpCallError`, `UnadvertisedToolError` or `InvalidExternalDataError` from Task 10's session. Task 11 introduces no new error type and no route, so the existing status mapping is untouched.

A `getProductDetails` failure of any kind is **non-fatal**: the selected product keeps its search-result nutrition status and the run continues. Losing a nutrition label must not cost the user an otherwise valid draft. A fallback `getReplacements` or `getSimilarProducts` failure is likewise non-fatal and leaves the pool as it was, which may drop the need.

An unadvertised tool is rejected by the session before any network call, so a Silpo surface that no longer advertises a catalog tool fails loudly rather than resolving against a guess.

### L11-09 — Purity and budget

`products/resolve-products.ts` and `products/category-queries.ts` import only shared contracts, `features/purchases/categorize.ts`, and Zod. No React, Next.js, MCP SDK, AI SDK or database import appears in either file, and neither imports `schemas/catalog.ts` or `live/catalog.ts`.

Per draft run the resolver issues at most one `findProducts` call with at most 30 queries, at most ten fallback calls, and at most ten `getProductDetails` calls.

The resolver does **not** call `getPromotions`. `Promotion` carries no product linkage, so a branch promotion cannot be attached to a candidate without inventing the association; the resolver's discount signal comes from each candidate's own `specialPrice` and `promotions` instead. `getPromotions` remains a gateway obligation because it is on the port and Task 12 and Task 13 consume it, and it is covered by the contract test rather than by a resolver call.

### L11-10 — Test evidence

`tests/contract/silpo-catalog.test.ts` drives the real gateway through an injected fake `callTool`: `tools/list` gating including rejection of an unadvertised catalog tool without a network call; the `find_products_batch` argument shape and `branchId` propagation; mapping for all five tools; a product missing `companyId` or `branchId` dropped; unknown extra fields tolerated; a missing required field raising `invalid_external_data`; nutrition present, partially present and absent.

`src/features/products/resolve-products.test.ts` drives the pure resolver through a fake gateway: exact numeric article search preferred; an unavailable exact SKU falling back to replacements; stock filtering; `stock < step` rejection; promotion and discount ordering; equal-budget deterministic sorting; missing nutrition reported as `insufficient` and never derived; plastic-bag exclusion; dietary filtering including the emptied-pool drop; a need with no candidate omitted; the 30-query cap and the ten-need cap; alternatives capped at three and unique; and a non-fatal details failure.

`src/features/products/category-queries.test.ts` holds the two pinning tests from L11-04.

## 7. Acceptance matrix

| ID | Required evidence | Primary test location |
|---|---|---|
| L11-01 | Unknown external fields tolerated; missing or mistyped required field is `invalid_external_data`; no guessed shape proceeds | `silpo-catalog.test.ts` |
| L11-02 | All five tools mapped field by field; product without company or branch ID dropped; availability and stock passed through unfiltered; nutrition status derived only from a present block | `silpo-catalog.test.ts` |
| L11-03 | `getReplacements` present on the port, implemented live and in demo, demo filtered to selectable products, fixture unchanged | `demo-gateway.test.ts`, `silpo-catalog.test.ts` |
| L11-04 | Every non-`uncategorized` category key has one query; the four fixture-pinned entries match the snapshot exactly | `category-queries.test.ts` |
| L11-05 | Article and category queries batched within 30; service rows, unselectable stock and restriction violations filtered; single bounded fallback; unresolvable need omitted | `resolve-products.test.ts` |
| L11-06 | Familiar selectable SKU wins; documented sort chain applied in order; equal-budget order stable across runs; alternatives capped, unique and schema-valid | `resolve-products.test.ts` |
| L11-07 | Details fetched once per resolved need; selected product's nutrition updated; alternatives untouched; nothing derived | `resolve-products.test.ts` |
| L11-08 | A search failure propagates unchanged; details and fallback failures degrade without losing the draft; unadvertised tool rejected before the network | `silpo-catalog.test.ts`, `resolve-products.test.ts` |
| L11-09 | Resolver imports stay pure; per-run call budget respected; no fabricated promotion-to-product linkage | `resolve-products.test.ts` |
| L11-10 | Focused suites pass from a clean invocation alongside `pnpm typecheck` | `pnpm vitest run tests/contract/silpo-catalog.test.ts src/features/products/resolve-products.test.ts src/features/products/category-queries.test.ts` |

## 8. Completion and handoff

The implementer must show red-to-green output for the contract and resolver suites, the unchanged Task 9 and Task 10 suites as regression evidence, and `pnpm test`, `pnpm typecheck`, `pnpm lint` and `pnpm build`. All automated tests use synthetic traffic and never real credentials.

**Known verification limits:**

- No Silpo credentials exist in this environment, so the read-only live smoke against `https://mcp.silpo.ua/mcp` cannot be run and the catalog field names in `schemas/catalog.ts` remain unreconciled against a live `tools/list`. This is carried forward from Tasks 9 and 10 and reported as an outstanding gap, not as a reason to weaken any test.
- The demo fixture has search results for four queries only, so `bread` and `coffee` needs resolve to nothing in demo mode and are dropped. Broadening the fixture belongs to whichever later task owns the demo scenario.

The handoff lists changed files, the exact commands and results, the remaining verification limits, and the commit hash. Task 11 stays unchecked in the backlog until implemented, reviewed and integrated.
