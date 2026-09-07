/**
 * Ukrainian search text for each category `categorize.ts` can produce.
 * `NeedCandidate` carries no product name, so without this table a category
 * need has nothing to search Silpo with.
 *
 * Four entries are pinned by `fixtures/demo/silpo-snapshot.json` and are
 * asserted against it: `water`, `dairy`, `grains` and `eggs`. `grains` is
 * therefore narrower than the category it serves — a known limitation to
 * revisit whenever the demo fixture is broadened.
 */
const CATEGORY_QUERIES: Record<string, string> = {
  water: "вода",
  dairy: "молоко",
  eggs: "яйця",
  bread: "хліб",
  coffee: "кава",
  tea: "чай",
  grains: "вівсяні пластівці",
  meat: "курка",
  fish: "риба",
  produce: "овочі",
  oil: "олія",
  sweets: "шоколад",
  snacks: "чіпси",
  household: "серветки",
};

export function queryForCategory(categoryKey: string): string | null {
  return CATEGORY_QUERIES[categoryKey] ?? null;
}
