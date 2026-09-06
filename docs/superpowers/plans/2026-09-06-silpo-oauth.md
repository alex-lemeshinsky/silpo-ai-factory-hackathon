# Task 9 Silpo OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan step-by-step. Steps use checkbox (`- [ ]`) syntax for tracking. One implementer owns Task 9; these stages are sequential, not parallel assignments. Follow repository worktree and review rules.

**Goal:** Establish a live application session through Silpo OAuth with server-side PKCE/state, encrypted credentials, single-use callbacks and bounded refresh.

**Architecture:** Thin Next.js routes call an injected OAuth application service. A durable auth repository owns session and flow lifecycle; the official SDK provider delegates token storage to Task 8's vault and network policy to a narrow transport adapter. Extract the existing vault's byte-encryption primitive for encrypted pre-token OAuth state without changing the vault's interface or stored format.

**Tech Stack:** Next.js App Router/Node runtime, TypeScript, Zod, Drizzle/Postgres, `node:crypto`, Vitest, `@modelcontextprotocol/client`, `@ai-sdk/mcp`.

**Spec:** [Task 9 Silpo OAuth Specification](../specs/2026-09-06-silpo-oauth-design.md).

Status: proposed 2026-09-06 against `16a136671b0c96e1b8a036cebbf86819e2ba1fc9`. This plan is complete as a planning artifact; execution is gated on the explicit file-ownership expansion in spec section 3. It is not an implementation-completion report.

## Global Constraints

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

## Ownership and interfaces

Read `AGENTS.md`, product spec, Tasks 2/7/8/9, project architecture sections 4/6–10/13–14, the Task 9 spec, Task 8's current source, and `SILPO_MCP.md` sections on OAuth. Do not load unrelated task implementations.

| File | Responsibility / action |
|---|---|
| `src/features/silpo/oauth/envelope.ts`, `.test.ts` | Create private byte-envelope primitive and cryptographic tests. |
| `src/features/silpo/oauth/token-vault.ts` | Modify only to use that primitive. Existing tests remain the regression contract. |
| `src/features/silpo/oauth/auth-repository.ts`, `.test.ts` | Create local payload/row schemas, session and flow ports, in-memory and Postgres implementations. |
| `src/db/schema.ts`, `src/db/schema.test.ts` | Add the two spec tables and assert constraints. |
| `drizzle/0002_silpo_oauth.sql`, `drizzle/meta/0002_snapshot.json`, `drizzle/meta/_journal.json` | Generate additive migration with `--name silpo_oauth`. If another migration lands first, regenerate at the next index. |
| `src/features/silpo/oauth/provider.ts`, `.test.ts` | Create official SDK provider and field-level SDK/local conversion. |
| `src/features/silpo/oauth/transport.ts`, `.test.ts` | Create SDK/network adapter and recovery-budget tests. |
| `src/features/silpo/oauth/service.ts`, `.test.ts` | Create application orchestration, session resolver and typed results. |
| `src/app/api/auth/silpo/start/route.ts` | Create start transport validation and response/cookie mapping. |
| `src/app/api/auth/silpo/callback/route.ts` | Create callback validation and response/cookie mapping. |
| `tests/integration/silpo-oauth.test.ts` | Create real route/SDK/vault tests with synthetic fetch responses. |
| `tests/integration/silpo-oauth-postgres.test.ts` | Create opt-in real-Postgres repository concurrency tests. |
| `vitest.config.ts` | Exclude the real-Postgres file unless its exact path is explicitly selected; selected runs must never silently skip. |
| `package.json`, `pnpm-lock.yaml` | Install Task 9's two dependencies only. |
| `docs/tasks.md`, `docs/project-architecture.md` | Record approved scope and normative auth details; check Task 9 only after integration. |

The auth repository owns its local Zod schemas and normalized types; it does not import `provider.ts`. Provider converts SDK values into these normalized shapes. No cyclic imports or edits to shared contracts are needed.

Implement these local interfaces; their types are not additions to the Task 2 domain contract:

