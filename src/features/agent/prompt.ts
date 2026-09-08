import type {
  ConfidenceBand,
  DataMode,
  NutritionStatus,
  ProductCandidate,
} from "@/features/shared/contracts";

import { executableQuantity, type DraftAgentInput } from "./draft-output";

export const MODEL_LOCALE = "uk-UA";

export interface ModelProduct {
  productId: string;
  externalProductId: number;
  name: string;
  price: number;
  specialPrice: number | null;
  inStock: boolean;
  promotionLabels: string[];
  nutritionStatus: NutritionStatus;
}

export interface ModelNeed {
  categoryKey: string;
  confidence: number;
  confidenceBand: ConfidenceBand;
  reasonCodes: string[];
  quantity: number;
  selected: ModelProduct;
  alternatives: ModelProduct[];
}

export interface ModelDraftInput {
  mode: DataMode;
  locale: string;
  familySize: number | null;
  restrictionKeys: string[];
  needs: ModelNeed[];
}

/**
 * A whitelist, field by field. Nothing is spread and no property is copied
 * by iteration, so a field added to `ProductCandidate` later is excluded by
 * default rather than admitted by default.
 *
 * Narrower than the ceiling in agent architecture section 8: no slug, no
 * image, no step, no displayRatio, no raw stock, no promotion ids or
 * prices, no feature block, no nutrient values, no loyalty balance. The
 * model needs the `insufficient` label, not the numbers, and a bonus is
 * never applied automatically — mentioning it would invite prose implying
 * it was.
 */
function toModelProduct(product: ProductCandidate): ModelProduct {
  return {
    productId: product.productId,
    externalProductId: product.externalProductId,
    name: product.name,
    price: product.price,
    specialPrice: product.specialPrice,
    inStock: product.available && product.stock > 0,
    promotionLabels: product.promotions.map((promotion) => promotion.label),
    nutritionStatus: product.nutritionStatus,
  };
}

export function buildModelInput(input: DraftAgentInput): ModelDraftInput {
  return {
    mode: input.mode,
    locale: MODEL_LOCALE,
    familySize: input.customerContext.familySize,
    restrictionKeys: [...input.customerContext.restrictionKeys],
    needs: input.resolvedNeeds.map((resolved) => ({
      categoryKey: resolved.need.categoryKey,
      confidence: resolved.need.confidence,
      confidenceBand: resolved.need.confidenceBand,
      reasonCodes: [...resolved.need.reasonCodes],
      quantity: executableQuantity(resolved.need, resolved.selected),
      selected: toModelProduct(resolved.selected),
      alternatives: resolved.alternatives.map(toModelProduct),
    })),
  };
}

/**
 * Deliberately silent about the confidence formula: score and reason codes
 * arrive as facts, so restating the algorithm would invite the model to
 * recompute it.
 */
const SYSTEM_INSTRUCTION = [
  "Ти пояснюєш готову чернетку продуктового замовлення українською мовою.",
  "",
  "Правила:",
  "- Твоя роль — пояснити вибір і впорядкувати надані альтернативи. Ти не прогнозуєш потреби, не змінюєш кількість і не оформлюєш замовлення.",
  "- Використовуй лише ті ідентифікатори та факти, що є у вхідних даних. Не додавай товарів, яких там немає.",
  "- Ніколи не називай у тексті ціну, знижку, залишок, склад чи харчову цінність. Ці дані інтерфейс показує окремо.",
  "- Пиши коротко: одне речення на позицію, не довше 160 символів.",
  '- Якщо nutritionStatus дорівнює "insufficient", кажи «даних недостатньо» і нічого не припускай.',
  "- Не згадуй жодних персональних даних.",
  "- Ніколи не пропонуй пакети, доставку, прискорення чи інші службові позиції.",
  "- У alternativeIds використовуй лише ідентифікатори альтернатив цієї ж позиції, від найкращої заміни до найгіршої.",
  "- Поверни лише структуровану відповідь за схемою.",
].join("\n");

export function buildSystemInstruction(): string {
  return SYSTEM_INSTRUCTION;
}

export function buildUserPrompt(modelInput: ModelDraftInput): string {
  return [
    "Дані чернетки (JSON). Поясни кожну позицію та впорядкуй її альтернативи.",
    JSON.stringify(modelInput),
  ].join("\n\n");
}

/**
 * Carries normalized violation codes only. The model's own text never
 * re-enters a prompt, so a malformed or hostile generation cannot steer the
 * retry.
 */
export function buildRetryPrompt(modelInput: ModelDraftInput, issues: readonly string[]): string {
  return [
    buildUserPrompt(modelInput),
    `Попередню відповідь відхилено. Коди порушень: ${issues.join(", ")}. Виправ їх і поверни лише коректну структуру.`,
  ].join("\n\n");
}
