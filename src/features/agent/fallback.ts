import type { ResolvedNeed } from "@/features/shared/contracts";

import {
  DraftProposalSchema,
  executableQuantity,
  type DraftAgentInput,
  type DraftProposal,
  type DraftProposalItem,
} from "./draft-output";

/**
 * One clause per reason code `score.ts` can emit. Pinned in both directions
 * by the test, so a code added to Task 5 cannot silently lose its copy.
 * Each clause states only what its code already asserts — never a price, a
 * discount or a nutrition claim.
 */
export const REASON_CLAUSES: Record<string, string> = Object.freeze({
  cycle_due: "за вашим звичним циклом час поповнити запас",
  category_repeat: "ви регулярно купуєте цю категорію",
  stable_cycle: "інтервал між покупками стабільний",
  familiar_sku: "це ваш звичний товар",
  other_city_history: "частину покупок зроблено в іншому місті",
  quantity_uncertain: "кількість орієнтовна",
});

/** Most explanatory first; the tail is dropped rather than truncated. */
const CLAUSE_ORDER = [
  "cycle_due",
  "category_repeat",
  "stable_cycle",
  "familiar_sku",
  "other_city_history",
  "quantity_uncertain",
];

/** `DraftItemSchema` caps `reason` at 160 and `summary` at 180. */
export const MAX_REASON_LENGTH = 160;
const MAX_REASON_CLAUSES = 3;
const NO_CODES_REASON = "Позиція з вашої історії покупок";

function truncateAtWord(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  const head = value.slice(0, limit - 1);
  const lastSpace = head.lastIndexOf(" ");
  return `${(lastSpace > 0 ? head.slice(0, lastSpace) : head).trimEnd()}…`;
}

function buildFallbackReason(reasonCodes: readonly string[]): string {
  const clauses = CLAUSE_ORDER
    .filter((code) => reasonCodes.includes(code))
    .slice(0, MAX_REASON_CLAUSES)
    .map((code) => REASON_CLAUSES[code]);
  const body = clauses.length === 0 ? NO_CODES_REASON : clauses.join(", ");
  const sentence = `${body.charAt(0).toUpperCase()}${body.slice(1)}.`;
  return truncateAtWord(sentence, MAX_REASON_LENGTH);
}

export function buildFallbackItem(resolved: ResolvedNeed): DraftProposalItem {
  return {
    productId: resolved.selected.productId,
    externalProductId: resolved.selected.externalProductId,
    quantity: executableQuantity(resolved.need, resolved.selected),
    reason: buildFallbackReason(resolved.need.reasonCodes),
    alternativeIds: resolved.alternatives.map((product) => product.productId),
  };
}

/**
 * Counts without a plural-agreement helper on purpose: `pluralizeUk` lives
 * in `src/components/`, and `src/features/` must not import upward. A
 * second copy of it would be a parallel abstraction for one sentence.
 */
function buildFallbackSummary(count: number): string {
  return count === 0
    ? "Поки що замало історії покупок, щоб зібрати чернетку."
    : `Чернетка за вашою історією покупок. Позицій у списку: ${count}.`;
}

export function buildFallbackProposal(input: DraftAgentInput): DraftProposal {
  const items = input.resolvedNeeds.map(buildFallbackItem);
  return DraftProposalSchema.parse({
    summary: buildFallbackSummary(items.length),
    items,
  });
}
