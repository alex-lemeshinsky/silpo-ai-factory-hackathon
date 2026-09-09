import { z } from "zod";
import {
  DraftItemSchema,
  DraftSchema,
  effectiveUnitPrice,
  type Draft,
  type DraftItem,
  type ProductCandidate,
} from "@/features/shared/contracts";
import { err, ok, type Result } from "@/lib/result";
import type { DraftItemDecision, DraftRepository } from "./repository";

export interface DraftApprovalInput {
  draftVersion: number;
  items: Array<{
    sourceProductId: string;
    itemVersion: number;
    selectedProductId: string | null;
    quantity: number | null;
  }>;
}

export interface DraftApprovalResponse {
  idempotencyKey: string;
}

export type DraftApprovalFailureCode =
  | "not_found"
  | "conflict"
  | "invalid_selection"
  | "unexpected";

export interface DraftApprovalFailure {
  code: DraftApprovalFailureCode;
  message: string;
  correlationId: string;
}

export interface ApproveDraftInput {
  draftId: string;
  userId: string;
  selection: DraftApprovalInput;
  correlationId: string;
}

export interface ApproveDraftDeps {
  repository: DraftRepository;
  newIdempotencyKey?: () => string;
  now?: () => Date;
}

const ApprovalItemInputSchema = z.object({
  sourceProductId: z.string().trim().min(1),
  itemVersion: z.number().int().positive(),
  selectedProductId: z.string().trim().min(1).nullable(),
  quantity: z.number().finite().positive().nullable(),
}).strict().superRefine((value, context) => {
  if ((value.selectedProductId === null) !== (value.quantity === null)) {
    context.addIssue({
      code: "custom",
      path: ["quantity"],
      message: "selectedProductId and quantity must both be null or non-null",
    });
  }
});

export const DraftApprovalInputSchema: z.ZodType<DraftApprovalInput> = z.object({
  draftVersion: z.number().int().positive(),
  items: z.array(ApprovalItemInputSchema).max(10),
}).strict().superRefine((value, context) => {
  const sourceIds = value.items.map((item) => item.sourceProductId);
  if (new Set(sourceIds).size !== sourceIds.length) {
    context.addIssue({ code: "custom", path: ["items"], message: "source IDs must be unique" });
  }
});

export const DraftApprovalResponseSchema: z.ZodType<DraftApprovalResponse> = z.object({
  idempotencyKey: z.uuid(),
}).strict();

const alignedToStep = (quantity: number, step: number) =>
  Math.abs(quantity / step - Math.round(quantity / step)) <= 1e-9;

const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

function replacementItem(
  source: DraftItem,
  candidate: ProductCandidate,
  quantity: number,
): DraftItem {
  return DraftItemSchema.parse({
    productId: candidate.productId,
    externalProductId: candidate.externalProductId,
    name: candidate.name,
    imageUrl: candidate.imageUrl,
    displayRatio: candidate.displayRatio,
    quantity,
    price: candidate.price,
    specialPrice: candidate.specialPrice,
    stock: candidate.stock,
    step: candidate.step,
    confidence: source.confidence,
    confidenceBand: source.confidenceBand,
    reasonCodes: [...source.reasonCodes],
    reason: source.reason,
    nutritionStatus: candidate.nutritionStatus,
    promotions: candidate.promotions.map((promotion) => ({ ...promotion })),
    alternatives: source.alternatives
      .filter((alternative) => alternative.productId !== candidate.productId)
      .map((alternative) => structuredClone(alternative)),
  });
}

function keptItem(source: DraftItem, quantity: number): DraftItem {
  return DraftItemSchema.parse({
    productId: source.productId,
    externalProductId: source.externalProductId,
    name: source.name,
    imageUrl: source.imageUrl,
    displayRatio: source.displayRatio,
    quantity,
    price: source.price,
    specialPrice: source.specialPrice,
    stock: source.stock,
    step: source.step,
    confidence: source.confidence,
    confidenceBand: source.confidenceBand,
    reasonCodes: [...source.reasonCodes],
    reason: source.reason,
    nutritionStatus: source.nutritionStatus,
    promotions: source.promotions.map((promotion) => ({ ...promotion })),
    alternatives: source.alternatives.map((candidate) => structuredClone(candidate)),
  });
}

type PreparedSelection =
  | {
      ok: true;
      draft: Draft & { status: "confirming" };
      decisions: DraftItemDecision[];
    }
  | { ok: false; code: "conflict" | "invalid_selection" };

