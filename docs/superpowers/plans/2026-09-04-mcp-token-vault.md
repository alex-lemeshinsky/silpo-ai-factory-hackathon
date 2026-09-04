# Task 8 Encrypted MCP Token Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store Silpo OAuth credentials encrypted at rest and hand them back to server-side callers, so no access token, refresh token, or client secret ever reaches Postgres in plaintext.

**Architecture:** One file exports a `TokenVault` composed over an injected `TokenVaultStorage` port. Cryptography lives once, above the port, so the in-memory fake and the Postgres adapter both exercise real AES-256-GCM. The vault is a storage boundary only: it reports expiry but never refreshes, never calls the network, and never decides policy.

**Tech Stack:** TypeScript, `node:crypto` (AES-256-GCM), Zod 4, Drizzle ORM, Vitest. No new dependency.

**Spec:** [docs/superpowers/specs/2026-09-04-mcp-token-vault-design.md](../specs/2026-09-04-mcp-token-vault-design.md)

## Global Constraints

- Use `pnpm` exclusively. Add no dependency; do not touch `package.json` or `pnpm-lock.yaml`.
- Create exactly two files: `src/features/silpo/oauth/token-vault.ts` and `src/features/silpo/oauth/token-vault.test.ts`. Modify no other file.
- Add no column, index, or migration. `src/db/schema.ts` and `drizzle/` are untouched.
- AES-256-GCM, a random 12-byte IV per write, a 16-byte authentication tag, and a key decoding to exactly 32 bytes.
- `userId` is the additional authenticated data on every encrypt and decrypt.
- The module contains no logging and no `console` call. No message, error, or thrown value carries a token, client secret, key, IV, tag, or ciphertext.
- No network call, model call, database migration, cart write, or checkout path.
- Follow red-green-refactor. One focused commit at the end: `feat: encrypt Silpo OAuth tokens`.
- Preserve the unrelated `.gitignore` modification in the working tree; never `git add -A`.

---

## File ownership and interfaces

| File | Responsibility |
|---|---|
| `src/features/silpo/oauth/token-vault.ts` | Types, Zod boundary schemas, envelope cryptography, the `TokenVault` factory, the in-memory storage fake, and the Postgres storage adapter. |
| `src/features/silpo/oauth/token-vault.test.ts` | The 18 behaviors in the spec's acceptance map, all against the fake with real cryptography. |

Both the fake and the adapter live in `token-vault.ts` because Task 8's file list in `docs/tasks.md` permits exactly these two paths, and because Task 7's repositories already colocate a fake with its Postgres counterpart.

**Produced for Task 9** — the complete surface later tasks may import:

```ts
export interface SilpoTokens {
  accessToken: string;
  refreshToken?: string | null;
  clientSecret?: string | null;
  expiresAt?: Date | null;
  scope?: string | null;
  oauthMetadata?: Record<string, unknown> | null;
}

export interface StoredSilpoTokens {
  accessToken: string;
  refreshToken: string | null;
  clientSecret: string | null;
  expiresAt: Date | null;
  scope: string | null;
  oauthMetadata: Record<string, unknown> | null;
  isExpired: boolean;
}

export interface TokenEnvelopeRow {
  tokenCiphertext: string;
  tokenIv: string;
  tokenAuthTag: string;
  expiresAt: Date | null;
  scope: string | null;
  oauthMetadata: Record<string, unknown> | null;
}

export interface StoredEnvelopeRow {
  userId: string;
  tokenCiphertext: string | null;
  tokenIv: string | null;
  tokenAuthTag: string | null;
  legacyEncryptedTokens: string | null;
  expiresAt: Date | null;
  scope: string | null;
  oauthMetadata: Record<string, unknown> | null;
}

export interface TokenVaultStorage {
  read(userId: string): Promise<TokenEnvelopeRow | null>;
  write(userId: string, row: TokenEnvelopeRow): Promise<void>;
  delete(userId: string): Promise<void>;
}

export interface TokenVault {
  get(userId: string): Promise<StoredSilpoTokens | null>;
  put(userId: string, tokens: SilpoTokens): Promise<void>;
  clear(userId: string): Promise<void>;
}

export type TokenVaultErrorCode = "envelope_unreadable" | "unsupported_envelope_version";
export class TokenVaultError extends Error { readonly code: TokenVaultErrorCode }

export function createTokenVault(options: {
  storage: TokenVaultStorage;
  encryptionKey?: Buffer;
  now?: () => Date;
}): TokenVault;

export function createPostgresTokenVaultStorage(db: DbClient): TokenVaultStorage;

export function createInMemoryTokenVaultStorage(): TokenVaultStorage & {
  raw(userId: string): StoredEnvelopeRow[];
  seedLegacyRow(userId: string, legacyCiphertext: string): void;
  attachLegacyCiphertext(userId: string, legacyCiphertext: string): void;
};
```

**Consumed from earlier tasks:**

- `DbClient` from `@/db/client` (Task 7).
- `mcpConnections` from `@/db/schema` (Task 7), with columns `userId`, `tokenCiphertext`, `tokenIv`, `tokenAuthTag`, `legacyEncryptedTokens`, `expiresAt`, `scope`, `oauthMetadata`, `updatedAt`, and the partial unique index `mcp_connections_user_id_envelope_unique` on `user_id` where `token_ciphertext is not null`.
- `getServerEnv` from `@/lib/env` (Task 2), whose `TOKEN_ENCRYPTION_KEY` is already validated as canonical base64 decoding to exactly 32 bytes.

