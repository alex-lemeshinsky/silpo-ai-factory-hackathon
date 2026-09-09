import { and, asc, eq, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";
import type { DbClient } from "@/db/client";
import { draftApprovals, draftItems, drafts, predictionRuns } from "@/db/schema";
import {
  DraftItemSchema,
  DraftSchema,
  type Draft,
  type DraftItem,
} from "@/features/shared/contracts";

export interface DraftApprovalRecord {
  id?: string;
  draftId: string;
  userId: string;
  idempotencyKey: string;
  createdAt: Date;
}

export type DraftItemDecision =
  | {
      sourceProductId: string;
      expectedVersion: number;
      decision: "removed";
      item: null;
    }
  | {
      sourceProductId: string;
      expectedVersion: number;
      decision: "kept" | "replaced";
      item: DraftItem;
    };

export interface PersistDraftApprovalInput {
  draftId: string;
  userId: string;
  expectedDraftVersion: number;
  approvedDraft: Draft & { status: "confirming" };
  decisions: DraftItemDecision[];
  idempotencyKey: string;
  approvedAt: Date;
}

export type PersistDraftApprovalResult =
  | { status: "approved"; idempotencyKey: string }
  | { status: "already_approved"; idempotencyKey: string }
  | { status: "not_found" }
  | { status: "conflict" };

export interface SaveDraftOptions {
  expectedVersion?: number;
}

export interface DraftRepository {
  save(userId: string, draft: Draft, options?: SaveDraftOptions): Promise<Draft>;
  get(draftId: string, userId: string): Promise<Draft | null>;
  getApproval(draftId: string, userId: string): Promise<DraftApprovalRecord | null>;
  approveSelection(input: PersistDraftApprovalInput): Promise<PersistDraftApprovalResult>;
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

function validMutationShape(input: PersistDraftApprovalInput): boolean {
  if (
    input.approvedDraft.id !== input.draftId ||
    input.approvedDraft.status !== "confirming" ||
    input.approvedDraft.version !== input.expectedDraftVersion + 1 ||
    input.decisions.length === 0
  ) return false;

  const sourceIds = input.decisions.map((decision) => decision.sourceProductId);
  if (new Set(sourceIds).size !== sourceIds.length) return false;

  const active = input.decisions.filter(
    (decision): decision is Extract<DraftItemDecision, { item: DraftItem }> => decision.item !== null,
  );
  if (active.length !== input.approvedDraft.items.length) return false;

  return active.every((decision, index) => {
    const parsedItem = DraftItemSchema.safeParse(decision.item);
    return parsedItem.success &&
      JSON.stringify(parsedItem.data) === JSON.stringify(input.approvedDraft.items[index]);
  });
}

function validateApprovalInput(input: PersistDraftApprovalInput): boolean {
  const parsedDraftId = nonEmptyString.safeParse(input.draftId);
  const parsedUserId = nonEmptyString.safeParse(input.userId);
  const parsedKey = z.string().uuid().safeParse(input.idempotencyKey);
  const validApprovedAt = input.approvedAt instanceof Date && Number.isFinite(input.approvedAt.getTime());
  const parsedApprovedDraft = DraftSchema.safeParse(input.approvedDraft);
  if (
    !parsedDraftId.success ||
    !parsedUserId.success ||
    !parsedKey.success ||
    !validApprovedAt ||
    !parsedApprovedDraft.success
  ) {
    return false;
  }
  if (!Array.isArray(input.decisions)) {
    return false;
  }
  for (const d of input.decisions) {
    if (!d || typeof d !== "object") return false;
    if (!nonEmptyString.safeParse(d.sourceProductId).success) return false;
    if (typeof d.expectedVersion !== "number" || !Number.isInteger(d.expectedVersion) || d.expectedVersion < 1) return false;
    if (d.decision === "removed" && d.item !== null) return false;
    if ((d.decision === "kept" || d.decision === "replaced") && d.item === null) return false;
  }
  return validMutationShape(input);
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
      imageUrl: item.imageUrl,
      displayRatio: item.displayRatio,
      quantity: item.quantity,
      price: item.price,
      specialPrice: item.specialPrice,
      stock: item.stock,
      step: item.step,
      confidence: item.confidence,
      confidenceBand: item.confidenceBand,
      reasonCodes: item.reasonCodes,
      reason: item.reason,
      nutritionStatus: item.nutritionStatus,
      promotions: item.promotions,
      alternatives: item.alternatives,
    })),
    total: draftRow.total,
    version: draftRow.version,
  });
}

