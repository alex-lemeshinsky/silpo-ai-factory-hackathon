import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { DbClient } from "@/db/client";
import { mcpConnections } from "@/db/schema";
import { getServerEnv } from "@/lib/env";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
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
