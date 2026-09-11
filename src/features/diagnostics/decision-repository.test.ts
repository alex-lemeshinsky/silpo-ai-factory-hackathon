import { describe, expect, it } from "vitest";

import { createInMemoryDecisionRepository, EMPTY_DECISION_TOTALS } from "./decision-repository";

describe("createInMemoryDecisionRepository", () => {
  it("A17-35 returns the totals it was given, for any user", async () => {
    const totals = {
      decidedItemCount: 5,
      keptItemCount: 3,
      replacedItemCount: 1,
      landedReplacements: [{ replacedFromPrice: 40, effectivePrice: 30, quantity: 2 }],
    };
    const repo = createInMemoryDecisionRepository(totals);

    expect(await repo.totalsForUser("user-1")).toEqual(totals);
  });

  it("A17-36 exposes an empty total for a visitor with no decisions", () => {
    expect(EMPTY_DECISION_TOTALS).toEqual({
      decidedItemCount: 0,
      keptItemCount: 0,
      replacedItemCount: 0,
      landedReplacements: [],
    });
  });
});