```ts
// envelope.ts — raw bytes only; caller validates decoded contents
export interface SealedBytes { ciphertext: string; iv: string; authTag: string }
export function sealBytes(key: Buffer, aad: string, plaintext: Buffer): SealedBytes;
export function openBytes(key: Buffer, aad: string, envelope: SealedBytes): Buffer;

// auth-repository.ts — all exported data has passed local Zod validation
export interface AuthSession {
  id: string;
  userId: string;
  handleHash: string;
  status: "pending" | "authenticated" | "revoked";
  expiresAt: Date;
}
export interface ClientRegistration {
  clientId: string;
  clientSecret: string | null;
  clientIdIssuedAt: number | null;
  clientSecretExpiresAt: number | null;
  tokenEndpointAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
  issuer: string;
}
export interface DiscoveryBinding {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  resource: string;
  resourceMetadataUrl: string | null;
  scopesSupported: string[];
  codeChallengeMethodsSupported: string[];
  tokenEndpointAuthMethodsSupported: string[];
  responseIssuerRequired: boolean;
}
export interface OAuthPayload {
  version: 1;
  flowId: string | null;
  state: string | null;
  verifier: string | null;
  registration: ClientRegistration | null;
  discovery: DiscoveryBinding | null;
}
export interface OAuthState {
  userId: string;
  version: number;
  phase: "idle" | "pending" | "processing";
  bindingHash: string | null;
  flowExpiresAt: Date | null;
  payload: OAuthPayload;
}
export interface AuthRepository {
  createPendingSession(input: { handleHash: string; now: Date; expiresAt: Date }): Promise<AuthSession>;
  findSession(handleHash: string, now: Date): Promise<AuthSession | null>;
  readState(userId: string): Promise<OAuthState | null>;
  beginFlow(input: { userId: string; bindingHash: string; flowId: string; state: string; now: Date; expiresAt: Date }): Promise<OAuthState>;
  saveState(input: { userId: string; expectedVersion: number; payload: OAuthPayload }): Promise<OAuthState>;
  claimFlow(input: { userId: string; bindingHash: string; expectedVersion: number; now: Date }): Promise<OAuthState | null>;
  finishFlow(input: { userId: string; expectedVersion: number }): Promise<boolean>;
  activateSession(input: { oldHandleHash: string; newHandleHash: string; userId: string; expectedFlowVersion: number; now: Date; expiresAt: Date }): Promise<AuthSession>;
}
```

`finishFlow` atomically clears pending secrets and returns to idle; it is used for validated denial and failure. `activateSession` does the same cleanup and old-handle revocation in its own transaction. Every mutation increments the state version; provider/service carries the latest version after each save. Do not call `finishFlow` before successful activation, because activation must check a live processing flow. `createPendingSession` creates its `users` row in the same transaction. `findSession` excludes revoked/expired rows but may return pending for the OAuth service; the exported session resolver requires authenticated status.

Repository factories:

```ts
createInMemoryAuthRepository(options: { encryptionKey: Buffer }): AuthRepository;
createPostgresAuthRepository(options: { db: DbClient; encryptionKey: Buffer }): AuthRepository;
```

Widen the in-memory factory only for tests with `rawState(userId): SealedBytes | null` and `rawSession(handleHash): AuthSession | null`, both returning clones. These allow storage assertions without exposing them through the production interface. Validate state with local schemas after decryption; provider adds SDK-specific validation before converting to/from the normalized registration/discovery fields above. Unsupported required protocol metadata becomes `invalid_external_data`, never guessed defaults.

## Stage 9.1 — Resolve scope and prove installed boundaries

**Files:** `docs/tasks.md`, `docs/project-architecture.md`, `package.json`, `pnpm-lock.yaml`, `provider.test.ts`.

**Produces:** Approved ownership and a compiler-checked SDK target.

- [ ] Confirm explicit approval of spec section 3. Record its expanded ownership in Task 9 and the two new tables in architecture section 8 before touching implementation files. If approval is absent, report this specific gate; do not improvise storage in `users.settings` or `mcp_connections.oauth_metadata`.
- [ ] Run `git status --short` and `git log -6 --oneline`. Preserve unrelated changes. Confirm Tasks 2/7/8 are integrated and the five-test prerequisite command from the spec passes.
- [ ] Install packages and record versions, without real OAuth calls:

```bash
pnpm add @ai-sdk/mcp @modelcontextprotocol/client
pnpm list @ai-sdk/mcp @modelcontextprotocol/client --depth 0
rg -n 'OAuthClientProvider|finishAuth|saveDiscoveryState|onUnauthorized' node_modules/@modelcontextprotocol/client
rg -n 'authProvider|OAuthClientProvider' node_modules/@ai-sdk/mcp
```

