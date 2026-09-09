# AGENTS.md

## Mission

Build the «Автопілот запасів» MVP as an explainable, action-first web application that predicts recurring grocery needs from Silpo purchase history, prepares an editable draft, and writes only explicitly approved products to a verified Silpo cart.

Optimize the repository for agent legibility: durable knowledge lives in versioned docs, modules have narrow responsibilities, external boundaries are typed and validated, and every task has a fast evidence-producing feedback loop.

## Source of truth

Use this precedence when instructions conflict:

1. The active user request.
2. This `AGENTS.md` for repository-wide working rules and invariants.
3. The relevant normative document in `docs/` for desired behavior.
4. The assigned task in `docs/tasks.md` for implementation sequence and file ownership.
5. Existing code and tests as evidence of current behavior, not permission to contradict the desired behavior.

Do not silently choose between contradictory sources. Stop, identify the exact conflict, and ask the controller or user to resolve it. A task plan may refine implementation details but may not weaken product, safety, architecture, or design requirements.

## Required reading

Read only the context needed for the assigned work, in this order:

1. `AGENTS.md`.
2. `docs/product-spec.md`.
3. The assigned task and its prerequisites in `docs/tasks.md`.
4. `docs/project-architecture.md` for application, integration, persistence, security, deployment, or test work.
5. `docs/agent-architecture.md` for prediction, product resolution, Gemini, prompts, structured output, fallback, or eval work.
6. `docs/design-system.md` for UI, copy, responsive behavior, accessibility, or visual review.
7. `SILPO_MCP.md` for any Silpo MCP or cart-context change.

Do not load every task into context when one task is assigned. Follow links only when they govern that task.

## Repository map

```text
AGENTS.md                    repository operating contract
docs/product-spec.md        product scope, flows, trust rules, MVP acceptance
docs/project-architecture.md modules, boundaries, data, security, deployment, tests
docs/agent-architecture.md   deterministic/LLM boundary, tools, prompts, fallback, evals
docs/design-system.md        visual tokens, components, states, responsive, accessibility
docs/tasks.md                dependency graph and detailed TDD backlog
SILPO_MCP.md                 local read-only Silpo MCP integration reference
```

The repository is the system of record. If a behavior or invariant changes, update the owning document in the same commit. Do not leave durable decisions only in chat, a commit message, or a task report.

## Golden principles

- Prefer explicit boundaries over clever coordination.
- Enforce invariants mechanically where possible; do not rely only on prose or prompt obedience.
- Parse external data at the boundary. Never probe guessed object shapes.
- Keep pure domain logic independent from frameworks and providers.
- Keep files focused enough that one agent can understand and test them in isolation.
- Reuse established ports, schemas, repositories, tokens, and test helpers instead of creating parallel abstractions.
- Make failures actionable: normalized status, safe context, correlation ID, and a clear next step.
- Keep changes small, reviewable, reversible, and tied to one acceptance boundary.
- Treat agent mistakes as harness feedback: improve contracts, tests, fixtures, docs, or tooling so the same class of mistake is harder to repeat.
- Pay down local drift while touching a module, but do not start unrelated refactors.

## Architecture invariants

- The product is a Next.js modular monolith, not a distributed or runtime multi-agent system.
- Dependency direction is `UI → Route Handler → Application Service → Domain + Ports`, with infrastructure adapters implementing ports.
- `src/features/purchases` and `src/features/prediction` remain pure TypeScript and do not import React, Next.js, MCP SDK, AI SDK, or DB clients.
- Route Handlers validate transport data, call application services, and map typed results. They do not contain scoring, ranking, or idempotency algorithms.
- All external HTTP, MCP, model, environment, and database-boundary data receives runtime validation where it enters the trusted core.
- Live and demo Silpo adapters implement the same `SilpoGateway` and return the same domain types.
- Live mode never silently falls back to demo mode. Demo mode is always visibly labeled.
- Provider changes must not require changes to the prediction engine, cart service, or UI contracts.
- Raw MCP responses are not persisted unless a new, reviewed requirement demonstrates why sanitized normalized data is insufficient.
- Each prediction run stores `algorithmVersion` and `trainingCutoff`.
- Each cart commit stores an idempotency key, absolute target quantities, and a verified or blocked result.

