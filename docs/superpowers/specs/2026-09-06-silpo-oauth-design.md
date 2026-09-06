# Task 9 Silpo OAuth Specification

Status: proposed on 2026-09-06. Documentation only; implementation has not started. The storage/file-ownership expansion in section 3 requires controller or user approval before execution.

## 1. Scope and authority

Refines [Task 9](../../tasks.md#task-9-silpo-oauth-start-and-callback) and is executed through the [implementation plan](../plans/2026-09-06-silpo-oauth.md). [AGENTS.md](../../../AGENTS.md), [product specification](../../product-spec.md), [project architecture](../../project-architecture.md), and the read-only [Silpo reference](../../../SILPO_MCP.md) retain precedence.

Build the server-side Authorization Code + PKCE flow for `https://mcp.silpo.ua/mcp`: start redirect, callback validation and code exchange, encrypted credentials, a bounded browser session, and bounded refresh. Successful authentication establishes a live application session; it does not generate a draft or authorize cart operations.

Excluded: history/cart/catalog adapters (Tasks 10–11), draft generation (Task 13), dashboard implementation (Task 14), approval and cart writes (Tasks 15–16), logout UI, account merging, scheduled cleanup services, and live write smoke. No Silpo phone number, profile ID, or other personal field is needed to create the internal application user.

## 2. Baseline and dependencies

Inspected commit: `16a136671b0c96e1b8a036cebbf86819e2ba1fc9`. The existing `.gitignore` modification is user-owned and outside this work.

| Existing evidence | Design consequence |
|---|---|
| Tasks 1–2 and 7–8 are integrated; Task 9 remains unchecked | Implement on these boundaries; do not recreate their output. |
| `TokenVault.get/put/clear`, `createTokenVault`, `createPostgresTokenVaultStorage` | All access/refresh tokens go through the existing vault. Preserve its public interface and encrypted format. |
| A vault write requires a nonempty access token | Dynamic registration and PKCE cannot be stored by inventing an access-token placeholder before authentication. |
| `users` exists; no application session or pending-OAuth table/repository exists | Task 9 needs durable storage beyond its current file list. |
| `oauth_metadata` is advisory plaintext with lenient reads | It is unsuitable for PKCE, state, a registration secret, or trusted issuer/discovery binding. |
| `PUBLIC_BASE_URL` is already validated by `getServerEnv()` | Derive fixed callback and landing URLs here; no new environment variable. |
| `Result`, `AppError`, and Node-runtime route composition already exist | Reuse these without changing shared contracts. |
| MCP packages are not installed | Install only Task 9's two authorized dependencies during implementation, then inspect their declarations. |
| No real-Postgres integration harness exists | Add focused database evidence; in-memory tests cannot establish atomic callback consumption. |

Planning prerequisite evidence: `pnpm vitest run src/features/silpo/oauth/token-vault.test.ts src/lib/env.test.ts src/db/schema.test.ts src/features/drafts/repository.test.ts src/features/cart/repository.test.ts` — **5 files, 61 tests passed** on 2026-09-06. This proves prerequisite behavior only.

## 3. Proposed scope resolution

The backlog grants five OAuth files plus dependency installation. A persistent browser session and pre-token registration/PKCE storage cannot be implemented within that list without hiding new persistence responsibilities in `provider.ts`. Repository ownership rules prohibit silently expanding it.

Propose adding the following to Task 9's approved ownership before code work:

| Paths | Purpose |
|---|---|
| `src/features/silpo/oauth/auth-repository.ts`, `.test.ts` | Typed session/OAuth-state storage with Postgres and in-memory adapters. |
| `src/features/silpo/oauth/envelope.ts`, `.test.ts` | Shared private AES-GCM byte-envelope primitive. |
| `src/features/silpo/oauth/token-vault.ts` | Extract only its byte encryption/decryption into that helper; preserve behavior, format, AAD, errors, and public types. |
| `src/features/silpo/oauth/service.ts`, `.test.ts` | Start/callback/session orchestration and typed results. |
| `src/features/silpo/oauth/transport.ts`, `.test.ts` | Official SDK composition, bounded network policy and refresh. |
| `tests/integration/silpo-oauth-postgres.test.ts` | Real database ownership, consumption and rotation tests. |
| `vitest.config.ts` | Exclude the real-Postgres file from ordinary runs; explicitly naming it enables a mandatory, non-skipping database gate. |
| `src/db/schema.ts`, `src/db/schema.test.ts`, new `drizzle/` migration and metadata | Two additive auth tables; preserve all existing tables and migrations. |
| `docs/tasks.md`, `docs/project-architecture.md` | Approved ownership, persistence model and auth lifetime/refresh rules in their owning documents. |

No edit to `src/features/shared/contracts.ts`, `src/lib/env.ts`, or `SILPO_MCP.md` is required. The Task 8 vault public contract remains unchanged; rerun its full regression suite after the extraction. Tasks 10, 13, 15 and 16 will use the new session resolver, so review that handoff before approving the expansion. Task 14's UI files do not overlap.

This is a concrete proposal, not permission to edit those files. Approval must resolve this ownership gap and be recorded in the backlog before implementation. The two planning documents can be completed independently of that approval.

## 4. Approach and trade-offs

Choose opaque cookie handles plus Postgres-backed sessions and encrypted OAuth state. They survive separate serverless requests, support revocation and single-use callbacks, and keep credentials outside the browser. This costs two small tables and a shared encryption extraction.

Alternatives considered:

- An in-process map has fewer files but fails across workers/restarts and cannot establish distributed single use.
- An encrypted browser cookie for the verifier/client registration moves OAuth material into the browser and cannot prevent replay without server-side persistence. It fails the server-side storage requirement.

Use one active authorization flow per internal user. A new start replaces a pending flow; a callback already processing blocks replacement until completion or expiry. This avoids a multi-flow scheduler. A separate browser without an existing application session receives a new internal user; cross-device account linking is outside Task 9.

## 5. Global constraints

- Use `pnpm` exclusively. Task 9 may add only `@ai-sdk/mcp` and `@modelcontextprotocol/client` as production dependencies.
- Preserve the `TokenVault` public interface, v1 token envelope, normalized-user AAD, and legacy-row behavior.
- Keep all OAuth material server-only; never log or serialize tokens, authorization codes, PKCE verifiers, state, cookies, or raw provider errors to application responses.
- Use AES-256-GCM, a random 12-byte IV, a 16-byte tag, and the existing key decoding to exactly 32 bytes.
- Pending OAuth lifetime is 10 minutes. Authenticated application session lifetime is 7 days, absolute and non-sliding.
- Cookies are `HttpOnly`, `SameSite=Lax`, `Path=/`, host-only, and `Secure` in production.
- Perform at most one token refresh attempt per logical authentication/read operation; never automatically retry a cart write.
- Runtime-validate HTTP input, OAuth responses, decrypted payloads, and database rows before use.
- Start each authenticated MCP session with `tools/list` as the first application operation after initialization; call no business tool in Task 9.
- Live mode never silently falls back to demo mode. OAuth routes return 404 in demo mode without network or database work.
- Do not modify `SILPO_MCP.md` or shared application contracts.
- Finish implementation in one focused commit: `feat: add Silpo OAuth flow`.

## 6. Requirements

### O9-01 — Identity and browser binding

The browser supplies only an opaque, cryptographically random handle: 32 random bytes encoded as base64url. Never accept `userId` from query parameters, headers, or a client body. Store the SHA-256 digest of the handle, never the bearer handle itself. Authentication is determined by a live server-side session row with `status=authenticated`, not by cookie presence.

Use the cookie name `silpo_session` in both environments. A pending handle lasts at most 600 seconds; an authenticated handle lasts at most 604800 seconds. Set explicit `Max-Age` and `Expires`, use the attributes in section 5, and clear a rejected/expired handle with the same scope. Do not clear an unrelated valid session when another flow supplies a mismatched callback.

With no valid session, start inserts an internal `users` row and pending session in one transaction. Reauthorization from a valid session keeps the same internal user and binds the flow to that session's digest. Successful callback rotates the handle and revokes the old session atomically. A failed initial login never promotes its pending session.

Expose `resolveSilpoSession(handle)` for later user-scoped routes. It returns `Result<{ userId: string; expiresAt: Date }, AppError>`, validates input and stored rows, and rejects missing, pending, revoked, malformed or expired sessions. It never returns a credential or queries a Silpo profile.

### O9-02 — Durable persistence and encryption

Add two tables with UUID primary keys, UTC timestamps, explicit checks and indexes:

| Table | Columns and invariants |
|---|---|
| `auth_sessions` | `id`, `user_id` nonnull FK → users/delete cascade, unique `handle_hash`, `status` (`pending`, `authenticated`, `revoked`), `expires_at`, `created_at`. Index `user_id` and `expires_at`. |
| `silpo_oauth_states` | `id`, unique `user_id` nonnull FK → users/delete cascade, `version` positive integer, `phase` (`idle`, `pending`, `processing`), nullable `binding_hash`, nullable `flow_expires_at`, nonnull `ciphertext`, `iv`, `auth_tag`, `updated_at`. Pending/processing require binding and expiry. |

The second table holds a versioned, Zod-validated encrypted payload: pending flow ID, state, verifier, validated client registration, validated discovery state and issuer binding. After completion/failure, erase state/verifier/flow ID while retaining usable encrypted registration/discovery. Never retain authorization codes. Unknown registration fields are stripped; if registration returns `client_secret`, encrypt it even before tokens exist. Store no raw HTTP/MCP response.

The shared `envelope.ts` seals/opens bytes only. The vault keeps responsibility for its token JSON format and error mapping. Auth-state payloads use AAD `silpo-oauth-state:v1:<lowercase-user-id>`; vault AAD remains the lowercase user ID exactly. Thus ciphertext cannot be transplanted across users or purposes. DB reads validate column types, enum values, timestamps, envelope encoding and decrypted schema. Crypto failures map to a safe error without exposing payloads.

Use compare-and-swap versions for updates. Claiming a callback is a single database conditional update from `pending` to `processing`, checking version, binding hash and unexpired flow; only the winner receives the decoded flow. A concurrent duplicate gets `unauthorized` and performs no exchange. Never hold a database transaction open during network calls. A crashed processing flow expires at the original 10-minute deadline, after which a fresh start is allowed. Check expiry again before activation.

Enforce expiry on every read and claim; opportunistically delete expired pending/revoked session rows for the current user when starting. A scheduled global cleanup job is not required. An old callback must not clear a newer flow: completion/cancellation also compares flow version.

### O9-03 — OAuth provider

Implement the installed official `OAuthClientProvider` contract in `provider.ts`, backed by injected vault/state ports. Expose async `createSilpoOAuthProvider(userId, options?)`, returning the initialized provider after loading validated durable state; the one-argument call composes lazy production dependencies, while tests inject them. `userId` always comes from a verified server-owned session context.

The provider persists state, verifier, registration and discovery before the browser redirect; callback reconstructs it on a separate request. An internal claimed-flow snapshot supplies the verifier during callback, after the durable claim has prevented replay. Await every SDK persistence hook. Capture the authorization URL for the application service; the provider never opens a browser or creates an HTTP response.

Use Authorization Code + S256 PKCE. Fix the resource endpoint above; derive the exact callback `/api/auth/silpo/callback` from the configured application origin. Do not derive trusted redirects from `Host`, `Forwarded`, callback query data or arbitrary return URLs. Reject credentials/query/fragment/path components in the configured base URL at the composition boundary if they would make it ambiguous; allow only an HTTP(S) origin, HTTPS in production. Do not introduce a second environment reader.

Store registration/discovery issuer binding in encrypted auth state. If the issuer changes, require fresh registration/authorization; never reuse another issuer's credentials. Do not spread untrusted metadata into the vault. Use an explicit allowlist for any advisory metadata, with secrets routed through encrypted fields. Preserve a previous refresh token when a same-issuer refresh response omits a replacement; never carry it into a fresh authorization-code grant. Convert relative expiry to an absolute timestamp at receipt; never extend expiry by repeatedly returning the original duration. Unknown expiry stays unknown.

Credential invalidation distinguishes verifier, discovery, client, tokens and all: removing a verifier must not delete tokens; token invalidation calls `vault.clear`; client/all invalidation clears corresponding encrypted registration and affected tokens. Every result is scoped to the current user and flow.

### O9-04 — Start route and service

`GET /api/auth/silpo/start` is dynamic, Node-runtime, and uncached. Reject unsupported query parameters instead of supporting open return redirects or caller-supplied identities.

1. Check mode and validated configuration.
2. Resolve/create the session and user. Allocate a fresh state and flow ID; persist the binding and deadline before starting OAuth. Refuse an unexpired processing flow with a safe 409.
3. Build the provider and official Streamable HTTP transport. Allow the SDK to discover endpoints and register the client; do not hard-code `/register` or `/authorize` paths.
4. If browser authorization is required, verify that state, verifier, registration and discovery were saved, then issue a 303 to the captured authorization URL and set the pending cookie for an initial login.
5. If already authorized, perform `tools/list`, complete session rotation and redirect to the fixed application landing path `/`.
6. Close the client/transport on every exit. Persist no transient transport/session identifier as a browser session.

The root route exists at the baseline; `/dashboard` does not. Redirecting to `/` is Task 9's landing behavior. Making that page render a live personalized draft remains the Task 13/14 integration boundary. Authentication must not relabel demo content as live or claim draft generation is complete.

### O9-05 — Callback validation, exchange and activation

`GET /api/auth/silpo/callback` accepts exactly one nonempty bounded `state` and either one `code` or one OAuth `error`; permit one optional `iss`, `error_description`, `error_uri`, and `session_state` for protocol compatibility, but never render/persist the last three. Reject duplicates, mixed code/error, missing values, state over 256 characters, code over 4096 characters, and total query over 8192 characters. Parse before invoking application logic.

Resolve the cookie and read only its user's pending flow. Compare state in constant time after equal-length validation; check expiry and issuer binding before any exchange. A valid denial consumes/cancels the flow and returns a safe restart instruction without exchanging a code. A mismatch does not consume a legitimate pending flow or clear its credentials.

For a valid success callback, atomically claim the flow, reconstruct the provider using the claimed snapshot, and call `transport.finishAuth(code)`; when `iss` is present, pass it through the SDK's supported positional issuer argument as well. Require an issuer if discovered metadata says it is mandatory. Use a fresh transport for reconnect, then `tools/list`. Never retry authorization-code exchange automatically. Immediately after exchange, the SDK's token persistence hook must have successfully written through the real vault before the service can activate a session.

Only after encrypted credentials and the read-only connection probe succeed, replace the old session handle in a transaction and clear pending secrets. Issue a 303 to `/` with the rotated cookie. A DB write, decrypt, exchange, probe, or activation failure issues no authenticated cookie and no success redirect. If tokens were saved but activation fails, they remain inaccessible to a pending session; a new login is required. Callback replay, including after a process restart, performs no exchange.

### O9-06 — One refresh owner and read/write separation

Put auth recovery in `transport.ts`, not in both routes and provider. The official SDK owns grant serialization; the adapter owns a per-operation budget that also wraps its injected fetch. An expired token uses the same single refresh allowance as a later 401. Missing refresh credentials cause reauthorization without a token request. A failed refresh, malformed response or repeated 401 ends recovery and clears unusable credentials; return `unauthorized` with a restart action.

The budget counts actual refresh-grant requests, including SDK-internal retries. Test the wire count; a mocked application callback count is insufficient. For Task 9 connection/`tools/list`, allow at most one read replay after successful refresh, and disable additional automatic reconnect/step-up loops. Cap each outbound request at 10 seconds and the entire start/callback network phase at 30 seconds. Timeouts return an actionable safe error and do not restart the flow automatically.

Task 10 receives a read-only connection factory. Task 16 must use a distinct bearer-only, no-recovery write transport after explicit preflight: a write 401 returns control without refreshing or replaying the write. Task 9 creates no cart-write implementation. Do not export a generic retry wrapper that accepts arbitrary business operations.

### O9-07 — External validation and disclosure

Use SDK validation plus narrow local Zod schemas for the fields persisted/consumed. Reject non-Bearer token types unless explicit support is designed later. Keep issuer/resource checks enabled; validate discovered endpoint URLs and redirects, reject non-HTTPS/private/loopback/link-local destinations for production outbound auth, and never forward a bearer token to discovery or registration endpoints. Tests may inject synthetic public HTTPS origins through the transport's fetch port.

All responses, including redirects/errors, use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Error bodies reuse `AppError` with fixed Ukrainian messages, correlation ID and nullable `retryAfterMs`. Responses contain no query echo, SDK exception text, cookie handle, user ID, token or registration detail. State is transmitted only where the OAuth protocol requires it (authorization redirect and callback), never as application diagnostics. No module logs request URLs, headers, provider objects or caught exceptions.

| Condition | HTTP / `AppError.code` | User-facing message |
|---|---|---|
| Missing/invalid/expired binding, state mismatch, replay, denial, exhausted auth | 400 for malformed/state input; otherwise 401 / `unauthorized` | `Не вдалося підтвердити вхід. Увійдіть у «Сільпо» ще раз.` |
| Unexpired flow already processing | 409 / `unauthorized` | `Вхід уже обробляється. Дочекайтеся завершення або почніть знову після завершення строку дії.` |
| Invalid provider response | 502 / `invalid_external_data` | `«Сільпо» повернуло некоректну відповідь. Спробуйте увійти ще раз.` |
| Upstream rate limit | 429 / `rate_limited`, validated retry metadata | `Забагато запитів. Спробуйте увійти трохи пізніше.` |
| Network timeout | 504 / `unexpected` | `Час очікування входу минув. Спробуйте ще раз.` |
| Persistence, envelope, unexpected failure | 500 / `unexpected` | `Не вдалося завершити вхід. Спробуйте ще раз.` |
| Demo mode | 404 | Fixed `not_found` response; no auth work |

Read-only 429 recovery, if invoked, follows the existing maximum three retries and metadata-or-250/500/1000-ms-plus-jitter rule, within the total deadline. Token exchange, dynamic registration and refresh are not read-only MCP requests and receive no generic 429 retry loop.

### O9-08 — SDK compatibility evidence

The current official client supports the OAuth provider and `finishAuth` pattern; state comparison is application-owned. Its issuer/discovery features must survive callback reconstruction. See the [client guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/client.md), [provider source](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/client/src/client/auth.ts), and [transport source](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/client/src/client/streamableHttp.ts), checked 2026-09-06. The [Silpo documentation](https://ai-factory.silpo.ua/docs/mcp) confirms the endpoint and Authorization Code + PKCE integration.

Those moving sources are planning evidence, not a version pin. At implementation, install the two backlog dependencies, record the resolved versions, inspect exports/types, and compile the provider against the actual installed interface. Verify the same provider can type-check as the AI SDK MCP auth provider without unsafe casting. If packages disagree or are unavailable, report the dependency conflict; do not silently substitute legacy packages. The local Silpo snippet's legacy import path does not override Task 9's explicit package list.

## 7. Acceptance matrix

| ID | Required evidence | Primary test location |
|---|---|---|
| O9-01 | Unknown/pending/expired sessions fail; user ID cannot be injected; success rotates and revokes | `service.test.ts`, `silpo-oauth.test.ts` |
| O9-02 | Encryption/AAD isolation; restart-safe state; one concurrent claim; old callback cannot clear a new flow | `envelope.test.ts`, `auth-repository.test.ts`, `silpo-oauth-postgres.test.ts` |
| O9-03 | Official provider typing; persisted S256 verifier/state/registration; fresh-instance reconstruction; token rotation/expiry | `provider.test.ts` |
| O9-04 | 303 and correct cookies; demo 404; fixed callback/landing; no business tool | `silpo-oauth.test.ts` |
| O9-05 | Mismatch/expiry/denial/replay precedes exchange; code and issuer forwarded; vault-before-session ordering | `service.test.ts`, `silpo-oauth.test.ts` |
| O9-06 | Exactly one actual refresh; one read replay; failure reauthorizes; deadline and close paths | `transport.test.ts`, `silpo-oauth.test.ts` |
| O9-07 | Malformed metadata/tokens/rows rejected; secret sentinel absent from responses/logs/storage plaintext | All OAuth suites |
| O9-08 | Installed provider/transport compatibility and SDK-backed mock HTTP integration | `provider.test.ts`, `silpo-oauth.test.ts`, `pnpm typecheck` |

## 8. Completion and handoff

Implementer must show red→green output for the focused OAuth tests; real-Postgres evidence for callback claim/session rotation; passing cumulative vault/repository tests; `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`. Run the existing E2E smoke when the build/route surface changes. All automated OAuth tests use synthetic provider traffic, never real credentials.

Document any manually performed read-only live OAuth smoke separately; it is not replaced by mocks, and lack of credentials is a reported verification limit rather than a reason to weaken tests. No live write smoke belongs to this task.

The handoff lists changed files, installed package versions, exact commands/results, database test evidence, remaining deployment limitations, and the commit hash. Task 9 remains unchecked until implemented, reviewed and integrated. The planning deliverable does not claim OAuth is working.
