# Draft Editing and Persisted Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user edit a ready grocery draft and atomically persist the final server-validated selection with one stable UUID approval key, without writing to the Silpo cart.

**Architecture:** A client `DraftEditor` owns reversible local edits and submits IDs, versions, and quantities only. A thin Next.js route resolves the server-side identity and calls a pure approval application service, which reconstructs the selection from persisted snapshots and delegates one locked edit-plus-approval transaction to `DraftRepository`. The dashboard transitions to `confirming`; Task 16 remains the only cart-write owner.

**Tech Stack:** TypeScript 5.9, React 19, Next.js 16 App Router, Zod 4, Drizzle ORM with Postgres, Vitest 4, Testing Library, CSS custom properties.

**Spec:** [docs/superpowers/specs/2026-09-09-draft-editing-approval-design.md](../specs/2026-09-09-draft-editing-approval-design.md)

## Global Constraints

- Use `pnpm` exclusively. This task adds no dependency, migration, environment variable, or shared-domain-contract change.
- Do not modify `src/features/shared/contracts.ts`, `src/db/schema.ts`, `drizzle/*`, package manifests, lockfiles, `SILPO_MCP.md`, any Gemini/prediction/product-resolution module, or any cart-write module.
- Preserve the user-owned `.gitignore`, `AGENTS.md`, and `.claude/` working-tree changes. Stage files explicitly; never use `git add .`.
- Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` before implementing the route. In this installed Next.js version, dynamic route `params` is a `Promise` and must be awaited.
- The browser sends only `draftVersion`, `sourceProductId`, `itemVersion`, `selectedProductId`, and `quantity`. It never sends user ID, mode, total, price, stock, step, display ratio, product copy, promotions, nutrition, confidence, or reason data.
- `DraftItem` has no public item version. The editor copies `draft.version` into each source row, and the repository still verifies each stored `draft_items.version` independently.
- Approval requires an owned `ready` draft, exact source-item coverage, matching draft/item versions, at least one active item, unique active product IDs, allowlisted replacements, and step/stock-valid quantities.
- Quantity alignment uses the existing tolerance: `Math.abs(quantity / step - Math.round(quantity / step)) <= 1e-9`.
- Totals use `quantity * (specialPrice ?? price)` and round to two decimal places. Client arithmetic is presentation; the service recomputes the persisted authority.
- One Postgres transaction locks the draft, applies every item decision, advances draft/item versions to `N + 1`, sets `confirming`, and inserts one UUID approval.
- Removed rows remain with `userDecision: "removed"` for diagnostics and are excluded from normal draft reads.
- Repeated and concurrent approval requests return the first stored key. No retry changes the approved selection.
- The route performs no MCP, model, catalog refresh, cart write, cart readback, or checkout work. Live mode never falls back to demo.
- Ukrainian user-facing copy follows the approved spec exactly. Errors never echo request bodies, database details, product snapshots, session handles, or secrets.
- WCAG 2.2 AA remains the target: keyboard operation, visible focus, text state labels, associated errors, live regions, and 44 by 44 pixel touch targets.
- Existing demo labeling, validation rendering, checkout gating, responsive behavior, and read-only non-ready states must remain intact.
- Work on `codex/task-15-draft-editing-approval` or an isolated worktree created at execution time. All slices below form one repository backlog task and end in one final commit: `feat: edit and approve draft baskets`.

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/features/drafts/repository.ts` | Modify | Approval mutation types, owner-scoped approval reads, removed-row filtering, in-memory parity, and locked Postgres transaction. |
| `src/features/drafts/repository.test.ts` | Modify | Atomicity, version, ownership, tombstone, retry, and Postgres transaction evidence. |
| `src/features/drafts/approval-service.ts` | Create | Approval HTTP schemas, pure selection reconstruction, typed failures, and application-service orchestration. |
| `src/features/drafts/approval-service.test.ts` | Create | Complete selection, replacement mapping, quantity, total, ownership, version, and repository-result behavior. |
| `src/app/api/drafts/[draftId]/approve/handlers.ts` | Create | Dependency-injected identity resolution, body parsing, dependency wiring, and HTTP mapping. |
| `src/app/api/drafts/[draftId]/approve/route.ts` | Create | Next.js-valid segment configuration and `POST` export only. |
| `tests/integration/draft-approval.test.ts` | Create | Route behavior for demo/live identity, ownership, idempotency, status mapping, headers, and persisted output. |
| `src/components/autopilot/draft-editor.tsx` | Create | Local editor rows, quantity validation, remove/undo, replacement picker, request submission, and approval callback. |
| `src/components/autopilot/draft-editor.test.tsx` | Create | T15-01 through T15-09 interaction evidence. |
| `src/components/autopilot/draft-product-card.tsx` | Modify | Server-owned package metadata plus optional editor content in one product presentation. |
| `src/components/autopilot/draft-summary.tsx` | Modify | Confirm handler, disabled/in-flight explanation, and edited draft totals while retaining checkout gates. |
| `src/components/autopilot/draft-dashboard.tsx` | Modify | Client coordination, ready-editor rendering, stable approval key, and local `confirming` transition. |
| `src/components/autopilot/draft-dashboard.test.tsx` | Modify | Dashboard transition and Task 14 regression evidence. |
| `src/app/globals.css` | Modify | Editor, picker, removed, invalid, locked, responsive, focus, and touch-target styles using existing tokens. |
| `docs/project-architecture.md` | Modify | Add the approval service and atomic repository boundary to the durable architecture. |
| `docs/tasks.md` | Modify | Refine the Task 15 file list/steps and record completion evidence after verification. |

## Locked Interfaces

Define these names once and use them unchanged in every later slice:

```ts
// src/features/drafts/approval-service.ts
export const DraftApprovalInputSchema: z.ZodType<DraftApprovalInput>;
export const DraftApprovalResponseSchema: z.ZodType<DraftApprovalResponse>;

export interface DraftApprovalInput {
  draftVersion: number;
  items: Array<{
    sourceProductId: string;
    itemVersion: number;
    selectedProductId: string | null;
    quantity: number | null;
  }>;
}

export interface DraftApprovalResponse {
  idempotencyKey: string;
}

export type DraftApprovalFailureCode =
  | "not_found"
  | "conflict"
  | "invalid_selection"
  | "unexpected";

export interface DraftApprovalFailure {
  code: DraftApprovalFailureCode;
  message: string;
  correlationId: string;
}

export interface ApproveDraftInput {
  draftId: string;
  userId: string;
  selection: DraftApprovalInput;
  correlationId: string;
}

export interface ApproveDraftDeps {
  repository: DraftRepository;
  newIdempotencyKey?: () => string;
  now?: () => Date;
}

export async function approveDraftSelection(
  input: ApproveDraftInput,
  deps: ApproveDraftDeps,
): Promise<Result<DraftApprovalResponse, DraftApprovalFailure>>;
```

```ts
// src/features/drafts/repository.ts
export type DraftItemDecision =
  | {
      sourceProductId: string;
      expectedVersion: number;
      decision: "removed";
      item: null;
    }
  | {
      sourceProductId: string;
      expectedVersion: number;
      decision: "kept" | "replaced";
      item: DraftItem;
    };

export interface PersistDraftApprovalInput {
  draftId: string;
  userId: string;
  expectedDraftVersion: number;
  approvedDraft: Draft & { status: "confirming" };
  decisions: DraftItemDecision[];
  idempotencyKey: string;
  approvedAt: Date;
}

export type PersistDraftApprovalResult =
  | { status: "approved"; idempotencyKey: string }
  | { status: "already_approved"; idempotencyKey: string }
  | { status: "not_found" }
  | { status: "conflict" };

export interface DraftRepository {
  save(userId: string, draft: Draft, options?: SaveDraftOptions): Promise<Draft>;
  get(draftId: string, userId: string): Promise<Draft | null>;
  getApproval(draftId: string, userId: string): Promise<DraftApprovalRecord | null>;
  approveSelection(input: PersistDraftApprovalInput): Promise<PersistDraftApprovalResult>;
}
```

Delete the old public `approve(draftId, userId, idempotencyKey)` method after its tests are replaced. Keeping it would create a second path that can persist approval without the edited snapshot transaction.

```ts
// src/components/autopilot/draft-editor.tsx
export type EditableDraft = Draft & { status: "ready" };
export type ConfirmingDraft = Draft & { status: "confirming" };

export interface DraftApprovedEvent {
  idempotencyKey: string;
  draft: ConfirmingDraft;
}

export type ApproveDraftRequest = (
  draftId: string,
  input: DraftApprovalInput,
) => Promise<DraftApprovalResponse>;

export interface DraftEditorProps {
  draft: EditableDraft;
  onApproved: (event: DraftApprovedEvent) => void;
  approveDraft?: ApproveDraftRequest;
}
```

---

## Task 15: Draft Editing and Persisted Approval

**Prerequisites:** Commits for Tasks 7, 13, and 14 are integrated. Task 14's checklist is stale, but commits `2ddf91a` and `a552b59` are ancestors of the approved baseline and its component tests pass.

**Behavior to prove:** A ready draft can be edited locally, and one explicit submit atomically persists the server-reconstructed active selection plus a stable approval key. Stale, unowned, invalid, repeated, or concurrent requests cannot create partial or duplicate approvals. No cart operation occurs.

