import { eq } from "drizzle-orm";
import type { DbClient } from "@/db/client";
import { draftApprovals } from "@/db/schema";

export interface DraftApprovalRecord {
  id?: string;
  draftId: string;
  userId: string;
  idempotencyKey: string;
  createdAt: Date;
}

export interface DraftRepository {
  approve(draftId: string, userId: string, idempotencyKey: string): Promise<{ idempotencyKey: string }>;
  getApproval(draftId: string): Promise<DraftApprovalRecord | null>;
}

export function createInMemoryDraftRepository(): DraftRepository {
  const approvalsByDraftId = new Map<string, DraftApprovalRecord>();

  return {
    async approve(draftId: string, userId: string, idempotencyKey: string): Promise<{ idempotencyKey: string }> {
      const existing = approvalsByDraftId.get(draftId);
      if (existing) {
        if (existing.userId === userId && existing.idempotencyKey === idempotencyKey) {
          return { idempotencyKey };
        }
        throw new Error("already approved");
      }
      approvalsByDraftId.set(draftId, {
        draftId,
        userId,
        idempotencyKey,
        createdAt: new Date(),
      });
      return { idempotencyKey };
    },

    async getApproval(draftId: string): Promise<DraftApprovalRecord | null> {
      return approvalsByDraftId.get(draftId) ?? null;
    },
  };
}

export function createPostgresDraftRepository(db: DbClient): DraftRepository {
  return {
    async approve(draftId: string, userId: string, idempotencyKey: string): Promise<{ idempotencyKey: string }> {
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
      const [record] = await db
        .select()
        .from(draftApprovals)
        .where(eq(draftApprovals.draftId, draftId))
        .limit(1);

      if (!record) {
        return null;
      }

      return {
        id: record.id,
        draftId: record.draftId,
        userId: record.userId,
        idempotencyKey: record.idempotencyKey,
        createdAt: record.createdAt,
      };
    },
  };
}
