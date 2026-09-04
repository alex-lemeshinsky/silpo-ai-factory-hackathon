import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { DbClient } from "@/db/client";
import { draftApprovals, draftItems, drafts, predictionRuns } from "@/db/schema";
import { DraftSchema, type Draft } from "@/features/shared/contracts";

export interface DraftApprovalRecord {
  id?: string;
  draftId: string;
  userId: string;
  idempotencyKey: string;
  createdAt: Date;
}

export interface DraftRepository {
  save(userId: string, draft: Draft, options?: SaveDraftOptions): Promise<Draft>;
  get(draftId: string, userId: string): Promise<Draft | null>;
  approve(draftId: string, userId: string, idempotencyKey: string): Promise<{ idempotencyKey: string }>;
  getApproval(draftId: string): Promise<DraftApprovalRecord | null>;
}

export interface SaveDraftOptions {
  expectedVersion?: number;
}

const nonEmptyString = z.string().trim().min(1);
const draftApprovalRecordSchema = z.object({
  id: nonEmptyString.optional(),
  draftId: nonEmptyString,
  userId: nonEmptyString,
  idempotencyKey: nonEmptyString,
  createdAt: z.date().refine((value) => Number.isFinite(value.getTime()), "date must be valid"),
}).strict();

function cloneDraft(value: Draft): Draft {
  return DraftSchema.parse(structuredClone(value));
}

function mapStoredDraft(
  draftRow: typeof drafts.$inferSelect,
  runRow: typeof predictionRuns.$inferSelect,
  itemRows: Array<typeof draftItems.$inferSelect>,
): Draft {
  return DraftSchema.parse({
    id: draftRow.id,
    mode: draftRow.mode,
    status: draftRow.status,
    algorithmVersion: runRow.algorithmVersion,
    trainingCutoff: runRow.temporalCutoff?.toISOString(),
    summary: draftRow.summary,
    items: itemRows.map((item) => ({
      productId: item.productId,
      externalProductId: item.externalProductId,
      name: item.name,
      quantity: item.quantity,
      price: item.price,
      stock: item.stock,
      step: item.step,
      confidence: item.confidence,
      confidenceBand: item.confidenceBand,
      reasonCodes: item.reasonCodes,
      reason: item.reason,
      nutritionStatus: item.nutritionStatus,
      alternatives: item.alternatives,
    })),
    total: draftRow.total,
    version: draftRow.version,
  });
}

export function createInMemoryDraftRepository(): DraftRepository {
  const draftsById = new Map<string, { userId: string; draft: Draft }>();
  const approvalsByDraftId = new Map<string, DraftApprovalRecord>();
  const draftIdByKey = new Map<string, string>();

  return {
    async save(userId: string, draft: Draft, options?: SaveDraftOptions): Promise<Draft> {
      const parsedUserId = nonEmptyString.parse(userId);
      const parsedDraft = DraftSchema.parse(draft);
      const existing = draftsById.get(parsedDraft.id);
      if (existing && existing.userId !== parsedUserId) {
        throw new Error("Draft owner cannot be changed");
      }
      if (existing) {
        if (options?.expectedVersion !== existing.draft.version) {
          throw new Error("Draft version conflict");
        }
        if (parsedDraft.version !== existing.draft.version + 1) {
          throw new Error("Draft version must increase by one");
        }
      }
      const stored = cloneDraft(parsedDraft);
      draftsById.set(parsedDraft.id, { userId: parsedUserId, draft: stored });
      return cloneDraft(stored);
    },

    async get(draftId: string, userId: string): Promise<Draft | null> {
      const parsedDraftId = nonEmptyString.parse(draftId);
      const parsedUserId = nonEmptyString.parse(userId);
      const stored = draftsById.get(parsedDraftId);
      if (!stored || stored.userId !== parsedUserId) {
        return null;
      }
      return cloneDraft(stored.draft);
    },

    async approve(draftId: string, userId: string, idempotencyKey: string): Promise<{ idempotencyKey: string }> {
      draftId = nonEmptyString.parse(draftId);
      userId = nonEmptyString.parse(userId);
      idempotencyKey = nonEmptyString.parse(idempotencyKey);
      const existing = approvalsByDraftId.get(draftId);
      if (existing) {
        if (existing.userId === userId && existing.idempotencyKey === idempotencyKey) {
          return { idempotencyKey };
        }
        throw new Error("already approved");
      }

      const existingDraftForThisKey = draftIdByKey.get(idempotencyKey);
      if (existingDraftForThisKey && existingDraftForThisKey !== draftId) {
        throw new Error("already approved");
      }

      const record: DraftApprovalRecord = {
        id: crypto.randomUUID(),
        draftId,
        userId,
        idempotencyKey,
        createdAt: new Date(),
      };
      approvalsByDraftId.set(draftId, record);
      draftIdByKey.set(idempotencyKey, draftId);
      return { idempotencyKey };
    },

    async getApproval(draftId: string): Promise<DraftApprovalRecord | null> {
      const record = approvalsByDraftId.get(nonEmptyString.parse(draftId));
      return record ? draftApprovalRecordSchema.parse(structuredClone(record)) : null;
    },
  };
}

