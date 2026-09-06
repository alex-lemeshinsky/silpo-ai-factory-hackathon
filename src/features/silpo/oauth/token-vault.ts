import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { DbClient } from "@/db/client";
import { mcpConnections } from "@/db/schema";
import { getServerEnv } from "@/lib/env";
import { openBytes, sealBytes } from "./envelope";

const KEY_BYTES = 32;
const ENVELOPE_VERSION = 1;
const SECRET_SHAPED_KEY = /secret|token|password|assertion|credential/i;
const UNREADABLE_MESSAGE = "stored credentials could not be authenticated";
const UNSUPPORTED_VERSION_MESSAGE = "stored envelope uses an unsupported format version";

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

// `mcp_connections.user_id` is a uuid column, so Postgres matches ids without regard to
// case and always renders them lowercase. The additional authenticated data has to
// normalize the same way: otherwise a differently cased id finds the row and then fails
// the authentication tag, locking a user out of a perfectly good connection.
const userIdSchema = nonEmptyString.transform((value) => value.toLowerCase());
const validDate = z
  .date()
  .refine((value) => Number.isFinite(value.getTime()), "date must be valid");

const plainObject = z.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  "must be a plain object",
);

const oauthMetadataSchema = plainObject.refine(
  (value) => !Object.keys(value).some((key) => SECRET_SHAPED_KEY.test(key)),
  "oauthMetadata must not contain secret-shaped keys",
);

const silpoTokensSchema = z
  .object({
    accessToken: nonEmptyString,
    refreshToken: nonEmptyString.nullable().default(null),
    clientSecret: nonEmptyString.nullable().default(null),
    expiresAt: validDate.nullable().default(null),
    scope: nonEmptyString.nullable().default(null),
    oauthMetadata: oauthMetadataSchema.nullable().default(null),
  })
  .strict();

// The envelope columns are security critical and stay strict. The rest are advisory
// plaintext that the authentication tag does not cover, so a malformed value there is
// degraded to null rather than raised: bricking a decryptable envelope over a column
// that carries no secret would only push the user into a needless reauthorization.
const tolerated = {
  date: z
    .unknown()
    .transform((value) =>
      value instanceof Date && Number.isFinite(value.getTime()) ? value : null,
    ),
  string: z.unknown().transform((value) => (typeof value === "string" ? value : null)),
  metadata: z
    .unknown()
    .transform((value) =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null,
    ),
};

const storedRowSchema = z
  .object({
    tokenCiphertext: nonEmptyString,
    tokenIv: nonEmptyString,
    tokenAuthTag: nonEmptyString,
    expiresAt: tolerated.date,
    scope: tolerated.string,
    oauthMetadata: tolerated.metadata,
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

const envelopeVersionProbeSchema = z.object({ version: z.unknown() });

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

function encryptEnvelope(
  key: Buffer,
  userId: string,
  secrets: { accessToken: string; refreshToken: string | null; clientSecret: string | null },
): Pick<TokenEnvelopeRow, "tokenCiphertext" | "tokenIv" | "tokenAuthTag"> {
  const plaintext = Buffer.from(
    JSON.stringify({
      version: ENVELOPE_VERSION,
      accessToken: secrets.accessToken,
      refreshToken: secrets.refreshToken,
      clientSecret: secrets.clientSecret,
    }),
    "utf8",
  );
  const sealed = sealBytes(key, userId, plaintext);
  return {
    tokenCiphertext: sealed.ciphertext,
    tokenIv: sealed.iv,
    tokenAuthTag: sealed.authTag,
  };
}

function decryptEnvelope(
  key: Buffer,
  userId: string,
  row: z.infer<typeof storedRowSchema>,
): z.infer<typeof envelopePayloadSchema> {
  let plaintextBuffer: Buffer;
  try {
    plaintextBuffer = openBytes(key, userId, {
      ciphertext: row.tokenCiphertext,
      iv: row.tokenIv,
      authTag: row.tokenAuthTag,
    });
  } catch {
    throw unreadable();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintextBuffer.toString("utf8"));
  } catch {
    throw unreadable();
  }

  const probe = envelopeVersionProbeSchema.safeParse(parsed);
  if (probe.success && probe.data.version !== undefined && probe.data.version !== ENVELOPE_VERSION) {
    throw new TokenVaultError("unsupported_envelope_version", UNSUPPORTED_VERSION_MESSAGE);
  }

  const payload = envelopePayloadSchema.safeParse(parsed);
  if (!payload.success) {
    throw unreadable();
  }
  return payload.data;
}

function hasEnvelope(row: StoredEnvelopeRow): boolean {
  return row.tokenCiphertext !== null && row.tokenIv !== null && row.tokenAuthTag !== null;
}

export function createInMemoryTokenVaultStorage(): TokenVaultStorage & {
  raw(userId: string): StoredEnvelopeRow[];
  seedLegacyRow(userId: string, legacyCiphertext: string): void;
  attachLegacyCiphertext(userId: string, legacyCiphertext: string): void;
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

    raw(userId: string): StoredEnvelopeRow[] {
      return rows.filter((row) => row.userId === userId).map((row) => structuredClone(row));
    },

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

    attachLegacyCiphertext(userId: string, legacyCiphertext: string): void {
      const row = envelopeRowOf(userId);
      if (!row) {
        throw new Error("expected an envelope row to attach legacy ciphertext to");
      }
      row.legacyEncryptedTokens = legacyCiphertext;
    },
  };
}

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
      const parsedUserId = userIdSchema.parse(userId);
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
      const parsedUserId = userIdSchema.parse(userId);
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
      await storage.delete(userIdSchema.parse(userId));
    },
  };
}

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
