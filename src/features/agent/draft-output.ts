import { z } from "zod";

import type {
  CustomerContext,
  DataMode,
  NeedCandidate,
  ProductCandidate,
  ResolvedNeed,
} from "@/features/shared/contracts";

/**
 * The wire contract with Google. Objects and arrays only: the Generative
 * Language API accepts a subset of OpenAPI 3.0 with no unions and no
 * records, so a `z.union`, a `z.record` or an `.optional()` here would be
 * rejected by the service rather than caught by a test.
 *
 * Business rules deliberately stay out. `externalProductId` is not bounded
 * to non-negative, for instance: a negative value is a semantic violation
 * that `validateProposal` reports with a useful code, not a schema error
 * that silently costs a model attempt.
 */
export const DraftProposalSchema = z.object({
  summary: z.string().max(180),
  items: z.array(z.object({
    productId: z.string().min(1),
    externalProductId: z.number().int(),
    quantity: z.number().positive(),
    reason: z.string().max(160),
    alternativeIds: z.array(z.string()),
  })).max(10),
});

export type DraftProposal = z.infer<typeof DraftProposalSchema>;
export type DraftProposalItem = DraftProposal["items"][number];

/**
 * Declared here rather than in `prompt.ts` because `prompt.ts` imports
 * `executableQuantity` from this module, and the dependency must not run
 * both ways.
 */
export interface DraftAgentInput {
  mode: DataMode;
  resolvedNeeds: ResolvedNeed[];
  customerContext: CustomerContext;
}

/** The same tolerance `contracts.ts` uses for step alignment. */
const STEP_TOLERANCE = 1e-9;