## Execution protocol

Work through sub-tasks 8.1 to 8.6 in order. Each is one red-green cycle. Do not commit until 8.6; the backlog requires a single commit for Task 8. Never weaken a test to make an implementation pass. If a step's expected output does not appear, stop and report rather than continuing.

Test names in this plan are exact. Use them verbatim so the spec's acceptance map stays checkable.

---

### Task 8.1: Dependency gate and the first red test

**Files:**
- Test: `src/features/silpo/oauth/token-vault.test.ts` (create)

**Interfaces:**
- Consumes: nothing yet; this task only proves the module is absent.
- Produces: a failing test file that pins the round-trip and at-rest behavior.

- [ ] **Step 1: Confirm the dependency tasks are green**

Run: `pnpm vitest run src/lib/env.test.ts src/db/schema.test.ts src/features/drafts/repository.test.ts src/features/cart/repository.test.ts`
Expected: PASS. If anything fails, stop — Task 7 or Task 2 is not integrated, and Task 8 must not paper over that.

- [ ] **Step 2: Confirm the working tree holds no unrelated staged change**

Run: `git status --short`
Expected: at most an unmodified-by-you ` M .gitignore`. Leave it alone.

- [ ] **Step 3: Create the test file with the three at-rest behaviors**

Create `src/features/silpo/oauth/token-vault.test.ts`:

```ts
import { createCipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  TokenVaultError,
  createInMemoryTokenVaultStorage,
  createTokenVault,
  type TokenEnvelopeRow,
} from "./token-vault";

const KEY_A = Buffer.alloc(32, 1);
const KEY_B = Buffer.alloc(32, 2);
const EXPIRES_AT = new Date("2026-09-04T12:00:00.000Z");
const BEFORE_EXPIRY = new Date("2026-09-04T11:00:00.000Z");
const AFTER_EXPIRY = new Date("2026-09-04T13:00:00.000Z");

type Fake = ReturnType<typeof createInMemoryTokenVaultStorage>;

function setup(overrides: { key?: Buffer; now?: () => Date } = {}) {
  const storage = createInMemoryTokenVaultStorage();
  const vault = createTokenVault({
    storage,
    encryptionKey: overrides.key ?? KEY_A,
    now: overrides.now ?? (() => BEFORE_EXPIRY),
  });
  return { storage, vault };
}

function envelopeOf(storage: Fake, userId: string): TokenEnvelopeRow {
  const row = storage.raw(userId).find((candidate) => candidate.tokenCiphertext !== null);
  if (!row || row.tokenCiphertext === null || row.tokenIv === null || row.tokenAuthTag === null) {
    throw new Error("expected an envelope row");
  }
  return {
    tokenCiphertext: row.tokenCiphertext,
    tokenIv: row.tokenIv,
    tokenAuthTag: row.tokenAuthTag,
    expiresAt: row.expiresAt,
    scope: row.scope,
    oauthMetadata: row.oauthMetadata,
  };
}

describe("TokenVault", () => {
  it("returns the tokens it stored", async () => {
    const { vault } = setup();

    await vault.put("u1", {
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresAt: EXPIRES_AT,
      scope: "cart:write",
    });

    expect(await vault.get("u1")).toMatchObject({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      scope: "cart:write",
      isExpired: false,
    });
  });

  it("does not store access or refresh tokens as plaintext", async () => {
    const { storage, vault } = setup();

    await vault.put("u1", {
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresAt: EXPIRES_AT,
    });

    expect(JSON.stringify(storage.raw("u1"))).not.toContain("secret");
    expect(await vault.get("u1")).toMatchObject({ accessToken: "access-secret" });
  });

  it("keeps the client secret inside the envelope", async () => {
    const { storage, vault } = setup();

    await vault.put("u1", {
      accessToken: "access-value",
      clientSecret: "client-secret-value",
    });

    expect(JSON.stringify(storage.raw("u1"))).not.toContain("client-secret-value");
    expect(await vault.get("u1")).toMatchObject({ clientSecret: "client-secret-value" });
  });
});
```

`KEY_B`, `AFTER_EXPIRY`, `createCipheriv`, `TokenVaultError`, and `envelopeOf` go unused until 8.3 to 8.5. Declare them now anyway rather than rewriting the header three times: lint runs once, in 8.6 Step 3, by which point every one of them is used.

- [ ] **Step 4: Run the test and confirm it fails for the right reason**

Run: `pnpm vitest run src/features/silpo/oauth/token-vault.test.ts`
Expected: FAIL at import resolution — `Failed to resolve import "./token-vault"`. It must not fail on an assertion; there is nothing to assert against yet.

---

### Task 8.2: Types, storage port, fake, and the encrypting vault

**Files:**
- Create: `src/features/silpo/oauth/token-vault.ts`

**Interfaces:**
- Consumes: `getServerEnv` from `@/lib/env`.
- Produces: `SilpoTokens`, `StoredSilpoTokens`, `TokenEnvelopeRow`, `StoredEnvelopeRow`, `TokenVaultStorage`, `TokenVault`, `TokenVaultError`, `createTokenVault`, `createInMemoryTokenVaultStorage`.

- [ ] **Step 1: Write the types, schemas, and error class**

