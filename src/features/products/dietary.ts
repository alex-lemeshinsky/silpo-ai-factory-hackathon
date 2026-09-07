import type { ProductCandidate } from "@/features/shared/contracts";

const VEGETARIAN_EXCLUSIONS = [
  /м['’]яс/i,
  /курк/i,
  /куряч/i,
  /свинин/i,
  /яловичин/i,
  /ковбас/i,
  /сосиск/i,
  /фарш/i,
  /риб/i,
  /філе/i,
  /індич/i,
];

const DAIRY_EXCLUSIONS = [/молок/i, /вершк/i, /кефір/i, /йогурт/i, /сметан/i, /сир/i, /ряжанк/i];

/**
 * Exclusion patterns per restriction key. A key absent from this table
 * excludes nothing: guessing what an unknown restriction means would be
 * worse than ignoring one. Reconcile against a live
 * `silpo_get_my_food_restrictions` once credentials exist.
 */
const RESTRICTION_PATTERNS: Record<string, RegExp[]> = {
  "no-added-sugar": [/цукор/i, /цукром/i, /підсолодж/i],
  "lactose-free": DAIRY_EXCLUSIONS,
  "gluten-free": [/пшенич/i, /хліб/i, /борошн/i, /глютен/i, /макарон/i, /булк/i, /батон/i],
  "nut-free": [/горіх/i, /арахіс/i, /фундук/i, /мигдал/i, /кеш['’]ю/i],
  vegetarian: VEGETARIAN_EXCLUSIONS,
  vegan: [...VEGETARIAN_EXCLUSIONS, ...DAIRY_EXCLUSIONS, /яйц/i, /мед/i],
};

/**
 * A hard exclusion rather than a ranking signal: a product that violates a
 * declared restriction is never offered, even when nothing else is left.
 */
export function isDietaryCompatible(
  product: ProductCandidate,
  restrictionKeys: string[],
): boolean {
  return restrictionKeys.every((key) => {
    const patterns = RESTRICTION_PATTERNS[key];
    if (patterns === undefined) {
      return true;
    }
    return !patterns.some((pattern) => pattern.test(product.name));
  });
}
