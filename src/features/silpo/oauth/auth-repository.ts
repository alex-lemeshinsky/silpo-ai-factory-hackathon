import { randomUUID } from "node:crypto";
import { and, eq, gt, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { DbClient } from "@/db/client";
import { authSessions, silpoOAuthStates, users } from "@/db/schema";
import { openBytes, sealBytes, type SealedBytes } from "./envelope";

// --- Types and Interfaces ---

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
  createPendingSession(input: {
    handleHash: string;
    now: Date;
    expiresAt: Date;
    userId?: string;
  }): Promise<AuthSession>;
  findSession(handleHash: string, now: Date): Promise<AuthSession | null>;
  readState(userId: string): Promise<OAuthState | null>;
  beginFlow(input: {
    userId: string;
    bindingHash: string;
    flowId: string;
    state: string;
    now: Date;
    expiresAt: Date;
  }): Promise<OAuthState>;
  saveState(input: {
    userId: string;
    expectedVersion: number;
    payload: OAuthPayload;
  }): Promise<OAuthState>;
  claimFlow(input: {
    userId: string;
    bindingHash: string;
    expectedVersion: number;
    now: Date;
  }): Promise<OAuthState | null>;
  finishFlow(input: { userId: string; expectedVersion: number }): Promise<boolean>;
  activateSession(input: {
    oldHandleHash: string;
    newHandleHash: string;
    userId: string;
    expectedFlowVersion: number;
    now: Date;
    expiresAt: Date;
  }): Promise<AuthSession>;
}

export interface InMemoryAuthRepository extends AuthRepository {
  rawState(userId: string): SealedBytes | null;
  rawSession(handleHash: string): AuthSession | null;
}

// --- Validation Schemas ---

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hashRegex = /^[0-9a-f]{64}$/i;

export const userIdSchema = z
  .string()
  .trim()
  .regex(uuidRegex, "must be a valid UUID")
  .transform((val) => val.toLowerCase());

export const hashSchema = z
  .string()
  .trim()
  .regex(hashRegex, "must be a 64-character hex hash")
  .transform((val) => val.toLowerCase());

export const clientRegistrationSchema = z
  .object({
    clientId: z.string().min(1),
    clientSecret: z.string().nullable().default(null),
    clientIdIssuedAt: z.number().int().nullable().default(null),
    clientSecretExpiresAt: z.number().int().nullable().default(null),
    tokenEndpointAuthMethod: z.enum([
      "none",
      "client_secret_post",
      "client_secret_basic",
    ]),
    issuer: z.string().min(1),
  })
  .strict();

export const discoveryBindingSchema = z
  .object({
    issuer: z.string().min(1),
    authorizationEndpoint: z.string().min(1),
    tokenEndpoint: z.string().min(1),
    registrationEndpoint: z.string().nullable().default(null),
    resource: z.string().min(1),
    resourceMetadataUrl: z.string().nullable().default(null),
    scopesSupported: z.array(z.string()),
    codeChallengeMethodsSupported: z.array(z.string()),
    tokenEndpointAuthMethodsSupported: z.array(z.string()),
    responseIssuerRequired: z.boolean(),
  })
  .strict();

export const oauthPayloadSchema = z
  .object({
    version: z.literal(1),
    flowId: z.string().nullable().default(null),
    state: z.string().nullable().default(null),
    verifier: z.string().nullable().default(null),
    registration: clientRegistrationSchema.nullable().default(null),
    discovery: discoveryBindingSchema.nullable().default(null),
  })
  .strict();

export const authSessionSchema = z
  .object({
    id: z.string().regex(uuidRegex),
    userId: userIdSchema,
    handleHash: hashSchema,
    status: z.enum(["pending", "authenticated", "revoked"]),
    expiresAt: z.date(),
  })
  .strict();

function getOAuthStateAAD(userId: string): string {
  return `silpo-oauth-state:v1:${userId.toLowerCase()}`;
}

function sealPayload(key: Buffer, userId: string, payload: OAuthPayload): SealedBytes {
  const validated = oauthPayloadSchema.parse(payload);
  const plaintext = Buffer.from(JSON.stringify(validated), "utf8");
  return sealBytes(key, getOAuthStateAAD(userId), plaintext);
}

function openPayload(key: Buffer, userId: string, sealed: SealedBytes): OAuthPayload {
  const plaintext = openBytes(key, getOAuthStateAAD(userId), sealed);
  const parsed = JSON.parse(plaintext.toString("utf8"));
  return oauthPayloadSchema.parse(parsed);
}