function prepareSelection(stored: Draft, selection: DraftApprovalInput): PreparedSelection {
  if (selection.draftVersion !== stored.version) return { ok: false, code: "conflict" };
  if (selection.items.length !== stored.items.length) {
    return { ok: false, code: "invalid_selection" };
  }
  const bySource = new Map(selection.items.map((item) => [item.sourceProductId, item]));
  if (bySource.size !== stored.items.length) return { ok: false, code: "invalid_selection" };

  const decisions: DraftItemDecision[] = [];
  const active: DraftItem[] = [];
  for (const source of stored.items) {
    const requested = bySource.get(source.productId);
    if (!requested) return { ok: false, code: "invalid_selection" };
    if (requested.itemVersion !== stored.version) return { ok: false, code: "conflict" };
    if (requested.selectedProductId === null || requested.quantity === null) {
      decisions.push({
        sourceProductId: source.productId,
        expectedVersion: requested.itemVersion,
        decision: "removed",
        item: null,
      });
      continue;
    }

    let candidate: ProductCandidate | null = null;
    if (requested.selectedProductId !== source.productId) {
      const allowed = source.alternatives.find(
        (item) => item.productId === requested.selectedProductId,
      );
      if (!allowed) return { ok: false, code: "invalid_selection" };
      candidate = allowed;
    }
    const selectedFacts = candidate ?? source;
    if (
      requested.quantity > selectedFacts.stock ||
      !alignedToStep(requested.quantity, selectedFacts.step) ||
      (candidate !== null && (!candidate.available || candidate.stock < candidate.step))
    ) return { ok: false, code: "invalid_selection" };

    const item = candidate
      ? replacementItem(source, candidate, requested.quantity)
      : keptItem(source, requested.quantity);
    active.push(item);
    decisions.push({
      sourceProductId: source.productId,
      expectedVersion: requested.itemVersion,
      decision: candidate ? "replaced" : "kept",
      item,
    });
  }

  if (active.length === 0 || new Set(active.map((item) => item.productId)).size !== active.length) {
    return { ok: false, code: "invalid_selection" };
  }
  const parsed = DraftSchema.safeParse({
    ...stored,
    status: "confirming",
    version: stored.version + 1,
    items: active,
    total: roundMoney(active.reduce(
      (sum, item) => sum + item.quantity * effectiveUnitPrice(item),
      0,
    )),
  });
  if (!parsed.success) return { ok: false, code: "invalid_selection" };
  return {
    ok: true,
    draft: parsed.data as Draft & { status: "confirming" },
    decisions,
  };
}

const FAILURE_COPY: Record<DraftApprovalFailureCode, string> = {
  not_found: "Чернетку не знайдено. Створіть нову.",
  conflict: "Чернетка змінилася. Оновіть сторінку й перевірте вибір ще раз.",
  invalid_selection: "Перевірте кількість або вибрану заміну.",
  unexpected: "Не вдалося підтвердити чернетку. Спробуйте ще раз.",
};

function failure(code: DraftApprovalFailureCode, correlationId: string) {
  return err({ code, message: FAILURE_COPY[code], correlationId });
}

const invalidSelection = (correlationId: string) =>
  failure("invalid_selection", correlationId);

export async function approveDraftSelection(
  input: ApproveDraftInput,
  deps: ApproveDraftDeps,
): Promise<Result<DraftApprovalResponse, DraftApprovalFailure>> {
  try {
    const existing = await deps.repository.getApproval(input.draftId, input.userId);
    if (existing) return ok(DraftApprovalResponseSchema.parse({ idempotencyKey: existing.idempotencyKey }));

    const parsed = DraftApprovalInputSchema.safeParse(input.selection);
    if (!parsed.success) return invalidSelection(input.correlationId);

    const stored = await deps.repository.get(input.draftId, input.userId);
    if (!stored) return failure("not_found", input.correlationId);
    if (stored.status !== "ready" || stored.version !== parsed.data.draftVersion) {
      return failure("conflict", input.correlationId);
    }

    const prepared = prepareSelection(stored, parsed.data);
    if (!prepared.ok) return failure(prepared.code, input.correlationId);

    const result = await deps.repository.approveSelection({
      draftId: stored.id,
      userId: input.userId,
      expectedDraftVersion: stored.version,
      approvedDraft: prepared.draft,
      decisions: prepared.decisions,
      idempotencyKey: (deps.newIdempotencyKey ?? (() => crypto.randomUUID()))(),
      approvedAt: (deps.now ?? (() => new Date()))(),
    });

    if (result.status === "not_found") return failure("not_found", input.correlationId);
    if (result.status === "conflict") return failure("conflict", input.correlationId);
    return ok(DraftApprovalResponseSchema.parse({ idempotencyKey: result.idempotencyKey }));
  } catch {
    return failure("unexpected", input.correlationId);
  }
}
