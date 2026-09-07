# Task 10 Live History and Cart-Context Gateway Specification

Status: proposed on 2026-09-07. Documentation only; implementation has not started. The file-ownership expansion in section 3 requires controller or user approval before execution.

## 1. Scope and authority

Refines [Task 10](../../tasks.md#task-10-live-history-and-cart-context-gateway) and is executed through the [implementation plan](../plans/2026-09-07-live-history-cart-context.md). [AGENTS.md](../../../AGENTS.md), the [product specification](../../product-spec.md), the [project architecture](../../project-architecture.md), and the read-only [Silpo reference](../../../SILPO_MCP.md) retain precedence.

Build the first authenticated business-tool surface over `https://mcp.silpo.ua/mcp`: an MCP session foundation, Zod parsers for the external boundary, a live cart-context gateway that bootstraps and verifies a cart with a valid time slot, a live history gateway that returns normalized purchase receipts and minimal customer context, and `POST /api/cart/context` for slot selection.

Excluded: catalog reads and product resolution (Task 11), the Gemini draft agent (Task 12), draft orchestration (Task 13), approval and cart product writes (Task 16), diagnostics traces (Task 17), any UI work, and any live write smoke. Task 10 writes to the cart only to establish delivery context — never cart products.

## 2. Baseline and dependencies

Inspected commit: `9f66aa587bfba46d0db143a0a37c6ace1cb78ea0`. The existing `.gitignore` modification is user-owned and outside this work.

| Existing evidence | Design consequence |
|---|---|
| Tasks 1–9 are integrated; Task 10 is unchecked | Implement on those boundaries; do not recreate their output. |
| `SilpoGateway`, `CartContextResult`, `UpdateCartContextInput`, `RawPurchaseReceipt`, `CustomerContext`, `TimeSlot` already exist in `src/features/shared/contracts.ts` | Task 10 implements against these unchanged. No shared-contract edit is required or permitted. |
| `OAuthConnection` in `transport.ts` exposes only `begin`, `finishAuth`, `probeTools`, `close` | No tool-call surface exists. Task 10 must add one. |
| The hardened `boundFetch` inside `transport.ts` is private and owns destination validation, manual redirect handling with credential stripping, the refresh budget, and deadlines | Re-implementing it inside `live/` would create a second way to do a standardized thing. It must be extracted and shared. |
| `boundFetch` retries any `429` whose path equals the MCP endpoint path (`isMcpReadOnly = currentUrl.pathname === serverUrl.pathname && !isTokenRequest`) | At the HTTP layer a read `tools/call` and a cart-write `tools/call` are both `POST /mcp`. That retry cannot distinguish them, so it would automatically retry a cart write. Retry discrimination must move to the tool-call layer. |
| `resolveSilpoSession(handle)` returns `{ userId, expiresAt }` for an authenticated cookie | The route and gateways obtain identity through this resolver; they never accept a caller-supplied user ID. |
| `createDemoSilpoGateway()` implements `loadCartContext` and `updateCartContext` | Demo mode drives the demo gateway through the same route, preserving live/demo parity and the demo label. |
| `tests/contract/` does not exist; `vitest.config.ts` excludes only e2e and the Postgres gate | Contract tests run in the ordinary `pnpm test` sweep with no config change. |
| Architecture §9 assigns the bearer-only write transport to Task 16 | Task 10 is the first task that performs a cart write, so it introduces that transport. The owning document is updated in the same commit. |

Planning prerequisite evidence: `pnpm vitest run src/features/silpo/oauth/transport.test.ts src/features/silpo/demo/demo-gateway.test.ts src/features/shared/contracts.test.ts` — **3 files, 41 tests passed** on 2026-09-07. This proves prerequisite behavior only; it proves nothing about Task 10.

## 3. Proposed scope resolution

The backlog grants seven implementation files plus two contract test files. An authenticated tool-call surface has no home in that list, and building one inside `live/history.ts` or `live/cart-context.ts` would hide transport and session-lifecycle responsibility inside a mapping module.

Propose adding the following to Task 10's approved ownership before code work:

| Paths | Purpose |
|---|---|
| `src/features/silpo/live/session.ts`, `.test.ts` | Read and write MCP session factories, tool-surface gating, `callTool` and lifecycle. |
| `src/features/silpo/oauth/transport.ts`, `.test.ts` | Extract the hardened fetch as an exported factory and route its `429` ladder through `live/retry.ts`. Behavior for the OAuth flow is preserved. |
| `docs/tasks.md`, `docs/project-architecture.md` | Record the approved ownership, the session module, and the read/write transport split in their owning documents. |

No edit to `src/features/shared/contracts.ts`, `src/lib/env.ts`, `src/db/schema.ts`, `vitest.config.ts`, `package.json`, or `SILPO_MCP.md` is required. Task 11 and Task 16 will consume `live/session.ts`, so review that handoff before approving the expansion.

This is a concrete proposal, not permission to edit those files. Approval must be recorded in the backlog before implementation.

## 4. Approach and trade-offs

**Extract the hardened fetch; build the session in `live/`.** `createHardenedFetch()` becomes an exported factory in `transport.ts`; `createSilpoOAuthConnection` calls it with today's settings so Task 9 behavior is unchanged. `live/session.ts` composes it with the official `Client` and `StreamableHTTPClientTransport`.

Alternatives considered:

- Adding `callTool` to `OAuthConnection` grows an already large Task 9 file and mixes one-shot authorization-flow concerns with steady-state business calls that have a different lifetime and a different retry policy.
- A self-contained session inside `live/` touches no Task 9 file but duplicates SSRF validation, redirect handling and deadlines. AGENTS.md prohibits a second way to do a standardized thing.
- A separate prerequisite refactor task has the cleanest ownership story but changes the backlog shape and delays Task 10 without changing the resulting code.

**Two sessions rather than one policy-driven session.** `openReadSession` carries one refresh attempt and bounded `429` retry; `openWriteSession` is bearer-only with no refresh and no retry code path at any layer. The write session does not decline to retry — it has nothing to invoke. A single session whose retry is gated by a read-only tool allowlist was rejected because the safety property would then depend on the allowlist staying correct as tools are added, which is a prose invariant rather than a structural one.

**Saved delivery addresses for the no-cart bootstrap.** `silpo_get_my_delivery_addresses` supplies the guest's own default address text to `silpo_find_address`. This needs no UI and no shared-contract change, and the address is used in flight and never persisted or logged. A `SelfPickup`-only bootstrap would touch no address data at all but would silently choose a store for the user. A third `needs_address` result variant would be the most honest product behavior but is a Task 2 shared-contract change plus later UI work, which is outside Task 10.

**Hybrid contract-test boundary.** Sequencing and mapping breadth run against an injected fake `callTool`; a small set of fetch-level fixtures drive the real MCP client to pin the actual `401`, `429`-exhaustion and malformed-response shapes. Session-layer fakes alone would prove the retry and refresh paths only against our own assumptions about error shape.

## 5. Global constraints

- Use `pnpm` exclusively. Task 10 adds no production or development dependency.
- Do not edit `src/features/shared/contracts.ts` or `SILPO_MCP.md`.
- Preserve every existing Task 9 behavior and its full test suite.
- Start every authenticated MCP session with `tools/list` before any business tool call.
- Retry read-only calls after `429` at most three times, using server-provided retry metadata when present and otherwise 250 ms, 500 ms and 1,000 ms plus jitter. A retry delay that cannot fit the remaining operation deadline ends the attempt loop instead of extending it.
- Never automatically retry a cart write.
- Delegate `401` to the OAuth provider for at most one refresh attempt, then require reauthorization.
- Do not continue with cart-dependent reads until a valid, available time slot is verified.
- Never persist, log, or return phone, email, precise address, loyalty barcode, profile IDs, full profile fields, or raw MCP payloads.
- Runtime-validate every MCP response before use; never proceed on a guessed shape.
- Live mode never silently falls back to demo mode; demo mode stays visibly labeled.
- History covers at most 180 days.
- Finish implementation in one focused commit: `feat: read live Silpo purchase context`.

## 6. Requirements

### L10-01 — MCP session foundation

`transport.ts` exports `createHardenedFetch(options)` carrying today's destination validation, manual redirect handling with credential stripping on cross-origin hops, per-request and per-operation deadlines, and the refresh budget. `createSilpoOAuthConnection` consumes it with unchanged settings; every existing `transport.test.ts` assertion continues to pass.

`live/session.ts` exports `openReadSession(userId, options)` and `openWriteSession(userId, options)`. Each builds the OAuth provider for that user, composes `Client` and `StreamableHTTPClientTransport` over a hardened fetch, connects, and calls `listTools()` as its first operation. The advertised tool set is cached on the session; `callTool(name, args)` rejects any name absent from it with `invalid_external_data` and performs no network call. Sessions expose `close()` and release both client and transport.

### L10-02 — Read and write separation

`openReadSession` sets a refresh budget of one, disables fetch-level `429` retry, and applies `withBoundedRetry` from `live/retry.ts` at the `callTool` layer.

`openWriteSession` sets a refresh budget of zero, disables fetch-level retry, has no retry wrapper, and disables transport auto-reconnection. A `401` on a write returns control immediately without a refresh attempt and without replaying the mutation.

`live/retry.ts` is a pure module: `RETRY_ATTEMPT_LIMIT`, `computeRetryDelayMs(attempt, retryAfterHeader, remainingDeadlineMs)`, a `isRetryableStatus` classifier, and `withBoundedRetry(operation, policy)`. The existing `429` loop in `transport.ts` calls `computeRetryDelayMs` so the delay ladder is defined exactly once in the repository. This makes `oauth/transport.ts` import from `live/retry.ts`; the direction is acceptable because `retry.ts` is pure and depends on no session, transport, or MCP type.

Only `silpo_create_shopping_cart` and `silpo_update_shopping_cart` use the write session. Every other Task 10 call uses the read session.

### L10-03 — External schema boundary

`schemas/common.ts` holds shared primitives and a `toolResult(schema)` helper that parses `structuredContent` from an MCP tool result and fails with `invalid_external_data` when the envelope is absent or malformed.

`schemas/cart.ts` parses `silpo_get_my_shopping_cart`, `silpo_get_shopping_cart_by_id`, `silpo_get_time_slots`, `silpo_get_available_delivery_types`, `silpo_list_branches`, `silpo_find_address`, `silpo_get_my_delivery_addresses`, `silpo_create_shopping_cart` and `silpo_update_shopping_cart`.

`schemas/history.ts` parses `silpo_get_my_online_orders`, `silpo_get_my_offline_orders`, `silpo_get_my_family`, `silpo_get_my_food_restrictions` and `silpo_get_loyalty_info`.

External response schemas are not `.strict()`. Zod strips unknown keys by default, so a field Silpo adds is additive rather than an outage. Required fields remain validated: a missing or wrongly typed field is `invalid_external_data` and the flow stops. Internal contracts in `src/features/shared/contracts.ts` keep their existing `.strict()` behavior.

### L10-04 — Cart context bootstrap

`createLiveCartContextGateway({ readSession, writeSession, now })` exposes `loadCartContext()`, `updateCartContext(input)` and `getTimeSlots(context)`.

`loadCartContext()` executes:

```text
get_my_shopping_cart
→ exists:  get_shopping_cart_by_id → get_time_slots
→ absent:  get_my_delivery_addresses → find_address
           → get_available_delivery_types
           → list_branches (only when branchId is null)
           → get_time_slots → create_shopping_cart
           → get_shopping_cart_by_id → get_time_slots
```

Classification against the readback and the slot list:

- the cart slot is present in `get_time_slots`, marked available, and ends after `now` → `{ status: "ready", context }`;
- the slot is expired, missing from the list, or unavailable → `{ status: "needs_slot", availableSlots }`, and no cart-dependent read proceeds;
- the guest has no saved delivery address → a typed actionable error. The gateway does not invent an address, a city, or a branch.

Silpo delivery types map to the contract's two values: `SelfPickup` maps to `pickup`; every other documented type maps to `delivery`.

### L10-05 — Slot selection and verified readback

`updateCartContext(input)` validates `input` against `UpdateCartContextInputSchema`, reads the cart, and confirms the requested `slotId` is present and available in the current slot list. It copies address and shipments verbatim from that readback into `silpo_update_shopping_cart`, then immediately re-reads the cart and verifies the returned slot equals the requested slot. A mismatch is a typed failure, not a returned context. The returned value parses cleanly as `CartContext`, which by its own refinement requires an available slot.

### L10-06 — History reads and mapping

`createLiveHistoryGateway({ readSession, now })` exposes `loadPurchaseHistory(context)` and `loadCustomerContext()`.

`loadPurchaseHistory(context)` requires a verified `CartContext`, reads online and offline orders, keeps only receipts inside a 180-day window ending at `now`, maps `lagerId` to `externalProductId`, excludes service rows such as bags, delivery fees and acceleration fees, and returns `RawPurchaseReceipt[]`. Timestamps are stored and returned as ISO UTC; conversion to local time is a presentation concern and does not happen here. Offline orders use the verified cart context.

### L10-07 — Privacy boundary

Mappers construct contract objects field by field. No raw payload is spread into a returned object, so phone, email, precise address, loyalty barcode, date of birth and profile IDs have no route into a returned value, a persisted row, or console output.

`loadCustomerContext()` returns only `familySize`, `restrictionKeys` and `loyaltyBonusAvailable`. Family member names, pet names and profile fields are read only to derive a count and are never returned.

### L10-08 — Cart context route

`POST /api/cart/context` runs on the Node runtime with `Cache-Control: no-store`. It resolves identity through `resolveSilpoSession` from the `silpo_session` cookie and never accepts a caller-supplied user ID. It Zod-validates the request body against `UpdateCartContextInput` and rejects unknown fields.

In demo mode the route drives `createDemoSilpoGateway()` through the same code path, so live and demo return the same shape and demo labeling is preserved.

Status mapping:

| Condition | Status | Body |
|---|---|---|
| Verified context returned | 200 | `{ mode, context }` |
| Requested slot unavailable or expired | 409 | `AppError` with code `needs_slot` |
| No or invalid session | 401 | `AppError` with code `unauthorized` |
| Rate limited after retry exhaustion | 429 | `AppError` with `retryAfterMs` |
| MCP response failed validation | 502 | `AppError` with code `invalid_external_data` |
| Anything else | 500 | `AppError` with code `unexpected` and a correlation ID |

Error bodies carry a correlation ID and a safe Ukrainian message. They never carry a URL, query string, header, stack trace, or provider error text.

### L10-09 — Contract test evidence

`tests/contract/silpo-cart-context.test.ts` and `tests/contract/silpo-history.test.ts` use injected fake `callTool` sessions for: `tools/list` gating including rejection of an unadvertised tool; active cart with a valid slot; expired slot returning `needs_slot`; no cart running the full bootstrap in the documented order; missing saved address; available delivery types; `list_branches` called only when `branchId` is null; cart creation; slot update copying address and shipments; readback validation rejecting a slot mismatch; family; food restrictions; loyalty; online orders; offline orders; the 180-day window; `lagerId` mapping; service-row exclusion; and the absence of any personal field in returned values.

Fetch-level fixtures drive the real `Client` and hardened fetch to pin: `429` retry exhaustion after exactly three attempts with the documented delay ladder; a cart write receiving `429` and being attempted exactly once; `401` delegating exactly one refresh attempt; and a malformed response producing `invalid_external_data` without a second call.

## 7. Acceptance matrix

| ID | Required evidence | Primary test location |
|---|---|---|
| L10-01 | Hardened fetch extraction preserves Task 9 behavior; session calls `tools/list` first; unadvertised tool rejected without a network call | `transport.test.ts`, `session.test.ts` |
| L10-02 | Read session retries a `429` three times; write session attempts a write exactly once; `401` triggers exactly one refresh on read and none on write; delay ladder defined once | `session.test.ts`, `silpo-cart-context.test.ts` |
| L10-03 | Unknown external fields tolerated; missing or mistyped required field rejected as `invalid_external_data`; no guessed shape proceeds | `silpo-cart-context.test.ts`, `silpo-history.test.ts` |
| L10-04 | Documented bootstrap order for both branches; expired slot yields `needs_slot` and blocks cart-dependent reads; missing address is a typed error; delivery-type mapping | `silpo-cart-context.test.ts` |
| L10-05 | Address and shipments copied verbatim; immediate readback; slot mismatch fails rather than returning a context | `silpo-cart-context.test.ts` |
| L10-06 | 180-day window; `lagerId` to `externalProductId`; service rows excluded; ISO UTC preserved | `silpo-history.test.ts` |
| L10-07 | No phone, email, address, barcode, DOB or profile ID appears in any returned value | `silpo-history.test.ts` |
| L10-08 | Session ownership enforced; body validation; demo parity; full status mapping; no leaked provider text | `silpo-cart-context.test.ts` |
| L10-09 | Focused contract suites pass from a clean invocation alongside `pnpm typecheck` | `pnpm vitest run tests/contract/silpo-history.test.ts tests/contract/silpo-cart-context.test.ts` |

## 8. Completion and handoff

The implementer must show red-to-green output for both contract suites, a passing `session.test.ts`, the unchanged full Task 9 OAuth suite as regression evidence, and `pnpm test`, `pnpm typecheck`, `pnpm lint` and `pnpm build`. All automated tests use synthetic traffic and never real credentials.

**Known verification limit, carried forward from Task 9:** no Silpo credentials are available in this environment, so the read-only live smoke against `https://mcp.silpo.ua/mcp` cannot be run. Mocks do not replace it. This is reported as an outstanding verification gap, not as a reason to weaken any test, and Task 10 is not claimed to be proven against the real MCP server.

The handoff lists changed files, the exact commands and results, the remaining verification limits, and the commit hash. Task 10 stays unchecked in the backlog until implemented, reviewed and integrated.