Create `src/features/silpo/oauth/token-vault.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

import { getServerEnv } from "@/lib/env";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ENVELOPE_VERSION = 1;
const UNREADABLE_MESSAGE = "stored credentials could not be authenticated";

export type TokenVaultErrorCode = "envelope_unreadable" | "unsupported_envelope_version";

export class TokenVaultError extends Error {
  readonly code: TokenVaultErrorCode;

  constructor(code: TokenVaultErrorCode, message: string) {
    super(message);
    this.name = "TokenVaultError";
    this.code = code;
  }
}

export interface SilpoTokens {
  accessToken: string;
  refreshToken?: string | null;
  clientSecret?: string | null;
  expiresAt?: Date | null;
  scope?: string | null;
  oauthMetadata?: Record<string, unknown> | null;
}

export interface StoredSilpoTokens {
  accessToken: string;
  refreshToken: string | null;
  clientSecret: string | null;
  expiresAt: Date | null;
  scope: string | null;
  oauthMetadata: Record<string, unknown> | null;
  isExpired: boolean;
}

export interface TokenEnvelopeRow {
  tokenCiphertext: string;
  tokenIv: string;
  tokenAuthTag: string;
  expiresAt: Date | null;
  scope: string | null;
  oauthMetadata: Record<string, unknown> | null;
}

export interface StoredEnvelopeRow {
  userId: string;
  tokenCiphertext: string | null;
  tokenIv: string | null;
  tokenAuthTag: string | null;
  legacyEncryptedTokens: string | null;
  expiresAt: Date | null;
  scope: string | null;
  oauthMetadata: Record<string, unknown> | null;
}

export interface TokenVaultStorage {
  read(userId: string): Promise<TokenEnvelopeRow | null>;
  write(userId: string, row: TokenEnvelopeRow): Promise<void>;
  delete(userId: string): Promise<void>;
}

export interface TokenVault {
  get(userId: string): Promise<StoredSilpoTokens | null>;
  put(userId: string, tokens: SilpoTokens): Promise<void>;
  clear(userId: string): Promise<void>;
}

const nonEmptyString = z.string().trim().min(1);
const validDate = z
  .date()
  .refine((value) => Number.isFinite(value.getTime()), "date must be valid");

const plainObject = z.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  "must be a plain object",
);

const silpoTokensSchema = z
  .object({
    accessToken: nonEmptyString,
    refreshToken: nonEmptyString.nullable().default(null),
    clientSecret: nonEmptyString.nullable().default(null),
    expiresAt: validDate.nullable().default(null),
    scope: nonEmptyString.nullable().default(null),
    oauthMetadata: plainObject.nullable().default(null),
  })
  .strict();

const storedRowSchema = z
  .object({
    tokenCiphertext: nonEmptyString,
    tokenIv: nonEmptyString,
    tokenAuthTag: nonEmptyString,
    expiresAt: validDate.nullable(),
    scope: z.string().nullable(),
    oauthMetadata: plainObject.nullable(),
  })
  .strict();

const envelopePayloadSchema = z
  .object({
    version: z.literal(ENVELOPE_VERSION),
    accessToken: nonEmptyString,
    refreshToken: nonEmptyString.nullable(),
    clientSecret: nonEmptyString.nullable(),
  })
  .strict();
```

`TokenVaultErrorCode` already names `unsupported_envelope_version`, but nothing throws it yet. That guard is 8.3's red test; the secret-shaped-key rule on `oauthMetadata` is 8.5's. Declaring the full error contract up front keeps Task 9's imports stable across sub-tasks.

- [ ] **Step 2: Add the cryptography helpers**

Append to the same file:

```ts
function resolveEncryptionKey(explicit?: Buffer): Buffer {
  const key = explicit ?? Buffer.from(getServerEnv().TOKEN_ENCRYPTION_KEY, "base64");
  if (key.byteLength !== KEY_BYTES) {
    throw new Error(`TokenVault requires an encryption key of exactly ${KEY_BYTES} bytes`);
  }
  return key;
}

function unreadable(): TokenVaultError {
  return new TokenVaultError("envelope_unreadable", UNREADABLE_MESSAGE);
}

function decodeBase64(value: string, expectedBytes?: number): Buffer {
  const decoded = Buffer.from(value, "base64");
  const canonical = decoded.toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "");
  if (decoded.byteLength === 0 || !canonical) {
    throw unreadable();
  }
  if (expectedBytes !== undefined && decoded.byteLength !== expectedBytes) {
    throw unreadable();
  }
  return decoded;
}

function encryptEnvelope(
  key: Buffer,
  userId: string,
  secrets: { accessToken: string; refreshToken: string | null; clientSecret: string | null },
): Pick<TokenEnvelopeRow, "tokenCiphertext" | "tokenIv" | "tokenAuthTag"> {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(userId, "utf8"));
  const plaintext = JSON.stringify({
    version: ENVELOPE_VERSION,
    accessToken: secrets.accessToken,
    refreshToken: secrets.refreshToken,
    clientSecret: secrets.clientSecret,
  });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    tokenCiphertext: ciphertext.toString("base64"),
    tokenIv: iv.toString("base64"),
    tokenAuthTag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptEnvelope(
  key: Buffer,
  userId: string,
  row: z.infer<typeof storedRowSchema>,
): z.infer<typeof envelopePayloadSchema> {
  const iv = decodeBase64(row.tokenIv, IV_BYTES);
  const authTag = decodeBase64(row.tokenAuthTag, AUTH_TAG_BYTES);
  const ciphertext = decodeBase64(row.tokenCiphertext);

  let plaintext: string;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(userId, "utf8"));
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw unreadable();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw unreadable();
  }

  const payload = envelopePayloadSchema.safeParse(parsed);
  if (!payload.success) {
    throw unreadable();
  }
  return payload.data;
}
```