- [ ] Add a compile-time conformance assertion in `provider.test.ts`, importing types from the actual exports discovered above. The provider return type must satisfy the installed official interface and AI SDK's configured auth-provider type without `as unknown as` casts. Record versions and official source links in the spec's SDK evidence section. Stop for an actual package conflict; do not replace a backlog dependency silently.
- [ ] Run the original focused command to capture the first expected red result:

```bash
pnpm vitest run src/features/silpo/oauth/provider.test.ts tests/integration/silpo-oauth.test.ts
```

Expected initial failure: implementation modules are absent. A package resolution or configuration failure is a dependency problem, not a valid behavior-test red.

## Stage 9.2 — Share cryptography without changing Task 8

**Files:** `envelope.ts`, `envelope.test.ts`, `token-vault.ts`.

**Consumes:** Existing token encryption format. **Produces:** `sealBytes/openBytes` as defined above.

- [ ] Write a failing byte-envelope test with real cryptography:

```ts
import { randomBytes } from "node:crypto";
import { openBytes, sealBytes } from "./envelope";

it("binds a secret to its purpose and user with a fresh IV", () => {
  const key = randomBytes(32);
  const aad = "silpo-oauth-state:v1:user-1";
  const value = Buffer.from("synthetic-verifier");
  const first = sealBytes(key, aad, value);
  const second = sealBytes(key, aad, value);
  expect(first.iv).not.toBe(second.iv);
  expect(Buffer.from(first.iv, "base64")).toHaveLength(12);
  expect(Buffer.from(first.authTag, "base64")).toHaveLength(16);
  expect(openBytes(key, aad, first)).toEqual(value);
  expect(() => openBytes(key, "user-1", first)).toThrow();
  expect(() => openBytes(key, "silpo-oauth-state:v1:user-2", first)).toThrow();
  expect(Buffer.from(first.ciphertext, "base64").includes(value)).toBe(false);
});
```

- [ ] Run `pnpm vitest run src/features/silpo/oauth/envelope.test.ts` and confirm missing-export failure.
- [ ] Move only the existing AES-GCM/base64 primitive into the helper. The core sealing operation is:

```ts
const iv = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", key, iv);
cipher.setAAD(Buffer.from(aad, "utf8"));
const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64") };
```

Require a 32-byte key; preserve canonical base64/IV/tag validation from the current vault on open. Throw fixed, secret-free primitive errors. The vault maps open failures back to `TokenVaultError("envelope_unreadable", ...)`, retains its version probe and JSON schemas, and preserves the exact payload serialization/AAD used by existing ciphertext.
- [ ] Add wrong-key, bad-IV, bad-tag, malformed-base64 and byte-tampering cases. Run `pnpm vitest run src/features/silpo/oauth/envelope.test.ts src/features/silpo/oauth/token-vault.test.ts`. Both must pass without weakening existing tests.

## Stage 9.3 — Persist session and OAuth lifecycle atomically

**Files:** `auth-repository.ts`, `.test.ts`, `src/db/schema.ts`, `src/db/schema.test.ts`, migration files, `tests/integration/silpo-oauth-postgres.test.ts`, `vitest.config.ts`.

**Consumes:** Byte envelopes, `users`, `DbClient`. **Produces:** `AuthRepository` and the two tables in O9-02.

- [ ] Add schema tests for table existence, unique handle/user indexes, FKs, status/phase checks and nonnull encrypted columns. Add this repository behavior using an actual factory:

```ts
it("allows only one claimant of a live bound flow", async () => {
  const repo = createInMemoryAuthRepository({ encryptionKey: randomBytes(32) });
  const now = new Date("2026-09-06T09:00:00Z");
  const session = await repo.createPendingSession({ handleHash: "a".repeat(64), now, expiresAt: new Date(now.getTime() + 600000) });
  const flow = await repo.beginFlow({ userId: session.userId, bindingHash: session.handleHash, flowId: "flow-1", state: "synthetic-state", now, expiresAt: session.expiresAt });
  const input = { userId: session.userId, bindingHash: session.handleHash, expectedVersion: flow.version, now };
  const results = await Promise.all([repo.claimFlow(input), repo.claimFlow(input)]);
  expect(results.filter(Boolean)).toHaveLength(1);
});
```