**Focused command:**

```bash
pnpm vitest run \
  src/features/drafts/approval-service.test.ts \
  src/features/drafts/repository.test.ts \
  src/components/autopilot/draft-editor.test.tsx \
  src/components/autopilot/draft-dashboard.test.tsx \
  tests/integration/draft-approval.test.ts
```

### 15.0 — Confirm dependencies and local framework rules

- [ ] Run the clean dependency checks before editing:

```bash
git status --short
git log -8 --oneline --decorate
pnpm vitest run src/components/autopilot/draft-dashboard.test.tsx src/features/drafts/repository.test.ts
```

Expected: the test command passes 59 tests. Status shows only the known user-owned `.gitignore`, `AGENTS.md`, and `.claude/` changes plus this already committed spec/plan history.

- [ ] Read the installed route-handler reference:

```bash
sed -n '1,180p' node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md
```

Expected: the `context.params` example uses `Promise<{ ... }>` and awaits it. Do not copy a synchronous params signature from an older Next.js version.

### 15.1 — Replace the standalone approval path with one atomic repository operation

- [ ] Replace the old in-memory approval tests in `src/features/drafts/repository.test.ts` with fixtures that save a ready draft before approval. Add two more source items so one mutation can prove kept, replaced, and removed decisions:

```ts
const replacement: ProductCandidate = ProductCandidateSchema.parse({
  productId: "product-2-alt",
  externalProductId: 202,
  slug: "product-2-alt",
  name: "Кефір",
  imageUrl: null,
  price: 60,
  specialPrice: 50,
  available: true,
  stock: 8,
  step: 1,
  displayRatio: 0.9,
  nutritionStatus: "insufficient",
  nutrition: null,
  promotions: [{ id: "promo-kefir", label: "Акція", price: 50 }],
});

function approvalMutation(overrides: Partial<PersistDraftApprovalInput> = {}): PersistDraftApprovalInput {
  const approvedDraft = DraftSchema.parse({
    ...editableDraftFixture,
    status: "confirming",
    version: 2,
    items: [
      { ...editableDraftFixture.items[0], quantity: 3 },
      {
        ...editableDraftFixture.items[1],
        productId: replacement.productId,
        externalProductId: replacement.externalProductId,
        name: replacement.name,
        imageUrl: replacement.imageUrl,
        displayRatio: replacement.displayRatio,
        quantity: 1,
        price: replacement.price,
        specialPrice: replacement.specialPrice,
        stock: replacement.stock,
        step: replacement.step,
        nutritionStatus: replacement.nutritionStatus,
        promotions: replacement.promotions,
        alternatives: [],
      },
    ],
    total: 3 * 55 + 50,
  }) as Draft & { status: "confirming" };

  return {
    draftId: editableDraftFixture.id,
    userId: "user-1",
    expectedDraftVersion: 1,
    approvedDraft,
    decisions: [
      { sourceProductId: "product-1", expectedVersion: 1, decision: "kept", item: approvedDraft.items[0] },
      { sourceProductId: "product-2", expectedVersion: 1, decision: "replaced", item: approvedDraft.items[1] },
      { sourceProductId: "product-3", expectedVersion: 1, decision: "removed", item: null },
    ],
    idempotencyKey: "00000000-0000-4000-8000-000000000015",
    approvedAt: new Date("2026-09-09T10:00:00.000Z"),
    ...overrides,
  };
}
```

Add `ProductCandidateSchema`, `type DraftItem`, `type ProductCandidate`, and the new repository types to the imports. Build `editableDraftFixture` through `DraftSchema.parse`, give `product-2` the `replacement` in its alternatives, and keep every source row at version `1` through the repository save.

- [ ] Add these in-memory tests:

```ts
it("T15-12 atomically stores kept, replaced, and removed decisions", async () => {
  const repo = createInMemoryDraftRepository();
  await repo.save("user-1", editableDraftFixture);

  await expect(repo.approveSelection(approvalMutation())).resolves.toEqual({
    status: "approved",
    idempotencyKey: "00000000-0000-4000-8000-000000000015",
  });
  await expect(repo.get(editableDraftFixture.id, "user-1"))
    .resolves.toEqual(approvalMutation().approvedDraft);
  await expect(repo.getApproval(editableDraftFixture.id, "user-1"))
    .resolves.toMatchObject({
      draftId: editableDraftFixture.id,
      userId: "user-1",
      idempotencyKey: "00000000-0000-4000-8000-000000000015",
    });
  await expect(repo.getApproval(editableDraftFixture.id, "user-2")).resolves.toBeNull();
});

it("T15-13 leaves the ready draft untouched after a stale item version", async () => {
  const repo = createInMemoryDraftRepository();
  await repo.save("user-1", editableDraftFixture);
  const input = approvalMutation({
    decisions: approvalMutation().decisions.map((decision, index) =>
      index === 1 ? { ...decision, expectedVersion: 9 } : decision),
  });

  await expect(repo.approveSelection(input)).resolves.toEqual({ status: "conflict" });
  await expect(repo.get(editableDraftFixture.id, "user-1")).resolves.toEqual(editableDraftFixture);
  await expect(repo.getApproval(editableDraftFixture.id, "user-1")).resolves.toBeNull();
});

it("T15-13 returns the first key for a repeated approval", async () => {
  const repo = createInMemoryDraftRepository();
  await repo.save("user-1", editableDraftFixture);
  await repo.approveSelection(approvalMutation());

  await expect(repo.approveSelection(approvalMutation({
    idempotencyKey: "00000000-0000-4000-8000-000000000099",
  }))).resolves.toEqual({
    status: "already_approved",
    idempotencyKey: "00000000-0000-4000-8000-000000000015",
  });
});
```

Also add cases for a missing draft, a different owner, stale draft version, incomplete/duplicate decisions, a next draft with the wrong ID/version/status, and a reused idempotency key from another draft. The ownership and validation cases return `not_found` or `conflict`; the key collision rejects just as the Postgres unique constraint does. None mutates state.

- [ ] Run the repository test to prove red:

```bash
pnpm vitest run src/features/drafts/repository.test.ts
```

Expected: FAIL at TypeScript transform because `PersistDraftApprovalInput` and `approveSelection` do not exist.

- [ ] In `src/features/drafts/repository.ts`, import `or`, `isNull`, and `ne` from Drizzle plus `DraftItemSchema` and the `DraftItem` type. Add the locked interfaces exactly as defined above. Change `getApproval` to require `userId`, remove the old `approve` signature, and add this common validation helper:

```ts
function validMutationShape(input: PersistDraftApprovalInput): boolean {
  if (
    input.approvedDraft.id !== input.draftId ||
    input.approvedDraft.status !== "confirming" ||
    input.approvedDraft.version !== input.expectedDraftVersion + 1 ||
    input.decisions.length === 0
  ) return false;

  const sourceIds = input.decisions.map((decision) => decision.sourceProductId);
  if (new Set(sourceIds).size !== sourceIds.length) return false;

  const active = input.decisions.filter(
    (decision): decision is Extract<DraftItemDecision, { item: DraftItem }> => decision.item !== null,
  );
  if (active.length !== input.approvedDraft.items.length) return false;

  return active.every((decision, index) => {
    const parsedItem = DraftItemSchema.safeParse(decision.item);
    return parsedItem.success &&
      JSON.stringify(parsedItem.data) === JSON.stringify(input.approvedDraft.items[index]);
  });
}
```

Validate non-empty IDs, the proposed UUID, date validity, and `approvedDraft` with the existing Zod schemas before this semantic helper. Because both sides of the equality check are schema-parsed objects with canonical key order, the serialized comparison is deterministic. Do not accept decisions in a different order from the persisted source rows; stable order makes active item order deterministic.

- [ ] Refactor the in-memory representation from a single cloned `Draft` to a stored draft plus item rows:

```ts
interface MemoryDraftRow {
  userId: string;
  draft: Draft;
  items: Array<{
    sourceProductId: string;
    item: DraftItem;
    version: number;
    decision: "kept" | "replaced" | "removed" | null;
  }>;
}
```

`save()` writes one row per current item with `sourceProductId: item.productId`, the draft version, and a null decision. `get()` rebuilds `items` from non-removed rows and validates the result through `DraftSchema`. Implement `approveSelection()` by validating into cloned temporary values first, then replacing the map entries only after every check passes. Perform no `await` between validation and map replacement so the in-memory mutation is one JavaScript critical section.

- [ ] Implement owner-scoped approval reads in memory:

```ts
async getApproval(draftId: string, userId: string): Promise<DraftApprovalRecord | null> {
  const record = approvalsByDraftId.get(nonEmptyString.parse(draftId));
  if (!record || record.userId !== nonEmptyString.parse(userId)) return null;
  return draftApprovalRecordSchema.parse(structuredClone(record));
}
```

- [ ] Run the in-memory suite:

```bash
pnpm vitest run src/features/drafts/repository.test.ts -t "in-memory"
```

Expected: PASS for every in-memory test. Existing save/get/version tests remain green after adapting `getApproval` call sites.

