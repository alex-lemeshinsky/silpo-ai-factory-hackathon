# Task 12 Gemini Draft Agent Specification

Status: approved on 2026-09-08, not yet implemented. The file-ownership expansion in section 3 and the three deviations in section 4 were approved before code work.

## 1. Scope and authority

Refines [Task 12](../../tasks.md#task-12-gemini-draft-agent) and is executed through its implementation plan. [AGENTS.md](../../../AGENTS.md), the [product specification](../../product-spec.md), the [project architecture](../../project-architecture.md), the [agent architecture](../../agent-architecture.md), and the read-only [Silpo reference](../../../SILPO_MCP.md) retain precedence.

Build the model boundary that turns verified `ResolvedNeed[]` into an explained `DraftProposal`: a Gemini-compatible output schema, a deterministic privacy filter and prompt builder, a provider adapter behind a `DraftModel` port, semantic post-validation against the run's own allowlist, and a deterministic reason-code fallback that guarantees the user a draft even when Gemini never succeeds.

Excluded: draft orchestration, persistence and the `POST /api/drafts` route (Task 13); the gateway composition `createSilpoGateway` (Task 13); UI (Tasks 14–15); approval, cart writes and verification (Task 16); diagnostics traces and metric aggregation (Task 17). Task 12 opens no MCP session, touches no database, and performs no cart write.

## 2. Baseline and dependencies

Inspected commit: `05495cc9863bfa9d211b07a1df9373a526e10381`. The existing `.gitignore` and `AGENTS.md` modifications in the working tree are user-owned and outside this work.

| Existing evidence | Design consequence |
|---|---|
| Tasks 1–11 are integrated; Task 12 is unchecked | Implement on those boundaries; do not recreate their output. |
| `ResolvedNeed`, `NeedCandidate`, `ProductCandidate`, `CustomerContext` and `DraftItem` already exist in `src/features/shared/contracts.ts` | The agent's input and the eventual draft shape are fixed. Task 12 introduces no shared-contract change. |
| `DraftItemSchema` requires `quantity` to be step-aligned and `<= stock`, and requires a non-empty `reason` of at most 160 characters | Whatever Task 12 produces must survive Task 13's assembly into a `DraftItem`. Quantity and reason length are hard obligations, not preferences. |
| `DraftSchema` caps items at ten and rejects a duplicate `productId` | A proposal may name at most ten distinct products. `resolveProducts` already caps needs at ten and excludes a product across needs, so the cap is reachable but never exceeded. |
| Task 5's `score.ts` emits exactly six reason codes: `category_repeat`, `cycle_due`, `stable_cycle`, `familiar_sku`, `other_city_history`, `quantity_uncertain` | The fallback vocabulary is closed and can be pinned by a test in both directions. |
| The Task 5 specification, section P5-04, states that `typicalQuantity` is advisory history evidence in the history's own unit and that "these tasks create no executable cart quantities" | Task 11 created none either. Task 12 is the first place an executable, step-aligned quantity can exist; see T12-05. |
| `resolveProducts` returns needs in prediction's confidence order and guarantees every returned candidate is available, in stock, at least one whole package, non-service and dietary-compatible | The agent never re-checks purchasability and never reorders needs. |
| `src/lib/env.ts` already validates `GOOGLE_GENERATIVE_AI_API_KEY` and `AGENT_MODEL` (default `gemini-3.7-flash`) | No environment change. The adapter receives both as explicit arguments rather than reading `process.env`. |
| `src/lib/result.ts` already declares the `model_invalid_output` code | Task 12 owns no route and needs no new `AppErrorCode`. |
| `ai` and `@ai-sdk/google` are absent; `@ai-sdk/mcp@2.0.45` pins `@ai-sdk/provider@4.0.10` and `@ai-sdk/provider-utils@5.0.36` | `ai@7` and `@ai-sdk/google@4` resolve to exactly those two, so the install adds no duplicate provider core. |
| `generateObject` is deprecated in `ai@7` in favour of `generateText` with an `output` setting | Use `generateText` + `Output.object`. Do not introduce a deprecated entry point in new code. |
| `z.toJSONSchema` exists in the installed Zod 4.5.4 and emits `additionalProperties: false` object schemas | Google structured-output compatibility can be enforced mechanically instead of by prose; see T12-01. |
| `vitest.config.ts` runs `src/**` and `tests/**` in the ordinary sweep | No test-configuration change. |

Planning prerequisite evidence: `pnpm vitest run src/features/products/resolve-products.test.ts src/features/shared/contracts.test.ts src/features/prediction/score.test.ts` — **3 files, 72 tests passed** on 2026-09-08. This proves prerequisite behavior only; it proves nothing about Task 12.

## 3. Approved scope resolution

The backlog grants three implementation files and one test file, plus `package.json` and `pnpm-lock.yaml` through its commit line. Four behaviors have no home in that list. The following additions were proposed and approved on 2026-09-08 before code work.

| Paths | Purpose |
|---|---|
| `src/features/agent/google-model.ts`, `tests/contract/gemini-draft-model.test.ts` | Isolate the only file that imports the AI SDK, so `draft-agent.ts` stays testable without SDK mocking and the `DraftModel` port of agent architecture section 16 becomes a real boundary. The contract test drives the real adapter through an injected `fetch`. |
| `src/features/agent/fallback.ts`, `.test.ts` | The `reasonCode → Ukrainian copy` vocabulary and the deterministic proposal builder, kept out of the orchestrator the way `category-queries.ts` is kept out of the resolver. |
| `src/features/agent/prompt.test.ts` | The privacy filter is a deterministic function that agent architecture section 8 requires to have its own unit test. |
| `src/features/agent/draft-output.test.ts` | Schema shape, Google compatibility, and semantic post-validation. |
| `docs/tasks.md`, `docs/agent-architecture.md` | Record the single-call decision, the quantity authority, the return envelope and this ownership in their owning documents. |

No edit to `src/features/shared/contracts.ts`, `src/lib/env.ts`, `src/lib/result.ts`, `src/db/schema.ts`, `src/features/prediction/*`, `src/features/products/*`, `src/features/purchases/*`, `src/features/silpo/*`, `vitest.config.ts`, `fixtures/demo/silpo-snapshot.json` or `SILPO_MCP.md` is required or permitted.

## 4. Approved deviations from the backlog

**D1 — `generateDraft` returns an envelope, not a bare proposal.** The backlog's interface line reads `generateDraft(input): Promise<DraftProposal>`. Agent architecture section 14 requires a *model fallback rate* online metric and section 13 requires a sanitized correlation trace; neither is computable from a bare proposal, because the caller cannot tell a model-authored draft from a deterministic one. `generateDraft` therefore returns `DraftGeneration = { proposal, source, attempts, normalizations }`. This is a refinement that strengthens compliance, not a weakening.

**D2 — the unknown-ID rejection is tested on the validator, not on the orchestrator.** The backlog's step 2 shows `generateDraftWithModel(fakeModelReturningUnknownId, input)` rejecting with `"unknown product"`, while its own step 5 requires that two model failures produce a deterministic draft rather than none. A fake that always returns an unknown ID satisfies both conditions at once, so the two lines cannot both hold at the orchestrator. The product requirement wins there: `generateDraftWithModel` never rejects for a model or provider fault. The guardrail keeps a mechanical test by moving down one level — the pure `validateProposal` throws `UnknownProductError`, whose message contains `unknown product`, and the orchestrator's own test asserts that this rejection is what drives the retry and then the fallback.

**D3 — Gemini receives no tools.** Agent architecture section 7 permits at most five high-level tools per step and section 11 at most six model steps. Both are ceilings. Section 5 steps 8 and 9 describe one prompt and one returned `DraftProposal`, section 9 post-validates against resolver input that exists only because the server already fetched it, and the AI SDK's structured-output path cannot call tools at all. Task 12 makes exactly one model call per attempt with zero tools, which is inside both ceilings. The five-tool surface stays documented in the agent architecture as a capability that no MVP task requires; a later task may claim it if a real need for model-initiated lookups appears.

## 5. Approach and trade-offs

**A thin provider adapter behind a pure orchestrator.** `google-model.ts` builds the AI SDK call and nothing else. `draft-agent.ts` owns attempts, validation, fallback and ordering, and imports no AI SDK symbol, so its entire suite runs against a hand-written fake model. Alternatives considered: putting the SDK call inside `draft-agent.ts` would make every orchestration test mock a third-party module and would put a provider detail on the same page as the retry policy; passing the AI SDK's `LanguageModel` itself as the seam would leak provider types into the domain and make the swap in section 16 a type change rather than a file change.

**A whitelist projection rather than field deletion.** `buildModelInput` constructs its output field by field from a declared type. Deleting or redacting fields from a domain object would work today and silently leak tomorrow: the moment `ProductCandidate` gains a field, a blacklist admits it by default and a whitelist excludes it by default. The cost is one mapping function to keep in step with genuinely new model-relevant facts, which is the correct place for that decision to be made deliberately.

**Reject versus normalize decided by one question.** Every post-validation outcome answers: does this anomaly risk showing the user an unverified fact? If yes, reject and let the retry-then-fallback ladder handle it. If no, replace the model's value with the server's and continue. The alternative of rejecting everything makes a stray alternative ID cost the user a model-authored draft; the alternative of repairing everything erodes the guardrail until "post-validated" means only "schema-valid". The single question keeps both the rule and its test list short.

**A fallback that also completes partial output.** `buildFallbackProposal` is not only the two-failures escape hatch; the same per-need builder fills any need the model omitted. One code path means the deterministic draft and the completed model draft cannot drift apart in wording, and it makes the deterministic engine — not the model — the thing that decides which needs reach the user.

**Nutrition status without nutrient values.** Agent architecture section 8 permits known nutrition attributes in model input. Task 12 passes `nutritionStatus` only. The model's job is to label «даних недостатньо», which the status alone supports; the design system renders nutrition in its own field, so nutrient numbers in the prompt would buy nothing and would give the model figures to restate in prose. Section 8's list is a ceiling, and narrowing inside it is safe.

## 6. Global constraints

- Use `pnpm` exclusively. Task 12 adds exactly two production dependencies: `ai` and `@ai-sdk/google`.
- `src/features/agent/*` imports no React, no Next.js, no MCP SDK, no database client, and no `src/db/*` or `src/components/*` symbol. Only `google-model.ts` imports `ai` or `@ai-sdk/google`.
- The module graph inside `src/features/agent/` runs one way: `draft-output.ts` depends on nothing else in the directory; `prompt.ts` and `fallback.ts` depend on it; `draft-agent.ts` depends on all three and on `google-model.ts`. `google-model.ts` therefore takes `DraftModel` from `draft-agent.ts` through `import type` only, so the one cycle in the graph is erased at compile time and never exists at runtime.
- Do not edit any file outside the ownership table in section 3.
- Gemini never invents or alters a product ID, price, special price, stock level, promotion, package `step`, `displayRatio`, nutrition value, quantity or checkout state.
- Model input never contains a full name, phone, email, precise address, loyalty barcode, profile ID, session ID, idempotency key, OAuth token, database key, checkout URL, raw receipt or raw MCP payload.
- `GOOGLE_GENERATIVE_AI_API_KEY` is passed explicitly to the adapter, never read from `process.env` inside `src/features/agent/*`, and never appears in a prompt, an error message, a test or a log line.
- Raw prompts and raw model output are never logged.
- Model-output schemas use objects and arrays only: no `z.union`, no `z.record`, no `z.discriminatedUnion`, no optional-versus-nullable mixing that produces `anyOf`.
- At most two model attempts per draft run. The AI SDK's own retry is disabled so the attempt count stays exactly what this specification says.
- The full generation run is bounded by a timeout.
- `generateDraft` never rejects because of a model or provider fault.
- Output is deterministic given a deterministic model: the same inputs produce the same proposal in the same order.
- Finish implementation in one focused commit: `feat: generate drafts with Gemini`.

## 7. Requirements

### T12-01 — Output schema

`src/features/agent/draft-output.ts` exports `DraftProposalSchema` exactly as normalized in agent architecture section 9:

```ts
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
```

The module also exports the inferred `DraftProposal` and `DraftProposalItem` types; `fallback.ts` builds one item at a time and needs the element type by name.

The schema is the wire contract with Google and stays free of refinements, transforms, unions and records. Every field is required and non-nullable, so the emitted JSON Schema contains no `anyOf` or `oneOf`.

A test converts the schema with `z.toJSONSchema` and asserts the result contains none of `anyOf`, `oneOf`, `allOf`, `not`, `patternProperties` or `additionalProperties: true` at any depth. This is the mechanical enforcement of the "compatible with Google structured output" invariant; the prose rule in `AGENTS.md` stays, but it is no longer the only guard.

Business-rule tightening belongs to T12-04 and to `DraftItemSchema`, not here. In particular `externalProductId` is not constrained to be non-negative at this boundary: a negative value is a semantic violation, caught by the allowlist check with a useful message, rather than a schema error that costs an attempt.

### T12-02 — Model input and the privacy filter

`src/features/agent/prompt.ts` exports `buildModelInput(input: DraftAgentInput): ModelDraftInput`, a pure synchronous function.

```ts
export interface DraftAgentInput {
  mode: DataMode;
  resolvedNeeds: ResolvedNeed[];
  customerContext: CustomerContext;
}
```

`ModelDraftInput` is a declared type built field by field. No domain object is spread into it, and no property is copied by iteration. It contains exactly:

- `mode` and `locale`, where `locale` is the constant `"uk-UA"`;
- `familySize` from `CustomerContext`, which is an aggregate count and carries no name;
- `restrictionKeys`, already normalized flags from Task 4's vocabulary;
- one entry per resolved need holding `categoryKey`, `confidence`, `confidenceBand`, `reasonCodes`, the server-computed `quantity` from T12-05, the selected product, and its alternatives.

Each product entry contains exactly `productId`, `externalProductId`, `name`, `price`, `specialPrice`, `inStock` (always `true` by construction, retained so the model is never asked to assume it), `promotionLabels` (the `label` field of each promotion, without IDs or prices) and `nutritionStatus`.

Deliberately excluded, narrowing section 8's ceiling: `slug`, `imageUrl`, `step`, `displayRatio`, the numeric `stock`, promotion IDs and promotion prices, the `NeedFeatures` block, nutrient values, and `loyaltyBonusAvailable`. Loyalty is excluded because a bonus is never applied automatically and mentioning it in a draft explanation would invite prose that implies it was.

`prompt.test.ts` proves the filter structurally, not by reading the prompt for known strings alone: it passes domain objects carrying extra properties whose values are recognizable poison — a phone number, a street address, a loyalty barcode, an OAuth-shaped token, a database UUID — and asserts that none of those values appears anywhere in `JSON.stringify(buildModelInput(...))` or in the built prompt. A second test asserts the exact key set of a product entry, so adding a field to the projection requires updating the test on purpose.

### T12-03 — Prompt construction

`prompt.ts` also exports:

- `buildSystemInstruction(): string` — a module-level constant covering every bullet of agent architecture section 10: the role is explanation and ranking, never prediction, never checkout; use only the supplied IDs and facts; never state a price, stock level, composition, nutrition value or promotion; write short Ukrainian explanations; report `nutritionStatus: "insufficient"` as «даних недостатньо»; never mention personal details; never recommend bags, delivery, acceleration or other service rows; return structured output only. It does not restate the confidence formula — confidence and reason codes arrive as facts.
- `buildUserPrompt(modelInput: ModelDraftInput): string` — a short Ukrainian framing line followed by the JSON serialization of `modelInput`. JSON keeps the payload compact and unambiguous about which ID belongs to which need.
- `buildRetryPrompt(modelInput: ModelDraftInput, issues: string[]): string` — the same payload plus a list of normalized violation codes from the previous attempt. It carries violation codes only. It never echoes the model's own text back, so a malformed or hostile generation cannot re-enter the next prompt.

### T12-04 — Semantic post-validation

`draft-output.ts` exports `validateProposal(proposal: DraftProposal, input: DraftAgentInput): ValidatedProposal`, where `ValidatedProposal` is `{ proposal: DraftProposal; normalizations: readonly ProposalViolationCode[] }`. Rejections travel as the `codes` field of a thrown error; normalizations have to travel as a return value, or T12-09's trace obligation has no channel and "recorded for the trace" is unimplementable.

`DraftAgentInput` is declared in this module rather than in `prompt.ts`, because `prompt.ts` imports `executableQuantity` from here and the dependency must not run both ways.

It builds the run's allowlist from `input.resolvedNeeds` — for each need, the selected product and its alternatives — and applies one question to every anomaly: *does this risk showing the user an unverified fact?*

**Rejected**, by throwing `UnknownProductError` (message contains `unknown product`) or `InvalidProposalError` with a normalized violation code:

- an item `productId` that is not the selected product of some resolved need;
- an `externalProductId` that disagrees with the server's value for that `productId`, since it is the key Task 16 writes to the cart;
- an `alternativeId` absent from that same need's alternatives — an alternative belonging to a different need included;
- a `reason` that is empty after trimming;
- a `reason` containing a currency amount or a percentage, matched as a digit separated by at most whitespace from `₴`, `%`, `грн` or `UAH`, in either order. Price and discount are server facts the UI renders in their own fields; prose carrying one is inventing a fact the post-validator cannot check.

**Normalized**, with the model's value replaced and a violation code recorded for the trace:

- `quantity` — always replaced by the server value from T12-05, whether or not the model agreed. The `quantity_replaced` code is recorded only when the model's value actually differed, so the code stays a signal rather than appearing on every run;
- item order — the returned items follow `input.resolvedNeeds` order, which prediction already sorted by confidence. The model's ranking authority is over `alternativeIds` within a need, not over which needs matter;
- a duplicate `productId` — the first occurrence is kept and later ones dropped, since `DraftSchema` rejects a draft naming one product twice;
- `alternativeIds` the model omitted — appended after the ones it named, in resolver order, so no swap option silently disappears from the UI. The model's own order is preserved for the IDs it did name.

`summary` is passed through after trimming. It is already length-bounded by the schema, and it names no product, so it carries no ID to verify.

`validateProposal` returns items only for the needs the model actually named, in resolver order. Completing an omitted need is the orchestrator's job under T12-08, not the validator's: `fallback.ts` depends on `executableQuantity` from this module, so a validator that called the fallback builder would close an import cycle between the two files.

### T12-05 — Quantity authority

`draft-output.ts` exports `executableQuantity(need: NeedCandidate, product: ProductCandidate): number`, a pure function, and it is the only source of a draft quantity in the system.

The Task 5 specification, section P5-04, establishes that `typicalQuantity` is advisory history evidence expressed in the history's own unit and that prediction creates no executable cart quantity. Task 11 created none either. Task 12 creates the first one, from server facts alone:

1. start from `need.typicalQuantity`;
2. round **up** to the nearest multiple of `product.step`, so at least the habitual amount is proposed and the result satisfies `DraftItemSchema`'s step-alignment rule;
3. clamp to the largest multiple of `step` not exceeding `product.stock`;
4. the result is never below one `step`, which `resolveProducts` already guaranteed to be purchasable.

Rounding is performed on the multiplier with the same `1e-9` tolerance the codebase already uses for float comparison, so a `typicalQuantity` that is already an exact multiple of `step` is not pushed to the next one by representation error.

This satisfies the `AGENTS.md` invariant that the deterministic engine computes quantities, while keeping `quantity` in the wire schema where agent architecture section 9 normatively places it. The model may state a quantity; it can never change one.

### T12-06 — The `DraftModel` port and the Google adapter

`draft-agent.ts` declares the port:

```ts
export interface DraftModelRequest { system: string; prompt: string }
export interface DraftModel {
  generateProposal(request: DraftModelRequest): Promise<unknown>;
}
```

The port returns `unknown`, so schema validation stays inside the pure agent and a fake model can exercise both the schema path and the semantic path.

`google-model.ts` exports `createGoogleDraftModel(options: { apiKey: string; model: string; timeoutMs?: number; fetch?: typeof globalThis.fetch }): DraftModel`. It:

- builds the provider with `createGoogleGenerativeAI({ apiKey, fetch })` rather than the ambient `google` singleton, so the key is explicit and the contract test can inject `fetch`;
- calls `generateText` with `output: Output.object({ schema: DraftProposalSchema })`. `generateObject` is deprecated in `ai@7` and is not used;
- sets `temperature: 0` for the low randomness the agent architecture requires;
- sets thinking level `low`. The exact spelling — the top-level `reasoning: "low"` setting or `providerOptions.google.thinkingConfig.thinkingLevel` — must be read from the installed package's own types and documentation at implementation time and not guessed; `thinking: medium` is not used anywhere in Task 12;
- sets `maxRetries: 0`, because the two-attempt policy belongs to `generateDraft`. Leaving the SDK's default in place would silently multiply the attempt count;
- bounds the call with an `AbortSignal` timeout;
- returns the generated object as `unknown` and lets any SDK error, `NoObjectGeneratedError` included, propagate to the orchestrator as a failed attempt.

The adapter contains no validation, no retry and no fallback logic.

### T12-07 — Deterministic fallback

`src/features/agent/fallback.ts` exports a frozen `reasonCode → Ukrainian clause` vocabulary, `buildFallbackItem(resolvedNeed): DraftProposalItem`, and `buildFallbackProposal(input: DraftAgentInput): DraftProposal`.

The vocabulary covers exactly the six codes `score.ts` emits. A test pins it in both directions: every code the scorer can produce has a clause, and every clause maps to a code the scorer can produce, so a code added to Task 5 cannot silently lose its copy. An unknown code contributes nothing and is not an error.

A fallback `reason` is composed from the need's codes in a fixed priority order, joined into one Ukrainian sentence and truncated at a word boundary to 160 characters so `DraftItemSchema` accepts it. It states only what the reason codes already assert — recurrence, due cycle, cycle stability, a familiar SKU, other-city history, quantity uncertainty — and never a price, a discount or a nutrition claim.

The fallback `summary` states the item count without a plural-agreement helper, so `src/features/agent/*` needs no import from `src/components/*` and no second copy of `pluralizeUk`.

`alternativeIds` are the need's alternatives in resolver order. `quantity` comes from `executableQuantity`. The result passes `DraftProposalSchema` and `validateProposal` unchanged — a test asserts this, because a fallback the post-validator would reject is not a fallback.

### T12-08 — Orchestration, attempts and fallback ladder

`draft-agent.ts` exports:

```ts
export interface DraftGeneration {
  proposal: DraftProposal;
  source: "model" | "fallback";
  attempts: number;
  normalizations: readonly ProposalViolationCode[];
}
export function generateDraftWithModel(model: DraftModel, input: DraftAgentInput): Promise<DraftGeneration>;
export function generateDraft(input: DraftAgentInput, options: { apiKey: string; model: string }): Promise<DraftGeneration>;
```

`generateDraft` is the thin composition: it constructs the Google adapter and delegates. `generateDraftWithModel` is the unit under test.

The ladder:

1. `input.resolvedNeeds` is empty — return `buildFallbackProposal(input)` with an empty item list, `source: "fallback"` and `attempts: 0`. The model is not called: there is nothing to explain, and agent architecture section 12 allows an empty explained draft for insufficient history. `attempts: 0` is what distinguishes "never attempted" from "attempted and failed" when Task 17 computes the model fallback rate.
2. Attempt 1 — `buildModelInput`, `buildSystemInstruction`, `buildUserPrompt`, then `model.generateProposal`. Parse with `DraftProposalSchema.safeParse`, then `validateProposal`. Success returns `{ source: "model", attempts: 1 }`.
3. Any failure of attempt 1 — a thrown provider error, a schema failure or a rejected semantic violation — leads to attempt 2 with `buildRetryPrompt` carrying the normalized violation codes.
4. Attempt 2 succeeding returns `{ source: "model", attempts: 2 }`.
5. Attempt 2 failing returns `buildFallbackProposal(input)` with `source: "fallback"` and `attempts: 2`.

After a successful attempt, the orchestrator composes the final item list: the validated items, plus `buildFallbackItem` for every resolved need the model omitted, ordered by `input.resolvedNeeds`. The result therefore always holds exactly one item per resolved need, whichever source produced it, and a model that names only half the needs costs the user wording rather than recommendations. This composition lives here because `fallback.ts` already imports `executableQuantity` from `draft-output.ts`; putting it in the validator would close an import cycle.

`generateDraftWithModel` never rejects for a model or provider fault. It rejects only for a programming fault in its own input, which `resolveProducts` output cannot produce.

Every returned proposal, from either source, has passed `DraftProposalSchema` and `validateProposal`, so Task 13 can assemble a `DraftItem` from any of them without re-checking IDs.

### T12-09 — Observability boundary

Task 12 writes no log line and creates no trace. It returns `source` and `attempts` so that Task 13's service, which owns the correlation ID, can record them. Violation codes are normalized short identifiers such as `unknown_product`, `external_id_mismatch`, `alternative_not_in_need`, `reason_contains_price`, `quantity_replaced`, `duplicate_product`, `missing_need`. They contain no model text, no product name and no prompt fragment, so a later task can log them safely.

### T12-10 — Test evidence

`src/features/agent/draft-agent.test.ts` drives the orchestrator through hand-written fake models: a valid proposal accepted on the first attempt; a schema-invalid first attempt recovered on the second and reported as `attempts: 2`; a model returning an unknown product ID twice landing on the deterministic fallback rather than rejecting; a provider that throws on both attempts landing on the fallback; the retry prompt differing from the first prompt and carrying violation codes but no model text; an empty `resolvedNeeds` returning an empty proposal with `attempts: 0` and no model call; the recorded prompt containing none of the injected poison values; item order following resolver order regardless of the model's order; a need the model omitted present in the output with fallback copy.

`src/features/agent/draft-output.test.ts` covers the emitted JSON Schema's Google compatibility, every rejection in T12-04, every normalization in T12-04, and the `executableQuantity` cases of T12-05: below one step, an exact multiple, a fractional multiple rounded up, and a demand exceeding stock clamped down.

`src/features/agent/prompt.test.ts` covers the structural privacy assertions and the product-entry key set of T12-02, and asserts the system instruction states the no-invention and «даних недостатньо» rules.

`src/features/agent/fallback.test.ts` covers the two-directional vocabulary pinning, reason truncation at a word boundary within 160 characters, the absence of any price or percentage in generated copy, and that a fallback proposal passes `validateProposal` unchanged.

`tests/contract/gemini-draft-model.test.ts` drives `createGoogleDraftModel` with an injected `fetch`: the request carries the configured model ID, `temperature: 0`, the thinking-level setting and a response schema containing no `anyOf`; a well-formed response parses to the expected object; a malformed response surfaces as a thrown error rather than a silently empty proposal; the API key appears in the request the SDK builds but in no thrown error message.

## 8. Acceptance matrix

| ID | Required evidence | Primary test location |
|---|---|---|
| T12-01 | Schema matches the normative shape; emitted JSON Schema has no `anyOf`, `oneOf`, `allOf`, `not`, `patternProperties` or open objects at any depth | `draft-output.test.ts` |
| T12-02 | Injected phone, address, barcode, token and database ID appear nowhere in the model input or prompt; product-entry key set is exact | `prompt.test.ts` |
| T12-03 | System instruction covers every section 10 bullet; retry prompt carries violation codes and no model text | `prompt.test.ts`, `draft-agent.test.ts` |
| T12-04 | Each rejection rejects and each normalization normalizes; validated items come back in resolver order | `draft-output.test.ts` |
| T12-05 | Quantity is step-aligned, at least one step, never above stock, and independent of the model's value | `draft-output.test.ts` |
| T12-06 | Adapter sends the configured model, zero temperature, low thinking, `maxRetries: 0` and a closed schema; errors propagate; key never in an error message | `gemini-draft-model.test.ts` |
| T12-07 | Vocabulary pinned both ways against `score.ts`; fallback copy free of price and percentage; fallback passes `validateProposal` | `fallback.test.ts` |
| T12-08 | Full ladder including two-failure fallback, `attempts` reported correctly, empty input short-circuit, no rejection for a model fault, one item per resolved need after composition | `draft-agent.test.ts` |
| T12-09 | Violation codes are normalized identifiers carrying no model text or product name | `draft-output.test.ts` |
| T12-10 | Focused suites pass from a clean invocation alongside `pnpm typecheck` | `pnpm vitest run src/features/agent tests/contract/gemini-draft-model.test.ts` |

## 9. Completion and handoff

The implementer must show red-to-green output for every suite named above, the unchanged Task 5 and Task 11 suites as regression evidence, and `pnpm test`, `pnpm typecheck`, `pnpm lint` and `pnpm build`. All automated tests use synthetic inputs and a fake or stubbed transport; no test calls Google and no test contains a real API key.

**Known verification limits:**

- No Google API key is exercised in the test suite, so the real Gemini request and response shape is proven only against the SDK's own serialization through an injected `fetch`, not against the live service. A one-off manual generation against `gemini-3.7-flash` should be run once a key is available, and any schema rejection reported as a spec deviation rather than fixed by loosening `DraftProposalSchema`.
- The default model string `gemini-3.7-flash` comes from `src/lib/env.ts` and is unverified against the live model catalogue in this environment. Do not substitute another model ID; report a mismatch instead.
- The thinking-level option's exact spelling must be confirmed against the installed `@ai-sdk/google` types before use. If the installed version exposes neither form, report it rather than shipping a silently ignored option.
- Demo latency targets in agent architecture section 11 are measured by Task 18, not here.

The handoff lists changed files, the exact commands and results, the remaining verification limits, and the commit hash. Task 12 stays unchecked in the backlog until implemented, reviewed and integrated.