The `catch` blocks are deliberately bare: the caught value is an OpenSSL error whose message must never escape, and every failure collapses into one code so callers get no decryption oracle.

- [ ] **Step 3: Add the in-memory storage fake**

Append to the same file:

```ts
function hasEnvelope(row: StoredEnvelopeRow): boolean {
  return row.tokenCiphertext !== null && row.tokenIv !== null && row.tokenAuthTag !== null;
}

export function createInMemoryTokenVaultStorage(): TokenVaultStorage & {
  raw(userId: string): StoredEnvelopeRow[];
} {
  const rows: StoredEnvelopeRow[] = [];

  function envelopeRowOf(userId: string): StoredEnvelopeRow | undefined {
    return rows.find((row) => row.userId === userId && hasEnvelope(row));
  }

  return {
    async read(userId: string): Promise<TokenEnvelopeRow | null> {
      const row = envelopeRowOf(userId);
      if (!row || row.tokenCiphertext === null || row.tokenIv === null || row.tokenAuthTag === null) {
        return null;
      }
      return {
        tokenCiphertext: row.tokenCiphertext,
        tokenIv: row.tokenIv,
        tokenAuthTag: row.tokenAuthTag,
        expiresAt: row.expiresAt,
        scope: row.scope,
        oauthMetadata: row.oauthMetadata === null ? null : structuredClone(row.oauthMetadata),
      };
    },

    async write(userId: string, row: TokenEnvelopeRow): Promise<void> {
      const existing = envelopeRowOf(userId);
      const next: StoredEnvelopeRow = {
        userId,
        tokenCiphertext: row.tokenCiphertext,
        tokenIv: row.tokenIv,
        tokenAuthTag: row.tokenAuthTag,
        legacyEncryptedTokens: existing?.legacyEncryptedTokens ?? null,
        expiresAt: row.expiresAt,
        scope: row.scope,
        oauthMetadata: row.oauthMetadata === null ? null : structuredClone(row.oauthMetadata),
      };
      if (existing) {
        rows[rows.indexOf(existing)] = next;
        return;
      }
      rows.push(next);
    },

    async delete(userId: string): Promise<void> {
      for (const row of [...rows]) {
        if (row.userId === userId && hasEnvelope(row)) {
          rows.splice(rows.indexOf(row), 1);
        }
      }
    },

    raw(userId: string): StoredEnvelopeRow[] {
      return rows.filter((row) => row.userId === userId).map((row) => structuredClone(row));
    },
  };
}
```

`read` already applies the three-column filter the Postgres adapter will use, so legacy rows are excluded from the start. The seeding helpers and `delete`'s legacy branch arrive in 8.4 and 8.5, driven by their own failing tests.

- [ ] **Step 4: Add the vault factory**

Append to the same file:

```ts
export function createTokenVault(options: {
  storage: TokenVaultStorage;
  encryptionKey?: Buffer;
  now?: () => Date;
}): TokenVault {
  const key = resolveEncryptionKey(options.encryptionKey);
  const now = options.now ?? ((): Date => new Date());
  const { storage } = options;

  return {
    async get(userId: string): Promise<StoredSilpoTokens | null> {
      const parsedUserId = nonEmptyString.parse(userId);
      const row = await storage.read(parsedUserId);
      if (!row) {
        return null;
      }

      const validated = storedRowSchema.safeParse(row);
      if (!validated.success) {
        throw unreadable();
      }

      const payload = decryptEnvelope(key, parsedUserId, validated.data);
      const expiresAt = validated.data.expiresAt;

      return {
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
        clientSecret: payload.clientSecret,
        expiresAt,
        scope: validated.data.scope,
        oauthMetadata: validated.data.oauthMetadata,
        isExpired: expiresAt !== null && expiresAt.getTime() <= now().getTime(),
      };
    },

    async put(userId: string, tokens: SilpoTokens): Promise<void> {
      const parsedUserId = nonEmptyString.parse(userId);
      const parsed = silpoTokensSchema.parse(tokens);
      const envelope = encryptEnvelope(key, parsedUserId, {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        clientSecret: parsed.clientSecret,
      });

      await storage.write(parsedUserId, {
        ...envelope,
        expiresAt: parsed.expiresAt,
        scope: parsed.scope,
        oauthMetadata: parsed.oauthMetadata,
      });
    },

    async clear(userId: string): Promise<void> {
      await storage.delete(nonEmptyString.parse(userId));
    },
  };
}
```

- [ ] **Step 5: Run the tests and confirm the first three pass**

Run: `pnpm vitest run src/features/silpo/oauth/token-vault.test.ts`
Expected: PASS, 3 tests. If `does not store access or refresh tokens as plaintext` fails, the envelope is leaking — do not adjust the assertion, fix the encryption.

---

### Task 8.3: Envelope integrity failures

**Files:**
- Modify: `src/features/silpo/oauth/token-vault.test.ts`

**Interfaces:**
- Consumes: `createTokenVault`, `createInMemoryTokenVaultStorage`, `TokenVaultError`, `TokenEnvelopeRow` from 8.2.
- Produces: the `unsupported_envelope_version` guard inside `decryptEnvelope`.

- [ ] **Step 1: Add the five integrity tests**