- [ ] Replace the old Postgres approval tests with transaction tests. Use the existing `DbClient` mock-builder style, but make the fake transaction expose `select`, `update`, `insert`, and a `.for("update").limit(1)` draft-lock chain. Add assertions for:

```ts
it("T15-12 locks the owned draft and persists decisions plus approval in one transaction", async () => {
  const repo = createPostgresDraftRepository(mockDbForSuccessfulApproval());

  await expect(repo.approveSelection(approvalMutation())).resolves.toEqual({
    status: "approved",
    idempotencyKey: approvalMutation().idempotencyKey,
  });
  expect(mockDb.transaction).toHaveBeenCalledOnce();
  expect(lockForUpdate).toHaveBeenCalledWith("update");
  expect(itemUpdates).toHaveLength(3);
  expect(itemUpdates[2]).toEqual(expect.objectContaining({ userDecision: "removed", version: 2 }));
  expect(approvalInsert).toHaveBeenCalledWith(expect.objectContaining({
    draftId: editableDraftFixture.id,
    userId: "user-1",
    idempotencyKey: approvalMutation().idempotencyKey,
    createdAt: approvalMutation().approvedAt,
  }));
});

it("T15-13 returns the locked row's existing approval without updates", async () => {
  const repo = createPostgresDraftRepository(mockDbWithExistingApproval());
  await expect(repo.approveSelection(approvalMutation())).resolves.toEqual({
    status: "already_approved",
    idempotencyKey: "00000000-0000-4000-8000-000000000015",
  });
  expect(draftUpdate).not.toHaveBeenCalled();
  expect(itemUpdates).toHaveLength(0);
  expect(approvalInsert).not.toHaveBeenCalled();
});
```

Add a rollback test whose fake transaction snapshots its rows and restores them when the approval insert throws. Assert the repository rejects the database error and the fake draft/items remain ready/version 1 with no approval. Add owner and stale-version cases that return before any update.

- [ ] Implement the Postgres transaction in this exact order:

```ts
return db.transaction(async (tx) => {
  const [lockedDraft] = await tx
    .select()
    .from(drafts)
    .where(and(eq(drafts.id, input.draftId), eq(drafts.userId, input.userId)))
    .for("update")
    .limit(1);
  if (!lockedDraft) return { status: "not_found" as const };

  const [existingApproval] = await tx
    .select()
    .from(draftApprovals)
    .where(and(
      eq(draftApprovals.draftId, input.draftId),
      eq(draftApprovals.userId, input.userId),
    ))
    .limit(1);
  if (existingApproval) {
    return {
      status: "already_approved" as const,
      idempotencyKey: existingApproval.idempotencyKey,
    };
  }

  if (lockedDraft.status !== "ready" || lockedDraft.version !== input.expectedDraftVersion) {
    return { status: "conflict" as const };
  }

  const rows = await tx
    .select()
    .from(draftItems)
    .where(eq(draftItems.draftId, input.draftId))
    .orderBy(asc(draftItems.position))
    .for("update");
```

Before writing, compare row count, ordered `productId`, and every row version against `input.decisions`. Then update the draft with an expected version/status predicate and require one returned row. Update every item by its locked database `id`; kept/replaced values map every `DraftItem` field explicitly, while removed values change only `userDecision` and `version`. Insert `draftApprovals` last with `createdAt: input.approvedAt`. A thrown update/insert error must escape so Drizzle rolls back.

- [ ] Change the Postgres `get()` item query to exclude tombstones:

```ts
.where(and(
  eq(draftItems.draftId, parsedDraftId),
  or(isNull(draftItems.userDecision), ne(draftItems.userDecision, "removed")),
))
```

Change Postgres `getApproval()` to filter on both parsed IDs. Update all existing repository tests to call `getApproval(draftId, userId)`.

- [ ] Run repository verification:

```bash
pnpm vitest run src/features/drafts/repository.test.ts
pnpm typecheck
```

Expected: PASS. Do not commit yet; Task 15 ends in one focused commit.

### 15.2 — Add the approval application service and schemas

- [ ] Create `src/features/drafts/approval-service.test.ts` with contract-parsed fixtures for three source items and one discounted replacement. Use `createInMemoryDraftRepository()` for integration-like service tests and a minimal fake repository for result mapping.

Start with schema tests:

```ts
it("T15-06 accepts intent only and rejects browser-supplied product facts", () => {
  const valid = {
    draftVersion: 1,
    items: [{
      sourceProductId: "product-1",
      itemVersion: 1,
      selectedProductId: "product-1",
      quantity: 2,
    }],
  };
  expect(DraftApprovalInputSchema.parse(valid)).toEqual(valid);
  expect(() => DraftApprovalInputSchema.parse({
    ...valid,
    total: 1,
    items: [{ ...valid.items[0], price: 0.01, stock: 999 }],
  })).toThrow();
});

it("T15-06 requires null selection and quantity together for removal", () => {
  expect(() => DraftApprovalInputSchema.parse({
    draftVersion: 1,
    items: [{
      sourceProductId: "product-1",
      itemVersion: 1,
      selectedProductId: null,
      quantity: 1,
    }],
  })).toThrow();
});
```

- [ ] Add service happy-path evidence:

```ts
it("T15-11 reconstructs snapshots, decisions, total, and version on the server", async () => {
  const repository = createInMemoryDraftRepository();
  await repository.save("user-1", editableDraftFixture);

  const result = await approveDraftSelection({
    draftId: editableDraftFixture.id,
    userId: "user-1",
    correlationId: "corr-15",
    selection: {
      draftVersion: 1,
      items: [
        { sourceProductId: "product-1", itemVersion: 1, selectedProductId: "product-1", quantity: 3 },
        { sourceProductId: "product-2", itemVersion: 1, selectedProductId: "product-2-alt", quantity: 1 },
        { sourceProductId: "product-3", itemVersion: 1, selectedProductId: null, quantity: null },
      ],
    },
  }, {
    repository,
    newIdempotencyKey: () => "00000000-0000-4000-8000-000000000015",
    now: () => new Date("2026-09-09T10:00:00.000Z"),
  });

  expect(result).toEqual({
    ok: true,
    value: { idempotencyKey: "00000000-0000-4000-8000-000000000015" },
  });
  const approved = await repository.get(editableDraftFixture.id, "user-1");
  expect(approved).toMatchObject({ status: "confirming", version: 2, total: 215 });
  expect(approved?.items.map((item) => item.productId))
    .toEqual(["product-1", "product-2-alt"]);
  expect(approved?.items[1]).toMatchObject({
    name: "Кефір",
    price: 60,
    specialPrice: 50,
    confidence: editableDraftFixture.items[1].confidence,
    reason: editableDraftFixture.items[1].reason,
  });
});
```

The `215` total is `3 * 55 + 1 * 50`; it proves that client totals are ignored and discounted server snapshots win.

- [ ] Add one T15-10 table-driven test covering these safe failures and messages:

```ts
const cases = [
  ["different owner", "not_found"],
  ["draft not ready", "conflict"],
  ["stale draft version", "conflict"],
  ["stale item version", "conflict"],
  ["missing source item", "invalid_selection"],
  ["extra source item", "invalid_selection"],
  ["all items removed", "invalid_selection"],
  ["duplicate selected product", "invalid_selection"],
  ["replacement outside source allowlist", "invalid_selection"],
  ["quantity zero", "invalid_selection"],
  ["quantity above stock", "invalid_selection"],
  ["quantity misaligned with step", "invalid_selection"],
] as const;
```

Each case asserts `result.ok === false`, the expected feature-local code, `correlationId: "corr-15"`, and absence of raw IDs or thrown error text in the message. Add one fake-repository case for `not_found`, `conflict`, and a thrown database error mapped to `unexpected`.

- [ ] Add idempotency tests:

```ts
it("T15-13 returns a persisted approval before validating a stale replay", async () => {
  const repository = createInMemoryDraftRepository();
  await repository.save("user-1", editableDraftFixture);
  await approveDraftSelection(firstRequest, { repository, newIdempotencyKey: () => FIRST_KEY });

  const replay = await approveDraftSelection({
    ...firstRequest,
    selection: { draftVersion: 1, items: [] },
  }, { repository, newIdempotencyKey: () => SECOND_KEY });

  expect(replay).toEqual({ ok: true, value: { idempotencyKey: FIRST_KEY } });
});
```

This service test deliberately calls with stale post-approval input. The HTTP route still requires structurally valid JSON before service invocation.

- [ ] Run the new test to prove red:

```bash
pnpm vitest run src/features/drafts/approval-service.test.ts
```

Expected: FAIL because `approval-service.ts` does not exist.

- [ ] Create `src/features/drafts/approval-service.ts`. Define the request item with a strict Zod object and pair nullable fields in `superRefine`:

```ts
const ApprovalItemInputSchema = z.object({
  sourceProductId: z.string().trim().min(1),
  itemVersion: z.number().int().positive(),
  selectedProductId: z.string().trim().min(1).nullable(),
  quantity: z.number().finite().positive().nullable(),
}).strict().superRefine((value, context) => {
  if ((value.selectedProductId === null) !== (value.quantity === null)) {
    context.addIssue({
      code: "custom",
      path: ["quantity"],
      message: "selectedProductId and quantity must both be null or non-null",
    });
  }
});

export const DraftApprovalInputSchema = z.object({
  draftVersion: z.number().int().positive(),
  items: z.array(ApprovalItemInputSchema).max(10),
}).strict().superRefine((value, context) => {
  const sourceIds = value.items.map((item) => item.sourceProductId);
  if (new Set(sourceIds).size !== sourceIds.length) {
    context.addIssue({ code: "custom", path: ["items"], message: "source IDs must be unique" });
  }
});

export type DraftApprovalInput = z.infer<typeof DraftApprovalInputSchema>;
export const DraftApprovalResponseSchema = z.object({ idempotencyKey: z.uuid() }).strict();
export type DraftApprovalResponse = z.infer<typeof DraftApprovalResponseSchema>;
```

Define the failure type from the locked interface. The service constructs these values directly; the route maps their discriminant to HTTP. The browser treats an error response as untrusted and chooses copy from the HTTP status, so it never renders server-provided error text.

- [ ] Add the pure helpers. These snippets fix the mapping rules and avoid spreading browser or candidate objects:

```ts
const alignedToStep = (quantity: number, step: number) =>
  Math.abs(quantity / step - Math.round(quantity / step)) <= 1e-9;

const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

function replacementItem(
  source: DraftItem,
  candidate: ProductCandidate,
  quantity: number,
): DraftItem {
  return DraftItemSchema.parse({
    productId: candidate.productId,
    externalProductId: candidate.externalProductId,
    name: candidate.name,
    imageUrl: candidate.imageUrl,
    displayRatio: candidate.displayRatio,
    quantity,
    price: candidate.price,
    specialPrice: candidate.specialPrice,
    stock: candidate.stock,
    step: candidate.step,
    confidence: source.confidence,
    confidenceBand: source.confidenceBand,
    reasonCodes: [...source.reasonCodes],
    reason: source.reason,
    nutritionStatus: candidate.nutritionStatus,
    promotions: candidate.promotions.map((promotion) => ({ ...promotion })),
    alternatives: source.alternatives
      .filter((alternative) => alternative.productId !== candidate.productId)
      .map((alternative) => structuredClone(alternative)),
  });
}
```

For a kept item, explicitly copy every `DraftItem` field and replace only `quantity`; do not use a request-object spread. Add the complete preparation helper:

```ts
type PreparedSelection =
  | {
      ok: true;
      draft: Draft & { status: "confirming" };
      decisions: DraftItemDecision[];
    }
  | { ok: false; code: "conflict" | "invalid_selection" };

function keptItem(source: DraftItem, quantity: number): DraftItem {
  return DraftItemSchema.parse({
    productId: source.productId,
    externalProductId: source.externalProductId,
    name: source.name,
    imageUrl: source.imageUrl,
    displayRatio: source.displayRatio,
    quantity,
    price: source.price,
    specialPrice: source.specialPrice,
    stock: source.stock,
    step: source.step,
    confidence: source.confidence,
    confidenceBand: source.confidenceBand,
    reasonCodes: [...source.reasonCodes],
    reason: source.reason,
    nutritionStatus: source.nutritionStatus,
    promotions: source.promotions.map((promotion) => ({ ...promotion })),
    alternatives: source.alternatives.map((candidate) => structuredClone(candidate)),
  });
}

function prepareSelection(stored: Draft, selection: DraftApprovalInput): PreparedSelection {
  if (selection.draftVersion !== stored.version) return { ok: false, code: "conflict" };
  if (selection.items.length !== stored.items.length) {
    return { ok: false, code: "invalid_selection" };
  }
  const bySource = new Map(selection.items.map((item) => [item.sourceProductId, item]));
  if (bySource.size !== stored.items.length) return { ok: false, code: "invalid_selection" };

  const decisions: DraftItemDecision[] = [];
  const active: DraftItem[] = [];
  for (const source of stored.items) {
    const requested = bySource.get(source.productId);
    if (!requested) return { ok: false, code: "invalid_selection" };
    if (requested.itemVersion !== stored.version) return { ok: false, code: "conflict" };
    if (requested.selectedProductId === null || requested.quantity === null) {
      decisions.push({
        sourceProductId: source.productId,
        expectedVersion: requested.itemVersion,
        decision: "removed",
        item: null,
      });
      continue;
    }

    let candidate: ProductCandidate | null = null;
    if (requested.selectedProductId !== source.productId) {
      const allowed = source.alternatives.find(
        (item) => item.productId === requested.selectedProductId,
      );
      if (!allowed) return { ok: false, code: "invalid_selection" };
      candidate = allowed;
    }
    const selectedFacts = candidate ?? source;
    if (
      requested.quantity > selectedFacts.stock ||
      !alignedToStep(requested.quantity, selectedFacts.step) ||
      (candidate !== null && (!candidate.available || candidate.stock < candidate.step))
    ) return { ok: false, code: "invalid_selection" };

    const item = candidate
      ? replacementItem(source, candidate, requested.quantity)
      : keptItem(source, requested.quantity);
    active.push(item);
    decisions.push({
      sourceProductId: source.productId,
      expectedVersion: requested.itemVersion,
      decision: candidate ? "replaced" : "kept",
      item,
    });
  }

  if (active.length === 0 || new Set(active.map((item) => item.productId)).size !== active.length) {
    return { ok: false, code: "invalid_selection" };
  }
  const parsed = DraftSchema.safeParse({
    ...stored,
    status: "confirming",
    version: stored.version + 1,
    items: active,
    total: roundMoney(active.reduce(
      (sum, item) => sum + item.quantity * effectiveUnitPrice(item),
      0,
    )),
  });
  if (!parsed.success) return { ok: false, code: "invalid_selection" };
  return {
    ok: true,
    draft: parsed.data as Draft & { status: "confirming" },
    decisions,
  };
}

const FAILURE_COPY: Record<DraftApprovalFailureCode, string> = {
  not_found: "Чернетку не знайдено. Створіть нову.",
  conflict: "Чернетка змінилася. Оновіть сторінку й перевірте вибір ще раз.",
  invalid_selection: "Перевірте кількість або вибрану заміну.",
  unexpected: "Не вдалося підтвердити чернетку. Спробуйте ще раз.",
};

function failure(code: DraftApprovalFailureCode, correlationId: string) {
  return err({ code, message: FAILURE_COPY[code], correlationId });
}

const invalidSelection = (correlationId: string) =>
  failure("invalid_selection", correlationId);
```

The map provides lookup only; iterate `stored.items` as above so output and decisions retain server order. The object spread in the final `DraftSchema` input copies the trusted stored draft, never the browser request.

- [ ] Implement `approveDraftSelection` in the spec order:

```ts
export async function approveDraftSelection(
  input: ApproveDraftInput,
  deps: ApproveDraftDeps,
): Promise<Result<DraftApprovalResponse, DraftApprovalFailure>> {
  try {
    const existing = await deps.repository.getApproval(input.draftId, input.userId);
    if (existing) return ok(DraftApprovalResponseSchema.parse({ idempotencyKey: existing.idempotencyKey }));

    const parsed = DraftApprovalInputSchema.safeParse(input.selection);
    if (!parsed.success) return invalidSelection(input.correlationId);

    const stored = await deps.repository.get(input.draftId, input.userId);
    if (!stored) return failure("not_found", input.correlationId);
    if (stored.status !== "ready" || stored.version !== parsed.data.draftVersion) {
      return failure("conflict", input.correlationId);
    }

    const prepared = prepareSelection(stored, parsed.data);
    if (!prepared.ok) return failure(prepared.code, input.correlationId);

    const result = await deps.repository.approveSelection({
      draftId: stored.id,
      userId: input.userId,
      expectedDraftVersion: stored.version,
      approvedDraft: prepared.draft,
      decisions: prepared.decisions,
      idempotencyKey: (deps.newIdempotencyKey ?? (() => crypto.randomUUID()))(),
      approvedAt: (deps.now ?? (() => new Date()))(),
    });

    if (result.status === "not_found") return failure("not_found", input.correlationId);
    if (result.status === "conflict") return failure("conflict", input.correlationId);
    return ok(DraftApprovalResponseSchema.parse({ idempotencyKey: result.idempotencyKey }));
  } catch {
    return failure("unexpected", input.correlationId);
  }
}
```

`prepareSelection` returns either `{ ok: true, draft, decisions }` or `{ ok: false, code: "conflict" | "invalid_selection" }`. Version mismatches are `conflict`; coverage, product, or quantity failures are `invalid_selection`. Do not place error detail in user-visible messages.

- [ ] Run service checks:

```bash
pnpm vitest run src/features/drafts/approval-service.test.ts src/features/drafts/repository.test.ts
pnpm typecheck
```

Expected: PASS.

### 15.3 — Add the owned approval route

- [ ] Create `tests/integration/draft-approval.test.ts`. Import `NextRequest`, the handler factory, demo identity helpers, in-memory repository, and the approval schemas. Define the Next 16 context helper exactly:

```ts
const context = (draftId: string) => ({ params: Promise.resolve({ draftId }) });

function post(draftId: string, body: unknown, cookies: Record<string, string> = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  const cookie = Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join("; ");
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest(`https://app.silpo-test.ua/api/drafts/${draftId}/approve`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
```

Use a valid UUID draft ID in fixtures because the route validates it. Build dependencies without a database or network:

```ts
function makeDeps(repository: DraftRepository): ApprovalHandlerDeps {
  return {
    getEnv: () => makeEnv({ DATA_MODE: "demo" }),
    resolveSession: async () => ok({ userId: "live-user" }),
    resolveDemoIdentity: async (handle) => ({
      userId: handle ? demoUserIdFor(handle) : "00000000-0000-4000-8000-00000000de15",
      handle: handle ?? DEMO_HANDLE,
      issued: handle === null,
    }),
    repository: () => repository,
    approve: approveDraftSelection,
    newIdempotencyKey: () => "00000000-0000-4000-8000-000000000015",
  };
}
```

- [ ] Add route happy-path and replay tests:

```ts
it("T15-14 persists an owned demo selection and returns one key", async () => {
  const repository = createInMemoryDraftRepository();
  const handle = createDemoHandle();
  const userId = demoUserIdFor(handle);
  await repository.save(userId, editableDraftFixture);
  const handler = createApproveDraftPostHandler(makeDeps(repository));

  const response = await handler(
    post(editableDraftFixture.id, validSelection, { demo_session: handle }),
    context(editableDraftFixture.id),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ idempotencyKey: APPROVAL_KEY });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  await expect(repository.getApproval(editableDraftFixture.id, userId))
    .resolves.toMatchObject({ idempotencyKey: APPROVAL_KEY });
});

it("T15-13 returns the first key for a repeated POST", async () => {
  const first = await handler(post(ID, validSelection, cookies), context(ID));
  const second = await handler(post(ID, validSelection, cookies), context(ID));
  expect(await first.json()).toEqual({ idempotencyKey: APPROVAL_KEY });
  expect(await second.json()).toEqual({ idempotencyKey: APPROVAL_KEY });
});
```

- [ ] Add table-driven route cases for invalid UUID, unreadable JSON, extra product facts, missing live session, non-owned draft, stale draft/item versions, invalid quantity/replacement, and injected database failure. Assert exact statuses `400`, `401`, `404`, `409`, `422`, and `500`; assert every error body has safe copy and a correlation ID but contains no supplied product ID, session handle, database error, or environment value.

Also prove:

- request body `mode` and `userId` cannot select identity or mode;
- live mode calls `resolveSession` and ignores the demo cookie;
- demo mode never calls `resolveSession`;
- an issued demo identity receives the same HttpOnly/SameSite/Path/Secure policy as draft creation;
- the dependency shape has no gateway or cart method and global `fetch` remains uncalled.

- [ ] Run the route test to prove red:

```bash
pnpm vitest run tests/integration/draft-approval.test.ts
```

Expected: FAIL because the approval handler and route do not exist.

- [ ] Create `handlers.ts` with this public dependency boundary, then create `route.ts` as a thin Next.js entrypoint that imports the factory and exports only `dynamic`, `runtime`, and `POST`:

```ts
const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

const INVALID_REQUEST_COPY = "Некоректний запит.";
const UNAUTHORIZED_COPY = "Не вдалося підтвердити вхід. Увійдіть у «Сільпо» ще раз.";
const UNEXPECTED_COPY = "Не вдалося підтвердити чернетку. Спробуйте ще раз.";

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: RESPONSE_HEADERS });
}

function invalidRequest(correlationId: string): NextResponse {
  return json({ error: { code: "invalid_selection", message: INVALID_REQUEST_COPY, correlationId } }, 400);
}

function unauthorized(correlationId: string): NextResponse {
  return json({ error: { code: "unauthorized", message: UNAUTHORIZED_COPY, correlationId } }, 401);
}

function unexpected(correlationId: string): NextResponse {
  return json({ error: { code: "unexpected", message: UNEXPECTED_COPY, correlationId } }, 500);
}

function setDemoCookie(
  response: NextResponse,
  identity: DemoIdentity,
  env: ServerEnv,
): void {
  response.cookies.set(DEMO_SESSION_COOKIE, identity.handle, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: env.NODE_ENV === "production",
    maxAge: DEMO_SESSION_MAX_AGE_SECONDS,
  });
}

export interface ApprovalHandlerDeps {
  getEnv: () => ServerEnv;
  resolveSession: (handle: string | null) => Promise<Result<{ userId: string }, AppError>>;
  resolveDemoIdentity: (cookieValue: string | null) => Promise<DemoIdentity>;
  repository: () => DraftRepository;
  approve: typeof approveDraftSelection;
  newIdempotencyKey: () => string;
}

export type ApprovalRouteContext = {
  params: Promise<{ draftId: string }>;
};

export function createApproveDraftPostHandler(overrides: Partial<ApprovalHandlerDeps> = {}) {
  const getEnv = overrides.getEnv ?? (() => getServerEnv());
  const deps: ApprovalHandlerDeps = {
    getEnv,
    resolveSession: (handle) => resolveSilpoSession(handle),
    resolveDemoIdentity: (cookie) => ensureDemoUser(getDbClient(), cookie),
    repository: () => createPostgresDraftRepository(getDbClient()),
    approve: approveDraftSelection,
    newIdempotencyKey: () => randomUUID(),
    ...overrides,
  };

  return async function POST(request: NextRequest, context: ApprovalRouteContext) {
    const correlationId = randomUUID();
    const parsedId = z.uuid().safeParse((await context.params).draftId);
    if (!parsedId.success) return invalidRequest(correlationId);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return invalidRequest(correlationId);
    }
    const selection = DraftApprovalInputSchema.safeParse(body);
    if (!selection.success) return invalidRequest(correlationId);

    let env: ServerEnv | null = null;
    let demoIdentity: DemoIdentity | null = null;
    try {
      env = deps.getEnv();
      let userId: string;
      if (env.DATA_MODE === "demo") {
        demoIdentity = await deps.resolveDemoIdentity(
          request.cookies.get(DEMO_SESSION_COOKIE)?.value ?? null,
        );
        userId = demoIdentity.userId;
      } else {
        const session = await deps.resolveSession(
          request.cookies.get("silpo_session")?.value ?? null,
        );
        if (!session.ok) return unauthorized(correlationId);
        userId = session.value.userId;
      }

      const result = await deps.approve({
        draftId: parsedId.data,
        userId,
        selection: selection.data,
        correlationId,
      }, {
        repository: deps.repository(),
        newIdempotencyKey: deps.newIdempotencyKey,
      });

      const response = result.ok
        ? json(result.value, 200)
        : json({ error: result.error }, STATUS_BY_CODE[result.error.code]);
      if (demoIdentity?.issued) setDemoCookie(response, demoIdentity, env);
      return response;
    } catch {
      const response = unexpected(correlationId);
      if (demoIdentity?.issued && env) setDemoCookie(response, demoIdentity, env);
      return response;
    }
  };
}
```

`route.ts` contains only the framework-owned exports:

```ts
import { createApproveDraftPostHandler } from "./handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const POST = createApproveDraftPostHandler();
```

Construct every production default lazily, following `src/app/api/drafts/handlers.ts`. Use `z.uuid().safeParse((await context.params).draftId)`. Wrap `request.json()` in its own `try/catch`; malformed JSON is `400`, not `500`. Parse through `DraftApprovalInputSchema` before resolving identity. Use `NextResponse.json` with the shared non-cache/referrer headers for every branch. Integration tests import the factory from `handlers.ts`, never from the framework-owned route module.

- [ ] Map service codes without inspecting messages:

```ts
const STATUS_BY_CODE: Record<DraftApprovalFailureCode, number> = {
  not_found: 404,
  conflict: 409,
  invalid_selection: 422,
  unexpected: 500,
};
```

For live `resolveSession` failure, return the existing safe reauthorization copy with `401`. In demo mode, call `ensureDemoUser(getDbClient(), cookieValue)` and attach a newly issued cookie to both success and failure responses, matching `src/app/api/drafts/handlers.ts` exactly.

- [ ] Run route and upstream checks:

```bash
pnpm vitest run tests/integration/draft-approval.test.ts src/features/drafts/approval-service.test.ts src/features/drafts/repository.test.ts
pnpm typecheck
```

Expected: PASS.

### 15.4 — Build the editor with reversible local state

- [ ] Create `src/components/autopilot/draft-editor.test.tsx`. Import `fireEvent`, `render`, `screen`, and `within`; do not add `@testing-library/user-event`. Reuse contract-parsed fixture builders like the dashboard tests.

Add quantity behavior first:

```tsx
it("T15-01 changes fractional quantity by the selected step and respects stock", () => {
  renderEditor(draft({ items: [item({ quantity: 0.5, step: 0.5, stock: 1.5 })] }));
  const input = screen.getByRole("spinbutton", { name: "Кількість для Вода" });

  fireEvent.click(screen.getByRole("button", { name: "Збільшити кількість Вода" }));
  expect(input).toHaveValue(1);
  fireEvent.click(screen.getByRole("button", { name: "Збільшити кількість Вода" }));
  expect(input).toHaveValue(1.5);
  expect(screen.getByRole("button", { name: "Збільшити кількість Вода" })).toBeDisabled();
});