export function createPostgresDraftRepository(db: DbClient): DraftRepository {
  return {
    async save(userId: string, draft: Draft, options?: SaveDraftOptions): Promise<Draft> {
      const parsedUserId = nonEmptyString.parse(userId);
      const parsedDraft = DraftSchema.parse(draft);

      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select({
            userId: drafts.userId,
            sourceRunId: drafts.sourceRunId,
            version: drafts.version,
          })
          .from(drafts)
          .where(eq(drafts.id, parsedDraft.id))
          .limit(1);

        if (existing && existing.userId !== parsedUserId) {
          throw new Error("Draft owner cannot be changed");
        }

        if (existing) {
          if (options?.expectedVersion !== existing.version) {
            throw new Error("Draft version conflict");
          }
          if (parsedDraft.version !== existing.version + 1) {
            throw new Error("Draft version must increase by one");
          }
        }

        let sourceRunId = existing?.sourceRunId ?? null;
        const runValues = {
          userId: parsedUserId,
          algorithmVersion: parsedDraft.algorithmVersion,
          temporalCutoff: new Date(parsedDraft.trainingCutoff),
          status: parsedDraft.status,
        };

        if (!sourceRunId) {
          const [insertedRun] = await tx
            .insert(predictionRuns)
            .values(runValues)
            .returning({ id: predictionRuns.id });
          if (!insertedRun) {
            throw new Error("Failed to persist prediction run");
          }
          sourceRunId = insertedRun.id;
        }

        const draftValues = {
          userId: parsedUserId,
          sourceRunId,
          mode: parsedDraft.mode,
          status: parsedDraft.status,
          total: parsedDraft.total,
          version: parsedDraft.version,
          summary: parsedDraft.summary,
          updatedAt: new Date(),
        };

        if (existing) {
          const [updatedDraft] = await tx
            .update(drafts)
            .set(draftValues)
            .where(and(
              eq(drafts.id, parsedDraft.id),
              eq(drafts.userId, parsedUserId),
              eq(drafts.version, options!.expectedVersion!),
            ))
            .returning({ id: drafts.id });
          if (!updatedDraft) {
            throw new Error("Draft version conflict");
          }
          await tx
            .update(predictionRuns)
            .set(runValues)
            .where(eq(predictionRuns.id, sourceRunId));
          await tx.delete(draftItems).where(eq(draftItems.draftId, parsedDraft.id));
        } else {
          await tx.insert(drafts).values({ id: parsedDraft.id, ...draftValues });
        }

        if (parsedDraft.items.length > 0) {
          await tx.insert(draftItems).values(
            parsedDraft.items.map((item, position) => ({
              draftId: parsedDraft.id,
              productId: item.productId,
              externalProductId: item.externalProductId,
              name: item.name,
              quantity: item.quantity,
              price: item.price,
              stock: item.stock,
              step: item.step,
              reason: item.reason,
              reasonCodes: item.reasonCodes,
              confidence: item.confidence,
              confidenceBand: item.confidenceBand,
              nutritionStatus: item.nutritionStatus,
              version: parsedDraft.version,
              position,
              alternatives: item.alternatives,
            })),
          );
        }

        return cloneDraft(parsedDraft);
      });
    },

    async get(draftId: string, userId: string): Promise<Draft | null> {
      const parsedDraftId = nonEmptyString.parse(draftId);
      const parsedUserId = nonEmptyString.parse(userId);
      const [row] = await db
        .select({ draft: drafts, run: predictionRuns })
        .from(drafts)
        .innerJoin(predictionRuns, eq(drafts.sourceRunId, predictionRuns.id))
        .where(and(
          eq(drafts.id, parsedDraftId),
          eq(drafts.userId, parsedUserId),
          eq(predictionRuns.userId, parsedUserId),
        ))
        .limit(1);

      if (!row) {
        return null;
      }

      const items = await db
        .select()
        .from(draftItems)
        .where(eq(draftItems.draftId, parsedDraftId))
        .orderBy(asc(draftItems.position));
      return mapStoredDraft(row.draft, row.run, items);
    },

    async approve(draftId: string, userId: string, idempotencyKey: string): Promise<{ idempotencyKey: string }> {
      draftId = nonEmptyString.parse(draftId);
      userId = nonEmptyString.parse(userId);
      idempotencyKey = nonEmptyString.parse(idempotencyKey);
      const [existing] = await db
        .select()
        .from(draftApprovals)
        .where(eq(draftApprovals.draftId, draftId))
        .limit(1);

      if (existing) {
        if (existing.userId === userId && existing.idempotencyKey === idempotencyKey) {
          return { idempotencyKey };
        }
        throw new Error("already approved");
      }

      try {
        await db.insert(draftApprovals).values({
          draftId,
          userId,
          idempotencyKey,
        });
        return { idempotencyKey };
      } catch (err: unknown) {
        const [rechecked] = await db
          .select()
          .from(draftApprovals)
          .where(eq(draftApprovals.draftId, draftId))
          .limit(1);

        if (rechecked) {
          if (rechecked.userId === userId && rechecked.idempotencyKey === idempotencyKey) {
            return { idempotencyKey };
          }
          throw new Error("already approved");
        }
        throw err;
      }
    },

    async getApproval(draftId: string): Promise<DraftApprovalRecord | null> {
      const parsedDraftId = nonEmptyString.parse(draftId);
      const [record] = await db
        .select()
        .from(draftApprovals)
        .where(eq(draftApprovals.draftId, parsedDraftId))
        .limit(1);

      if (!record) {
        return null;
      }

      return draftApprovalRecordSchema.parse({
        id: record.id,
        draftId: record.draftId,
        userId: record.userId,
        idempotencyKey: record.idempotencyKey,
        createdAt: record.createdAt,
      });
    },
  };
}