Append inside the existing `describe("TokenVault", ...)` block in `src/features/silpo/oauth/token-vault.test.ts`:

```ts
  it("uses a fresh initialization vector for every write", async () => {
    const { storage, vault } = setup();

    await vault.put("u1", { accessToken: "access-value" });
    const first = envelopeOf(storage, "u1");
    await vault.put("u1", { accessToken: "access-value" });
    const second = envelopeOf(storage, "u1");

    expect(second.tokenIv).not.toBe(first.tokenIv);
    expect(second.tokenCiphertext).not.toBe(first.tokenCiphertext);
  });

  it("rejects an envelope encrypted under another key", async () => {
    const storage = createInMemoryTokenVaultStorage();
    const writer = createTokenVault({ storage, encryptionKey: KEY_A, now: () => BEFORE_EXPIRY });
    const reader = createTokenVault({ storage, encryptionKey: KEY_B, now: () => BEFORE_EXPIRY });

    await writer.put("u1", { accessToken: "access-value" });

    await expect(reader.get("u1")).rejects.toBeInstanceOf(TokenVaultError);
  });

  it("rejects a tampered envelope", async () => {
    const { storage, vault } = setup();
    await vault.put("u1", { accessToken: "access-value" });

    await storage.write("u1", {
      ...envelopeOf(storage, "u1"),
      tokenAuthTag: Buffer.alloc(16, 9).toString("base64"),
    });

    await expect(vault.get("u1")).rejects.toBeInstanceOf(TokenVaultError);
  });

  it("rejects an envelope transplanted to another user", async () => {
    const { storage, vault } = setup();
    await vault.put("u1", { accessToken: "access-value" });

    await storage.write("u2", envelopeOf(storage, "u1"));

    await expect(vault.get("u2")).rejects.toBeInstanceOf(TokenVaultError);
  });

  it("reports a typed error without leaking secrets", async () => {
    const storage = createInMemoryTokenVaultStorage();
    const writer = createTokenVault({ storage, encryptionKey: KEY_A, now: () => BEFORE_EXPIRY });
    const reader = createTokenVault({ storage, encryptionKey: KEY_B, now: () => BEFORE_EXPIRY });
    await writer.put("u1", { accessToken: "access-secret" });

    const caught: unknown = await reader.get("u1").catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(TokenVaultError);
    expect((caught as TokenVaultError).code).toBe("envelope_unreadable");
    expect((caught as TokenVaultError).message).not.toContain("secret");
  });

  it("rejects an envelope written in an unsupported format version", async () => {
    const { storage, vault } = setup();
    const iv = Buffer.alloc(12, 3);
    const cipher = createCipheriv("aes-256-gcm", KEY_A, iv);
    cipher.setAAD(Buffer.from("u1", "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(
        JSON.stringify({
          version: 2,
          accessToken: "access-value",
          refreshToken: null,
          clientSecret: null,
        }),
        "utf8",
      ),
      cipher.final(),
    ]);

    await storage.write("u1", {
      tokenCiphertext: ciphertext.toString("base64"),
      tokenIv: iv.toString("base64"),
      tokenAuthTag: cipher.getAuthTag().toString("base64"),
      expiresAt: null,
      scope: null,
      oauthMetadata: null,
    });

    const caught: unknown = await vault.get("u1").catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(TokenVaultError);
    expect((caught as TokenVaultError).code).toBe("unsupported_envelope_version");
  });
```

- [ ] **Step 2: Run the tests and confirm exactly one fails**

Run: `pnpm vitest run src/features/silpo/oauth/token-vault.test.ts`
Expected: 8 pass, 1 fails — `rejects an envelope written in an unsupported format version`, because a version-2 payload currently fails `envelopePayloadSchema` and collapses into `envelope_unreadable`. The reported failure is `expected 'envelope_unreadable' to be 'unsupported_envelope_version'`.

The other five are regression locks over paths 8.2 already built. If any of them fails, the envelope is wrong, not the test: `rejects an envelope transplanted to another user` failing means `setAAD` is missing from the encrypt or the decrypt side.

- [ ] **Step 3: Add the version probe**

In `src/features/silpo/oauth/token-vault.ts`, add the message constant and probe schema beside their neighbours:

```ts
const UNSUPPORTED_VERSION_MESSAGE = "stored envelope uses an unsupported format version";

const envelopeVersionProbeSchema = z.object({ version: z.unknown() });
```

Then, inside `decryptEnvelope`, insert the probe between the `JSON.parse` block and the payload parse:

```ts
  const probe = envelopeVersionProbeSchema.safeParse(parsed);
  if (probe.success && probe.data.version !== undefined && probe.data.version !== ENVELOPE_VERSION) {
    throw new TokenVaultError("unsupported_envelope_version", UNSUPPORTED_VERSION_MESSAGE);
  }
```