// --- In-Memory Implementation ---

interface InMemoryStoredState {
  version: number;
  phase: "idle" | "pending" | "processing";
  bindingHash: string | null;
  flowExpiresAt: Date | null;
  sealed: SealedBytes;
  updatedAt: Date;
}

export function createInMemoryAuthRepository(options: {
  encryptionKey: Buffer;
}): InMemoryAuthRepository {
  const { encryptionKey } = options;
  if (!Buffer.isBuffer(encryptionKey) || encryptionKey.byteLength !== 32) {
    throw new Error("invalid_key_length");
  }

  const sessions = new Map<string, AuthSession>(); // handleHash -> AuthSession
  const userSessions = new Map<string, Set<string>>(); // userId -> Set<handleHash>
  const states = new Map<string, InMemoryStoredState>(); // userId -> InMemoryStoredState

  return {
    async createPendingSession(input: {
      handleHash: string;
      now: Date;
      expiresAt: Date;
      userId?: string;
    }): Promise<AuthSession> {
      const handleHash = hashSchema.parse(input.handleHash);
      const userId = input.userId !== undefined ? userIdSchema.parse(input.userId) : randomUUID();
      const id = randomUUID();

      // Opportunistically prune expired sessions for user
      const userSet = userSessions.get(userId) ?? new Set();
      for (const h of userSet) {
        const s = sessions.get(h);
        if (s && (s.status === "revoked" || s.expiresAt.getTime() <= input.now.getTime())) {
          sessions.delete(h);
          userSet.delete(h);
        }
      }

      const session: AuthSession = {
        id,
        userId,
        handleHash,
        status: "pending",
        expiresAt: input.expiresAt,
      };

      sessions.set(handleHash, session);
      userSet.add(handleHash);
      userSessions.set(userId, userSet);

      return structuredClone(session);
    },

    async findSession(handleHash: string, now: Date): Promise<AuthSession | null> {
      let parsedHash: string;
      try {
        parsedHash = hashSchema.parse(handleHash);
      } catch {
        return null;
      }

      const session = sessions.get(parsedHash);
      if (!session) return null;
      if (session.status === "revoked") return null;
      if (session.expiresAt.getTime() <= now.getTime()) return null;

      return structuredClone(session);
    },

    async readState(userId: string): Promise<OAuthState | null> {
      const normUserId = userIdSchema.parse(userId);
      const stored = states.get(normUserId);
      if (!stored) return null;

      const payload = openPayload(encryptionKey, normUserId, stored.sealed);
      return {
        userId: normUserId,
        version: stored.version,
        phase: stored.phase,
        bindingHash: stored.bindingHash,
        flowExpiresAt: stored.flowExpiresAt ? new Date(stored.flowExpiresAt) : null,
        payload,
      };
    },

    async beginFlow(input: {
      userId: string;
      bindingHash: string;
      flowId: string;
      state: string;
      now: Date;
      expiresAt: Date;
    }): Promise<OAuthState> {
      const normUserId = userIdSchema.parse(input.userId);
      const normBinding = hashSchema.parse(input.bindingHash);

      const existing = states.get(normUserId);
      let registration: ClientRegistration | null = null;
      let discovery: DiscoveryBinding | null = null;
      let nextVersion = 1;

      if (existing) {
        if (
          existing.phase === "processing" &&
          existing.flowExpiresAt &&
          existing.flowExpiresAt.getTime() > input.now.getTime()
        ) {
          throw new Error("flow_processing");
        }
        try {
          const prevPayload = openPayload(encryptionKey, normUserId, existing.sealed);
          registration = prevPayload.registration;
          discovery = prevPayload.discovery;
        } catch {
          // ignore corrupted payload on replacement
        }
        nextVersion = existing.version + 1;
      }

      const newPayload: OAuthPayload = {
        version: 1,
        flowId: input.flowId,
        state: input.state,
        verifier: null,
        registration,
        discovery,
      };

      const sealed = sealPayload(encryptionKey, normUserId, newPayload);
      const stored: InMemoryStoredState = {
        version: nextVersion,
        phase: "pending",
        bindingHash: normBinding,
        flowExpiresAt: new Date(input.expiresAt),
        sealed,
        updatedAt: new Date(input.now),
      };

      states.set(normUserId, stored);

      return {
        userId: normUserId,
        version: stored.version,
        phase: stored.phase,
        bindingHash: stored.bindingHash,
        flowExpiresAt: stored.flowExpiresAt,
        payload: newPayload,
      };
    },

    async saveState(input: {
      userId: string;
      expectedVersion: number;
      payload: OAuthPayload;
    }): Promise<OAuthState> {
      const normUserId = userIdSchema.parse(input.userId);
      const stored = states.get(normUserId);
      if (!stored || stored.version !== input.expectedVersion) {
        throw new Error("version_mismatch");
      }

      const sealed = sealPayload(encryptionKey, normUserId, input.payload);
      stored.version += 1;
      stored.sealed = sealed;
      stored.updatedAt = new Date();

      return {
        userId: normUserId,
        version: stored.version,
        phase: stored.phase,
        bindingHash: stored.bindingHash,
        flowExpiresAt: stored.flowExpiresAt ? new Date(stored.flowExpiresAt) : null,
        payload: oauthPayloadSchema.parse(input.payload),
      };
    },

    async claimFlow(input: {
      userId: string;
      bindingHash: string;
      expectedVersion: number;
      now: Date;
    }): Promise<OAuthState | null> {
      const normUserId = userIdSchema.parse(input.userId);
      const normBinding = hashSchema.parse(input.bindingHash);

      const stored = states.get(normUserId);
      if (!stored) return null;

      if (
        stored.version !== input.expectedVersion ||
        stored.bindingHash !== normBinding ||
        stored.phase !== "pending" ||
        !stored.flowExpiresAt ||
        stored.flowExpiresAt.getTime() <= input.now.getTime()
      ) {
        return null;
      }

      stored.phase = "processing";
      stored.version += 1;
      stored.updatedAt = new Date(input.now);

      const payload = openPayload(encryptionKey, normUserId, stored.sealed);
      return {
        userId: normUserId,
        version: stored.version,
        phase: stored.phase,
        bindingHash: stored.bindingHash,
        flowExpiresAt: stored.flowExpiresAt,
        payload,
      };
    },

    async finishFlow(input: { userId: string; expectedVersion: number }): Promise<boolean> {
      const normUserId = userIdSchema.parse(input.userId);
      const stored = states.get(normUserId);
      if (!stored || stored.version !== input.expectedVersion) {
        return false;
      }

      let registration: ClientRegistration | null = null;
      let discovery: DiscoveryBinding | null = null;
      try {
        const prev = openPayload(encryptionKey, normUserId, stored.sealed);
        registration = prev.registration;
        discovery = prev.discovery;
      } catch {
        // preserve nulls
      }

      const cleanPayload: OAuthPayload = {
        version: 1,
        flowId: null,
        state: null,
        verifier: null,
        registration,
        discovery,
      };

      stored.phase = "idle";
      stored.bindingHash = null;
      stored.flowExpiresAt = null;
      stored.version += 1;
      stored.sealed = sealPayload(encryptionKey, normUserId, cleanPayload);
      stored.updatedAt = new Date();

      return true;
    },

    async activateSession(input: {
      oldHandleHash: string;
      newHandleHash: string;
      userId: string;
      expectedFlowVersion: number;
      now: Date;
      expiresAt: Date;
    }): Promise<AuthSession> {
      const normUserId = userIdSchema.parse(input.userId);
      const normOldHash = hashSchema.parse(input.oldHandleHash);
      const normNewHash = hashSchema.parse(input.newHandleHash);

      const storedState = states.get(normUserId);
      if (
        !storedState ||
        storedState.phase !== "processing" ||
        storedState.version !== input.expectedFlowVersion ||
        storedState.bindingHash !== normOldHash ||
        !storedState.flowExpiresAt ||
        storedState.flowExpiresAt.getTime() <= input.now.getTime()
      ) {
        throw new Error("activation_conflict");
      }

      const oldSession = sessions.get(normOldHash);
      if (!oldSession || oldSession.userId !== normUserId) {
        throw new Error("activation_conflict");
      }

      // Revoke old session
      oldSession.status = "revoked";

      // Create new authenticated session
      const newSession: AuthSession = {
        id: randomUUID(),
        userId: normUserId,
        handleHash: normNewHash,
        status: "authenticated",
        expiresAt: new Date(input.expiresAt),
      };
      sessions.set(normNewHash, newSession);
      const userSet = userSessions.get(normUserId) ?? new Set();
      userSet.add(normNewHash);
      userSessions.set(normUserId, userSet);

      // Clean state
      let registration: ClientRegistration | null = null;
      let discovery: DiscoveryBinding | null = null;
      try {
        const prev = openPayload(encryptionKey, normUserId, storedState.sealed);
        registration = prev.registration;
        discovery = prev.discovery;
      } catch {
        // preserve nulls
      }

      const cleanPayload: OAuthPayload = {
        version: 1,
        flowId: null,
        state: null,
        verifier: null,
        registration,
        discovery,
      };

      storedState.phase = "idle";
      storedState.bindingHash = null;
      storedState.flowExpiresAt = null;
      storedState.version += 1;
      storedState.sealed = sealPayload(encryptionKey, normUserId, cleanPayload);
      storedState.updatedAt = new Date(input.now);

      return structuredClone(newSession);
    },

    rawState(userId: string): SealedBytes | null {
      const norm = userIdSchema.safeParse(userId);
      if (!norm.success) return null;
      const entry = states.get(norm.data);
      return entry ? structuredClone(entry.sealed) : null;
    },

    rawSession(handleHash: string): AuthSession | null {
      const norm = hashSchema.safeParse(handleHash);
      if (!norm.success) return null;
      const entry = sessions.get(norm.data);
      return entry ? structuredClone(entry) : null;
    },
  };
}