/** Multiplying a fractional step reintroduces float noise; trim it back. */
function trimFloatNoise(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * The only source of a draft quantity in the system.
 *
 * `typicalQuantity` is advisory history evidence in the history's own unit
 * (Task 5, P5-04), so it is not directly buyable. This converts it to whole
 * packages of the product actually being offered: round up, so the guest is
 * never sent home with less than the habit, then clamp to what is in stock.
 *
 * `resolveProducts` has already guaranteed `stock >= step`, so at least one
 * whole package is always purchasable.
 */
export function executableQuantity(need: NeedCandidate, product: ProductCandidate): number {
  const desiredSteps = Math.ceil(need.typicalQuantity / product.step - STEP_TOLERANCE);
  const affordableSteps = Math.floor(product.stock / product.step + STEP_TOLERANCE);
  const steps = Math.max(1, Math.min(desiredSteps, affordableSteps));
  return trimFloatNoise(steps * product.step);
}

export type ProposalViolationCode =
  | "unknown_product"
  | "external_id_mismatch"
  | "alternative_not_in_need"
  | "reason_empty"
  | "reason_contains_price"
  | "summary_contains_price"
  | "duplicate_alternative"
  | "schema_invalid"
  | "model_unavailable"
  | "quantity_replaced"
  | "duplicate_product"
  | "alternatives_completed"
  | "missing_need";

/**
 * Carries normalized codes and nothing else — no model text, no product
 * name, no prompt fragment — so a later task can log it and a retry prompt
 * can quote it without feeding a bad generation back to the model.
 */
export class InvalidProposalError extends Error {
  readonly codes: readonly ProposalViolationCode[];

  constructor(message: string, codes: readonly ProposalViolationCode[]) {
    super(message);
    this.name = "InvalidProposalError";
    this.codes = codes;
  }
}

export class UnknownProductError extends InvalidProposalError {
  constructor(codes: readonly ProposalViolationCode[]) {
    super("unknown product in model proposal", codes);
    this.name = "UnknownProductError";
  }
}

export interface ValidatedProposal {
  proposal: DraftProposal;
  normalizations: readonly ProposalViolationCode[];
}

/**
 * A digit within whitespace of a currency or percent marker, in either
 * order. Price and discount are server facts the UI renders in their own
 * fields, so prose carrying one is inventing something this validator
 * cannot check against anything.
 */
const PRICE_CLAIM = /(\d\s*(?:₴|%|грн|uah)|(?:₴|%|грн|uah)\s*\d)/iu;

interface AllowlistEntry {
  index: number;
  resolved: ResolvedNeed;
  alternativeIds: string[];
}

function buildAllowlist(resolvedNeeds: ResolvedNeed[]): Map<string, AllowlistEntry> {
  return new Map(resolvedNeeds.map((resolved, index) => [
    resolved.selected.productId,
    { index, resolved, alternativeIds: resolved.alternatives.map((product) => product.productId) },
  ]));
}

/** Every rejection, so one retry prompt can carry all of them. */
function collectRejections(
  proposal: DraftProposal,
  allowlist: Map<string, AllowlistEntry>,
): ProposalViolationCode[] {
  const codes: ProposalViolationCode[] = [];

  // The summary is the dashboard's hero line, rendered directly above the
  // server-computed total. An invented saving there contradicts a real
  // number on the same screen, so it is held to the same rule as a reason.
  if (PRICE_CLAIM.test(proposal.summary)) {
    codes.push("summary_contains_price");
  }

  for (const item of proposal.items) {
    const entry = allowlist.get(item.productId);
    if (entry === undefined) {
      codes.push("unknown_product");
      continue;
    }
    if (item.externalProductId !== entry.resolved.selected.externalProductId) {
      codes.push("external_id_mismatch");
    }
    if (item.reason.trim().length === 0) {
      codes.push("reason_empty");
    } else if (PRICE_CLAIM.test(item.reason)) {
      codes.push("reason_contains_price");
    }
    if (item.alternativeIds.some((id) => !entry.alternativeIds.includes(id))) {
      codes.push("alternative_not_in_need");
    }
  }
  return codes;
}

/**
 * Checks the model's output against this run's own allowlist. Rejections
 * throw; normalizations are applied and reported. Completing a need the
 * model omitted is deliberately *not* done here — `fallback.ts` imports
 * this module, so calling it back would close an import cycle. The
 * orchestrator composes instead.
 */
export function validateProposal(
  proposal: DraftProposal,
  input: DraftAgentInput,
): ValidatedProposal {
  const allowlist = buildAllowlist(input.resolvedNeeds);
  const rejections = collectRejections(proposal, allowlist);
  if (rejections.length > 0) {
    throw rejections.includes("unknown_product")
      ? new UnknownProductError(rejections)
      : new InvalidProposalError(`invalid proposal: ${rejections.join(", ")}`, rejections);
  }

  const normalizations = new Set<ProposalViolationCode>();
  const byIndex = new Map<number, DraftProposalItem>();

  for (const item of proposal.items) {
    // `collectRejections` proved every id is present.
    const entry = allowlist.get(item.productId) as AllowlistEntry;
    if (byIndex.has(entry.index)) {
      normalizations.add("duplicate_product");
      continue;
    }

    const quantity = executableQuantity(entry.resolved.need, entry.resolved.selected);
    if (Math.abs(quantity - item.quantity) > STEP_TOLERANCE) {
      normalizations.add("quantity_replaced");
    }

    const missing = entry.alternativeIds.filter((id) => !item.alternativeIds.includes(id));
    if (missing.length > 0) {
      normalizations.add("alternatives_completed");
    }

    // The model's ranking survives for what it named; the rest follow in
    // resolver order so no swap option disappears from the UI. Deduping is
    // this module's job: `DraftItemSchema.alternatives` has no uniqueness
    // refinement, so a repeated id would render the same swap twice.
    const alternativeIds = [...new Set([...item.alternativeIds, ...missing])];
    if (alternativeIds.length !== item.alternativeIds.length + missing.length) {
      normalizations.add("duplicate_alternative");
    }

    byIndex.set(entry.index, {
      productId: item.productId,
      externalProductId: item.externalProductId,
      quantity,
      reason: item.reason.trim(),
      alternativeIds,
    });
  }

  const items = input.resolvedNeeds
    .map((_, index) => byIndex.get(index))
    .filter((entry): entry is DraftProposalItem => entry !== undefined);

  return {
    proposal: DraftProposalSchema.parse({ summary: proposal.summary.trim(), items }),
    normalizations: [...normalizations],
  };
}