The `!== undefined` guard matters: an envelope with no `version` at all is malformed, not a future format, and must stay `envelope_unreadable`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/features/silpo/oauth/token-vault.test.ts`
Expected: PASS, 9 tests.

---

### Task 8.4: Read semantics — replacement, legacy, and expiry

**Files:**
- Modify: `src/features/silpo/oauth/token-vault.test.ts`

**Interfaces:**
- Consumes: `raw` from the fake in 8.2.
- Produces: `seedLegacyRow` on the in-memory fake.

- [ ] **Step 1: Add the four read tests**

Append inside the same `describe` block:

```ts
  it("replaces the previous envelope for the same user", async () => {
    const { storage, vault } = setup();

    await vault.put("u1", { accessToken: "first-value" });
    await vault.put("u1", { accessToken: "second-value" });

    expect(storage.raw("u1")).toHaveLength(1);
    expect(await vault.get("u1")).toMatchObject({ accessToken: "second-value" });
  });

  it("ignores legacy ciphertext rows", async () => {
    const { storage, vault } = setup();

    storage.seedLegacyRow("u1", "legacy-blob");

    expect(await vault.get("u1")).toBeNull();
    expect(storage.raw("u1")).toHaveLength(1);
  });

  it("returns expired credentials with an expiry flag", async () => {
    const { vault } = setup({ now: () => AFTER_EXPIRY });

    await vault.put("u1", {
      accessToken: "access-value",
      refreshToken: "refresh-value",
      expiresAt: EXPIRES_AT,
    });

    expect(await vault.get("u1")).toMatchObject({
      isExpired: true,
      refreshToken: "refresh-value",
    });
  });

  it("treats an unknown expiry as unexpired", async () => {
    const { vault } = setup({ now: () => AFTER_EXPIRY });

    await vault.put("u1", { accessToken: "access-value" });

    expect(await vault.get("u1")).toMatchObject({ expiresAt: null, isExpired: false });
  });