interface MemoryDraftRow {
  userId: string;
  draft: Draft;
  items: Array<{
    sourceProductId: string;
    item: DraftItem;
    version: number;
    decision: "kept" | "replaced" | "removed" | null;
  }>;
}

export function createInMemoryDraftRepository(): DraftRepository {
  const draftsById = new Map<string, MemoryDraftRow>();
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
      const storedDraft = cloneDraft(parsedDraft);
      const storedItems = storedDraft.items.map((item) => ({
        sourceProductId: item.productId,
        item: DraftItemSchema.parse(structuredClone(item)),
        version: storedDraft.version,
        decision: null as "kept" | "replaced" | "removed" | null,
      }));
      draftsById.set(parsedDraft.id, {
        userId: parsedUserId,
        draft: storedDraft,
        items: storedItems,
      });
      return cloneDraft(storedDraft);
    },

    async get(draftId: string, userId: string): Promise<Draft | null> {
      const parsedDraftId = nonEmptyString.parse(draftId);
      const parsedUserId = nonEmptyString.parse(userId);
      const stored = draftsById.get(parsedDraftId);
      if (!stored || stored.userId !== parsedUserId) {
        return null;
      }
      const nonRemovedItems = stored.items
        .filter((row) => row.decision !== "removed")
        .map((row) => structuredClone(row.item));
      const rebuilt = DraftSchema.parse({
        ...stored.draft,
        items: nonRemovedItems,
      });
      return cloneDraft(rebuilt);
    },

    async approveSelection(input: PersistDraftApprovalInput): Promise<PersistDraftApprovalResult> {
      if (!validateApprovalInput(input)) {
        return { status: "conflict" };
      }

      const stored = draftsById.get(input.draftId);
      if (!stored || stored.userId !== input.userId) {
        return { status: "not_found" };
      }

      const existingApproval = approvalsByDraftId.get(input.draftId);
      if (existingApproval) {
        return {
          status: "already_approved",
          idempotencyKey: existingApproval.idempotencyKey,
        };
      }

      if (stored.draft.status !== "ready" || stored.draft.version !== input.expectedDraftVersion) {
        return { status: "conflict" };
      }

      if (stored.items.length !== input.decisions.length) {
        return { status: "conflict" };
      }

      for (let i = 0; i < stored.items.length; i++) {
        const storedItem = stored.items[i];
        const decision = input.decisions[i];
        if (
          storedItem.sourceProductId !== decision.sourceProductId ||
          storedItem.version !== decision.expectedVersion
        ) {
          return { status: "conflict" };
        }
      }

      const existingDraftForThisKey = draftIdByKey.get(input.idempotencyKey);
      if (existingDraftForThisKey && existingDraftForThisKey !== input.draftId) {
        throw new Error("unique constraint violation: draft_approvals.idempotency_key");
      }

      const nextItems = stored.items.map((storedItem, index) => {
        const decision = input.decisions[index];
        if (decision.decision === "removed") {
          return {
            sourceProductId: storedItem.sourceProductId,
            item: storedItem.item,
            version: input.approvedDraft.version,
            decision: "removed" as const,
          };
        }
        return {
          sourceProductId: storedItem.sourceProductId,
          item: DraftItemSchema.parse(structuredClone(decision.item)),
          version: input.approvedDraft.version,
          decision: decision.decision,
        };
      });

      const nextDraft: MemoryDraftRow = {
        userId: input.userId,
        draft: cloneDraft(input.approvedDraft),
        items: nextItems,
      };

      const approvalRecord: DraftApprovalRecord = {
        id: crypto.randomUUID(),
        draftId: input.draftId,
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        createdAt: new Date(input.approvedAt.getTime()),
      };

      draftsById.set(input.draftId, nextDraft);
      approvalsByDraftId.set(input.draftId, approvalRecord);
      draftIdByKey.set(input.idempotencyKey, input.draftId);

      return {
        status: "approved",
        idempotencyKey: input.idempotencyKey,
      };
    },

    async getApproval(draftId: string, userId: string): Promise<DraftApprovalRecord | null> {
      const record = approvalsByDraftId.get(nonEmptyString.parse(draftId));
      if (!record || record.userId !== nonEmptyString.parse(userId)) return null;
      return draftApprovalRecordSchema.parse(structuredClone(record));
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
              imageUrl: item.imageUrl,
              displayRatio: item.displayRatio,
              quantity: item.quantity,
              price: item.price,
              specialPrice: item.specialPrice,
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
              promotions: item.promotions,
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
        .where(and(
          eq(draftItems.draftId, parsedDraftId),
          or(isNull(draftItems.userDecision), ne(draftItems.userDecision, "removed")),
        ))
        .orderBy(asc(draftItems.position));
      return mapStoredDraft(row.draft, row.run, items);
    },

    async approveSelection(input: PersistDraftApprovalInput): Promise<PersistDraftApprovalResult> {
      if (!validateApprovalInput(input)) {
        return { status: "conflict" };
      }

      return db.transaction(async (tx) => {
        const [lockedDraft] = await tx
          .select()
          .from(drafts)
          .where(and(eq(drafts.id, input.draftId), eq(drafts.userId, input.userId)))
          .for("update")
          .limit(1);
        if (!lockedDraft) return { status: "not_found" as const };

        const [existingApproval] = await tx
          .select()
          .from(draftApprovals)
          .where(and(
            eq(draftApprovals.draftId, input.draftId),
            eq(draftApprovals.userId, input.userId),
          ))
          .limit(1);
        if (existingApproval) {
          return {
            status: "already_approved" as const,
            idempotencyKey: existingApproval.idempotencyKey,
          };
        }

        if (lockedDraft.status !== "ready" || lockedDraft.version !== input.expectedDraftVersion) {
          return { status: "conflict" as const };
        }

        const rows = await tx
          .select()
          .from(draftItems)
          .where(eq(draftItems.draftId, input.draftId))
          .orderBy(asc(draftItems.position))
          .for("update");

        if (rows.length !== input.decisions.length) {
          return { status: "conflict" as const };
        }

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const decision = input.decisions[i];
          if (
            row.productId !== decision.sourceProductId ||
            row.version !== decision.expectedVersion
          ) {
            return { status: "conflict" as const };
          }
        }

        const [updatedDraft] = await tx
          .update(drafts)
          .set({
            status: input.approvedDraft.status,
            total: input.approvedDraft.total,
            version: input.approvedDraft.version,
            summary: input.approvedDraft.summary,
            updatedAt: new Date(),
          })
          .where(and(
            eq(drafts.id, input.draftId),
            eq(drafts.userId, input.userId),
            eq(drafts.version, input.expectedDraftVersion),
            eq(drafts.status, "ready"),
          ))
          .returning({ id: drafts.id });

        if (!updatedDraft) {
          return { status: "conflict" as const };
        }

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const decision = input.decisions[i];
          if (decision.decision === "removed") {
            await tx
              .update(draftItems)
              .set({
                userDecision: "removed",
                version: input.approvedDraft.version,
              })
              .where(eq(draftItems.id, row.id));
          } else {
            await tx
              .update(draftItems)
              .set({
                productId: decision.item.productId,
                externalProductId: decision.item.externalProductId,
                name: decision.item.name,
                imageUrl: decision.item.imageUrl,
                displayRatio: decision.item.displayRatio,
                quantity: decision.item.quantity,
                price: decision.item.price,
                specialPrice: decision.item.specialPrice,
                stock: decision.item.stock,
                step: decision.item.step,
                reason: decision.item.reason,
                reasonCodes: decision.item.reasonCodes,
                confidence: decision.item.confidence,
                confidenceBand: decision.item.confidenceBand,
                nutritionStatus: decision.item.nutritionStatus,
                alternatives: decision.item.alternatives,
                promotions: decision.item.promotions,
                userDecision: decision.decision,
                version: input.approvedDraft.version,
              })
              .where(eq(draftItems.id, row.id));
          }
        }

        await tx.insert(draftApprovals).values({
          draftId: input.draftId,
          userId: input.userId,
          idempotencyKey: input.idempotencyKey,
          createdAt: input.approvedAt,
        });

        return {
          status: "approved" as const,
          idempotencyKey: input.idempotencyKey,
        };
      });
    },

    async getApproval(draftId: string, userId: string): Promise<DraftApprovalRecord | null> {
      const parsedDraftId = nonEmptyString.parse(draftId);
      const parsedUserId = nonEmptyString.parse(userId);
      const [record] = await db
        .select()
        .from(draftApprovals)
        .where(and(
          eq(draftApprovals.draftId, parsedDraftId),
          eq(draftApprovals.userId, parsedUserId),
        ))
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

