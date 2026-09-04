# Task 8 Encrypted MCP Token Vault Specification

Status: specified for review on 2026-09-04; implementation has not started.

## 1. Scope and authority

This specification refines [Task 8](../../tasks.md#task-8-encrypted-mcp-token-vault). It defines observable behavior; the [implementation plan](../plans/2026-09-04-mcp-token-vault.md) defines execution and evidence. It does not supersede [AGENTS.md](../../../AGENTS.md), the [product specification](../../product-spec.md), or the [project architecture](../../project-architecture.md).

Task 8 owns one boundary: Silpo OAuth credentials at rest. It encrypts secret material before it reaches Postgres, decrypts it for the server-side caller, and removes it on request. It owns no network, no browser, and no policy.

Excluded and owned elsewhere: the `OAuthClientProvider` implementation, authorization redirects, PKCE verifier and `state` storage, the browser session cookie, the refresh-versus-reauthorize decision, and every MCP call (Task 9 and later). Deciding *when* a token is refreshed is Task 9's; reporting *whether* it has expired is Task 8's.

## 2. Repository evidence and dependency gates

Inspected baseline: `5c77243` (`fix: harden task 7 persistence boundaries`). The working tree carried only an unrelated `.gitignore` modification. Tasks 1–7 are integrated; Task 8 is pending; Task 9 must wait for Task 8's reviewed commit.

| Existing boundary | Consequence for this work |
|---|---|
| `mcp_connections` in `src/db/schema.ts` — `token_ciphertext`, `token_iv`, `token_auth_tag`, `expires_at`, `scope`, `oauth_metadata`, plus legacy `encrypted_tokens` | Use these columns as they stand. Task 8 adds no column, no index, and no migration. |
| `mcp_connections_user_id_envelope_unique`, a unique index on `user_id` where `token_ciphertext is not null` | At most one new-format envelope exists per user, so `get(userId)` resolves to at most one row without ordering heuristics. |
| `users.id` referenced with `on delete cascade` | The vault never creates users. Writing for an unknown user is a storage failure, not a vault state. |
| `TOKEN_ENCRYPTION_KEY` in `src/lib/env.ts`, validated as canonical base64 decoding to exactly 32 bytes | `getServerEnv()` stays the only environment reader. The vault re-checks the decoded length rather than trusting its caller. |
| `createInMemoryDraftRepository` / `createInMemoryCartCommitRepository` beside their Postgres counterparts in one file | Follow the same shape: fake and adapter live together in `token-vault.ts`, both satisfying one exported interface. |
| Task 7 repositories validate rows with Zod before returning trusted values, and `userId` is a non-empty trimmed string, not a UUID | Match both. Readable identifiers such as `"u1"` remain valid in tests. |
| No database test harness — `vitest.config.ts` declares no `globalSetup` and the project has no test container | Every Task 8 test runs against the in-memory storage fake with real cryptography. |

Fresh prerequisite evidence during planning: `pnpm vitest run src/lib/env.test.ts src/db/schema.test.ts src/features/drafts/repository.test.ts src/features/cart/repository.test.ts` is the dependency gate. This is prerequisite evidence, not proof that Task 8 is implemented.

## 3. Design decisions

| Decision | Selected approach and trade-off |
|---|---|
| Composition | An injected `TokenVaultStorage` port with an in-memory fake and a Postgres adapter; cryptography lives once, above the port. Two independent `TokenVault` implementations would let the fake re-implement encryption, so the central "no plaintext at rest" test would prove nothing about the Postgres path. |
| Envelope contents | One authenticated ciphertext over `accessToken`, `refreshToken`, and `clientSecret`. Dynamic Client Registration can return a client secret; leaving it for Task 9 invites it into the plaintext `oauth_metadata` column. |
| Plaintext columns | `expires_at`, `scope`, and non-secret `oauth_metadata` stay readable. They are not secrets, and encrypting them would block expiry queries and make operational debugging opaque for no gain. |
| Envelope binding | `userId` as AES-GCM additional authenticated data. A row copied between users then fails authentication instead of decrypting into the wrong session. |
| Legacy rows | Read, decrypt, and rewrite nothing in `encrypted_tokens`. Its format is documented nowhere in this repository; guessing it risks a silent wrong-key decrypt. A legacy-only user reads as absent and reauthorizes. |
| Expiry | `get` returns the record with a computed `isExpired`, never `null`. Withholding an expired record would also withhold the refresh token and break the one-refresh-attempt invariant. |
| Unreadable envelope | Throw a typed error rather than return `null`. A `null` would disguise key rotation or corruption as "user not connected" and loop that user through reauthorization indefinitely. |
| Failure granularity | One error code for every authentication failure. Distinguishing a bad tag from a bad key from a bad payload hands an attacker a decryption oracle and helps no legitimate caller. |

Changing any of these decisions requires updating this document in the same commit as the behavior.

## 4. Global constraints

- Use `pnpm` exclusively; add no dependency and no package or lockfile change. `node:crypto` is the only new import.
- Create exactly `src/features/silpo/oauth/token-vault.ts` and `src/features/silpo/oauth/token-vault.test.ts`. Modify no other file.
- Add no column, index, or migration. `drizzle/` is untouched.
- Secret material is AES-256-GCM at rest, with a random 12-byte IV per write, an authentication tag, and a key decoding to exactly 32 bytes.
- The module contains no logging. No error message, stack, or thrown value carries a token, a client secret, a key, an IV, a tag, or ciphertext.
- No network call, model call, cart write, or checkout path is introduced.
- Follow red-green-refactor and end in one focused commit: `feat: encrypt Silpo OAuth tokens`.

## 5. Requirements

### V8-01 — Public interface

The module exports one vault factory and its types:

```ts
export interface SilpoTokens {
  accessToken: string;
  refreshToken: string | null;
  clientSecret: string | null;
  expiresAt: Date | null;
  scope: string | null;
  oauthMetadata: Record<string, unknown> | null;
}

export interface StoredSilpoTokens extends SilpoTokens {
  isExpired: boolean;
}

export interface TokenVault {
  get(userId: string): Promise<StoredSilpoTokens | null>;
  put(userId: string, tokens: SilpoTokens): Promise<void>;
  clear(userId: string): Promise<void>;
}

export function createTokenVault(options: {
  storage: TokenVaultStorage;
  encryptionKey?: Buffer;
  now?: () => Date;
}): TokenVault;
```

`encryptionKey` defaults to the base64-decoded `TOKEN_ENCRYPTION_KEY` from `getServerEnv()`, read when the vault is constructed, not at module import. `now` defaults to `() => new Date()`. A supplied key that is not exactly 32 bytes is rejected at construction.

### V8-02 — Storage port and implementations

```ts
export interface TokenEnvelopeRow {
  tokenCiphertext: string;
  tokenIv: string;
  tokenAuthTag: string;
  expiresAt: Date | null;
  scope: string | null;
  oauthMetadata: Record<string, unknown> | null;
}

export interface TokenVaultStorage {
  read(userId: string): Promise<TokenEnvelopeRow | null>;
  write(userId: string, row: TokenEnvelopeRow): Promise<void>;
  delete(userId: string): Promise<void>;
}
```

Ciphertext, IV, and tag are base64 strings. Two implementations ship in the same file:

- `createInMemoryTokenVaultStorage(): TokenVaultStorage & { raw(userId: string): unknown }`. `raw` returns the stored row exactly as held, for at-rest assertions. It is a property of the fake, not of the port.
- `createPostgresTokenVaultStorage(db: DbClient): TokenVaultStorage`, backed by `mcp_connections`.

The fake does not model foreign keys. That gap is intentional and is why V8-04's unknown-user behavior is specified against the adapter rather than proven by a unit test.

### V8-03 — Envelope format

The plaintext is a UTF-8 JSON object built with a fixed key order:

```ts
JSON.stringify({ version: 1, accessToken, refreshToken, clientSecret })
```

`refreshToken` and `clientSecret` are serialized as `null` when absent, so the shape is constant. Encryption is `aes-256-gcm` with a fresh `randomBytes(12)` IV per write, additional authenticated data of `Buffer.from(userId, "utf8")`, and a 16-byte authentication tag. The three outputs are base64-encoded into `tokenCiphertext`, `tokenIv`, and `tokenAuthTag`.

Decryption reverses this and then parses the plaintext with a Zod schema requiring `version === 1`. A record whose `version` is present but unequal to `1` fails as an unsupported version; every other failure is an authentication failure under V8-07.

### V8-04 — Write behavior

`put(userId, tokens)`:

1. Validates its arguments per V8-08 and rejects before touching storage.
2. Encrypts the secret triple per V8-03 with a newly generated IV, even when the token values are unchanged.
3. Writes the envelope together with `expiresAt`, `scope`, and `oauthMetadata` through `TokenVaultStorage.write`.

The write is an upsert against one envelope per user. In Postgres this is `on conflict (user_id) where token_ciphertext is not null do update`, which the existing partial unique index supports. A legacy row for the same user does not conflict, is not modified, and does not block the insert; the user may then hold one legacy row and one envelope row. `get` remains unambiguous because it reads only envelope rows.

`put` never inserts into `users`. When no matching user exists, the adapter's foreign key rejects the write and the error propagates unchanged; the vault adds no fallback and creates no orphan state.

### V8-05 — Read behavior

`get(userId)`:

1. Reads through `TokenVaultStorage.read`, which selects only rows whose `token_ciphertext`, `token_iv`, and `token_auth_tag` are all present. A user with only a legacy row therefore reads as `null`.
2. Returns `null` when no envelope row exists.
3. Decrypts with `userId` as additional authenticated data and returns `accessToken`, `refreshToken`, `clientSecret`, `expiresAt`, `scope`, and `oauthMetadata`.
4. Computes `isExpired` as `expiresAt !== null && expiresAt.getTime() <= now().getTime()`. An unknown expiry (`expiresAt === null`) is not expired. An instant exactly equal to the expiry is expired.

An expired record is returned in full, including its refresh token. `get` performs no refresh, no network call, and no write.

### V8-06 — Clear behavior

`clear(userId)` removes the encrypted envelope without destroying legacy ciphertext, in one transaction. Task 8 never writes a row holding both an envelope and legacy ciphertext, so the second branch below is defensive against rows produced elsewhere:

- A row that carries an envelope and no legacy ciphertext is deleted.
- A row that carries both has `token_ciphertext`, `token_iv`, `token_auth_tag`, `expires_at`, `scope`, and `oauth_metadata` set to `NULL`, and keeps `encrypted_tokens`.

After `clear`, `get` returns `null` and a subsequent `put` succeeds by inserting a fresh envelope. `clear` is idempotent: clearing a user with no envelope, or clearing twice, succeeds and changes nothing.

### V8-07 — Errors and redaction

The module exports:

```ts
export type TokenVaultErrorCode = "envelope_unreadable" | "unsupported_envelope_version";

export class TokenVaultError extends Error {
  readonly code: TokenVaultErrorCode;
}
```

`envelope_unreadable` covers every authentication and decoding failure without distinction: a wrong key, a modified ciphertext, a modified IV, a modified tag, an envelope belonging to another user, a base64 field that does not decode, a plaintext that is not JSON, and a payload that fails its schema. Callers cannot distinguish these cases, by design.

`unsupported_envelope_version` is raised only when the payload parses and carries a `version` other than `1`.

Neither error message includes plaintext, ciphertext, key, IV, tag, or `userId`. Messages are fixed strings. The module calls no logger and no `console` method.

### V8-08 — Input validation

Validation occurs at the boundary with Zod, throwing `ZodError` exactly as the Task 7 repositories do; `TokenVaultError` is reserved for envelope failures.

- `userId` is a trimmed, non-empty string on all three methods.
- `accessToken` is a trimmed, non-empty string.
- `refreshToken` and `clientSecret` are trimmed, non-empty strings or `null`.
- `expiresAt` is a valid `Date` or `null`.
- `scope` is a trimmed, non-empty string or `null`.
- `oauthMetadata` is a plain object or `null`, and **must not contain a top-level key matching `/secret|token|password|assertion|credential/i`**. This rejects a client secret routed into the plaintext column instead of the envelope.
- Rows read back from storage are validated before decryption: the three envelope fields are non-empty base64, the IV decodes to 12 bytes, and the tag decodes to 16 bytes. A row failing these checks raises `envelope_unreadable`.

### V8-09 — Handoff to Task 9

Task 9 consumes `TokenVault` unchanged. It supplies `userId`, decides on `isExpired` and on a `401` whether to refresh once or require reauthorization, calls `put` with the refreshed credentials, and calls `clear` when reauthorization is required. Task 8 exposes no other surface, and Task 9 must not read `mcp_connections` directly.

## 6. Acceptance and verification map

| ID | Behavior proven | Test |
|---|---|---|
| V8-01, V8-05 | A stored record round-trips to the same access and refresh token | `returns the tokens it stored` |
| V8-03, V8-04 | No secret appears at rest in any stored column | `does not store access or refresh tokens as plaintext` |
| V8-03, V8-04 | The client secret is likewise absent from the row and present after read | `keeps the client secret inside the envelope` |
| V8-03 | Two writes of identical tokens produce different IV and ciphertext | `uses a fresh initialization vector for every write` |
| V8-04 | A second `put` replaces the envelope rather than adding one | `replaces the previous envelope for the same user` |
| V8-07 | A vault holding a different key cannot read the envelope | `rejects an envelope encrypted under another key` |
| V8-07 | A modified ciphertext, IV, or tag fails authentication | `rejects a tampered envelope` |
| V8-03, V8-07 | An envelope read under another `userId` fails the AAD check | `rejects an envelope transplanted to another user` |
| V8-07 | Errors carry a code and no secret material | `reports a typed error without leaking secrets` |
| V8-05 | A user with only a legacy row reads as absent | `ignores legacy ciphertext rows` |
| V8-05 | An expired record still yields its refresh token, flagged | `returns expired credentials with an expiry flag` |
| V8-05 | An absent expiry is not treated as expired | `treats an unknown expiry as unexpired` |
| V8-06 | `clear` removes the envelope and is idempotent | `clears an envelope and tolerates repeat clears` |
| V8-08 | Metadata carrying a secret-shaped key is rejected | `refuses secret-shaped keys in oauth metadata` |
| V8-08 | An empty user or access token is rejected before storage | `validates its inputs before writing` |

Verification commands and their expected results:

```bash
pnpm vitest run src/features/silpo/oauth/token-vault.test.ts   # all tests pass
pnpm typecheck                                                  # no errors
pnpm lint                                                       # no errors
pnpm vitest run src/lib/env.test.ts src/db/schema.test.ts \
  src/features/drafts/repository.test.ts \
  src/features/cart/repository.test.ts                          # dependencies stay green
```

Task 8 is done when every requirement above holds, the four commands pass from a clean invocation, the diff touches only the two Task 8 files, and no placeholder remains.