- [ ] Run `pnpm vitest run src/features/silpo/oauth/auth-repository.test.ts src/db/schema.test.ts` and confirm the intended red.
- [ ] Implement local strict Zod schemas for the interfaces above. Trim/validate IDs, lowercase real user UUIDs, enforce a 64-character hex handle hash, validate dates and phase/payload relationships. Persist encrypted normalized payloads; return no unparsed DB data. Start with fakes using the same schemas/crypto as Postgres.
- [ ] Implement claim as one conditional update, not read-then-write logic:

```sql
UPDATE silpo_oauth_states
SET phase = 'processing', version = version + 1, updated_at = $1
WHERE user_id = $2 AND binding_hash = $3 AND version = $4
  AND phase = 'pending' AND flow_expires_at > $1
RETURNING *;
```

Use parameterized Drizzle queries. For session activation, lock/read the expected processing state inside a short transaction, validate unexpired flow and user/binding, insert the new authenticated session, revoke the old one and clear pending secrets with version increment. Roll back all steps on a conflict. `beginFlow` rejects unexpired processing state and preserves encrypted registration/discovery when replacing pending/expired state. Every provider save uses optimistic version matching.
- [ ] Add tests for expiry at exact boundary, missing/wrong binding, stale version, restart with the same Postgres store, encrypted registration before tokens, ciphertext transplantation, invalid DB rows and activation rollback. Prove a replay cannot erase a newer flow.
- [ ] Generate the additive migration:

```bash
pnpm drizzle-kit generate --name silpo_oauth
pnpm vitest run src/features/silpo/oauth/auth-repository.test.ts src/db/schema.test.ts
```

- [ ] Implement real DB tests with `// @vitest-environment node`. Use `getServerEnv().DATABASE_URL` for a dedicated disposable test database only. In `vitest.config.ts`, add the exact DB test path to `exclude` unless explicitly named in the CLI arguments:

```ts
const oauthPostgresTest = "tests/integration/silpo-oauth-postgres.test.ts";
const runOAuthPostgres = process.argv.some((arg) => arg === oauthPostgresTest || arg.endsWith(`/${oauthPostgresTest}`));
// Append to the existing test.exclude array:
...(runOAuthPostgres ? [] : [oauthPostgresTest])
```

The selected file contains no skip condition: missing/unreachable test DB must fail. Do not log the connection string. Refuse production mode. Create a unique test schema, apply the migration SQL in order inside that schema with an isolated search path, and drop only that test schema in cleanup. Never migrate/drop application tables from a test. Inspect migrations for schema-qualified targets before running them; refuse any migration that escapes the test schema.
- [ ] Against two separate connections sharing that schema, run concurrent claims and assert one returned row; test cascade, duplicate hash constraint, session rotation rollback and post-restart replay. Run:

```bash
pnpm vitest run tests/integration/silpo-oauth-postgres.test.ts
```

If a dedicated DB cannot be supplied, record the exact missing gate; do not mark the implementation complete based on the fake alone. No credentials belong in the plan, fixtures, shell output or report.

## Stage 9.4 — Implement the provider and encrypted token handoff

**Files:** `provider.ts`, `provider.test.ts`.

**Consumes:** `TokenVault`, `AuthRepository`, installed SDK types. **Produces:** `createSilpoOAuthProvider(userId, options?)`.

Define injected options with `vault`, `repository`, `publicBaseUrl`, `now`, and optional claimed `OAuthState`. The factory is async: await the durable state read before returning the initialized provider. The resolved value exposes the SDK provider plus local flow controls: `authorizationUrl(): URL | null` and `currentState(): OAuthState`; use intersection types so the SDK contract remains compiler-enforced. Read production environment/DB lazily only when options are omitted.

- [ ] Write failing tests using real in-memory vault storage and real encrypted auth repository. Test that `saveCodeVerifier` and the state callback survive construction of a fresh provider over the same repository; record client registration with a synthetic secret before any vault token exists. Verify plaintext raw state and raw vault rows contain neither secret.
- [ ] Run `pnpm vitest run src/features/silpo/oauth/provider.test.ts` and confirm behavior failures.
- [ ] Implement SDK hooks and explicit field conversion. For token save, the central mapping is:

```ts
await vault.put(userId, {
  accessToken: parsed.access_token,
  refreshToken: parsed.refresh_token ?? refreshTokenFromSameGrant,
  clientSecret: registration.clientSecret,
  expiresAt: parsed.expires_in === undefined ? null : new Date(now().getTime() + parsed.expires_in * 1000),
  scope: parsed.scope ?? null,
  oauthMetadata: null,
});
```

`parsed` must come from the installed SDK token schema plus a Bearer/finite-positive-expiry check; `refreshTokenFromSameGrant` is the previous same-issuer refresh token only during a refresh grant, otherwise `null`. Do not infer grant type from whether a token happened to exist. Have transport explicitly supply grant context through a provider-local setter `setGrantKind(kind: "authorization_code" | "refresh_token"): void` before the SDK saves tokens. Registration/discovery remain encrypted in auth state and supply issuer binding when reconstructing SDK tokens. `tokens()` computes remaining `expires_in` from the absolute stored expiry and keeps expired refresh credentials available to the recovery path.
- [ ] Persist validated discovery through the SDK hook and reconstruct the installed discovery type field-by-field from `DiscoveryBinding`. Do not cast an unknown stored object to the SDK type. If required installed fields exceed the normalized shape, update this local shape and tests in the same change; do not edit shared domain contracts.
- [ ] Add tests for captured redirect only after durable hooks, exact callback origin/path, S256 challenge, issuer mismatch, token type rejection, registration expiry, omitted/rotated refresh token, `tokens()` without issuer context, elapsed expiry, malformed persisted payload and each invalidation scope. A fresh provider instance must complete reconstruction without a shared map.
- [ ] Run `pnpm vitest run src/features/silpo/oauth/provider.test.ts src/features/silpo/oauth/token-vault.test.ts && pnpm typecheck`.

## Stage 9.5 — Bound transport authentication and cleanup

**Files:** `transport.ts`, `transport.test.ts`.

**Consumes:** Provider and SDK client. **Produces:** Narrow connection factory for the application service; no generic write/retry function.

```ts
export interface OAuthConnection {
  begin(): Promise<"authorized" | "redirect">;
  finishAuth(code: string, issuer?: string): Promise<void>;
  probeTools(): Promise<void>;
  close(): Promise<void>;
}
export type OAuthConnectionFactory = (provider: SilpoOAuthProvider) => OAuthConnection;
```

Export `SilpoOAuthProvider` as `Awaited<ReturnType<typeof createSilpoOAuthProvider>>`. Production factory creates the installed `Client`/`StreamableHTTPClientTransport`. `begin` normalizes interactive authorization; `finishAuth` delegates code/issuer once; `probeTools` reconnects with a fresh transport if necessary and invokes `listTools`. Keep initialization separate from application-tool calls.

- [ ] Write a fake `fetch` that returns synthetic OAuth metadata/registration/token responses and MCP JSON-RPC initialization/tools-list responses. Use real SDK code, record method/URL/grant type counts, and fail the test on every unrecognized request. Response fixtures must satisfy the installed SDK schemas/protocol version, not bypass them with casts.
- [ ] Add the decisive refresh test: seed an expired vault record with a refresh token, return one valid refresh response, then return 401 from the MCP probe. Assert the actual token endpoint saw exactly one `grant_type=refresh_token`, the result is `unauthorized`, and no second refresh or business tool ran. Also test initial 401→refresh→successful read, missing refresh token, invalid_grant and malformed refresh response.
- [ ] Run `pnpm vitest run src/features/silpo/oauth/transport.test.ts` to capture red.
- [ ] Wrap injected SDK fetch with a shared operation deadline and grant budget. The refresh guard must run before the network call:

```ts
if (grantType === "refresh_token") {
  if (budget.refreshAttempts >= 1) throw new ReauthorizationRequired();
  budget.refreshAttempts += 1;
  provider.setGrantKind("refresh_token");
}
if (grantType === "authorization_code") {
  if (budget.codeExchanges >= 1) throw new ReauthorizationRequired();
  budget.codeExchanges += 1;
  provider.setGrantKind("authorization_code");
}
```

