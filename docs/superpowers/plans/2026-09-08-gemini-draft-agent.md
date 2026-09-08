# Gemini Draft Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn verified `ResolvedNeed[]` into an explained, post-validated `DraftProposal` — one structured Gemini call over sanitized input, with a deterministic reason-code fallback so the user always gets a draft.

**Architecture:** `draft-output.ts` owns the Gemini-compatible wire schema, the executable-quantity policy and semantic post-validation, and depends on nothing else in the directory. `prompt.ts` projects domain objects onto a whitelist type and builds the prompts. `fallback.ts` turns reason codes into Ukrainian copy. `draft-agent.ts` owns the attempt ladder behind a `DraftModel` port and imports no AI SDK symbol, so its whole suite runs against hand-written fakes. `google-model.ts` is the only file that touches `ai` or `@ai-sdk/google`.

**Tech Stack:** TypeScript, Zod 4, Vitest, `ai@7`, `@ai-sdk/google@4`, Gemini 3.7 Flash via Google AI Studio.

**Spec:** [2026-09-08-gemini-draft-agent-design.md](../specs/2026-09-08-gemini-draft-agent-design.md)

## Global Constraints

- Use `pnpm` exclusively. Task 12 adds exactly two production dependencies, `ai` and `@ai-sdk/google`, and only in Task 6.
- Do not edit any file outside this plan's task file lists. In particular: no edit to `src/features/shared/contracts.ts`, `src/lib/env.ts`, `src/lib/result.ts`, `src/db/*`, `src/features/prediction/*`, `src/features/products/*`, `src/features/purchases/*`, `src/features/silpo/*`, `src/components/*`, `vitest.config.ts`, `fixtures/demo/silpo-snapshot.json`, or `SILPO_MCP.md`.
- `src/features/agent/*` imports no React, no Next.js, no MCP SDK, no database client, and no `src/db/*` or `src/components/*` symbol. Only `google-model.ts` imports `ai` or `@ai-sdk/google`.
- The module graph runs one way: `draft-output.ts` → (nothing in this directory); `prompt.ts` and `fallback.ts` → `draft-output.ts`; `draft-agent.ts` → all three plus `google-model.ts`. `google-model.ts` takes `DraftModel` from `draft-agent.ts` via `import type` **only**, so the single cycle is erased at compile time.
- Model-output schemas use objects and arrays only: no `z.union`, no `z.record`, no `z.discriminatedUnion`, no `.optional()`, no `.nullable()` inside `DraftProposalSchema`.
- Gemini never invents or alters a product ID, price, special price, stock level, promotion, package `step`, `displayRatio`, nutrition value, quantity or checkout state.
- Model input never contains a full name, phone, email, precise address, loyalty barcode, profile ID, session ID, idempotency key, OAuth token, database key, checkout URL, raw receipt or raw MCP payload.
- `GOOGLE_GENERATIVE_AI_API_KEY` is passed explicitly into the adapter, never read from `process.env` inside `src/features/agent/*`, and never appears in a prompt, an error message, a test file or a log line.
- Raw prompts and raw model output are never logged. Task 12 writes no log line at all.
- At most **two** model attempts per draft run. The AI SDK's own retry is disabled (`maxRetries: 0`) so the attempt count is exactly what this plan says.
- `generateDraftWithModel` and `generateDraft` never reject because of a model or provider fault.
- All copy is Ukrainian. No test contains a real API key and no test calls Google over the network.
- **Response and option names in Task 6 are provisional.** Verify `Output`, `providerOptions.google.thinkingConfig.thinkingLevel` versus a top-level `reasoning: "low"`, and the `fetch` option on `createGoogleGenerativeAI` against the *installed* package's types and README before writing the adapter. Report a mismatch as a spec deviation — do not silently reshape the adapter or loosen `DraftProposalSchema` to match whatever arrives.
- **Commit discipline:** work on branch `task-12-gemini-draft-agent`. Each task below ends in its own commit on that branch. Task 7 squashes the branch into one commit on `main` with the backlog's mandated message, `feat: generate drafts with Gemini`.

---

### Task 1: Output schema and executable quantity

`draft-output.ts` is the bottom of the module graph, so it goes first: every other file in the directory imports from it. This task builds the wire contract with Google and the one function in the system allowed to produce a draft quantity.

The Task 5 specification established that `NeedCandidate.typicalQuantity` is *advisory history evidence in the history's own unit* and that prediction "creates no executable cart quantities". Task 11 created none either. This is where the first executable, step-aligned quantity comes from, and it comes from server facts alone — never from the model.

**Files:**
- Create: `src/features/agent/draft-output.ts`
- Test: `src/features/agent/draft-output.test.ts`

**Interfaces:**
- Consumes: `NeedCandidate`, `ProductCandidate`, `ResolvedNeed`, `CustomerContext`, `DataMode` from `@/features/shared/contracts`.
- Produces: `DraftProposalSchema`, `DraftProposal`, `DraftProposalItem`, `DraftAgentInput`, `executableQuantity(need, product): number`.

- [ ] **Step 1: Write the failing test**

Create `src/features/agent/draft-output.test.ts`:

```ts
import { expect, it } from "vitest";
import { z } from "zod";

import {
  DraftProposalSchema,
  executableQuantity,
} from "@/features/agent/draft-output";
import {
  NeedCandidateSchema,
  ProductCandidateSchema,
  type NeedCandidate,
  type ProductCandidate,
} from "@/features/shared/contracts";

function need(overrides: Partial<NeedCandidate> = {}): NeedCandidate {
  return NeedCandidateSchema.parse({
    categoryKey: "dairy",
    confidence: 0.8,
    confidenceBand: "high",
    typicalQuantity: 1,
    reasonCodes: ["category_repeat"],
    preferredExternalProductIds: [40123],
    features: {
      weightedPurchaseCount: 6,
      medianIntervalDays: 7,
      intervalMadDays: 1,
      daysSinceLastPurchase: 8,
      activeCityShare: 1,
      repeatScore: 0.9,
      dueScore: 1,
      stabilityScore: 0.8,
    },
    ...overrides,
  });
}

function candidate(overrides: Partial<ProductCandidate> = {}): ProductCandidate {
  return ProductCandidateSchema.parse({
    productId: "p-1",
    externalProductId: 40123,
    slug: "moloko-25-900",
    name: "Молоко 2,5% 900 г",
    imageUrl: null,
    price: 45.5,
    specialPrice: null,
    available: true,
    stock: 20,
    step: 1,
    displayRatio: 0.9,
    nutritionStatus: "insufficient",
    nutrition: null,
    promotions: [],
    ...overrides,
  });
}

function jsonSchemaText(): string {
  return JSON.stringify(z.toJSONSchema(DraftProposalSchema, { target: "draft-7" }));
}

it("accepts the normative proposal shape", () => {
  const parsed = DraftProposalSchema.parse({
    summary: "Чернетка за вашою історією покупок.",
    items: [
      {
        productId: "p-1",
        externalProductId: 40123,
        quantity: 2,
        reason: "Ви регулярно купуєте цю категорію.",
        alternativeIds: ["p-2"],
      },
    ],
  });

  expect(parsed.items[0].productId).toBe("p-1");
});

it("emits a JSON Schema Google structured output accepts", () => {
  const text = jsonSchemaText();

  for (const forbidden of ["anyOf", "oneOf", "allOf", "patternProperties", '"not"']) {
    expect(text).not.toContain(forbidden);
  }
  expect(text).not.toContain('"additionalProperties":true');
});

it("keeps at most ten items and bounded copy", () => {
  expect(DraftProposalSchema.safeParse({ summary: "s", items: Array(11).fill(null) }).success).toBe(false);
  expect(DraftProposalSchema.safeParse({ summary: "x".repeat(181), items: [] }).success).toBe(false);
});

it("rounds the habitual quantity up to a whole package", () => {
  expect(executableQuantity(need({ typicalQuantity: 1.5 }), candidate({ step: 1 }))).toBe(2);
});

it("leaves an exact multiple of step alone", () => {
  expect(executableQuantity(need({ typicalQuantity: 0.9 }), candidate({ step: 0.3 }))).toBeCloseTo(0.9, 9);
});

it("never proposes less than one whole package", () => {
  expect(executableQuantity(need({ typicalQuantity: 0.4 }), candidate({ step: 0.5 }))).toBe(0.5);
});

it("clamps demand to the stock on hand", () => {
  expect(executableQuantity(need({ typicalQuantity: 20 }), candidate({ step: 2, stock: 5 }))).toBe(4);
});

it("produces a quantity a draft item would accept", () => {
  const product = candidate({ step: 0.3, stock: 3 });
  const quantity = executableQuantity(need({ typicalQuantity: 0.7 }), product);

  expect(Math.abs(quantity / product.step - Math.round(quantity / product.step))).toBeLessThanOrEqual(1e-9);
  expect(quantity).toBeLessThanOrEqual(product.stock);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/features/agent/draft-output.test.ts`
Expected: FAIL — `Cannot find module '@/features/agent/draft-output'`.

- [ ] **Step 3: Write the schema and the quantity policy**

Create `src/features/agent/draft-output.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/features/agent/draft-output.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git checkout -b task-12-gemini-draft-agent
git add src/features/agent/draft-output.ts src/features/agent/draft-output.test.ts
git commit -m "feat: add the Gemini draft output schema and quantity policy"
```

---

### Task 2: Semantic post-validation

Schema validity is not enough: a proposal can parse perfectly and still name a product this run never resolved, or state a price in prose. This task adds the allowlist check.

One question decides every outcome: **does this anomaly risk showing the user an unverified fact?** If yes, reject and let Task 5's ladder retry and then fall back. If no, replace the model's value with the server's and continue. Rejecting everything would make a stray alternative ID cost the user a model-authored draft; repairing everything would reduce "post-validated" to "schema-valid".