## Agent and prediction invariants

- Prediction is category-first and SKU-second.
- History window is at most 180 days.
- Exact-SKU candidates need at least two observations; category candidates need at least three.
- Active-city weight is `1.0`; other-city weight is `0.35`.
- Confidence is `0.40 × due + 0.35 × repeat + 0.25 × stability`.
- Confidence below `0.55` abstains; `0.55–0.74` is medium; `≥ 0.75` is high.
- The deterministic engine computes features, confidence, quantities, and candidates.
- Gemini 3.7 Flash explains and ranks only server-provided candidates.
- Gemini never invents or changes product IDs, prices, stock, promotions, nutrition facts, quantity steps, or checkout state.
- Model input excludes raw receipts, raw MCP payloads, tokens, names, phone, email, precise address, loyalty barcode, profile IDs, session IDs, and idempotency keys.
- Model output is Zod-validated and then semantically checked against the allowlist for that run.
- Gemini gets at most five high-level tools per step and at most six model steps per draft.
- After two invalid or failed model attempts, return the deterministic reason-code fallback instead of dropping the draft.
- Model output schemas must stay compatible with Google structured output; do not use `z.union` or `z.record` in those schemas.

## MCP, OAuth, and cart safety

- Treat `SILPO_MCP.md` as read-only unless the user explicitly asks to change it.
- Begin a live MCP session with `tools/list`; do not assume the available tool surface.
- Use the exact cart context required by Silpo: cart readback and valid time slot precede cart-dependent operations.
- If no cart exists, use the documented address → delivery type → optional branch → time slot → create → readback flow.
- For `401`, perform at most one token refresh attempt, then require reauthorization.
- Retry read-only `429` responses at most three times using server metadata or 250/500/1000 ms plus jitter.
- Never automatically retry a cart write.
- Never call a cart write before explicit approval is persisted on the server.
- Before commit, re-read cart, validate slot, refresh products, and validate stock, price and `step`.
- Persist absolute target quantities before write and call `silpo_add_or_update_cart_products` with `addQuantity=false`.
- Immediately read the cart after every write and map all validations.
- Show checkout links only for a verified cart with no error-level validation.
- Bags, delivery fees, acceleration fees, and other service rows are never recommended or added.
- Loyalty bonus may be displayed but is never applied automatically.
- Live smoke is read-only by default. A write smoke requires fresh manual confirmation for that run.

## Secrets and privacy

- Secrets are server-only and never committed, rendered, logged, or included in model context.
- Do not expose `GOOGLE_GENERATIVE_AI_API_KEY`, `TOKEN_ENCRYPTION_KEY`, DB credentials, MCP tokens, authorization headers, PKCE verifier, or OAuth state.
- MCP tokens at rest use AES-256-GCM with a random 12-byte IV and authenticated tag; the decoded encryption key is exactly 32 bytes.
- Redact phone, email, address, barcode, profile IDs, raw prompts, and raw MCP payloads before persistence and console output.
- Demo fixtures must use synthetic names, phones, addresses, loyalty IDs, order IDs, and tokens.
- Do not paste secrets into tests or task reports. `.env.example` contains names only.

## Design invariants

- The dashboard is action-first; chat is outside MVP.
- Use the tokens and component rules in `docs/design-system.md`; do not hard-code alternate brand colors in components.
- The visual language may be Silpo-inspired but must not copy its logo, proprietary font files, illustrations, or imply official ownership.
- Every recommendation shows reason, confidence, current price, stock state, and available user action.
- Missing nutrition data is labeled «даних недостатньо»; never infer it.
- Color is not the only state signal. Error, warning, confidence, live/demo, and progress states require text.
- A changed price or stock value is shown before write.
- Checkout is absent until verified.
- Meet WCAG 2.2 AA targets, keyboard operation, visible focus, 44×44 px touch targets, and reduced-motion behavior.
- Verify no horizontal overflow and no sticky-content overlap at 390 px and 1440 px.

## Task workflow

Before editing:

1. Read the assigned task, its dependencies, and its exact file list in `docs/tasks.md`.
2. Run `git status --short` and preserve unrelated or user-owned changes.
3. Confirm dependency tasks are integrated. If not, report the dependency instead of recreating its output.
4. State the behavior to prove and the focused test command.