it("T15-02 associates invalid typed quantity and disables confirmation", () => {
  renderEditor(draft());
  const input = screen.getByRole("spinbutton", { name: "Кількість для Вода" });
  fireEvent.change(input, { target: { value: "1.25" } });

  expect(input).toBeInvalid();
  expect(input).toHaveAccessibleDescription("Кількість має відповідати кроку 1 і не перевищувати запас 10.");
  expect(screen.getByRole("button", { name: "Додати у кошик “Сільпо”" })).toBeDisabled();
});
```

Add separate T15-02 cases for empty input, zero, `Infinity`-like text, and over-stock input. The component retains the raw input string for display but only creates an approval payload from a parsed valid number.

- [ ] Add remove and undo tests:

```tsx
it("T15-03 removes from count and total, then restores the edited row", () => {
  renderEditor(draft());
  const quantity = screen.getByRole("spinbutton", { name: "Кількість для Вода" });
  fireEvent.change(quantity, { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: "Прибрати Вода" }));

  expect(screen.getByText("Товар прибрано з чернетки")).toBeVisible();
  expect(screen.getByText("Немає що додавати")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Додати у кошик “Сільпо”" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Повернути Вода" }));
  expect(screen.getByRole("spinbutton", { name: "Кількість для Вода" })).toHaveValue(3);
  expect(screen.getByText("Разом 60,00 ₴")).toBeVisible();
});
```

- [ ] Add replacement tests. The fixture has one original at `quantity: 2`, `price: 20` and one alternative at `specialPrice: 15`, `stock: 3`, `step: 1`, `nutritionStatus: "insufficient"`:

```tsx
it("T15-04 disables confirm while replacement is unresolved and updates snapshot total", () => {
  renderEditor(draft({ items: [item({ alternatives: [alternative()] })] }));
  fireEvent.click(screen.getByRole("button", { name: "Замінити Вода" }));

  expect(screen.getByRole("button", { name: "Додати у кошик “Сільпо”" })).toBeDisabled();
  expect(screen.getByText("Спочатку виберіть заміну або скасуйте вибір.")).toBeVisible();
  const picker = screen.getByRole("group", { name: "Виберіть заміну для Вода" });
  expect(within(picker).getByText("Фасування: ×0,9")).toBeVisible();
  expect(within(picker).getByText("В наявності: 3")).toBeVisible();
  expect(within(picker).getByText("Акція: 15,00 ₴")).toBeVisible();
  fireEvent.click(screen.getByRole("radio", { name: /Вода 2 л/ }));

  expect(screen.getByRole("heading", { level: 3, name: "Вода 2 л" })).toBeVisible();
  expect(screen.getByText("Фасування: ×0,9")).toBeVisible();
  expect(screen.getByText("В наявності: 3")).toBeVisible();
  expect(screen.getByText("Акція: 15,00 ₴")).toBeVisible();
  expect(screen.getByText("Разом 30,00 ₴")).toBeVisible();
  expect(screen.getByRole("button", { name: "Додати у кошик “Сільпо”" })).toBeEnabled();
  expect(screen.queryByText(/калор|білк|жир|вуглев/i)).toBeNull();
});
```

Add a cancel test that preserves the pre-picker product and quantity. Add a replacement-with-lower-stock test proving the quantity is not silently capped and confirm stays disabled until explicit adjustment. Add a defensive test that unavailable, zero-stock, and `stock < step` alternatives do not appear.

- [ ] Add the nutrition boundary as its own acceptance test:

```tsx
it("T15-05 never invents a nutrition comparison without facts on both sides", () => {
  renderEditor(draft({ items: [item({ alternatives: [alternative()] })] }));
  fireEvent.click(screen.getByRole("button", { name: "Замінити Вода" }));

  expect(screen.getByText("Даних про склад недостатньо")).toBeVisible();
  expect(screen.queryByText(/калор|білк|жир|вуглев|здоровіш/i)).toBeNull();
});
```

- [ ] Add the empty-selection gate separately from remove/undo:

```tsx
it("T15-07 exposes no confirmation action when every row is removed", () => {
  renderEditor(draft());
  fireEvent.click(screen.getByRole("button", { name: "Прибрати Вода" }));

  expect(screen.getByText("Немає що додавати")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Додати у кошик “Сільпо”" })).toBeNull();
  expect(screen.getByRole("button", { name: "Повернути Вода" })).toBeEnabled();
});
```

- [ ] Add request and double-submit tests with an injected deferred request:

```tsx
it("T15-06 sends only IDs, versions, and quantity intent", async () => {
  const approveDraft = vi.fn(async () => ({ idempotencyKey: APPROVAL_KEY }));
  renderEditor(draft(), { approveDraft });
  fireEvent.click(screen.getByRole("button", { name: "Додати у кошик “Сільпо”" }));

  await waitFor(() => expect(approveDraft).toHaveBeenCalledOnce());
  expect(approveDraft).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001", {
    draftVersion: 1,
    items: [{
      sourceProductId: "water-1",
      itemVersion: 1,
      selectedProductId: "water-1",
      quantity: 2,
    }],
  });
  expect(JSON.stringify(approveDraft.mock.calls[0])).not.toMatch(/price|stock|total|reason|confidence|mode/);
});

it("T15-08 locks synchronously and sends one request for rapid clicks", async () => {
  let resolve!: (value: DraftApprovalResponse) => void;
  const approveDraft = vi.fn(() => new Promise<DraftApprovalResponse>((done) => { resolve = done; }));
  renderEditor(draft(), { approveDraft });
  const confirm = screen.getByRole("button", { name: "Додати у кошик “Сільпо”" });

  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(approveDraft).toHaveBeenCalledOnce();
  expect(confirm).toBeDisabled();
  expect(screen.getByRole("spinbutton")).toBeDisabled();

  resolve({ idempotencyKey: APPROVAL_KEY });
  await waitFor(() => expect(onApproved).toHaveBeenCalledOnce());
});
```

Add error tests for `401`, `404`, `409`, `422`, malformed success JSON, and network failure. Assert the approved Ukrainian messages, `role="alert"`, controls unlocked when retry is allowed, and no demo fallback text.

- [ ] Run the editor test to prove red:

```bash
pnpm vitest run src/components/autopilot/draft-editor.test.tsx
```

Expected: FAIL because `draft-editor.tsx` does not exist.

- [ ] Modify `DraftProductCard` to accept editor content without duplicating product facts:

```tsx
import type { ReactNode } from "react";

export interface DraftProductCardProps {
  item: DraftItem;
  validations: CartValidation[];
  showQuantity?: boolean;
  children?: ReactNode;
}

// Render package metadata as `Фасування: ×${formatNumber(item.displayRatio)}`.
// Render `{children}` after product facts and before post-commit validations.
```

Default `showQuantity` to `true`; the editor passes `false` because its labeled numeric input is the quantity authority. Keep all existing product facts and add the server-owned package ratio to the read-only and editable card alike. This prevents the picker from promising metadata that disappears after selection. Update the dashboard regression test to assert the package text and preserve every existing stock, promotion, confidence, reason, nutrition, and validation assertion.

- [ ] Modify `DraftSummary` with an optional action contract:

```ts
export interface DraftSummaryProps {
  draft: Draft;
  cart: VerifiedCart | null;
  itemCount?: number;
  displayTotal?: number;
  onConfirm?: () => void;
  confirmDisabled?: boolean;
  confirmDescription?: string | null;
  confirmPending?: boolean;
}
```

Default `itemCount` and `displayTotal` to the current draft-derived values, preserving every read-only caller. The editor supplies the number of all non-removed rows and its local presentation total, so an invalid input never makes an active row disappear. For a non-empty ready draft, the existing button calls `onConfirm`, takes `disabled={confirmDisabled || confirmPending}`, and uses `confirmPending ? "Підтверджуємо…" : "Додати у кошик “Сільпо”"`. Render the description in a stable element and connect it through `aria-describedby`. Existing checkout logic remains byte-for-byte equivalent.

- [ ] Create `DraftEditor` with reducer-like immutable updates. Use these state shapes and validation helper:

```ts
interface EditorRow {
  source: DraftItem;
  selected: DraftItem | ProductCandidate;
  quantityText: string;
  lastFiniteQuantity: number;
  removed: boolean;
  picker: "closed" | "unresolved";
  selectionBeforePicker: DraftItem | ProductCandidate;
}