```

- [ ] **Step 2: Run the tests and confirm one fails**

Run: `pnpm vitest run src/features/silpo/oauth/token-vault.test.ts`
Expected: 12 pass, 1 fails — `ignores legacy ciphertext rows`, with `storage.seedLegacyRow is not a function`. The fake cannot yet represent a legacy row, so the behavior is untestable rather than wrong.

- [ ] **Step 3: Let the fake hold legacy rows**

In `createInMemoryTokenVaultStorage`, widen the return type and add the seeding method:

```ts
export function createInMemoryTokenVaultStorage(): TokenVaultStorage & {
  raw(userId: string): StoredEnvelopeRow[];
  seedLegacyRow(userId: string, legacyCiphertext: string): void;
} {
```

```ts
    seedLegacyRow(userId: string, legacyCiphertext: string): void {
      rows.push({
        userId,
        tokenCiphertext: null,
        tokenIv: null,
        tokenAuthTag: null,
        legacyEncryptedTokens: legacyCiphertext,
        expiresAt: null,
        scope: null,
        oauthMetadata: null,
      });
    },
```

Add nothing to `read`. Its three-column filter, written in 8.2, is what makes the legacy row invisible; if the test now passes without touching `read`, that filter is correct and the Postgres adapter in 8.6 can mirror it.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/features/silpo/oauth/token-vault.test.ts`
Expected: PASS, 13 tests.

---

### Task 8.5: Clear behavior and input validation

**Files:**
- Modify: `src/features/silpo/oauth/token-vault.test.ts`

**Interfaces:**
- Consumes: `seedLegacyRow` from the fake in 8.4.
- Produces: `attachLegacyCiphertext` on the in-memory fake, the secret-shaped-key screen, and `delete`'s legacy branch.

- [ ] **Step 1: Add the five remaining tests**

Append inside the same `describe` block:

```ts
  it("clears an envelope and tolerates repeat clears", async () => {
    const { storage, vault } = setup();
    await vault.put("u1", { accessToken: "access-value" });

    await vault.clear("u1");

    expect(await vault.get("u1")).toBeNull();
    expect(storage.raw("u1")).toHaveLength(0);
    await expect(vault.clear("u1")).resolves.toBeUndefined();

    await vault.put("u1", { accessToken: "second-value" });
    expect(await vault.get("u1")).toMatchObject({ accessToken: "second-value" });
  });

  it("keeps legacy ciphertext when clearing", async () => {
    const { storage, vault } = setup();
    storage.seedLegacyRow("u1", "legacy-blob");
    await vault.put("u1", { accessToken: "access-value" });

    await vault.clear("u1");

    expect(await vault.get("u1")).toBeNull();
    expect(storage.raw("u1")).toEqual([
      expect.objectContaining({ legacyEncryptedTokens: "legacy-blob", tokenCiphertext: null }),
    ]);
  });

  it("keeps legacy ciphertext on a row that also holds an envelope", async () => {
    const { storage, vault } = setup();
    await vault.put("u1", { accessToken: "access-value" });
    storage.attachLegacyCiphertext("u1", "legacy-blob");

    await vault.clear("u1");

    expect(await vault.get("u1")).toBeNull();
    expect(storage.raw("u1")).toEqual([
      expect.objectContaining({
        legacyEncryptedTokens: "legacy-blob",
        tokenCiphertext: null,
        tokenIv: null,
        tokenAuthTag: null,
      }),
    ]);
  });

  it("refuses secret-shaped keys in oauth metadata", async () => {
    const { vault } = setup();

    await expect(
      vault.put("u1", {
        accessToken: "access-value",
        oauthMetadata: { clientId: "abc", client_secret: "leak" },
      }),
    ).rejects.toThrow();

    await expect(
      vault.put("u1", {
        accessToken: "access-value",
        oauthMetadata: { clientId: "abc", issuer: "https://auth.silpo.ua" },
      }),
    ).resolves.toBeUndefined();
  });

  it("validates its inputs before writing", async () => {
    const { storage, vault } = setup();

    await expect(vault.put("", { accessToken: "access-value" })).rejects.toThrow();
    await expect(vault.put("u1", { accessToken: "   " })).rejects.toThrow();
    await expect(vault.get("")).rejects.toThrow();

    expect(storage.raw("u1")).toHaveLength(0);
  });
```

- [ ] **Step 2: Run the tests and confirm two fail**

Run: `pnpm vitest run src/features/silpo/oauth/token-vault.test.ts`
Expected: 16 pass, 2 fail:

- `keeps legacy ciphertext on a row that also holds an envelope` — `storage.attachLegacyCiphertext is not a function`.
- `refuses secret-shaped keys in oauth metadata` — the first `put` resolves instead of rejecting, because nothing screens metadata keys yet.

`keeps legacy ciphertext when clearing` passes already, and that is the point of it: a legacy row and an envelope row are separate rows, so 8.2's `delete` never touches the legacy one. Treat a failure there as a defect in `delete`'s `hasEnvelope` filter, not as a missing feature.

- [ ] **Step 3: Add the metadata screen, the legacy-aware delete, and the attach helper**

In `src/features/silpo/oauth/token-vault.ts`, add the pattern beside the other constants:

```ts
const SECRET_SHAPED_KEY = /secret|token|password|assertion|credential/i;
```

Add the refined schema after `plainObject`, and point `silpoTokensSchema` at it:

```ts
const oauthMetadataSchema = plainObject.refine(
  (value) => !Object.keys(value).some((key) => SECRET_SHAPED_KEY.test(key)),
  "oauthMetadata must not contain secret-shaped keys",
);
```

```ts
    oauthMetadata: oauthMetadataSchema.nullable().default(null),
```

Leave `storedRowSchema` reading plain `plainObject.nullable()`. The screen guards what this vault writes; rejecting a row already in the database would lock a user out of their own connection over a naming choice.

Then widen the fake once more, replace its `delete`, and add the attach helper:

```ts
export function createInMemoryTokenVaultStorage(): TokenVaultStorage & {
  raw(userId: string): StoredEnvelopeRow[];
  seedLegacyRow(userId: string, legacyCiphertext: string): void;
  attachLegacyCiphertext(userId: string, legacyCiphertext: string): void;
} {
```

```ts
    async delete(userId: string): Promise<void> {
      for (const row of [...rows]) {
        if (row.userId !== userId || !hasEnvelope(row)) {
          continue;
        }
        if (row.legacyEncryptedTokens === null) {
          rows.splice(rows.indexOf(row), 1);
          continue;
        }
        row.tokenCiphertext = null;
        row.tokenIv = null;
        row.tokenAuthTag = null;
        row.expiresAt = null;
        row.scope = null;
        row.oauthMetadata = null;
      }
    },
```

```ts
    attachLegacyCiphertext(userId: string, legacyCiphertext: string): void {
      const row = envelopeRowOf(userId);
      if (!row) {
        throw new Error("expected an envelope row to attach legacy ciphertext to");
      }
      row.legacyEncryptedTokens = legacyCiphertext;
    },
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/features/silpo/oauth/token-vault.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Confirm the module holds no logging**

Run: `grep -n "console\.\|logger" src/features/silpo/oauth/token-vault.ts`
Expected: no output (exit status 1). Any match violates a global constraint.

---

### Task 8.6: Postgres adapter, full verification, and commit

**Files:**
- Modify: `src/features/silpo/oauth/token-vault.ts`

**Interfaces:**
- Consumes: `DbClient` from `@/db/client`, `mcpConnections` from `@/db/schema`.
- Produces: `createPostgresTokenVaultStorage(db: DbClient): TokenVaultStorage`.

- [ ] **Step 1: Extend the imports**

At the top of `src/features/silpo/oauth/token-vault.ts`, add:

```ts
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

import type { DbClient } from "@/db/client";
import { mcpConnections } from "@/db/schema";
```

- [ ] **Step 2: Add the adapter**

Append to the same file:

```ts
export function createPostgresTokenVaultStorage(db: DbClient): TokenVaultStorage {
  return {
    async read(userId: string): Promise<TokenEnvelopeRow | null> {
      const [row] = await db
        .select({
          tokenCiphertext: mcpConnections.tokenCiphertext,
          tokenIv: mcpConnections.tokenIv,
          tokenAuthTag: mcpConnections.tokenAuthTag,
          expiresAt: mcpConnections.expiresAt,
          scope: mcpConnections.scope,
          oauthMetadata: mcpConnections.oauthMetadata,
        })
        .from(mcpConnections)
        .where(
          and(
            eq(mcpConnections.userId, userId),
            isNotNull(mcpConnections.tokenCiphertext),
            isNotNull(mcpConnections.tokenIv),
            isNotNull(mcpConnections.tokenAuthTag),
          ),
        )
        .limit(1);

      if (
        !row ||
        row.tokenCiphertext === null ||
        row.tokenIv === null ||
        row.tokenAuthTag === null
      ) {
        return null;
      }

      return {
        tokenCiphertext: row.tokenCiphertext,
        tokenIv: row.tokenIv,
        tokenAuthTag: row.tokenAuthTag,
        expiresAt: row.expiresAt,
        scope: row.scope,
        oauthMetadata: row.oauthMetadata ?? null,
      };
    },

    async write(userId: string, row: TokenEnvelopeRow): Promise<void> {
      const values = {
        tokenCiphertext: row.tokenCiphertext,
        tokenIv: row.tokenIv,
        tokenAuthTag: row.tokenAuthTag,
        expiresAt: row.expiresAt,
        scope: row.scope,
        oauthMetadata: row.oauthMetadata,
        updatedAt: new Date(),
      };

      await db
        .insert(mcpConnections)
        .values({ userId, ...values })
        .onConflictDoUpdate({
          target: mcpConnections.userId,
          targetWhere: sql`${mcpConnections.tokenCiphertext} is not null`,
          set: values,
        });
    },

    async delete(userId: string): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .update(mcpConnections)
          .set({
            tokenCiphertext: null,
            tokenIv: null,
            tokenAuthTag: null,
            expiresAt: null,
            scope: null,
            oauthMetadata: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(mcpConnections.userId, userId),
              isNotNull(mcpConnections.tokenCiphertext),
              isNotNull(mcpConnections.legacyEncryptedTokens),
            ),
          );

        await tx
          .delete(mcpConnections)
          .where(
            and(
              eq(mcpConnections.userId, userId),
              isNotNull(mcpConnections.tokenCiphertext),
              isNull(mcpConnections.legacyEncryptedTokens),
            ),
          );
      });
    },
  };
}
```

`targetWhere` renders `on conflict ("user_id") where "token_ciphertext" is not null`, which matches the partial unique index Task 7 created. Without it Postgres cannot infer that index and the insert fails at runtime.

- [ ] **Step 3: Run the focused tests, typecheck, and lint**

Run: `pnpm vitest run src/features/silpo/oauth/token-vault.test.ts && pnpm typecheck && pnpm lint`
Expected: 18 tests pass, no type errors, no lint errors.

- [ ] **Step 4: Run the dependency suites to prove nothing regressed**

Run: `pnpm vitest run src/lib/env.test.ts src/db/schema.test.ts src/features/drafts/repository.test.ts src/features/cart/repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Review the diff against the spec**

