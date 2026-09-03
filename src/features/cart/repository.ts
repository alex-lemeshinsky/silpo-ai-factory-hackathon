import { eq } from "drizzle-orm";
import type { DbClient } from "@/db/client";
import { cartCommits } from "@/db/schema";

export type CartCommitStatus = "pending" | "partially_committed" | "verified" | "blocked";

export interface CartCommitRecord {
  id?: string;
  idempotencyKey: string;
  draftId?: string | null;
  userId?: string | null;
  targetQuantities: Record<string, number>;
  status: CartCommitStatus;
  confirmationTimestamp?: Date | null;
  result?: unknown | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface StartCartCommitInput {
  key: string;
  targetQuantities: Record<string, number>;
  userId?: string;
  draftId?: string;
}

export interface SaveCartCommitResultInput {
  status: "verified" | "blocked" | "partially_committed";
  data?: unknown;
}

export interface CartCommitRepository {
  start(input: StartCartCommitInput): Promise<CartCommitRecord>;
  get(key: string): Promise<CartCommitRecord | null>;
  saveResult(key: string, result: SaveCartCommitResultInput): Promise<CartCommitRecord>;
}

export function createInMemoryCartCommitRepository(): CartCommitRepository {
  const commitsByKey = new Map<string, CartCommitRecord>();

  return {
    async start(input: StartCartCommitInput): Promise<CartCommitRecord> {
      const existing = commitsByKey.get(input.key);
      if (existing) {
        return existing;
      }
      const now = new Date();
      const record: CartCommitRecord = {
        idempotencyKey: input.key,
        targetQuantities: { ...input.targetQuantities },
        userId: input.userId ?? null,
        draftId: input.draftId ?? null,
        status: "pending",
        result: null,
        createdAt: now,
        updatedAt: now,
      };
      commitsByKey.set(input.key, record);
      return record;
    },

    async get(key: string): Promise<CartCommitRecord | null> {
      return commitsByKey.get(key) ?? null;
    },

    async saveResult(key: string, result: SaveCartCommitResultInput): Promise<CartCommitRecord> {
      const existing = commitsByKey.get(key);
      if (!existing) {
        throw new Error(`Cart commit record not found for key: ${key}`);
      }
      const updated: CartCommitRecord = {
        ...existing,
        status: result.status,
        result,
        updatedAt: new Date(),
      };
      commitsByKey.set(key, updated);
      return updated;
    },
  };
}

export function createPostgresCartCommitRepository(db: DbClient): CartCommitRepository {
  return {
    async start(input: StartCartCommitInput): Promise<CartCommitRecord> {
      const [existing] = await db
        .select()
        .from(cartCommits)
        .where(eq(cartCommits.idempotencyKey, input.key))
        .limit(1);

      if (existing) {
        return {
          id: existing.id,
          idempotencyKey: existing.idempotencyKey,
          draftId: existing.draftId,
          userId: existing.userId,
          confirmationTimestamp: existing.confirmationTimestamp,
          targetQuantities: existing.targetQuantities as Record<string, number>,
          status: existing.status as CartCommitStatus,
          result: existing.result,
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
        };
      }

      try {
        const [inserted] = await db
          .insert(cartCommits)
          .values({
            idempotencyKey: input.key,
            targetQuantities: input.targetQuantities,
            userId: input.userId ?? null,
            draftId: input.draftId ?? null,
            status: "pending",
          })
          .returning();

        return {
          id: inserted.id,
          idempotencyKey: inserted.idempotencyKey,
          draftId: inserted.draftId,
          userId: inserted.userId,
          confirmationTimestamp: inserted.confirmationTimestamp,
          targetQuantities: inserted.targetQuantities as Record<string, number>,
          status: inserted.status as CartCommitStatus,
          result: inserted.result,
          createdAt: inserted.createdAt,
          updatedAt: inserted.updatedAt,
        };
      } catch {
        const [rechecked] = await db
          .select()
          .from(cartCommits)
          .where(eq(cartCommits.idempotencyKey, input.key))
          .limit(1);

        if (rechecked) {
          return {
            id: rechecked.id,
            idempotencyKey: rechecked.idempotencyKey,
            draftId: rechecked.draftId,
            userId: rechecked.userId,
            confirmationTimestamp: rechecked.confirmationTimestamp,
            targetQuantities: rechecked.targetQuantities as Record<string, number>,
            status: rechecked.status as CartCommitStatus,
            result: rechecked.result,
            createdAt: rechecked.createdAt,
            updatedAt: rechecked.updatedAt,
          };
        }
        throw new Error(`Failed to start cart commit for key: ${input.key}`);
      }
    },

    async get(key: string): Promise<CartCommitRecord | null> {
      const [record] = await db
        .select()
        .from(cartCommits)
        .where(eq(cartCommits.idempotencyKey, key))
        .limit(1);

      if (!record) {
        return null;
      }

      return {
        id: record.id,
        idempotencyKey: record.idempotencyKey,
        draftId: record.draftId,
        userId: record.userId,
        confirmationTimestamp: record.confirmationTimestamp,
        targetQuantities: record.targetQuantities as Record<string, number>,
        status: record.status as CartCommitStatus,
        result: record.result,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    },

    async saveResult(key: string, result: SaveCartCommitResultInput): Promise<CartCommitRecord> {
      const [updated] = await db
        .update(cartCommits)
        .set({
          status: result.status,
          result,
          updatedAt: new Date(),
        })
        .where(eq(cartCommits.idempotencyKey, key))
        .returning();

      if (!updated) {
        throw new Error(`Cart commit record not found for key: ${key}`);
      }

      return {
        id: updated.id,
        idempotencyKey: updated.idempotencyKey,
        draftId: updated.draftId,
        userId: updated.userId,
        confirmationTimestamp: updated.confirmationTimestamp,
        targetQuantities: updated.targetQuantities as Record<string, number>,
        status: updated.status as CartCommitStatus,
        result: updated.result,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      };
    },
  };
}
