import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { queryForCategory } from "@/features/products/category-queries";

/**
 * Read from source rather than imported, so adding a category to
 * `categorize.ts` without a query fails here instead of silently losing
 * that category's search path.
 */
function categoryKeysFromSource(): string[] {
  const source = readFileSync(
    join(process.cwd(), "src/features/purchases/categorize.ts"),
    "utf8",
  );
  const keys = [...source.matchAll(/categoryKey:\s*"([a-z-]+)"/g)].map((match) => match[1]);
  expect(keys.length).toBeGreaterThan(5);
  return [...new Set(keys)];
}

it("supplies exactly one query for every predicted category", () => {
  for (const key of categoryKeysFromSource()) {
    expect(queryForCategory(key), `missing query for "${key}"`).toEqual(expect.any(String));
  }
});

it("returns null for a category it does not know", () => {
  expect(queryForCategory("uncategorized")).toBeNull();
  expect(queryForCategory("truffles")).toBeNull();
});

it("keeps the fixture-backed queries identical to the demo snapshot", () => {
  const snapshot = JSON.parse(
    readFileSync(join(process.cwd(), "fixtures/demo/silpo-snapshot.json"), "utf8"),
  ) as { productSearchResults: { query: string }[] };
  const fixtureQueries = new Set(snapshot.productSearchResults.map((result) => result.query));

  // Demo mode resolves nothing for a category whose query misses the fixture.
  for (const key of ["water", "dairy", "grains", "eggs"]) {
    expect(fixtureQueries.has(queryForCategory(key) ?? "")).toBe(true);
  }
});