function quantityError(row: EditorRow): string | null {
  const quantity = Number(row.quantityText);
  if (
    row.quantityText.trim() === "" ||
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    quantity > row.selected.stock ||
    Math.abs(quantity / row.selected.step - Math.round(quantity / row.selected.step)) > 1e-9
  ) {
    return `Кількість має відповідати кроку ${formatNumber(row.selected.step)} і не перевищувати запас ${formatNumber(row.selected.stock)}.`;
  }
  return null;
}
```

Use decimal-safe step normalization:

```ts
function stepQuantity(value: number, step: number, direction: -1 | 1): number {
  const precision = Math.max(decimalPlaces(value), decimalPlaces(step));
  const factor = 10 ** Math.min(precision, 9);
  return (Math.round(value * factor) + direction * Math.round(step * factor)) / factor;
}
```

Initialize `lastFiniteQuantity` from the source quantity and update it whenever typed text parses to a finite positive number, even if that number is temporarily step- or stock-invalid. The local presentation total uses each active row's parsed finite positive quantity, falling back to `lastFiniteQuantity` only for empty or non-finite intermediate text; it rounds to kopecks and uses the selected snapshot's effective price. This total is display state, not a `Draft` contract and is supplied through `DraftSummary.displayTotal` together with the full non-removed count.

For card presentation, map the selected candidate's product facts with the source need facts and a harmless schema-valid placeholder quantity of `candidate.step`; pass `showQuantity={false}` so that placeholder is never rendered or submitted. Build and `DraftSchema.parse` the confirming draft only after every active row passes `quantityError`, using the actual parsed quantities and the same explicit candidate mapping as the service. Build the request in original source order. The request's `itemVersion` is `draft.version` for every source row.

- [ ] Implement the default HTTP adapter inside `draft-editor.tsx`:

```ts
async function postDraftApproval(
  draftId: string,
  input: DraftApprovalInput,
): Promise<DraftApprovalResponse> {
  const response = await fetch(`/api/drafts/${encodeURIComponent(draftId)}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new DraftApprovalHttpError(response.status);
  const parsed = DraftApprovalResponseSchema.safeParse(payload);
  if (!parsed.success) throw new DraftApprovalHttpError(500);
  return parsed.data;
}
```

Import the response schema at runtime and request/response types from `approval-service.ts`. That module is framework- and database-client-free; its repository import must remain type-only so the client graph cannot pull Drizzle into the browser.

- [ ] Define the HTTP error and its copy mapping next to the adapter. Do not render server-provided error text:

```ts
class DraftApprovalHttpError extends Error {
  constructor(readonly status: number) {
    super(`draft approval failed with status ${status}`);
    this.name = "DraftApprovalHttpError";
  }
}

function messageForApprovalError(error: unknown): string {
  if (!(error instanceof DraftApprovalHttpError)) {
    return "Не вдалося підтвердити чернетку. Спробуйте ще раз.";
  }
  if (error.status === 401) {
    return "Не вдалося підтвердити вхід. Увійдіть у «Сільпо» ще раз.";
  }
  if (error.status === 404) return "Чернетку не знайдено. Створіть нову.";
  if (error.status === 409) {
    return "Чернетка змінилася. Оновіть сторінку й перевірте вибір ще раз.";
  }
  if (error.status === 422) return "Перевірте кількість або вибрану заміну.";
  return "Не вдалося підтвердити чернетку. Спробуйте ще раз.";
}
```

- [ ] Render the exact interaction structure:

```tsx
<section className="autopilot-products autopilot-editor" aria-labelledby="autopilot-products-title">
  <h2 id="autopilot-products-title">Ймовірно закінчується</h2>
  <ul className="autopilot-grid">
    {rows.map((row, index) => row.removed ? (
      <li key={row.source.productId} className="autopilot-product autopilot-product-removed">
        <h3>{row.source.name}</h3>
        <p>Товар прибрано з чернетки</p>
        <button type="button" onClick={() => restore(row.source.productId)}>
          Повернути {row.source.name}
        </button>
      </li>
    ) : (
      <DraftProductCard
        key={row.source.productId}
        item={displayItem(row)}
        validations={[]}
        showQuantity={false}
      >
        <div className="autopilot-quantity">
          <button
            type="button"
            aria-label={`Зменшити кількість ${displayItem(row).name}`}
            onClick={() => changeByStep(row.source.productId, -1)}
            disabled={submitting || cannotDecrease(row)}
          >−</button>
          <label htmlFor={`quantity-${index}`}>Кількість</label>
          <input
            id={`quantity-${index}`}
            type="number"
            inputMode="decimal"
            aria-label={`Кількість для ${displayItem(row).name}`}
            aria-invalid={quantityError(row) !== null}
            aria-describedby={quantityError(row) ? `quantity-error-${index}` : undefined}
            value={row.quantityText}
            onChange={(event) => setQuantity(row.source.productId, event.currentTarget.value)}
            disabled={submitting}
          />
          <button
            type="button"
            aria-label={`Збільшити кількість ${displayItem(row).name}`}
            onClick={() => changeByStep(row.source.productId, 1)}
            disabled={submitting || cannotIncrease(row)}
          >+</button>
        </div>
        {quantityError(row) && (
          <p id={`quantity-error-${index}`} className="autopilot-quantity-error">
            {quantityError(row)}
          </p>
        )}
        <div className="autopilot-editor-actions">
          <button className="autopilot-editor-button" type="button" onClick={() => remove(row.source.productId)} disabled={submitting}>
            Прибрати {displayItem(row).name}
          </button>
          {availableAlternatives(row).length > 0 && (
            <button className="autopilot-editor-button" type="button" onClick={() => openPicker(row.source.productId)} disabled={submitting}>
              Замінити {displayItem(row).name}
            </button>
          )}
        </div>
        {row.picker === "unresolved" && (
          <fieldset className="autopilot-picker" disabled={submitting}>
            <legend>Виберіть заміну для {row.source.name}</legend>
            <ul className="autopilot-picker-options">
              {availableAlternatives(row).map((candidate) => (
                <li key={candidate.productId}>
                  <label>
                    <input
                      type="radio"
                      name={`replacement-${index}`}
                      onChange={() => selectReplacement(row.source.productId, candidate.productId)}
                    />
                    <span className="autopilot-picker-copy">
                      <strong>{candidate.name} — {formatHryvnia(candidate.specialPrice ?? candidate.price)}</strong>
                      <span>Фасування: ×{formatNumber(candidate.displayRatio)}</span>
                      <span>В наявності: {formatNumber(candidate.stock)}</span>
                      {candidate.promotions.map((promotion) => (
                        <span key={promotion.id}>
                          {promotion.price === null
                            ? promotion.label
                            : `${promotion.label}: ${formatHryvnia(promotion.price)}`}
                        </span>
                      ))}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <button className="autopilot-editor-button" type="button" onClick={() => cancelPicker(row.source.productId)}>
              Скасувати заміну
            </button>
          </fieldset>
        )}
      </DraftProductCard>
    ))}
  </ul>
</section>
```

Inside the card, use actual `<button type="button">`, `<input type="number" inputMode="decimal">`, and a `<fieldset><legend>Виберіть заміну для {name}</legend>` with radio choices. Each label includes candidate name, formatted effective price, package ratio, stock, and every persisted promotion. A separate «Скасувати заміну» button closes the fieldset without selecting. Use stable IDs derived from an index, not raw product IDs, for `aria-describedby`.

- [ ] Submit with a synchronous in-flight guard in addition to disabled UI:

```ts
const submittingRef = useRef(false);

async function submit() {
  if (submittingRef.current || disabledReason !== null) return;
  submittingRef.current = true;
  setSubmitting(true);
  setSubmitError(null);
  try {
    const response = await (approveDraft ?? postDraftApproval)(draft.id, buildRequest(rows));
    onApproved({
      idempotencyKey: response.idempotencyKey,
      draft: { ...buildDisplayDraft(rows), status: "confirming", version: draft.version + 1 },
    });
  } catch (error) {
    setSubmitError(messageForApprovalError(error));
    submittingRef.current = false;
    setSubmitting(false);
  }
}
```

On success, do not unlock locally; the parent replaces the editor with the confirming dashboard. On failure, map status to the exact spec copy and unlock. Never call `/api/cart/commit`.

- [ ] Run editor and read-only regressions:

```bash
pnpm vitest run src/components/autopilot/draft-editor.test.tsx src/components/autopilot/draft-dashboard.test.tsx
pnpm typecheck
```

Expected: editor tests pass and all Task 14 tests remain green.

### 15.5 — Coordinate the confirming transition in the dashboard

- [ ] Add a dashboard test using a ready draft and injected approval request:

```tsx
it("T15-09 replaces the editor with confirming state after approval", async () => {
  const approveDraft = vi.fn(async () => ({ idempotencyKey: APPROVAL_KEY }));
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  renderDashboard({ approveDraft });

  fireEvent.click(screen.getByRole("button", { name: "Додати у кошик “Сільпо”" }));

  expect(await screen.findByRole("heading", {
    level: 2,
    name: "Перевіряємо ціну та наявність",
  })).toBeVisible();
  expect(screen.queryByRole("spinbutton")).toBeNull();
  expect(screen.queryByRole("link", { name: /Оформити/ })).toBeNull();
  expect(approveDraft).toHaveBeenCalledOnce();
  expect(fetchSpy).not.toHaveBeenCalled();
});
```

Add `fireEvent`, `waitFor` or `findByRole`, and `vi` imports. Extend `DraftDashboardProps` with optional `approveDraft?: ApproveDraftRequest` only for dependency injection; server callers omit it.

- [ ] Run the single test to prove red:

```bash
pnpm vitest run src/components/autopilot/draft-dashboard.test.tsx -t "T15-09"
```

Expected: FAIL because the dashboard does not render `DraftEditor` or accept `approveDraft`.

- [ ] Add `"use client"` to `draft-dashboard.tsx`. Keep an optional local override containing the confirming draft and key:

```ts
interface ApprovedState {
  idempotencyKey: string;
  draft: ConfirmingDraft;
}

const [approved, setApproved] = useState<ApprovedState | null>(null);
const sourceDraft = phase.kind === "draft" ? phase.draft : null;
const displayedDraft = approved?.draft ?? sourceDraft;
```

Reset `approved` in an effect only when the incoming phase changes to a different draft ID/version or to a server-supplied status beyond `ready`; do not reset merely because the component rerenders. Store the key even though Task 15 does not yet consume it, so Task 16 has one continuation seam.

When `displayedDraft.status === "ready"`, render `DraftEditor` in place of the existing product grid and `DraftSummary`. For every other actionable status, render the existing read-only product grid and summary. Pass `setApproved` through the editor callback and preserve header, overview, demo banner, validations, and checkout gates.

- [ ] Run all component tests:

```bash
pnpm vitest run src/components/autopilot/draft-editor.test.tsx src/components/autopilot/draft-dashboard.test.tsx
pnpm typecheck
```

Expected: PASS.

This fresh dashboard run is the T15-15 regression gate: every existing demo banner, validation, checkout, non-ready-state, ordering, and responsive semantic assertion must remain unchanged.

### 15.6 — Add accessible editor styling and responsive evidence

- [ ] Append only semantic classes using existing CSS variables in `src/app/globals.css`:

```css
.autopilot-editor-actions,
.autopilot-quantity,
.autopilot-picker-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--autopilot-space-2);
  align-items: center;
}

.autopilot-editor-button,
.autopilot-quantity button,
.autopilot-product-removed button {
  min-width: 44px;
  min-height: 44px;
  border: 1px solid var(--autopilot-border);
  border-radius: var(--autopilot-radius-pill);
  background: var(--autopilot-surface);
  color: var(--autopilot-ink);
}

.autopilot-quantity input {
  width: 88px;
  min-height: 44px;
  border: 1px solid var(--autopilot-border);
  border-radius: var(--autopilot-radius-sm);
  padding-inline: var(--autopilot-space-2);
  font: inherit;
  font-variant-numeric: tabular-nums;
}

.autopilot-quantity input[aria-invalid="true"] {
  border: 2px solid var(--autopilot-danger);
}

.autopilot-editor-error,
.autopilot-quantity-error {
  color: var(--autopilot-danger);
  font-size: var(--autopilot-font-small);
}

.autopilot-product-removed {
  border: 2px dashed var(--autopilot-border);
  background: var(--autopilot-bg);
}

.autopilot-picker {
  margin: 0;
  padding: var(--autopilot-space-3);
  border: 1px solid var(--autopilot-border);
  border-radius: var(--autopilot-radius-sm);
}

.autopilot-picker-options {
  display: grid;
  gap: var(--autopilot-space-2);
  margin: var(--autopilot-space-3) 0;
  padding: 0;
  list-style: none;
}

.autopilot-picker label {
  display: flex;
  min-height: 44px;
  gap: var(--autopilot-space-2);
  align-items: center;
}

.autopilot-picker-copy {
  display: grid;
  flex: 1;
  gap: var(--autopilot-space-1);
  min-width: 0;
}

.autopilot-editor button:disabled,
.autopilot-editor input:disabled {
  cursor: not-allowed;
  opacity: 0.65;
}
```

Use the existing global `:focus-visible`, summary mobile layout, and reduced-motion rule. Add no new color literal and no inline style.

- [ ] Add structural assertions to `draft-editor.test.tsx`: every editor button and input has a semantic role/name, invalid input has `aria-describedby`, failure uses `role="alert"`, pending confirmation exposes status text, and removed/unresolved/pending states contain textual labels independent of CSS.

- [ ] Run static component verification:

```bash
pnpm vitest run src/components/autopilot/draft-editor.test.tsx src/components/autopilot/draft-dashboard.test.tsx
pnpm lint
pnpm typecheck
pnpm build
```

Expected: every command exits 0.

- [ ] Inspect the ready editor at 390 px and 1440 px through the existing development/browser workflow. At each width verify no horizontal overflow, no sticky-summary overlap, visible focus on every action, and 44 by 44 pixel targets. Record the observations in the Task 15 completion note; do not add a new Playwright suite owned by Task 18.

### 15.7 — Update durable documentation and run final gates

- [ ] In `docs/project-architecture.md`, add `DraftApprovalService` immediately after `DraftService`:

```markdown
### `DraftApprovalService`

Приймає лише IDs, версії та quantity intent для повного набору вихідних позицій. Перевіряє ownership, `ready` status, draft/item versions, allowlisted replacements, `step`, stock і unique active products; відновлює всі product facts із persisted snapshots. `DraftRepository.approveSelection` в одній транзакції блокує draft, зберігає kept/replaced/removed decisions, переводить draft у `confirming` і створює один UUID idempotency key. Повторний або конкурентний запит повертає вже збережений key. Жодного MCP або cart write цей сервіс не виконує.
```

Extend section 7 with an approval flow between draft generation and cart commit:

````markdown
### 7.4. Draft editing and approval

```text
ready draft snapshot
→ local quantity/remove/replace edits
→ validate owned draft and item versions
→ reconstruct selection from persisted snapshots
→ atomic edited draft + approval
→ confirming + idempotency key
```

Removed rows remain decision tombstones but normal draft reads return only active items. The approval route performs no cart call; Task 16 revalidates slot, stock, price and step before write.
````

Renumber the existing cart-commit subsection to 7.5. Keep its behavior unchanged.

- [ ] Refine Task 15 in `docs/tasks.md` to include the approved additional service/repository/component/CSS/doc files and focused command. Check each Task 15 step only after its evidence is fresh. Append this completion-note form with actual results filled from the commands below, not estimates:

```markdown
Виконано 2026-09-09. Специфікація: [design](./superpowers/specs/2026-09-09-draft-editing-approval-design.md), план: [plan](./superpowers/plans/2026-09-09-draft-editing-approval.md). Approval route не викликає MCP або cart write; live write smoke належить Task 16. Перевірено component/service/repository/integration suites, lint, typecheck, build і responsive layout на 390 px та 1440 px.
```

If execution occurs on a later calendar day, replace `2026-09-09` with that actual date before committing. Also mark Task 14 complete if and only if its existing implementation/review evidence and focused/build gates were reconfirmed in this checkout; otherwise leave its stale checkbox unchanged and mention the ledger drift in the handoff.

- [ ] Run the focused suite from a fresh invocation:

```bash
pnpm vitest run \
  src/features/drafts/approval-service.test.ts \
  src/features/drafts/repository.test.ts \
  src/components/autopilot/draft-editor.test.tsx \
  src/components/autopilot/draft-dashboard.test.tsx \
  tests/integration/draft-approval.test.ts
```

Expected: PASS with every T15 acceptance ID represented.

- [ ] Run cumulative and static/build gates separately so each failure is attributable:

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

Expected: every command exits 0. Do not claim success from an earlier invocation.

- [ ] Review the final diff:

```bash
git diff --check
git diff --stat
git diff -- \
  src/features/drafts/repository.ts \
  src/features/drafts/approval-service.ts \
  src/app/api/drafts/'[draftId]'/approve/route.ts \
  src/components/autopilot \
  src/app/globals.css \
  tests/integration/draft-approval.test.ts \
  docs/project-architecture.md \
  docs/tasks.md
rg -n 'TO''DO|TB''D|FIX''ME|console\.(log|debug)|addQuantity=true|/api/cart/commit' \
  src/features/drafts \
  src/app/api/drafts/'[draftId]'/approve \
  src/components/autopilot \
  tests/integration/draft-approval.test.ts
```

Expected: no whitespace errors; only owned files changed; no secrets, raw payload logging, placeholders, cart call, or alternate approval path. `/api/cart/commit` may appear only in a negative test assertion proving it was not called.

- [ ] Stage only Task 15 files and commit once:

```bash
git add \
  src/features/drafts/repository.ts \
  src/features/drafts/repository.test.ts \
  src/features/drafts/approval-service.ts \
  src/features/drafts/approval-service.test.ts \
  src/app/api/drafts/'[draftId]'/approve/handlers.ts \
  src/app/api/drafts/'[draftId]'/approve/route.ts \
  tests/integration/draft-approval.test.ts \
  src/components/autopilot/draft-editor.tsx \
  src/components/autopilot/draft-editor.test.tsx \
  src/components/autopilot/draft-dashboard.tsx \
  src/components/autopilot/draft-dashboard.test.tsx \
  src/components/autopilot/draft-product-card.tsx \
  src/components/autopilot/draft-summary.tsx \
  src/app/globals.css \
  docs/project-architecture.md \
  docs/tasks.md
git diff --cached --check
git commit -m "feat: edit and approve draft baskets"
```

Do not stage `.gitignore`, `AGENTS.md`, `.claude/`, the design spec, or this implementation plan; the spec and plan are already committed documentation history.

- [ ] Record handoff evidence:

```bash
git status --short
git rev-parse HEAD
git show --stat --oneline --summary HEAD
```

The handoff reports changed files, focused/cumulative/static/build results, 390 px and 1440 px observations, remaining risk that live cart behavior is intentionally untested until Task 16, and the exact commit hash. The only remaining working-tree entries should be the preserved user-owned changes.