// --- Postgres Implementation ---

export function createPostgresAuthRepository(options: {
  db: DbClient;
  encryptionKey: Buffer;
}): AuthRepository {
  const { db, encryptionKey } = options;
  if (!Buffer.isBuffer(encryptionKey) || encryptionKey.byteLength !== 32) {
    throw new Error("invalid_key_length");
  }

  return {
    async createPendingSession(input: {
      handleHash: string;
      now: Date;
      expiresAt: Date;
      userId?: string;
    }): Promise<AuthSession> {
      const handleHash = hashSchema.parse(input.handleHash);
      const targetUserId = input.userId !== undefined ? userIdSchema.parse(input.userId) : null;

      return await db.transaction(async (tx) => {
        let userId = targetUserId;
        if (!userId) {
          const [newUser] = await tx.insert(users).values({}).returning({ id: users.id });
          userId = newUser.id;
        }

        // Opportunistically prune expired sessions for this user
        await tx
          .delete(authSessions)
          .where(
            and(
              eq(authSessions.userId, userId),
              or(eq(authSessions.status, "revoked"), sql`${authSessions.expiresAt} <= ${input.now}`),
            ),
          );

        const [session] = await tx
          .insert(authSessions)
          .values({
            userId,
            handleHash,
            status: "pending",
            expiresAt: input.expiresAt,
            createdAt: input.now,
          })
          .returning();

        return {
          id: session.id,
          userId: session.userId,
          handleHash: session.handleHash,
          status: session.status as "pending" | "authenticated" | "revoked",
          expiresAt: session.expiresAt,
        };
      });
    },

    async findSession(handleHash: string, now: Date): Promise<AuthSession | null> {
      let normHash: string;
      try {
        normHash = hashSchema.parse(handleHash);
      } catch {
        return null;
      }

      const rows = await db
        .select()
        .from(authSessions)
        .where(
          and(
            eq(authSessions.handleHash, normHash),
            sql`${authSessions.status} != 'revoked'`,
            gt(authSessions.expiresAt, now),
          ),
        )
        .limit(1);

      if (rows.length === 0) return null;
      const row = rows[0];
      return {
        id: row.id,
        userId: row.userId,
        handleHash: row.handleHash,
        status: row.status as "pending" | "authenticated" | "revoked",
        expiresAt: row.expiresAt,
      };
    },

    async readState(userId: string): Promise<OAuthState | null> {
      const normUserId = userIdSchema.parse(userId);
      const rows = await db
        .select()
        .from(silpoOAuthStates)
        .where(eq(silpoOAuthStates.userId, normUserId))
        .limit(1);

      if (rows.length === 0) return null;
      const row = rows[0];

      const payload = openPayload(encryptionKey, normUserId, {
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authTag,
      });

      return {
        userId: row.userId,
        version: row.version,
        phase: row.phase as "idle" | "pending" | "processing",
        bindingHash: row.bindingHash,
        flowExpiresAt: row.flowExpiresAt,
        payload,
      };
    },

    async beginFlow(input: {
      userId: string;
      bindingHash: string;
      flowId: string;
      state: string;
      now: Date;
      expiresAt: Date;
    }): Promise<OAuthState> {
      const normUserId = userIdSchema.parse(input.userId);
      const normBinding = hashSchema.parse(input.bindingHash);

      return await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(silpoOAuthStates)
          .where(eq(silpoOAuthStates.userId, normUserId))
          .limit(1);

        let registration: ClientRegistration | null = null;
        let discovery: DiscoveryBinding | null = null;
        let nextVersion = 1;

        if (rows.length > 0) {
          const existing = rows[0];
          if (
            existing.phase === "processing" &&
            existing.flowExpiresAt &&
            existing.flowExpiresAt.getTime() > input.now.getTime()
          ) {
            throw new Error("flow_processing");
          }
          try {
            const prev = openPayload(encryptionKey, normUserId, {
              ciphertext: existing.ciphertext,
              iv: existing.iv,
              authTag: existing.authTag,
            });
            registration = prev.registration;
            discovery = prev.discovery;
          } catch {
            // ignore corrupted payload on replacement
          }
          nextVersion = existing.version + 1;
        }

        const newPayload: OAuthPayload = {
          version: 1,
          flowId: input.flowId,
          state: input.state,
          verifier: null,
          registration,
          discovery,
        };

        const sealed = sealPayload(encryptionKey, normUserId, newPayload);

        const [upserted] = await tx
          .insert(silpoOAuthStates)
          .values({
            userId: normUserId,
            version: nextVersion,
            phase: "pending",
            bindingHash: normBinding,
            flowExpiresAt: input.expiresAt,
            ciphertext: sealed.ciphertext,
            iv: sealed.iv,
            authTag: sealed.authTag,
            updatedAt: input.now,
          })
          .onConflictDoUpdate({
            target: silpoOAuthStates.userId,
            set: {
              version: nextVersion,
              phase: "pending",
              bindingHash: normBinding,
              flowExpiresAt: input.expiresAt,
              ciphertext: sealed.ciphertext,
              iv: sealed.iv,
              authTag: sealed.authTag,
              updatedAt: input.now,
            },
          })
          .returning();

        return {
          userId: upserted.userId,
          version: upserted.version,
          phase: upserted.phase as "idle" | "pending" | "processing",
          bindingHash: upserted.bindingHash,
          flowExpiresAt: upserted.flowExpiresAt,
          payload: newPayload,
        };
      });
    },

    async saveState(input: {
      userId: string;
      expectedVersion: number;
      payload: OAuthPayload;
    }): Promise<OAuthState> {
      const normUserId = userIdSchema.parse(input.userId);
      const sealed = sealPayload(encryptionKey, normUserId, input.payload);

      const rows = await db
        .update(silpoOAuthStates)
        .set({
          version: sql`${silpoOAuthStates.version} + 1`,
          ciphertext: sealed.ciphertext,
          iv: sealed.iv,
          authTag: sealed.authTag,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(silpoOAuthStates.userId, normUserId),
            eq(silpoOAuthStates.version, input.expectedVersion),
          ),
        )
        .returning();

      if (rows.length === 0) {
        throw new Error("version_mismatch");
      }

      const updated = rows[0];
      return {
        userId: updated.userId,
        version: updated.version,
        phase: updated.phase as "idle" | "pending" | "processing",
        bindingHash: updated.bindingHash,
        flowExpiresAt: updated.flowExpiresAt,
        payload: oauthPayloadSchema.parse(input.payload),
      };
    },

    async claimFlow(input: {
      userId: string;
      bindingHash: string;
      expectedVersion: number;
      now: Date;
    }): Promise<OAuthState | null> {
      const normUserId = userIdSchema.parse(input.userId);
      const normBinding = hashSchema.parse(input.bindingHash);

      const rows = await db
        .update(silpoOAuthStates)
        .set({
          phase: "processing",
          version: sql`${silpoOAuthStates.version} + 1`,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(silpoOAuthStates.userId, normUserId),
            eq(silpoOAuthStates.bindingHash, normBinding),
            eq(silpoOAuthStates.version, input.expectedVersion),
            eq(silpoOAuthStates.phase, "pending"),
            gt(silpoOAuthStates.flowExpiresAt, input.now),
          ),
        )
        .returning();

      if (rows.length === 0) {
        return null;
      }

      const row = rows[0];
      const payload = openPayload(encryptionKey, normUserId, {
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authTag,
      });

      return {
        userId: row.userId,
        version: row.version,
        phase: row.phase as "idle" | "pending" | "processing",
        bindingHash: row.bindingHash,
        flowExpiresAt: row.flowExpiresAt,
        payload,
      };
    },

    async finishFlow(input: { userId: string; expectedVersion: number }): Promise<boolean> {
      const normUserId = userIdSchema.parse(input.userId);

      return await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(silpoOAuthStates)
          .where(
            and(
              eq(silpoOAuthStates.userId, normUserId),
              eq(silpoOAuthStates.version, input.expectedVersion),
            ),
          )
          .limit(1);

        if (rows.length === 0) return false;
        const existing = rows[0];

        let registration: ClientRegistration | null = null;
        let discovery: DiscoveryBinding | null = null;
        try {
          const prev = openPayload(encryptionKey, normUserId, {
            ciphertext: existing.ciphertext,
            iv: existing.iv,
            authTag: existing.authTag,
          });
          registration = prev.registration;
          discovery = prev.discovery;
        } catch {
          // preserve nulls
        }

        const cleanPayload: OAuthPayload = {
          version: 1,
          flowId: null,
          state: null,
          verifier: null,
          registration,
          discovery,
        };

        const sealed = sealPayload(encryptionKey, normUserId, cleanPayload);

        const updated = await tx
          .update(silpoOAuthStates)
          .set({
            phase: "idle",
            bindingHash: null,
            flowExpiresAt: null,
            version: sql`${silpoOAuthStates.version} + 1`,
            ciphertext: sealed.ciphertext,
            iv: sealed.iv,
            authTag: sealed.authTag,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(silpoOAuthStates.userId, normUserId),
              eq(silpoOAuthStates.version, input.expectedVersion),
            ),
          )
          .returning();

        return updated.length > 0;
      });
    },

    async activateSession(input: {
      oldHandleHash: string;
      newHandleHash: string;
      userId: string;
      expectedFlowVersion: number;
      now: Date;
      expiresAt: Date;
    }): Promise<AuthSession> {
      const normUserId = userIdSchema.parse(input.userId);
      const normOldHash = hashSchema.parse(input.oldHandleHash);
      const normNewHash = hashSchema.parse(input.newHandleHash);

      return await db.transaction(async (tx) => {
        // Lock and read processing state
        const stateRows = await tx
          .select()
          .from(silpoOAuthStates)
          .where(
            and(
              eq(silpoOAuthStates.userId, normUserId),
              eq(silpoOAuthStates.phase, "processing"),
              eq(silpoOAuthStates.version, input.expectedFlowVersion),
              eq(silpoOAuthStates.bindingHash, normOldHash),
              gt(silpoOAuthStates.flowExpiresAt, input.now),
            ),
          )
          .for("update")
          .limit(1);

        if (stateRows.length === 0) {
          throw new Error("activation_conflict");
        }
        const stateRow = stateRows[0];

        // Revoke old session
        const revokedRows = await tx
          .update(authSessions)
          .set({ status: "revoked" })
          .where(
            and(
              eq(authSessions.handleHash, normOldHash),
              eq(authSessions.userId, normUserId),
            ),
          )
          .returning();

        if (revokedRows.length === 0) {
          throw new Error("activation_conflict");
        }

        // Insert new authenticated session
        const [newSession] = await tx
          .insert(authSessions)
          .values({
            userId: normUserId,
            handleHash: normNewHash,
            status: "authenticated",
            expiresAt: input.expiresAt,
            createdAt: input.now,
          })
          .returning();

        // Clear flow secrets and return to idle
        let registration: ClientRegistration | null = null;
        let discovery: DiscoveryBinding | null = null;
        try {
          const prev = openPayload(encryptionKey, normUserId, {
            ciphertext: stateRow.ciphertext,
            iv: stateRow.iv,
            authTag: stateRow.authTag,
          });
          registration = prev.registration;
          discovery = prev.discovery;
        } catch {
          // preserve nulls
        }

        const cleanPayload: OAuthPayload = {
          version: 1,
          flowId: null,
          state: null,
          verifier: null,
          registration,
          discovery,
        };

        const sealed = sealPayload(encryptionKey, normUserId, cleanPayload);

        await tx
          .update(silpoOAuthStates)
          .set({
            phase: "idle",
            bindingHash: null,
            flowExpiresAt: null,
            version: sql`${silpoOAuthStates.version} + 1`,
            ciphertext: sealed.ciphertext,
            iv: sealed.iv,
            authTag: sealed.authTag,
            updatedAt: input.now,
          })
          .where(eq(silpoOAuthStates.userId, normUserId));

        return {
          id: newSession.id,
          userId: newSession.userId,
          handleHash: newSession.handleHash,
          status: newSession.status as "pending" | "authenticated" | "revoked",
          expiresAt: newSession.expiresAt,
        };
      });
    },
  };
}