Implement with red-green-refactor:

1. Add the smallest test that expresses one acceptance behavior.
2. Run it and confirm it fails for the expected reason.
3. Implement the minimum coherent change.
4. Run the focused test and make it pass.
5. Refactor only while tests stay green.
6. Repeat for the remaining acceptance behaviors.

Before handoff:

1. Review `git diff` for scope, secrets, guessed shapes, duplicated abstractions, dead code, and accidental documentation drift.
2. Run the focused tests from the task.
3. Run cumulative tests for all completed dependent modules.
4. Run the applicable static/build/browser gates.
5. Report changed files, commands run, results, remaining risks, and commit hash.

Do not weaken a test to make an implementation pass. Do not claim success without fresh command output. Do not leave placeholders such as `TODO`, `TBD`, “handle errors,” or “similar to task N” in committed plans or production paths.

## Standard commands

After Task 1 creates the project shell, use `pnpm` exclusively:

```bash
pnpm install
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm test:e2e
```

Prefer the focused `pnpm vitest run <paths>` command named in the assigned task before the full suite. If a standard command does not exist before Task 1, only Task 1 may create it; later tasks treat its absence as an unmet dependency.

## Parallel work and worktrees

- One implementation agent owns one task at a time.
- Parallel implementation requires an isolated Git worktree and branch per agent.
- Never run parallel agents in the same checkout.
- Do not run tasks concurrently when they touch shared contracts, the same feature directory, package manifests, lockfiles, migrations, or overlapping files.
- With four available slots, use at most three implementation agents and keep one slot for review/integration.
- Integrate commits in dependency order, then rerun focused and cumulative checks in the controller checkout.
- `docs/tasks.md` is coordinator-owned during parallel execution. Implementation agents report checkbox progress; the coordinator updates the shared ledger.

Review sequence for each task:

1. Implementer completes tests and commit.
2. Spec reviewer checks the task against product and relevant normative docs.
3. Code-quality reviewer checks maintainability, security, test strength, and scope.
4. Original implementer resolves findings.
5. Controller reruns verification and integrates.

## Git and change discipline

- Preserve unrelated changes and untracked user files.
- Do not use destructive Git commands to clean the workspace.
- Each task ends in one focused commit unless the controller explicitly requests another structure.
- Commit messages use the task's documented message where provided.
- Do not add production dependencies outside the task that owns the package/lockfile change.
- Avoid broad formatting passes that obscure functional diffs.
- Do not edit shared contracts after Task 2 without controller approval and dependent-task impact review.
- Documentation changes that alter a rule belong in the same commit as the behavior change.

## Definition of done

A task is done only when:

- every acceptance behavior in its `docs/tasks.md` section is implemented;
- focused tests pass from a clean invocation;
- applicable lint, typecheck, build, contract, integration, E2E, responsive, or live-smoke checks pass;
- external data is runtime-validated and sensitive fields are redacted;
- no new cart-write path bypasses approval, idempotency, slot validation, readback, or checkout gating;
- live/demo parity and mode labeling remain intact;
- the diff contains no unrelated changes or unresolved placeholders;
- normative docs match the resulting behavior;
- the handoff includes evidence, risks, and the exact commit hash.

## Self-review and entropy control

Before declaring completion, ask:

- Did this change introduce a second way to do something already standardized?
- Can a future agent find the invariant without reading chat history?
- Is the rule documented in exactly one owning document and referenced elsewhere?
- Can the boundary be enforced with a schema, type, test, lint rule, or fixture?
- Are error and partial states as testable as the happy path?
- Did demo behavior drift from live behavior?
- Did a module become large enough to hide more than one responsibility?

If repeated drift appears, create a small follow-up task that improves the harness—tests, schemas, fixtures, commands, documentation, or architecture checks—rather than adding another warning paragraph.

## References

- [Product specification](docs/product-spec.md)
- [Project architecture](docs/project-architecture.md)
- [Agent architecture](docs/agent-architecture.md)
- [Design system](docs/design-system.md)
- [Task backlog](docs/tasks.md)
- [Silpo MCP reference](SILPO_MCP.md)
- [OpenAI: custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