Run: `git status --short && git diff --stat`
Expected: exactly two new untracked files under `src/features/silpo/oauth/`, plus the pre-existing ` M .gitignore` you did not touch. Any other modified file is a scope violation — revert it.

Read the diff and confirm by eye, because no unit test covers the adapter: `read` filters on all three envelope columns; `write` carries `targetWhere`; `delete` nulls the combined row and deletes the envelope-only row, and never touches `encrypted_tokens`.

- [ ] **Step 6: Commit**

```bash
git add src/features/silpo/oauth/token-vault.ts src/features/silpo/oauth/token-vault.test.ts
git commit -m "feat: encrypt Silpo OAuth tokens"
```

- [ ] **Step 7: Report the handoff**

Report the changed files, the exact commands run with their results, the commit hash, and the two standing risks: the Postgres adapter has no runtime test until Task 9's integration test, and `put` for an unknown `userId` fails on the foreign key rather than through a typed vault error.

---

## Requirement-to-step traceability

| Spec requirement | Implemented in | Proven by |
|---|---|---|
| V8-01 Public interface | 8.2 Steps 1, 4 | `returns the tokens it stored`; `pnpm typecheck` |
| V8-02 Storage port and implementations | 8.2 Step 3, 8.4 Step 3, 8.5 Step 3, 8.6 Step 2 | `ignores legacy ciphertext rows`; 8.6 Step 5 diff review |
| V8-03 Envelope format | 8.2 Step 2, 8.3 Step 3 | `does not store access or refresh tokens as plaintext`; `keeps the client secret inside the envelope`; `uses a fresh initialization vector for every write`; `rejects an envelope written in an unsupported format version` |
| V8-04 Write behavior | 8.2 Step 4, 8.6 Step 2 | `replaces the previous envelope for the same user`; 8.6 Step 5 diff review |
| V8-05 Read behavior | 8.2 Step 4 | `ignores legacy ciphertext rows`; `returns expired credentials with an expiry flag`; `treats an unknown expiry as unexpired` |
| V8-06 Clear behavior | 8.2 Step 3, 8.5 Step 3, 8.6 Step 2 | `clears an envelope and tolerates repeat clears`; `keeps legacy ciphertext when clearing`; `keeps legacy ciphertext on a row that also holds an envelope` |
| V8-07 Errors and redaction | 8.2 Step 2, 8.3 Step 3 | `rejects an envelope encrypted under another key`; `rejects a tampered envelope`; `rejects an envelope transplanted to another user`; `reports a typed error without leaking secrets`; 8.5 Step 5 grep |
| V8-08 Input validation | 8.2 Steps 1, 4, 8.5 Step 3 | `refuses secret-shaped keys in oauth metadata`; `validates its inputs before writing` |
| V8-09 Handoff to Task 9 | 8.6 Step 7 | File ownership table above; no other module imports `mcpConnections` for tokens |

## Known risks

- **The Postgres adapter has no runtime test.** This repository has no database test harness, and building one is outside Task 8's file list. Mitigation: `pnpm typecheck`, the by-eye review in 8.6 Step 5, and Task 9's integration test, which is the first code to exercise it against a real database.
- **`put` for an unknown `userId` surfaces a foreign key error, not a typed vault error.** The in-memory fake does not model foreign keys, so no unit test covers it. This is specified behavior (V8-04), not a defect, but Task 9 must be ready for it.

## Planning handoff

Task 8 is complete when all 18 tests pass from a clean invocation, `pnpm typecheck` and `pnpm lint` are clean, the diff contains only the two Task 8 files, and the commit exists. Task 9 then consumes `TokenVault` unchanged and must not read `mcp_connections` directly.
