import { eq } from "drizzle-orm";
import { z } from "zod";
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
  confirmationTimestamp?: Date;
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

const nonEmptyString = z.string().trim().min(1);
const validDate = z.date().refine((value) => Number.isFinite(value.getTime()), "date must be valid");
const targetQuantitiesSchema = z
  .record(nonEmptyString, z.number().finite().positive())
  .refine((value) => Object.keys(value).length > 0, "targetQuantities must not be empty");
const cartCommitStatusSchema = z.enum(["pending", "partially_committed", "verified", "blocked"]);
const savedCartCommitResultSchema = z.object({
  status: z.enum(["verified", "blocked", "partially_committed"]),
  data: z.unknown().optional(),
}).strict();
const startCartCommitInputSchema = z.object({
  key: nonEmptyString,
  targetQuantities: targetQuantitiesSchema,
  userId: nonEmptyString.optional(),
  draftId: nonEmptyString.optional(),
  confirmationTimestamp: validDate.optional(),
}).strict();
const saveCartCommitResultInputSchema = savedCartCommitResultSchema;
const cartCommitRecordSchema = z.object({
  id: nonEmptyString.optional(),
  idempotencyKey: nonEmptyString,
  draftId: nonEmptyString.nullable().optional(),
  userId: nonEmptyString.nullable().optional(),
  targetQuantities: targetQuantitiesSchema,
  status: cartCommitStatusSchema,
  confirmationTimestamp: validDate.nullable().optional(),
  result: savedCartCommitResultSchema.nullable().optional(),
  createdAt: validDate.optional(),
  updatedAt: validDate.optional(),
}).strict();

function parseCartCommitRecord(value: unknown): CartCommitRecord {
  return cartCommitRecordSchema.parse(value);
}

export function createInMemoryCartCommitRepository(): CartCommitRepository {
  const commitsByKey = new Map<string, CartCommitRecord>();

  return {
    async start(input: StartCartCommitInput): Promise<CartCommitRecord> {
      const parsedInput = startCartCommitInputSchema.parse(input);
      const existing = commitsByKey.get(parsedInput.key);
      if (existing) {
        return parseCartCommitRecord(structuredClone(existing));
      }
      const now = new Date();
      const confirmationTimestamp = parsedInput.confirmationTimestamp ?? now;
      const record: CartCommitRecord = {
        id: crypto.randomUUID(),
        idempotencyKey: parsedInput.key,
        targetQuantities: { ...parsedInput.targetQuantities },
        userId: parsedInput.userId ?? null,
        draftId: parsedInput.draftId ?? null,
        status: "pending",
        confirmationTimestamp,
        result: null,
        createdAt: now,
        updatedAt: now,
      };
      commitsByKey.set(parsedInput.key, record);
      return parseCartCommitRecord(structuredClone(record));
    },

    async get(key: string): Promise<CartCommitRecord | null> {
      const record = commitsByKey.get(nonEmptyString.parse(key));
      return record ? parseCartCommitRecord(structuredClone(record)) : null;
    },

    async saveResult(key: string, result: SaveCartCommitResultInput): Promise<CartCommitRecord> {
      const parsedKey = nonEmptyString.parse(key);
      const parsedResult = saveCartCommitResultInputSchema.parse(result);
      const existing = commitsByKey.get(parsedKey);
      if (!existing) {
        throw new Error(`Cart commit record not found for key: ${key}`);
      }
      const updated: CartCommitRecord = {
        ...existing,
        status: parsedResult.status,
        result: parsedResult,
        updatedAt: new Date(),
      };
      commitsByKey.set(parsedKey, updated);
      return parseCartCommitRecord(structuredClone(updated));
    },
  };
}

export function createPostgresCartCommitRepository(db: DbClient): CartCommitRepository {
  return {
    async start(input: StartCartCommitInput): Promise<CartCommitRecord> {
      const parsedInput = startCartCommitInputSchema.parse(input);
      const [existing] = await db
        .select()
        .from(cartCommits)
        .where(eq(cartCommits.idempotencyKey, parsedInput.key))
        .limit(1);

      if (existing) {
        return parseCartCommitRecord(existing);
      }

      const confirmationTimestamp = parsedInput.confirmationTimestamp ?? new Date();

      let inserted: typeof cartCommits.$inferSelect | undefined;
      try {
        [inserted] = await db
          .insert(cartCommits)
          .values({
            idempotencyKey: parsedInput.key,
            targetQuantities: parsedInput.targetQuantities,
            userId: parsedInput.userId ?? null,
            draftId: parsedInput.draftId ?? null,
            confirmationTimestamp,
            status: "pending",
          })
          .returning();

      } catch (error: unknown) {
        const [rechecked] = await db
          .select()
          .from(cartCommits)
          .where(eq(cartCommits.idempotencyKey, parsedInput.key))
          .limit(1);

        if (rechecked) {
          return parseCartCommitRecord(rechecked);
        }
        throw error;
      }

      return parseCartCommitRecord(inserted);
    },

    async get(key: string): Promise<CartCommitRecord | null> {
      const parsedKey = nonEmptyString.parse(key);
      const [record] = await db
        .select()
        .from(cartCommits)
        .where(eq(cartCommits.idempotencyKey, parsedKey))
        .limit(1);

      if (!record) {
        return null;
      }

      return parseCartCommitRecord(record);
    },

    async saveResult(key: string, result: SaveCartCommitResultInput): Promise<CartCommitRecord> {
      const parsedKey = nonEmptyString.parse(key);
      const parsedResult = saveCartCommitResultInputSchema.parse(result);
      const [updated] = await db
        .update(cartCommits)
        .set({
          status: parsedResult.status,
          result: parsedResult,
          updatedAt: new Date(),
        })
        .where(eq(cartCommits.idempotencyKey, parsedKey))
        .returning();

      if (!updated) {
        throw new Error(`Cart commit record not found for key: ${key}`);
      }

      return parseCartCommitRecord(updated);
    },
  };
}