Define local `ReauthorizationRequired` with a fixed message and map it to `unauthorized`; never expose the error object. Read the normalized fetch request body with `URLSearchParams` only for the validated token endpoint, using a cloned `Request` so inspection cannot consume the outgoing body. Keep a single budget across proactive expiry handling, SDK recovery, reconnect and probe. Use `AbortSignal` with 10-second request/30-second operation deadlines, and disable additional reconnect/step-up retries in the installed SDK. The token endpoint must not receive raw MCP bearer headers.
- [ ] Add request-destination validation and tests for insecure/private destinations and redirect escapes. Revalidate each redirect target before following it; enforce production network policy at DNS/connect time as well as URL parsing so a public hostname cannot resolve to an internal address. Use a narrow injected network adapter in this file; do not weaken SDK issuer/resource checks.
- [ ] Test exactly one read replay, no automatic exchange/registration retry, 429 limits only for read-only operations, every close path, and timeout with fake timers. `probeTools` accepts no tool name or arbitrary callback, so it cannot become a cart-write retry path. Document the later bearer-only write boundary in architecture section 9.
- [ ] Run `pnpm vitest run src/features/silpo/oauth/transport.test.ts src/features/silpo/oauth/provider.test.ts`.

## Stage 9.6 — Add application service and thin routes

**Files:** `service.ts`, `.test.ts`, start/callback routes, `tests/integration/silpo-oauth.test.ts`.

**Consumes:** Auth repository, provider, connection factory, `getServerEnv`, `Result/AppError`. **Produces:** start/callback completion and authenticated-session resolver.

```ts
export interface OAuthCompletion {
  location: string;
  cookie: { value: string; expiresAt: Date; maxAge: number } | null;
}
export interface CallbackInput {
  handle: string | null;
  state: string;
  code?: string;
  issuer?: string;
  denied: boolean;
}
export interface OAuthFailure {
  status: number;
  error: AppError;
  clearCookie: boolean;
}
export interface SilpoOAuthService {
  start(handle: string | null, correlationId: string): Promise<Result<OAuthCompletion, OAuthFailure>>;
  callback(input: CallbackInput, correlationId: string): Promise<Result<OAuthCompletion, OAuthFailure>>;
  resolveSession(handle: string | null, correlationId: string): Promise<Result<{ userId: string; expiresAt: Date }, AppError>>;
}
```

Implement `createSilpoOAuthService(options?)` with injected `repository`, `createProvider(userId, claimedState?): Promise<SilpoOAuthProvider>`, `connect: OAuthConnectionFactory`, validated environment, clock and `randomHandle(): string`; omitted options compose production dependencies lazily. Await provider creation before calling `connect`. Export `resolveSilpoSession(handle)` as a small production delegate generating its correlation ID. No provider/transport gets browser-supplied identity.

- [ ] Write failing service tests with a connection spy. Seed sessions/flows through the repository interface, then call callback with wrong state and assert `finishAuth` and vault writes are not called. Repeat for wrong browser, expired flow, duplicated callback, denial and old-flow/new-start races. Use real crypto/repositories and fake network only.
- [ ] Run `pnpm vitest run src/features/silpo/oauth/service.test.ts` and confirm the expected red.
- [ ] Implement start and callback in the exact order of O9-04/O9-05. Use `timingSafeEqual` only after checking byte lengths. Keep the claimed flow snapshot for the provider. After SDK persistence/probe succeeds, hash a fresh random handle and call `activateSession` with the current version. Never promote on an intermediate success.
- [ ] Add injected-failure tests at each persistence/network boundary: begin/save/claim/vault/probe/activate/cleanup. Assert no success redirect/cookie after failure; close runs even when finishAuth throws; a mismatched callback cannot clear valid tokens. Verify the at-most-one claimant test results in at most one code exchange and one activated handle.
- [ ] Create both routes with dynamic/Node runtime declarations and shared service composition. Cookie/header plumbing belongs in routes; state comparison, user creation and refresh do not. Read cookies through the request; use fixed `PUBLIC_BASE_URL` for outgoing application destinations. Parse duplicate query parameters with `getAll`, not `Object.fromEntries` (which hides duplicates).

```ts
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const responseHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
// Apply to success and failure, including all redirects.
// Success uses NextResponse.redirect(result.value.location, 303).
// Set silpo_session with httpOnly/sameSite/path/secure/maxAge/expires.
// Failure uses only result.error.error and its fixed HTTP status.
```