**Files:**
- Modify: `src/features/agent/draft-output.ts` (append; do not alter Task 1's exports)
- Test: `src/features/agent/draft-output.test.ts` (append)

**Interfaces:**
- Consumes: `DraftProposal`, `DraftProposalItem`, `DraftAgentInput`, `executableQuantity` from Task 1.
- Produces: `ProposalViolationCode`, `InvalidProposalError` (with a readonly `codes` field), `UnknownProductError`, `ValidatedProposal`, `validateProposal(proposal, input): ValidatedProposal`.

- [ ] **Step 1: Write the failing test**

Append to `src/features/agent/draft-output.test.ts`. First extend the two existing imports at the top of that file:

```ts
import {
  DraftProposalSchema,
  InvalidProposalError,
  UnknownProductError,
  executableQuantity,
  validateProposal,
  type DraftProposal,
  type DraftProposalItem,
} from "@/features/agent/draft-output";
import {
  NeedCandidateSchema,
  ProductCandidateSchema,
  ResolvedNeedSchema,
  type NeedCandidate,
  type ProductCandidate,
  type ResolvedNeed,
} from "@/features/shared/contracts";
```

Then append:

```ts
function resolved(overrides: Partial<ResolvedNeed> = {}): ResolvedNeed {
  return ResolvedNeedSchema.parse({
    need: need(),
    selected: candidate(),
    alternatives: [candidate({ productId: "p-2", externalProductId: 40124, slug: "alt-a" })],
    ...overrides,
  });
}

function input(resolvedNeeds: ResolvedNeed[] = [resolved()]) {
  return {
    mode: "demo" as const,
    resolvedNeeds,
    customerContext: { familySize: 2, restrictionKeys: [], loyaltyBonusAvailable: null },
  };
}

function item(overrides: Partial<DraftProposalItem> = {}): DraftProposalItem {
  return {
    productId: "p-1",
    externalProductId: 40123,
    quantity: 1,
    reason: "Ви регулярно купуєте цю категорію.",
    alternativeIds: ["p-2"],
    ...overrides,
  };
}

function proposal(items: DraftProposalItem[]): DraftProposal {
  return DraftProposalSchema.parse({ summary: "Чернетка.", items });
}

it("rejects a product id absent from resolved candidates", () => {
  expect(() => validateProposal(proposal([item({ productId: "p-999" })]), input()))
    .toThrow(/unknown product/);
});

it("rejects an external id that disagrees with the server", () => {
  expect(() => validateProposal(proposal([item({ externalProductId: 999 })]), input()))
    .toThrow(InvalidProposalError);
});

it("rejects an alternative belonging to another need", () => {
  const other = resolved({
    need: need({ categoryKey: "water" }),
    selected: candidate({ productId: "p-3", externalProductId: 40125, slug: "water" }),
    alternatives: [],
  });

  expect(() => validateProposal(proposal([item({ alternativeIds: ["p-3"] })]), input([resolved(), other])))
    .toThrow(/alternative_not_in_need/);
});

it.each(["Ціна лише 45 ₴ сьогодні", "Знижка 20%", "Всього 30 грн"])(
  "rejects a reason stating a price or a discount: %s",
  (reason) => {
    expect(() => validateProposal(proposal([item({ reason })]), input())).toThrow(InvalidProposalError);
  },
);

it("rejects an empty reason", () => {
  expect(() => validateProposal(proposal([item({ reason: "   " })]), input())).toThrow(InvalidProposalError);
});

it("reports every rejection code, not only the first", () => {
  try {
    validateProposal(proposal([item({ productId: "p-999" }), item({ reason: " " })]), input());
    expect.unreachable("validateProposal should have thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(UnknownProductError);
    expect((error as InvalidProposalError).codes).toEqual(["unknown_product", "reason_empty"]);
  }
});

it("replaces the model's quantity with the server's", () => {
  const result = validateProposal(proposal([item({ quantity: 99 })]), input());

  expect(result.proposal.items[0].quantity).toBe(1);
  expect(result.normalizations).toContain("quantity_replaced");
});

it("does not report a replacement when the model already agreed", () => {
  const result = validateProposal(proposal([item({ quantity: 1 })]), input());

  expect(result.normalizations).not.toContain("quantity_replaced");
});

it("drops a repeated product and keeps the first mention", () => {
  const result = validateProposal(proposal([item({ reason: "Перше." }), item({ reason: "Друге." })]), input());

  expect(result.proposal.items).toHaveLength(1);
  expect(result.proposal.items[0].reason).toBe("Перше.");
  expect(result.normalizations).toContain("duplicate_product");
});

it("appends alternatives the model left out, keeping its order for the rest", () => {
  const wide = resolved({
    alternatives: [
      candidate({ productId: "p-2", externalProductId: 40124, slug: "alt-a" }),
      candidate({ productId: "p-3", externalProductId: 40125, slug: "alt-b" }),
    ],
  });
  const result = validateProposal(proposal([item({ alternativeIds: ["p-3"] })]), input([wide]));

  expect(result.proposal.items[0].alternativeIds).toEqual(["p-3", "p-2"]);
  expect(result.normalizations).toContain("alternatives_completed");
});

it("returns validated items in resolver order, not the model's", () => {
  const second = resolved({
    need: need({ categoryKey: "water" }),
    selected: candidate({ productId: "p-9", externalProductId: 40199, slug: "water" }),
    alternatives: [],
  });
  const model = proposal([
    item({ productId: "p-9", externalProductId: 40199, alternativeIds: [] }),
    item(),
  ]);

  const result = validateProposal(model, input([resolved(), second]));

  expect(result.proposal.items.map((entry) => entry.productId)).toEqual(["p-1", "p-9"]);
});

it("returns only the needs the model named", () => {
  const second = resolved({
    need: need({ categoryKey: "water" }),
    selected: candidate({ productId: "p-9", externalProductId: 40199, slug: "water" }),
    alternatives: [],
  });

  const result = validateProposal(proposal([item()]), input([resolved(), second]));

  expect(result.proposal.items).toHaveLength(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/features/agent/draft-output.test.ts`
Expected: FAIL — `validateProposal is not a function`.

- [ ] **Step 3: Implement the validator**

Append to `src/features/agent/draft-output.ts`:

```ts
export type ProposalViolationCode =
  | "unknown_product"
  | "external_id_mismatch"
  | "alternative_not_in_need"
  | "reason_empty"
  | "reason_contains_price"
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

    byIndex.set(entry.index, {
      productId: item.productId,
      externalProductId: item.externalProductId,
      quantity,
      reason: item.reason.trim(),
      // The model's ranking survives for what it named; the rest follow in
      // resolver order so no swap option disappears from the UI.
      alternativeIds: [...item.alternativeIds, ...missing],
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/features/agent/draft-output.test.ts && pnpm typecheck`
Expected: PASS — 22 tests, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/features/agent/draft-output.ts src/features/agent/draft-output.test.ts
git commit -m "feat: post-validate model proposals against the run allowlist"
```

---

### Task 3: Privacy filter and prompt builders

The agent architecture requires the privacy filter to be a deterministic function with its own unit test, because a prompt instruction alone is not enforcement.

The filter is a **whitelist projection**, built field by field from a declared type. Never spread a domain object and never copy properties by iteration: a blacklist admits any field `ProductCandidate` gains next year, a whitelist excludes it by default.

**Files:**
- Create: `src/features/agent/prompt.ts`
- Test: `src/features/agent/prompt.test.ts`

**Interfaces:**
- Consumes: `DraftAgentInput`, `executableQuantity` from Task 1.
- Produces: `ModelProduct`, `ModelNeed`, `ModelDraftInput`, `MODEL_LOCALE`, `buildModelInput(input): ModelDraftInput`, `buildSystemInstruction(): string`, `buildUserPrompt(modelInput): string`, `buildRetryPrompt(modelInput, issues): string`.

- [ ] **Step 1: Write the failing test**

Create `src/features/agent/prompt.test.ts`:

```ts
import { expect, it } from "vitest";

import {
  buildModelInput,
  buildRetryPrompt,
  buildSystemInstruction,
  buildUserPrompt,
} from "@/features/agent/prompt";
import type { DraftAgentInput } from "@/features/agent/draft-output";
import {
  NeedCandidateSchema,
  ProductCandidateSchema,
  ResolvedNeedSchema,
  type ResolvedNeed,
} from "@/features/shared/contracts";

const POISON = {
  phone: "+380671234567",
  address: "вул. Хрещатик, 22, кв. 5",
  barcode: "9780201379624",
  token: "ya29.a0AfH6SMB-secret-token",
  databaseId: "6f1c0f8e-3f2a-4e0b-9d1a-2c3b4d5e6f70",
};

function resolvedNeed(): ResolvedNeed {
  return ResolvedNeedSchema.parse({
    need: NeedCandidateSchema.parse({
      categoryKey: "dairy",
      confidence: 0.8,
      confidenceBand: "high",
      typicalQuantity: 1.5,
      reasonCodes: ["category_repeat", "cycle_due"],
      preferredExternalProductIds: [40123],
      features: {
        weightedPurchaseCount: 6,
        medianIntervalDays: 7,
        intervalMadDays: 1,
        daysSinceLastPurchase: 8,
        activeCityShare: 1,
        repeatScore: 0.9,
        dueScore: 1,
        stabilityScore: 0.8,
      },
    }),
    selected: ProductCandidateSchema.parse({
      productId: "p-1",
      externalProductId: 40123,
      slug: "moloko-25-900",
      name: "Молоко 2,5% 900 г",
      imageUrl: "https://example.test/p-1.jpg",
      price: 45.5,
      specialPrice: 39.9,
      available: true,
      stock: 20,
      step: 1,
      displayRatio: 0.9,
      nutritionStatus: "insufficient",
      nutrition: null,
      promotions: [{ id: "promo-1", label: "Мінус 20%", price: 39.9 }],
    }),
    alternatives: [],
  });
}

/** Domain objects carrying extra properties, the way a leak would arrive. */
function poisonedInput(): DraftAgentInput {
  const resolved = resolvedNeed();
  return {
    mode: "live",
    resolvedNeeds: [{
      ...resolved,
      selected: { ...resolved.selected, ...POISON },
      need: { ...resolved.need, ...POISON },
    } as ResolvedNeed],
    customerContext: {
      familySize: 3,
      restrictionKeys: ["lactose_free"],
      loyaltyBonusAvailable: 128.5,
      ...POISON,
    } as DraftAgentInput["customerContext"],
  };
}

it("passes no private value into the model input or the prompt", () => {
  const modelInput = buildModelInput(poisonedInput());
  const text = `${JSON.stringify(modelInput)}\n${buildUserPrompt(modelInput)}`;

  for (const value of Object.values(POISON)) {
    expect(text).not.toContain(value);
  }
});

it("projects exactly the approved product fields", () => {
  const modelInput = buildModelInput(poisonedInput());

  expect(Object.keys(modelInput.needs[0].selected).sort()).toEqual([
    "externalProductId",
    "inStock",
    "name",
    "nutritionStatus",
    "price",
    "productId",
    "promotionLabels",
    "specialPrice",
  ]);
});

it("omits loyalty, slug, imageUrl, step, displayRatio and raw stock", () => {
  const text = JSON.stringify(buildModelInput(poisonedInput()));

  for (const forbidden of ["loyaltyBonusAvailable", "slug", "imageUrl", "displayRatio", '"step"', '"stock"', '"features"']) {
    expect(text).not.toContain(forbidden);
  }
  expect(text).not.toContain("promo-1");
});

it("carries the server quantity, not the habit", () => {
  // typicalQuantity 1.5 with step 1 becomes two whole packages.
  expect(buildModelInput(poisonedInput()).needs[0].quantity).toBe(2);
});

it("states the no-invention and insufficient-nutrition rules", () => {
  const system = buildSystemInstruction();

  expect(system).toContain("даних недостатньо");
  expect(system).toMatch(/ціну/i);
  expect(system).toMatch(/структуров/i);
});

it("carries violation codes but no model text into the retry prompt", () => {
  const modelInput = buildModelInput(poisonedInput());
  const retry = buildRetryPrompt(modelInput, ["unknown_product", "reason_contains_price"]);

  expect(retry).toContain("unknown_product");
  expect(retry).toContain("reason_contains_price");
  expect(retry).not.toBe(buildUserPrompt(modelInput));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/features/agent/prompt.test.ts`
Expected: FAIL — `Cannot find module '@/features/agent/prompt'`.

- [ ] **Step 3: Implement the projection and the prompts**

Create `src/features/agent/prompt.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/features/agent/prompt.test.ts && pnpm typecheck`
Expected: PASS — 6 tests, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/features/agent/prompt.ts src/features/agent/prompt.test.ts
git commit -m "feat: build sanitized Gemini prompts from resolved needs"
```

---

### Task 4: Deterministic reason-code fallback

The user must get an explainable draft even when Gemini never succeeds. The same per-need builder also completes any need a successful model left out, so the deterministic draft and a completed model draft cannot drift apart in wording.

The vocabulary is pinned in **both** directions against `score.ts`: every code the scorer can emit has a clause, and every clause maps to a code the scorer can emit. A code added to Task 5 therefore cannot silently lose its copy.

**Files:**
- Create: `src/features/agent/fallback.ts`
- Test: `src/features/agent/fallback.test.ts`

**Interfaces:**
- Consumes: `DraftProposal`, `DraftProposalItem`, `DraftAgentInput`, `DraftProposalSchema`, `executableQuantity`, `validateProposal` from Tasks 1–2.
- Produces: `REASON_CLAUSES`, `MAX_REASON_LENGTH`, `buildFallbackItem(resolved): DraftProposalItem`, `buildFallbackProposal(input): DraftProposal`.

- [ ] **Step 1: Write the failing test**

Create `src/features/agent/fallback.test.ts`. Reuse the `need`, `candidate`, `resolved` and `input` builder style from Task 2's test file — repeat them locally; the suites do not share a helper module, matching `resolve-products.test.ts`.

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { buildFallbackItem, buildFallbackProposal, REASON_CLAUSES, MAX_REASON_LENGTH } from "@/features/agent/fallback";
import { validateProposal } from "@/features/agent/draft-output";
import {
  NeedCandidateSchema,
  ProductCandidateSchema,
  ResolvedNeedSchema,
  type NeedCandidate,
  type ProductCandidate,
  type ResolvedNeed,
} from "@/features/shared/contracts";

function need(overrides: Partial<NeedCandidate> = {}): NeedCandidate {
  return NeedCandidateSchema.parse({
    categoryKey: "dairy",
    confidence: 0.8,
    confidenceBand: "high",
    typicalQuantity: 1,
    reasonCodes: ["category_repeat"],
    preferredExternalProductIds: [40123],
    features: {
      weightedPurchaseCount: 6,
      medianIntervalDays: 7,
      intervalMadDays: 1,
      daysSinceLastPurchase: 8,
      activeCityShare: 1,
      repeatScore: 0.9,
      dueScore: 1,
      stabilityScore: 0.8,
    },
    ...overrides,
  });
}

function candidate(overrides: Partial<ProductCandidate> = {}): ProductCandidate {
  return ProductCandidateSchema.parse({
    productId: "p-1",
    externalProductId: 40123,
    slug: "moloko-25-900",
    name: "Молоко 2,5% 900 г",
    imageUrl: null,
    price: 45.5,
    specialPrice: null,
    available: true,
    stock: 20,
    step: 1,
    displayRatio: 0.9,
    nutritionStatus: "insufficient",
    nutrition: null,
    promotions: [],
    ...overrides,
  });
}

function resolved(overrides: Partial<ResolvedNeed> = {}): ResolvedNeed {
  return ResolvedNeedSchema.parse({
    need: need(),
    selected: candidate(),
    alternatives: [candidate({ productId: "p-2", externalProductId: 40124, slug: "alt-a" })],
    ...overrides,
  });
}

function input(resolvedNeeds: ResolvedNeed[] = [resolved()]) {
  return {
    mode: "demo" as const,
    resolvedNeeds,
    customerContext: { familySize: 2, restrictionKeys: [], loyaltyBonusAvailable: null },
  };
}

const ALL_CODES = [
  "category_repeat",
  "cycle_due",
  "stable_cycle",
  "familiar_sku",
  "other_city_history",
  "quantity_uncertain",
];

it("covers exactly the reason codes the scorer can emit", () => {
  const scorer = readFileSync(join(process.cwd(), "src/features/prediction/score.ts"), "utf8");
  const emitted = [...scorer.matchAll(/reasonCodes(?:\.push\(|: string\[\] = \[)"([a-z_]+)"/g)]
    .map((match) => match[1]);

  expect(new Set(emitted)).toEqual(new Set(ALL_CODES));
  expect(Object.keys(REASON_CLAUSES).sort()).toEqual([...ALL_CODES].sort());
});

it("writes a reason a draft item would accept", () => {
  const reason = buildFallbackItem(resolved({ need: need({ reasonCodes: ALL_CODES }) })).reason;

  expect(reason.length).toBeGreaterThan(0);
  expect(reason.length).toBeLessThanOrEqual(MAX_REASON_LENGTH);
});

it("never states a price or a percentage", () => {
  const reason = buildFallbackItem(resolved({ need: need({ reasonCodes: ALL_CODES }) })).reason;

  expect(reason).not.toMatch(/₴|%|грн/i);
});

it("uses the server quantity and every resolver alternative", () => {
  const item = buildFallbackItem(resolved({ need: need({ typicalQuantity: 1.5 }) }));

  expect(item.quantity).toBe(2);
  expect(item.alternativeIds).toEqual(["p-2"]);
});

it("explains an empty draft rather than returning nothing", () => {
  const proposal = buildFallbackProposal(input([]));

  expect(proposal.items).toEqual([]);
  expect(proposal.summary.length).toBeGreaterThan(0);
});

it("produces a proposal the post-validator accepts unchanged", () => {
  const built = input();
  const result = validateProposal(buildFallbackProposal(built), built);

  expect(result.proposal.items).toHaveLength(1);
  expect(result.normalizations).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/features/agent/fallback.test.ts`
Expected: FAIL — `Cannot find module '@/features/agent/fallback'`.

- [ ] **Step 3: Implement the vocabulary and the builders**

Create `src/features/agent/fallback.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/features/agent/fallback.test.ts && pnpm typecheck`
Expected: PASS — 6 tests, clean typecheck.

If the first test fails because the regex does not match `score.ts`'s current formatting, fix the **regex**, not the vocabulary, and do not weaken it to a hard-coded list — the point is that it reads the scorer.

- [ ] **Step 5: Commit**

```bash
git add src/features/agent/fallback.ts src/features/agent/fallback.test.ts
git commit -m "feat: explain drafts deterministically from reason codes"
```

---

### Task 5: The attempt ladder and the model port

This is the task the backlog's acceptance behaviors mostly describe. It owns the `DraftModel` port, the two-attempt policy, the fallback ladder, and the final composition that guarantees one item per resolved need.

Note the deviation recorded in the spec, section 4, D2: the backlog's illustrative test has `generateDraftWithModel` *rejecting* on an unknown product ID, while its own step 5 requires a deterministic draft after two failures. Both cannot hold here, and the product requirement wins: the orchestrator never rejects for a model fault. The guardrail keeps its mechanical test one level down, in Task 2's `validateProposal`.

**Files:**
- Create: `src/features/agent/draft-agent.ts`
- Test: `src/features/agent/draft-agent.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: `DraftModelRequest`, `DraftModel`, `DraftGeneration`, `MAX_MODEL_ATTEMPTS`, `generateDraftWithModel(model, input): Promise<DraftGeneration>`. `generateDraft` is added in Task 6, once an adapter exists to compose.

- [ ] **Step 1: Write the failing test**

Create `src/features/agent/draft-agent.test.ts`:

```ts
import { expect, it, vi } from "vitest";

import { generateDraftWithModel, type DraftModel, type DraftModelRequest } from "@/features/agent/draft-agent";
import {
  NeedCandidateSchema,
  ProductCandidateSchema,
  ResolvedNeedSchema,
  type NeedCandidate,
  type ProductCandidate,
  type ResolvedNeed,
} from "@/features/shared/contracts";

function need(overrides: Partial<NeedCandidate> = {}): NeedCandidate {
  return NeedCandidateSchema.parse({
    categoryKey: "dairy",
    confidence: 0.8,
    confidenceBand: "high",
    typicalQuantity: 1,
    reasonCodes: ["category_repeat"],
    preferredExternalProductIds: [40123],
    features: {
      weightedPurchaseCount: 6,
      medianIntervalDays: 7,
      intervalMadDays: 1,
      daysSinceLastPurchase: 8,
      activeCityShare: 1,
      repeatScore: 0.9,
      dueScore: 1,
      stabilityScore: 0.8,
    },
    ...overrides,
  });
}

function candidate(overrides: Partial<ProductCandidate> = {}): ProductCandidate {
  return ProductCandidateSchema.parse({
    productId: "p-1",
    externalProductId: 40123,
    slug: "moloko-25-900",
    name: "Молоко 2,5% 900 г",
    imageUrl: null,
    price: 45.5,
    specialPrice: null,
    available: true,
    stock: 20,
    step: 1,
    displayRatio: 0.9,
    nutritionStatus: "insufficient",
    nutrition: null,
    promotions: [],
    ...overrides,
  });
}

function resolved(overrides: Partial<ResolvedNeed> = {}): ResolvedNeed {
  return ResolvedNeedSchema.parse({
    need: need(),
    selected: candidate(),
    alternatives: [candidate({ productId: "p-2", externalProductId: 40124, slug: "alt-a" })],
    ...overrides,
  });
}

function input(resolvedNeeds: ResolvedNeed[] = [resolved()]) {
  return {
    mode: "demo" as const,
    resolvedNeeds,
    customerContext: { familySize: 2, restrictionKeys: [], loyaltyBonusAvailable: null },
  };
}

interface RecordingModel extends DraftModel {
  requests: DraftModelRequest[];
}

/** Replies in order; a thrown entry simulates a provider failure. */
function fakeModel(...replies: unknown[]): RecordingModel {
  const requests: DraftModelRequest[] = [];
  return {
    requests,
    async generateProposal(request) {
      requests.push(request);
      const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
      if (reply instanceof Error) {
        throw reply;
      }
      return reply;
    },
  };
}

function goodReply(overrides: Record<string, unknown> = {}) {
  return {
    summary: "Чернетка за вашою історією покупок.",
    items: [{
      productId: "p-1",
      externalProductId: 40123,
      quantity: 1,
      reason: "Ви регулярно купуєте цю категорію.",
      alternativeIds: ["p-2"],
      ...overrides,
    }],
  };
}

it("accepts a valid proposal on the first attempt", async () => {
  const result = await generateDraftWithModel(fakeModel(goodReply()), input());

  expect(result.source).toBe("model");
  expect(result.attempts).toBe(1);
  expect(result.proposal.items[0].reason).toBe("Ви регулярно купуєте цю категорію.");
});

it("retries once after a schema-invalid reply and reports two attempts", async () => {
  const model = fakeModel({ summary: 5, items: "nope" }, goodReply());

  const result = await generateDraftWithModel(model, input());

  expect(result.source).toBe("model");
  expect(result.attempts).toBe(2);
  expect(model.requests).toHaveLength(2);
});

it("falls back deterministically when the model names an unknown product twice", async () => {
  const model = fakeModel(goodReply({ productId: "p-999" }));

  const result = await generateDraftWithModel(model, input());

  expect(result.source).toBe("fallback");
  expect(result.attempts).toBe(2);
  expect(result.proposal.items[0].productId).toBe("p-1");
});

it("falls back when the provider throws on both attempts", async () => {
  const model = fakeModel(new Error("503 upstream"));

  const result = await generateDraftWithModel(model, input());

  expect(result.source).toBe("fallback");
  expect(result.attempts).toBe(2);
});

it("carries violation codes into the retry prompt and no model text", async () => {
  const model = fakeModel(goodReply({ reason: "Лише 45 ₴ сьогодні" }), goodReply());

  await generateDraftWithModel(model, input());

  expect(model.requests[1].prompt).toContain("reason_contains_price");
  expect(model.requests[1].prompt).not.toContain("45 ₴");
});

it("does not call the model when nothing was resolved", async () => {
  const model = fakeModel(goodReply());

  const result = await generateDraftWithModel(model, input([]));

  expect(model.requests).toHaveLength(0);
  expect(result.attempts).toBe(0);
  expect(result.source).toBe("fallback");
  expect(result.proposal.items).toEqual([]);
});

it("completes a need the model omitted instead of dropping it", async () => {
  const second = resolved({
    need: need({ categoryKey: "water" }),
    selected: candidate({ productId: "p-9", externalProductId: 40199, slug: "water" }),
    alternatives: [],
  });
  const model = fakeModel(goodReply());

  const result = await generateDraftWithModel(model, input([resolved(), second]));

  expect(result.proposal.items.map((entry) => entry.productId)).toEqual(["p-1", "p-9"]);
  expect(result.normalizations).toContain("missing_need");
});

it("orders items by resolver confidence, not by the model's order", async () => {
  const second = resolved({
    need: need({ categoryKey: "water" }),
    selected: candidate({ productId: "p-9", externalProductId: 40199, slug: "water" }),
    alternatives: [],
  });
  const model = fakeModel({
    summary: "Чернетка.",
    items: [
      { productId: "p-9", externalProductId: 40199, quantity: 1, reason: "Вода.", alternativeIds: [] },
      { productId: "p-1", externalProductId: 40123, quantity: 1, reason: "Молоко.", alternativeIds: ["p-2"] },
    ],
  });

  const result = await generateDraftWithModel(model, input([resolved(), second]));

  expect(result.proposal.items.map((entry) => entry.productId)).toEqual(["p-1", "p-9"]);
});

it("never rejects for a model fault", async () => {
  const model: DraftModel = { generateProposal: vi.fn().mockRejectedValue(new Error("boom")) };

  await expect(generateDraftWithModel(model, input())).resolves.toMatchObject({ source: "fallback" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/features/agent/draft-agent.test.ts`
Expected: FAIL — `Cannot find module '@/features/agent/draft-agent'`.

- [ ] **Step 3: Implement the ladder**

Create `src/features/agent/draft-agent.ts`:

```ts
import {
  DraftProposalSchema,
  InvalidProposalError,
  validateProposal,
  type DraftAgentInput,
  type DraftProposal,
  type DraftProposalItem,
  type ProposalViolationCode,
} from "./draft-output";
import { buildFallbackItem, buildFallbackProposal } from "./fallback";
import {
  buildModelInput,
  buildRetryPrompt,
  buildSystemInstruction,
  buildUserPrompt,
} from "./prompt";

export type { DraftAgentInput } from "./draft-output";

export interface DraftModelRequest {
  system: string;
  prompt: string;
}

/**
 * Returns `unknown` on purpose: schema validation belongs to this module,
 * so a fake model can exercise both the schema path and the semantic path,
 * and swapping providers never touches the domain.
 */
export interface DraftModel {
  generateProposal(request: DraftModelRequest): Promise<unknown>;
}

export const MAX_MODEL_ATTEMPTS = 2;

export interface DraftGeneration {
  proposal: DraftProposal;
  source: "model" | "fallback";
  /** `0` means the model was never called, which is not a model failure. */
  attempts: number;
  normalizations: readonly ProposalViolationCode[];
}

/**
 * Fills any need the model left out. Composition lives here rather than in
 * the validator because `fallback.ts` imports `draft-output.ts`, so a
 * validator that called the fallback builder would close an import cycle.
 */
function completeProposal(
  proposal: DraftProposal,
  input: DraftAgentInput,
): { proposal: DraftProposal; completed: boolean } {
  const byProductId = new Map(proposal.items.map((item) => [item.productId, item]));
  let completed = false;

  const items: DraftProposalItem[] = input.resolvedNeeds.map((resolved) => {
    const existing = byProductId.get(resolved.selected.productId);
    if (existing !== undefined) {
      return existing;
    }
    completed = true;
    return buildFallbackItem(resolved);
  });

  return { proposal: DraftProposalSchema.parse({ summary: proposal.summary, items }), completed };
}

function fallbackGeneration(input: DraftAgentInput, attempts: number): DraftGeneration {
  return { proposal: buildFallbackProposal(input), source: "fallback", attempts, normalizations: [] };
}

/**
 * One structured Gemini call per attempt, at most two attempts, then the
 * deterministic draft. Never rejects for a model or provider fault: the
 * user gets an explainable draft either way.
 */
export async function generateDraftWithModel(
  model: DraftModel,
  input: DraftAgentInput,
): Promise<DraftGeneration> {
  if (input.resolvedNeeds.length === 0) {
    return fallbackGeneration(input, 0);
  }

  const modelInput = buildModelInput(input);
  const system = buildSystemInstruction();
  let issues: ProposalViolationCode[] = [];

  for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt += 1) {
    const prompt = attempt === 1 ? buildUserPrompt(modelInput) : buildRetryPrompt(modelInput, issues);
    try {
      const raw = await model.generateProposal({ system, prompt });
      const parsed = DraftProposalSchema.safeParse(raw);
      if (!parsed.success) {
        issues = ["schema_invalid"];
        continue;
      }

      const validated = validateProposal(parsed.data, input);
      const { proposal, completed } = completeProposal(validated.proposal, input);
      return {
        proposal,
        source: "model",
        attempts: attempt,
        normalizations: completed
          ? [...validated.normalizations, "missing_need"]
          : validated.normalizations,
      };
    } catch (error) {
      issues = error instanceof InvalidProposalError ? [...error.codes] : ["model_unavailable"];
    }
  }

  return fallbackGeneration(input, MAX_MODEL_ATTEMPTS);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/features/agent && pnpm typecheck`
Expected: PASS — all four agent suites, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/features/agent/draft-agent.ts src/features/agent/draft-agent.test.ts
git commit -m "feat: run the bounded Gemini attempt ladder"
```

---

### Task 6: The Google adapter

The last file, and the only one that imports the AI SDK. It contains no validation, no retry and no fallback: those all live in Task 5, which is why they are testable without touching a third-party module.

**Verify before writing code.** Read the installed package's own types and README for three things and report a mismatch as a spec deviation rather than guessing: whether `Output` is exported from `ai`; whether the thinking level is set as top-level `reasoning: "low"` or as `providerOptions.google.thinkingConfig.thinkingLevel`; and whether `createGoogleGenerativeAI` accepts a `fetch` option. The contract test depends on the third.

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`
- Create: `src/features/agent/google-model.ts`
- Modify: `src/features/agent/draft-agent.ts` (append `generateDraft` only)
- Test: `tests/contract/gemini-draft-model.test.ts`

**Interfaces:**
- Consumes: `DraftProposalSchema` from Task 1, `DraftModel` and `DraftModelRequest` from Task 5.
- Produces: `GoogleDraftModelOptions`, `DEFAULT_GENERATION_TIMEOUT_MS`, `createGoogleDraftModel(options): DraftModel`, and `generateDraft(input, options): Promise<DraftGeneration>` on `draft-agent.ts`.

- [ ] **Step 1: Install the provider**

Run: `pnpm add ai @ai-sdk/google`

Both resolve `@ai-sdk/provider@4.0.10` and `@ai-sdk/provider-utils@5.0.36`, which `@ai-sdk/mcp@2.0.45` already pins, so the install adds no duplicate provider core. Confirm that with `pnpm why @ai-sdk/provider` and stop to report it if a second version appears.

- [ ] **Step 2: Read the installed API surface**

Run: `ls node_modules/ai/dist/index.d.ts node_modules/@ai-sdk/google/dist/index.d.ts && grep -n "thinkingLevel\|reasoning?:\|declare function generateText\|Output" node_modules/@ai-sdk/google/dist/index.d.ts | head -30`

Note which spelling exists. Use it in step 4. Do not use `generateObject`: it is deprecated in `ai@7` in favour of `generateText` with an `output` setting.

- [ ] **Step 3: Write the failing contract test**

Create `tests/contract/gemini-draft-model.test.ts`. Assertions run against the **serialized request body** rather than named fields, because the Google wire format's field names are not what this repository controls — a substring assertion survives a provider rename while still proving the value was sent.

```ts
import { expect, it, vi } from "vitest";

import { createGoogleDraftModel } from "@/features/agent/google-model";

const API_KEY = "test-key-not-a-real-credential";

function geminiResponse(payload: unknown): Response {
  return new Response(
    JSON.stringify({
      candidates: [{
        content: { role: "model", parts: [{ text: JSON.stringify(payload) }] },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function stubFetch(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response();
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const proposal = {
  summary: "Чернетка.",
  items: [{
    productId: "p-1",
    externalProductId: 40123,
    quantity: 1,
    reason: "Ви регулярно купуєте цю категорію.",
    alternativeIds: [],
  }],
};

it("sends the configured model, zero temperature and a closed schema", async () => {
  const { fetch, calls } = stubFetch(() => geminiResponse(proposal));
  const model = createGoogleDraftModel({ apiKey: API_KEY, model: "gemini-3.7-flash", fetch });

  await model.generateProposal({ system: "system", prompt: "prompt" });

  const body = String(calls[0].init.body);
  expect(calls[0].url).toContain("gemini-3.7-flash");
  expect(body).toContain('"temperature":0');
  expect(body).not.toContain("anyOf");
  expect(JSON.stringify(calls[0].init.headers)).toContain(API_KEY);
});

it("asks for a low thinking level", async () => {
  const { fetch, calls } = stubFetch(() => geminiResponse(proposal));
  const model = createGoogleDraftModel({ apiKey: API_KEY, model: "gemini-3.7-flash", fetch });

  await model.generateProposal({ system: "system", prompt: "prompt" });

  expect(String(calls[0].init.body).toLowerCase()).toContain("low");
});

it("returns the generated object for the agent to validate", async () => {
  const { fetch } = stubFetch(() => geminiResponse(proposal));
  const model = createGoogleDraftModel({ apiKey: API_KEY, model: "gemini-3.7-flash", fetch });

  await expect(model.generateProposal({ system: "s", prompt: "p" })).resolves.toMatchObject({
    items: [{ productId: "p-1" }],
  });
});

it("surfaces a malformed response as an error, never as an empty draft", async () => {
  const { fetch } = stubFetch(() => geminiResponse({ nope: true }));
  const model = createGoogleDraftModel({ apiKey: API_KEY, model: "gemini-3.7-flash", fetch });

  await expect(model.generateProposal({ system: "s", prompt: "p" })).rejects.toThrow();
});

it("keeps the API key out of thrown errors", async () => {
  const { fetch } = stubFetch(() => new Response("upstream exploded", { status: 500 }));
  const model = createGoogleDraftModel({ apiKey: API_KEY, model: "gemini-3.7-flash", fetch });

  await expect(model.generateProposal({ system: "s", prompt: "p" }))
    .rejects.toSatisfy((error: unknown) => !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(API_KEY));
});
```

If the SDK rejects the stubbed envelope, fix the **stub** to match what the SDK's parser expects — read its response schema — and never loosen `DraftProposalSchema` or the adapter to accommodate a wrong stub.

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm vitest run tests/contract/gemini-draft-model.test.ts`
Expected: FAIL — `Cannot find module '@/features/agent/google-model'`.

- [ ] **Step 5: Implement the adapter**

Create `src/features/agent/google-model.ts`, using the thinking-level spelling confirmed in step 2:

```ts
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { Output, generateText } from "ai";

import type { DraftModel, DraftModelRequest } from "./draft-agent";
import { DraftProposalSchema } from "./draft-output";

/** Agent architecture section 11 requires a bounded generation run. */
export const DEFAULT_GENERATION_TIMEOUT_MS = 30_000;

export interface GoogleDraftModelOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** Injected by the contract test; production leaves it undefined. */
  fetch?: typeof globalThis.fetch;
}

/**
 * The only file in the repository that imports the AI SDK. It builds one
 * call and returns what came back; validation, retries and fallback all
 * belong to `draft-agent.ts`, which is why that module needs no SDK mock.
 *
 * The provider is constructed explicitly rather than through the ambient
 * `google` singleton so the key is passed in, never read from the
 * environment inside `src/features/agent/`.
 */
export function createGoogleDraftModel(options: GoogleDraftModelOptions): DraftModel {
  const provider = createGoogleGenerativeAI({ apiKey: options.apiKey, fetch: options.fetch });
  const timeoutMs = options.timeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS;

  return {
    async generateProposal(request: DraftModelRequest): Promise<unknown> {
      const result = await generateText({
        model: provider(options.model),
        system: request.system,
        prompt: request.prompt,
        output: Output.object({ schema: DraftProposalSchema }),
        temperature: 0,
        // The two-attempt policy belongs to `generateDraftWithModel`.
        // Leaving the SDK's own retry on would silently multiply it.
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(timeoutMs),
        providerOptions: { google: { thinkingConfig: { thinkingLevel: "low" } } },
      });
      return result.output;
    },
  };
}
```

- [ ] **Step 6: Compose the production entry point**

Add this import to the **top** of `src/features/agent/draft-agent.ts`, alongside the existing `./fallback` and `./prompt` imports:

```ts
import { createGoogleDraftModel, type GoogleDraftModelOptions } from "./google-model";
```

Then add this function at the **end** of the same file:

```ts
/**
 * The production entry point. `apiKey` and `model` come from `getServerEnv`
 * at the call site in Task 13, never from `process.env` here.
 */
export async function generateDraft(
  input: DraftAgentInput,
  options: GoogleDraftModelOptions,
): Promise<DraftGeneration> {
  return generateDraftWithModel(createGoogleDraftModel(options), input);
}
```

`google-model.ts` imports `DraftModel` from `draft-agent.ts` through `import type` only, so this pairing has no runtime cycle. Confirm the `import type` is present before moving on.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run src/features/agent tests/contract/gemini-draft-model.test.ts && pnpm typecheck`
Expected: PASS — all five suites, clean typecheck.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml src/features/agent/google-model.ts src/features/agent/draft-agent.ts tests/contract/gemini-draft-model.test.ts
git commit -m "feat: call Gemini through a swappable draft model port"
```

---

### Task 7: Documentation, full verification and integration

A rule that changed belongs in its owning document in the same change as the behavior. Three decisions in this work are not yet recorded anywhere normative: the zero-tool model call, the server-owned quantity, and the `DraftGeneration` envelope.

**Files:**
- Modify: `docs/tasks.md` (the Task 12 section only)
- Modify: `docs/agent-architecture.md` (sections 7, 9 and 12)

**Interfaces:**
- Consumes: the implemented behavior from Tasks 1–6.
- Produces: normative documentation matching that behavior, and one squashed commit on `main`.

- [ ] **Step 1: Record the decisions in the agent architecture**

In `docs/agent-architecture.md`:

- Section 7, after the five-tool list, add: «Ці п'ять tools є стелею, а не обов'язком. У MVP `CREATE_DRAFT` виконує один structured-output виклик без tools: resolver уже зібрав усіх кандидатів, а structured-output шлях AI SDK не підтримує tool calling. Task 12 лишається в межах обох лімітів.»
- Section 9, after the schema block, add: «`quantity` обчислює сервер. `executableQuantity` округлює `typicalQuantity` вгору до цілого `step` обраного товару й обмежує його `stock`; значення моделі завжди замінюється серверним. Модель може назвати кількість, але не може її змінити.» and «`generateDraft` повертає `DraftGeneration = { proposal, source, attempts, normalizations }`, щоб Task 17 міг рахувати model fallback rate, а Task 13 — записувати sanitized trace.»
- Section 12, in the "Gemini недоступний після двох спроб" row, add that the same deterministic builder also completes any need a successful model omitted, so a partial generation costs wording rather than recommendations.

- [ ] **Step 2: Record the ownership and interface in the backlog**

In `docs/tasks.md`, in the Task 12 section:

- extend the **Files** list with `src/features/agent/google-model.ts`, `src/features/agent/fallback.ts`, `src/features/agent/{draft-output,prompt,fallback}.test.ts` and `tests/contract/gemini-draft-model.test.ts`, each marked `(controller-approved addition)` in the style Task 11 uses;
- change the **Interfaces** «Produces» line to `generateDraft(input, options): Promise<DraftGeneration>` and note the envelope;
- replace the step 2 snippet's second assertion target so the unknown-ID rejection is asserted on `validateProposal`, and add one line recording that the orchestrator falls back rather than rejecting, per spec section 4, D2;
- tick the six checkboxes and append the completion line, following Task 11's wording: `Виконано 2026-09-08. Специфікація: [design](./superpowers/specs/2026-09-08-gemini-draft-agent-design.md). Живий виклик Gemini не виконано — немає API-ключа.`

- [ ] **Step 3: Run every gate**

Run each and paste real output into the handoff; do not summarize from memory:

```bash
pnpm vitest run src/features/agent tests/contract/gemini-draft-model.test.ts
```

```bash
pnpm test
```

```bash
pnpm typecheck && pnpm lint && pnpm build
```

Expected: all pass. `pnpm test` must show the Task 5, Task 10 and Task 11 suites still green as regression evidence. If `pnpm build` newly rewrites the `nextjs-agent-rules` block in `AGENTS.md`, commit that with the work rather than reverting it.

- [ ] **Step 4: Commit the documentation**

```bash
git add docs/tasks.md docs/agent-architecture.md
git commit -m "docs: record the draft agent's tool, quantity and envelope decisions"
```

- [ ] **Step 5: Squash onto main**

```bash
git checkout main
git merge --squash task-12-gemini-draft-agent
git commit -m "feat: generate drafts with Gemini"
```

Preserve the pre-existing unstaged `.gitignore` and `AGENTS.md` modifications: they are user-owned. Do not use `git checkout --` or `git clean` to tidy the workspace.

- [ ] **Step 6: Hand off**

Report changed files, every command with its real output, the remaining verification limits from spec section 9 — no Google API key exercised, `gemini-3.7-flash` unverified against the live catalogue, the thinking-level spelling as confirmed in Task 6 step 2 — and the commit hash.