- [ ] Add route integration tests through exported `GET` handlers. In one suite mock only service composition to test all HTTP/cookie mappings; in a second suite inject only network/storage so real service/provider/vault/SDK execute. Construct a new service/provider for the callback to prove request independence. Required successful ordering is `persist flow → save verifier/registration → redirect → claim → finishAuth → vault.put → listTools → activate → 303`.
- [ ] Test production cookie flags, pending/authenticated lifetimes, root landing, bounded input, duplicate code/state, issuer forwarding, denial, fixed error messages, no-referrer/no-store on every response, no checkout/cart tool, unknown cookie, demo mode 404 with zero DB/network work, and untrusted Host/return/userId parameters. Assert secret sentinels are absent from JSON/error bodies and console calls; the protocol-required state in the authorization URL and opaque Set-Cookie handle are narrowly allowed.
- [ ] Run the backlog's focused acceptance command and static check:

```bash
pnpm vitest run src/features/silpo/oauth/provider.test.ts tests/integration/silpo-oauth.test.ts
pnpm vitest run src/features/silpo/oauth/service.test.ts src/features/silpo/oauth/transport.test.ts
pnpm typecheck
```

## Stage 9.7 — Review, evidence and single commit

**Files:** Task 9-owned code/docs only. **Produces:** Reviewed, integrated OAuth boundary and evidence report.

- [ ] Update project architecture sections 5, 7.1, 8, 9, 10 and 13 with the approved session/flow ownership, 10-minute/7-day lifetimes, root landing, one-refresh owner, callback claim/rotation and database verification. Link detailed behavior to the spec instead of duplicating the entire spec. Keep the task ledger unchecked until actual implementation/review/integration completes.
- [ ] Run full OAuth and cumulative prerequisites:

```bash
pnpm vitest run src/features/silpo/oauth tests/integration/silpo-oauth.test.ts
pnpm vitest run tests/integration/silpo-oauth-postgres.test.ts
pnpm vitest run src/lib/env.test.ts src/db/schema.test.ts src/features/drafts/repository.test.ts src/features/cart/repository.test.ts
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm test:e2e
```

The explicit Postgres test is mandatory for completion even though ordinary `pnpm test` excludes that file. Use a disposable test DB configured by the runner, with no credentials printed. Existing E2E is regression evidence, not proof of a real Silpo authorization round trip.
- [ ] Inspect `git diff --check`, `git diff --stat`, and the full diff. Check O9-01 through O9-08 against the acceptance matrix. Verify no edits to user-owned `.gitignore`, no legacy-vault behavior change, no shared-contract changes, no raw metadata dumps, no automatic write retries, and no unrelated package churn.
- [ ] Have spec and code-quality reviews run sequentially according to `AGENTS.md`; any implementation agents use isolated worktrees. Resolve findings in this task and rerun affected tests. The controller reruns focused/cumulative gates after integration.
- [ ] Stage only explicit owned paths and generated migration artifacts; do not use `git add -A`. Commit once:

```bash
git commit -m "feat: add Silpo OAuth flow"
git rev-parse HEAD
git status --short
```

- [ ] Report commit hash, file list, package versions, command results, actual Postgres evidence, and whether a live read-only smoke was performed. Do not claim the root page already renders a live draft. Hand Tasks 10/13/15/16 the session resolver; give Task 10 the read-only connection boundary and Task 16 the no-replay write constraint.

## Coverage and planning self-review

| Spec requirements | Implementation stage |
|---|---|
| Scope gate and installed package contract | 9.1 |
| O9-01 identity/session | 9.3, 9.6 |
| O9-02 persistence/encryption/concurrency | 9.2, 9.3 |
| O9-03 provider/token mapping | 9.4 |
| O9-04 start/landing | 9.5, 9.6 |
| O9-05 callback/claim/activation | 9.3–9.6 |
| O9-06 refresh/deadlines/no write replay | 9.5 |
| O9-07 validation/redaction | 9.3–9.6 |
| O9-08 real installed SDK evidence | 9.1, 9.4–9.6 |
| Completion and downstream handoff | 9.7 |

All stages are part of one Task 9 commit, not independent feature commits. No application code, dependency installation, migration application or live OAuth request was performed while writing this plan. The separate planning commit contains only these two documents and their backlog links.
