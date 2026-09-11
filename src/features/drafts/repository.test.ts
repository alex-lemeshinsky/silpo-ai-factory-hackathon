import { describe, expect, it, vi, type Mock } from "vitest";
import type { DbClient } from "@/db/client";
import { drafts } from "@/db/schema";
import {
  DraftItemSchema,
  DraftSchema,
  ProductCandidateSchema,
  type Draft,
  type DraftItem,
  type ProductCandidate,
} from "@/features/shared/contracts";
import {
  createInMemoryDraftRepository,
  createPostgresDraftRepository,
  replacedFromPriceFor,
  type PersistDraftApprovalInput,
} from "./repository";

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

const editableDraftFixture: Draft = DraftSchema.parse({
  id: "00000000-0000-4000-8000-000000000001",
  mode: "demo",
  status: "ready",
  algorithmVersion: "prediction-v1",
  trainingCutoff: "2026-09-01T10:00:00.000Z",
  summary: "Регулярне поповнення",
  items: [
    {
      productId: "product-1",
      externalProductId: 101,
      name: "Молоко",
      imageUrl: null,
      displayRatio: 1,
      quantity: 2,
      price: 55,
      specialPrice: null,
      stock: 10,
      step: 1,
      confidence: 0.8,
      confidenceBand: "high",
      reasonCodes: ["weekly_cycle"],
      reason: "Купуєте приблизно щотижня",
      nutritionStatus: "insufficient",
      promotions: [],
      alternatives: [],
    },
    {
      productId: "product-2",
      externalProductId: 102,
      name: "Сметана",
      imageUrl: null,
      displayRatio: 1,
      quantity: 1,
      price: 65,
      specialPrice: null,
      stock: 10,
      step: 1,
      confidence: 0.8,
      confidenceBand: "high",
      reasonCodes: ["weekly_cycle"],
      reason: "Купуєте приблизно щотижня",
      nutritionStatus: "insufficient",
      promotions: [],
      alternatives: [replacement],
    },
    {
      productId: "product-3",
      externalProductId: 103,
      name: "Хліб",
      imageUrl: null,
      displayRatio: 1,
      quantity: 1,
      price: 30,
      specialPrice: null,
      stock: 5,
      step: 1,
      confidence: 0.8,
      confidenceBand: "high",
      reasonCodes: ["weekly_cycle"],
      reason: "Купуєте приблизно щотижня",
      nutritionStatus: "insufficient",
      promotions: [],
      alternatives: [],
    },
  ],
  total: 2 * 55 + 65 + 30,
  version: 1,
});

const draftFixture = editableDraftFixture;

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

describe("DraftRepository (in-memory)", () => {
  it("saves, loads, and updates an owned draft", async () => {
    const repo = createInMemoryDraftRepository();

    await repo.save("user-1", draftFixture);
    expect(await repo.get(draftFixture.id, "user-1")).toEqual(draftFixture);
    expect(await repo.get(draftFixture.id, "user-2")).toBeNull();

    const updated = { ...draftFixture, summary: "Оновлена чернетка", version: 2 };
    await repo.save("user-1", updated, { expectedVersion: 1 });
    expect(await repo.get(draftFixture.id, "user-1")).toEqual(updated);

    await expect(
      repo.save("user-1", { ...updated, version: 3 }, { expectedVersion: 1 }),
    ).rejects.toThrow(/version/i);
  });

  it("rejects invalid drafts and ownership changes", async () => {
    const repo = createInMemoryDraftRepository();
    await repo.save("user-1", draftFixture);

    await expect(repo.save("user-2", draftFixture)).rejects.toThrow(/owner/i);
    await expect(
      repo.save("user-1", { ...draftFixture, total: -1 } as Draft),
    ).rejects.toThrow();
  });

  it("T15-12 atomically stores kept, replaced, and removed decisions", async () => {
    const repo = createInMemoryDraftRepository();
    await repo.save("user-1", editableDraftFixture);

    const firstItem: DraftItem = editableDraftFixture.items[0];
    expect(DraftItemSchema.safeParse(firstItem).success).toBe(true);

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

  it("returns not_found when approving a missing draft or from a different owner", async () => {
    const repo = createInMemoryDraftRepository();
    await repo.save("user-1", editableDraftFixture);

    // Missing draft
    const missing = approvalMutation({
      draftId: "00000000-0000-4000-8000-000000000099",
      approvedDraft: { ...approvalMutation().approvedDraft, id: "00000000-0000-4000-8000-000000000099" },
    });
    await expect(repo.approveSelection(missing)).resolves.toEqual({ status: "not_found" });

    // Different owner
    const wrongOwner = approvalMutation({ userId: "user-2" });
    await expect(repo.approveSelection(wrongOwner)).resolves.toEqual({ status: "not_found" });
    await expect(repo.get(editableDraftFixture.id, "user-1")).resolves.toEqual(editableDraftFixture);
    await expect(repo.getApproval(editableDraftFixture.id, "user-1")).resolves.toBeNull();
  });

  it("returns conflict on stale draft version, incomplete decisions, or duplicate decisions", async () => {
    const repo = createInMemoryDraftRepository();
    await repo.save("user-1", editableDraftFixture);

    // Stale draft version
    await expect(
      repo.approveSelection(approvalMutation({ expectedDraftVersion: 9 })),
    ).resolves.toEqual({ status: "conflict" });

    // Incomplete decisions (2 instead of 3)
    await expect(
      repo.approveSelection(approvalMutation({ decisions: approvalMutation().decisions.slice(0, 2) })),
    ).resolves.toEqual({ status: "conflict" });

    // Duplicate decisions (same sourceProductId twice)
    await expect(
      repo.approveSelection(approvalMutation({
        decisions: [
          approvalMutation().decisions[0],
          approvalMutation().decisions[0],
          approvalMutation().decisions[2],
        ],
      })),
    ).resolves.toEqual({ status: "conflict" });

    await expect(repo.get(editableDraftFixture.id, "user-1")).resolves.toEqual(editableDraftFixture);
    await expect(repo.getApproval(editableDraftFixture.id, "user-1")).resolves.toBeNull();
  });

  it("returns conflict when approvedDraft has wrong id, version, or status", async () => {
    const repo = createInMemoryDraftRepository();
    await repo.save("user-1", editableDraftFixture);

    // Wrong ID
    await expect(
      repo.approveSelection(approvalMutation({
        approvedDraft: { ...approvalMutation().approvedDraft, id: "00000000-0000-4000-8000-000000000099" },
      })),
    ).resolves.toEqual({ status: "conflict" });

    // Wrong version (not expectedDraftVersion + 1)
    await expect(
      repo.approveSelection(approvalMutation({
        approvedDraft: { ...approvalMutation().approvedDraft, version: 5 },
      })),
    ).resolves.toEqual({ status: "conflict" });

    // Wrong status
    await expect(
      repo.approveSelection(approvalMutation({
        approvedDraft: { ...approvalMutation().approvedDraft, status: "ready" as unknown as "confirming" },
      })),
    ).resolves.toEqual({ status: "conflict" });

    await expect(repo.get(editableDraftFixture.id, "user-1")).resolves.toEqual(editableDraftFixture);
    await expect(repo.getApproval(editableDraftFixture.id, "user-1")).resolves.toBeNull();
  });

  it("rejects when idempotency key was already used for another draft", async () => {
    const repo = createInMemoryDraftRepository();
    await repo.save("user-1", editableDraftFixture);

    const secondDraft: Draft = {
      ...editableDraftFixture,
      id: "00000000-0000-4000-8000-000000000002",
    };
    await repo.save("user-1", secondDraft);

    // Approve first draft
    await repo.approveSelection(approvalMutation());

    // Attempt to approve second draft with same idempotency key
    const secondMutation: PersistDraftApprovalInput = {
      ...approvalMutation(),
      draftId: secondDraft.id,
      approvedDraft: {
        ...approvalMutation().approvedDraft,
        id: secondDraft.id,
      },
    };
    await expect(repo.approveSelection(secondMutation)).rejects.toThrow();

    // Second draft remains ready and unapproved
    await expect(repo.get(secondDraft.id, "user-1")).resolves.toEqual(secondDraft);
    await expect(repo.getApproval(secondDraft.id, "user-1")).resolves.toBeNull();
  });

  it("retrieves persisted approval or returns null", async () => {
    const repo = createInMemoryDraftRepository();
    expect(await repo.getApproval(editableDraftFixture.id, "user-1")).toBeNull();

    await repo.save("user-1", editableDraftFixture);
    await repo.approveSelection(approvalMutation());
    const record = await repo.getApproval(editableDraftFixture.id, "user-1");

    expect(record).not.toBeNull();
    expect(record?.id).toBeDefined();
    expect(typeof record?.id).toBe("string");
    expect(record?.draftId).toBe(editableDraftFixture.id);
    expect(record?.userId).toBe("user-1");
    expect(record?.idempotencyKey).toBe("00000000-0000-4000-8000-000000000015");
    expect(await repo.getApproval(editableDraftFixture.id, "user-2")).toBeNull();
  });

  it("A7-02 round-trips presentation fields through the in-memory repository", async () => {
    const repo = createInMemoryDraftRepository();
    const discounted: Draft = {
      ...draftFixture,
      items: [{
        ...draftFixture.items[0],
        imageUrl: "https://example.test/water.png",
        displayRatio: 0.5,
        specialPrice: 45,
        promotions: [{ id: "promo-1", label: "Акція тижня", price: 45 }],
      }],
      total: 90,
    };

    await repo.save("user-1", discounted);
    expect(await repo.get(discounted.id, "user-1")).toEqual(discounted);
  });

  it("A7-02 rejects a stored row missing its display ratio", () => {
    expect(() => DraftSchema.parse({
      ...draftFixture,
      items: [{ ...draftFixture.items[0], displayRatio: null }],
    })).toThrow();
  });
});

describe("DraftRepository (postgres)", () => {
  let mockDb: DbClient;
  let lockForUpdate: Mock;
  let itemUpdates: Array<Record<string, unknown>>;
  let approvalInsert: Mock;
  let draftUpdate: Mock<() => unknown>;

  function mockDbForSuccessfulApproval() {
    lockForUpdate = vi.fn().mockReturnThis();
    itemUpdates = [];
    draftUpdate = vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => [{ id: editableDraftFixture.id }]),
        })),
      })),
    }));
    const updateItem = vi.fn(() => ({
      set: vi.fn((val: Record<string, unknown>) => {
        itemUpdates.push(val);
        return {
          where: vi.fn(async () => []),
        };
      }),
    }));
    approvalInsert = vi.fn(async () => []);

    const lockedDraftRow = {
      id: editableDraftFixture.id,
      userId: "user-1",
      sourceRunId: "run-1",
      mode: "demo",
      status: "ready",
      total: editableDraftFixture.total,
      version: 1,
      summary: editableDraftFixture.summary,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const itemRows = [
      { id: "item-row-1", draftId: editableDraftFixture.id, productId: "product-1", version: 1, position: 0 },
      { id: "item-row-2", draftId: editableDraftFixture.id, productId: "product-2", version: 1, position: 1 },
      { id: "item-row-3", draftId: editableDraftFixture.id, productId: "product-3", version: 1, position: 2 },
    ];

    let selectCallCount = 0;
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => {
          selectCallCount++;
          if (selectCallCount === 1) {
            return {
              where: vi.fn(() => ({
                for: lockForUpdate.mockReturnValue({
                  limit: vi.fn(async () => [lockedDraftRow]),
                }),
              })),
            };
          } else if (selectCallCount === 2) {
            return {
              where: vi.fn(() => ({
                limit: vi.fn(async () => []),
              })),
            };
          } else {
            return {
              where: vi.fn(() => ({
                orderBy: vi.fn(() => ({
                  for: lockForUpdate.mockReturnValue(Promise.resolve(itemRows)),
                })),
              })),
            };
          }
        }),
      })),
      update: vi.fn((table) => {
        if (table === drafts) {
          return draftUpdate();
        }
        return updateItem();
      }),
      insert: vi.fn(() => ({
        values: approvalInsert,
      })),
    };

    mockDb = {
      transaction: vi.fn(async <T>(callback: (txArg: typeof tx) => Promise<T>) => callback(tx)),
    } as unknown as DbClient;

    return mockDb;
  }

  function mockDbWithExistingApproval() {
    draftUpdate = vi.fn();
    itemUpdates = [];
    approvalInsert = vi.fn();

    const lockedDraftRow = {
      id: editableDraftFixture.id,
      userId: "user-1",
      sourceRunId: "run-1",
      mode: "demo",
      status: "ready",
      total: editableDraftFixture.total,
      version: 1,
      summary: editableDraftFixture.summary,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const existingApprovalRow = {
      id: "app-row-1",
      draftId: editableDraftFixture.id,
      userId: "user-1",
      idempotencyKey: "00000000-0000-4000-8000-000000000015",
      createdAt: new Date(),
    };

    let selectCallCount = 0;
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => {
          selectCallCount++;
          if (selectCallCount === 1) {
            return {
              where: vi.fn(() => ({
                for: vi.fn().mockReturnValue({
                  limit: vi.fn(async () => [lockedDraftRow]),
                }),
              })),
            };
          } else {
            return {
              where: vi.fn(() => ({
                limit: vi.fn(async () => [existingApprovalRow]),
              })),
            };
          }
        }),
      })),
      update: draftUpdate,
      insert: approvalInsert,
    };

    return {
      transaction: vi.fn(async <T>(callback: (txArg: typeof tx) => Promise<T>) => callback(tx)),
    } as unknown as DbClient;
  }

  it("persists a draft, prediction metadata, and item snapshots atomically", async () => {
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => []) })),
        })),
      })),
      insert: vi
        .fn()
        .mockImplementationOnce(() => ({
          values: vi.fn(() => ({
            returning: vi.fn(async () => [{ id: "00000000-0000-4000-8000-000000000099" }]),
          })),
        }))
        .mockImplementationOnce(() => ({ values: vi.fn(async () => []) }))
        .mockImplementationOnce(() => ({ values: vi.fn(async () => []) })),
    };
    const db = {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<Draft>) =>
        callback(tx)),
    } as unknown as DbClient;

    const repo = createPostgresDraftRepository(db);
    await expect(repo.save("user-1", draftFixture)).resolves.toEqual(draftFixture);
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(tx.insert).toHaveBeenCalledTimes(3);
  });

  it("updates a draft only when the persisted version matches", async () => {
    const updatedDraft = { ...draftFixture, summary: "Оновлена чернетка", version: 2 };
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [{
              userId: "user-1",
              sourceRunId: "00000000-0000-4000-8000-000000000099",
              version: 1,
            }]),
          })),
        })),
      })),
      update: vi
        .fn()
        .mockImplementationOnce(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({
              returning: vi.fn(async () => [{ id: draftFixture.id }]),
            })),
          })),
        }))
        .mockImplementationOnce(() => ({
          set: vi.fn(() => ({ where: vi.fn(async () => []) })),
        })),
      delete: vi.fn(() => ({ where: vi.fn(async () => []) })),
      insert: vi.fn(() => ({ values: vi.fn(async () => []) })),
    };
    const db = {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<Draft>) =>
        callback(tx)),
    } as unknown as DbClient;
    const repo = createPostgresDraftRepository(db);

    await expect(
      repo.save("user-1", updatedDraft, { expectedVersion: 1 }),
    ).resolves.toEqual(updatedDraft);
    expect(tx.update).toHaveBeenCalledTimes(2);
    expect(tx.delete).toHaveBeenCalledOnce();
  });

  it("loads and validates an owned draft from postgres excluding removed tombstones", async () => {
    const createdAt = new Date("2026-09-01T10:00:00.000Z");
    const storedDraft = {
      id: draftFixture.id,
      userId: "user-1",
      sourceRunId: "00000000-0000-4000-8000-000000000099",
      mode: draftFixture.mode,
      status: draftFixture.status,
      total: draftFixture.total,
      version: draftFixture.version,
      summary: draftFixture.summary,
      createdAt,
      updatedAt: createdAt,
    };
    const storedRun = {
      id: "00000000-0000-4000-8000-000000000099",
      userId: "user-1",
      algorithmVersion: draftFixture.algorithmVersion,
      temporalCutoff: new Date(draftFixture.trainingCutoff),
      metrics: null,
      status: draftFixture.status,
      createdAt,
    };
    const storedItem = {
      id: "00000000-0000-4000-8000-000000000098",
      draftId: draftFixture.id,
      ...draftFixture.items[0],
      userDecision: null,
      version: draftFixture.version,
      position: 0,
    };
    let capturedWhere: unknown;
    const select = vi
      .fn()
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [{ draft: storedDraft, run: storedRun }]),
            })),
          })),
        })),
      }))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn((clause) => {
            capturedWhere = clause;
            return {
              orderBy: vi.fn(async () => [
                storedItem,
                { ...storedItem, id: "item-2", ...draftFixture.items[1], position: 1 },
                { ...storedItem, id: "item-3", ...draftFixture.items[2], position: 2 },
              ]),
            };
          }),
        })),
      }));
    const repo = createPostgresDraftRepository({ select } as unknown as DbClient);

    await expect(repo.get(draftFixture.id, "user-1")).resolves.toEqual(draftFixture);
    expect(capturedWhere).toBeDefined();
  });

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

  it("rolls back draft and item changes when approval insert throws in postgres", async () => {
    let fakeDraft = {
      id: editableDraftFixture.id,
      userId: "user-1",
      status: "ready",
      version: 1,
      total: editableDraftFixture.total,
    };
    const fakeItems = [
      { id: "item-row-1", draftId: editableDraftFixture.id, productId: "product-1", version: 1, userDecision: null, position: 0 },
      { id: "item-row-2", draftId: editableDraftFixture.id, productId: "product-2", version: 1, userDecision: null, position: 1 },
      { id: "item-row-3", draftId: editableDraftFixture.id, productId: "product-3", version: 1, userDecision: null, position: 2 },
    ];
    const fakeApprovals: Array<Record<string, unknown>> = [];

    let selectCallCount = 0;
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => {
          selectCallCount++;
          if (selectCallCount === 1) {
            return {
              where: vi.fn(() => ({
                for: vi.fn().mockReturnValue({
                  limit: vi.fn(async () => [fakeDraft]),
                }),
              })),
            };
          } else if (selectCallCount === 2) {
            return {
              where: vi.fn(() => ({
                limit: vi.fn(async () => fakeApprovals),
              })),
            };
          } else {
            return {
              where: vi.fn(() => ({
                orderBy: vi.fn(() => ({
                  for: vi.fn().mockReturnValue(Promise.resolve(fakeItems)),
                })),
              })),
            };
          }
        }),
      })),
      update: vi.fn((table) => {
        if (table === drafts) {
          return {
            set: vi.fn((val) => {
              Object.assign(fakeDraft, val);
              return {
                where: vi.fn(() => ({
                  returning: vi.fn(async () => [{ id: fakeDraft.id }]),
                })),
              };
            }),
          };
        }
        return {
          set: vi.fn((val) => {
            return {
              where: vi.fn(async () => {
                const target = fakeItems.find((i) => i.productId === val.productId || (val.userDecision === "removed" && i.productId === "product-3"));
                if (target) Object.assign(target, val);
              }),
            };
          }),
        };
      }),
      insert: vi.fn(() => ({
        values: vi.fn(async () => {
          throw new Error("unique constraint violation: draft_approvals.idempotency_key");
        }),
      })),
    };

    const rollbackDb = {
      transaction: vi.fn(async <T>(cb: (txArg: typeof tx) => Promise<T>) => {
        const draftSnapshot = { ...fakeDraft };
        const itemsSnapshot = fakeItems.map((item) => ({ ...item }));
        const approvalsSnapshot = [...fakeApprovals];
        try {
          return await cb(tx);
        } catch (error) {
          fakeDraft = draftSnapshot;
          for (let i = 0; i < fakeItems.length; i++) {
            Object.assign(fakeItems[i], itemsSnapshot[i]);
          }
          fakeApprovals.length = 0;
          fakeApprovals.push(...approvalsSnapshot);
          throw error;
        }
      }),
    } as unknown as DbClient;

    const repo = createPostgresDraftRepository(rollbackDb);
    await expect(repo.approveSelection(approvalMutation())).rejects.toThrow("unique constraint violation");

    expect(fakeDraft.status).toBe("ready");
    expect(fakeDraft.version).toBe(1);
    expect(fakeItems[0].version).toBe(1);
    expect(fakeItems[0].userDecision).toBeNull();
    expect(fakeApprovals).toHaveLength(0);
  });

  it("returns not_found before any update when locked row is missing in postgres", async () => {
    const updateFn = vi.fn();
    const insertFn = vi.fn();
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            for: vi.fn().mockReturnValue({
              limit: vi.fn(async () => []),
            }),
          })),
        })),
      })),
      update: updateFn,
      insert: insertFn,
    };
    const db = {
      transaction: vi.fn(async <T>(cb: (txArg: typeof tx) => Promise<T>) => cb(tx)),
    } as unknown as DbClient;

    const repo = createPostgresDraftRepository(db);
    await expect(repo.approveSelection(approvalMutation({ userId: "user-2" }))).resolves.toEqual({
      status: "not_found",
    });
    expect(updateFn).not.toHaveBeenCalled();
    expect(insertFn).not.toHaveBeenCalled();
  });

  it("returns conflict before updates when locked row has stale version in postgres", async () => {
    const updateFn = vi.fn();
    const insertFn = vi.fn();
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            for: vi.fn().mockReturnValue({
              limit: vi.fn(async () => [{
                id: editableDraftFixture.id,
                userId: "user-1",
                status: "ready",
                version: 2,
              }]),
            }),
            limit: vi.fn(async () => []),
          })),
        })),
      })),
      update: updateFn,
      insert: insertFn,
    };
    const db = {
      transaction: vi.fn(async <T>(cb: (txArg: typeof tx) => Promise<T>) => cb(tx)),
    } as unknown as DbClient;

    const repo = createPostgresDraftRepository(db);
    await expect(repo.approveSelection(approvalMutation({ expectedDraftVersion: 1 }))).resolves.toEqual({
      status: "conflict",
    });
    expect(updateFn).not.toHaveBeenCalled();
    expect(insertFn).not.toHaveBeenCalled();
  });

  it("retrieves approval record from postgres scoped to user", async () => {
    const now = new Date();
    const rows = [
      {
        id: "uuid-1",
        draftId: "draft-1",
        userId: "user-1",
        idempotencyKey: "key-1",
        createdAt: now,
      },
    ];
    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => rows),
          })),
        })),
      })),
    } as unknown as DbClient;

    const repo = createPostgresDraftRepository(mockDb);
    const record = await repo.getApproval("draft-1", "user-1");
    expect(record).toEqual({
      id: "uuid-1",
      draftId: "draft-1",
      userId: "user-1",
      idempotencyKey: "key-1",
      createdAt: now,
    });
  });

  it("A7-02 writes presentation columns in the item insert", async () => {
    const itemValues = vi.fn(async () => []);
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => []) })),
        })),
      })),
      insert: vi
        .fn()
        .mockImplementationOnce(() => ({
          values: vi.fn(() => ({
            returning: vi.fn(async () => [{ id: "00000000-0000-4000-8000-000000000099" }]),
          })),
        }))
        .mockImplementationOnce(() => ({ values: vi.fn(async () => []) }))
        .mockImplementationOnce(() => ({ values: itemValues })),
    };
    const db = {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<Draft>) => callback(tx)),
    } as unknown as DbClient;

    await createPostgresDraftRepository(db).save("user-1", {
      ...draftFixture,
      items: [{
        ...draftFixture.items[0],
        imageUrl: "https://example.test/milk.png",
        displayRatio: 0.5,
        specialPrice: 45,
        promotions: [{ id: "promo-1", label: "Акція", price: 45 }],
      }],
      total: 90,
    });

    expect(itemValues).toHaveBeenCalledWith([expect.objectContaining({
      imageUrl: "https://example.test/milk.png",
      displayRatio: 0.5,
      specialPrice: 45,
      promotions: [{ id: "promo-1", label: "Акція", price: 45 }],
    })]);
  });

  it("records commit outcome in postgres without version bump", async () => {
    const updateFn = vi.fn(() => ({
      where: vi.fn(async () => []),
    }));
    const selectFn = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ status: "confirming" }]),
        })),
      })),
    }));
    const mockDb = {
      select: selectFn,
      update: vi.fn(() => ({
        set: updateFn,
      })),
    } as unknown as DbClient;

    const repo = createPostgresDraftRepository(mockDb);
    const result = await repo.recordCommitOutcome({
      draftId: editableDraftFixture.id,
      userId: "user-1",
      status: "verified",
    });

    expect(result).toBe("updated");
    expect(updateFn).toHaveBeenCalledWith(expect.objectContaining({
      status: "verified",
    }));
  });

  it("returns not_found in postgres for missing draft", async () => {
    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => []),
          })),
        })),
      })),
    } as unknown as DbClient;

    const repo = createPostgresDraftRepository(mockDb);
    const result = await repo.recordCommitOutcome({
      draftId: "missing-id",
      userId: "user-1",
      status: "verified",
    });
    expect(result).toBe("not_found");
  });

  it("returns conflict in postgres for unapproved draft", async () => {
    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [{ status: "ready" }]),
          })),
        })),
      })),
    } as unknown as DbClient;

    const repo = createPostgresDraftRepository(mockDb);
    const result = await repo.recordCommitOutcome({
      draftId: editableDraftFixture.id,
      userId: "user-1",
      status: "verified",
    });
    expect(result).toBe("conflict");
  });
});

describe("recordCommitOutcome (in-memory)", () => {
  const USER = "user-1";
  const readyDraft = editableDraftFixture;

  it("moves a confirming draft to a terminal status without changing its version", async () => {
    const repository = createInMemoryDraftRepository();
    await repository.save(USER, readyDraft);
    await repository.approveSelection(approvalMutation());

    const outcome = await repository.recordCommitOutcome({
      draftId: readyDraft.id,
      userId: USER,
      status: "verified",
    });

    expect(outcome).toBe("updated");
    const stored = await repository.get(readyDraft.id, USER);
    expect(stored?.status).toBe("verified");
    expect(stored?.version).toBe(readyDraft.version + 1);
  });

  it("keeps removed decisions as tombstones", async () => {
    const repository = createInMemoryDraftRepository();
    await repository.save(USER, readyDraft);
    await repository.approveSelection(approvalMutation());

    await repository.recordCommitOutcome({ draftId: readyDraft.id, userId: USER, status: "blocked" });
    const stored = await repository.get(readyDraft.id, USER);
    expect(stored?.items.map((entry) => entry.productId)).toEqual(["product-1", "product-2-alt"]);
    expect(await repository.getApproval(readyDraft.id, USER)).not.toBeNull();
  });

  it("does not change item quantities or prices", async () => {
    const repository = createInMemoryDraftRepository();
    await repository.save(USER, readyDraft);
    await repository.approveSelection(approvalMutation());

    const before = await repository.get(readyDraft.id, USER);
    await repository.recordCommitOutcome({ draftId: readyDraft.id, userId: USER, status: "partially_committed" });
    const after = await repository.get(readyDraft.id, USER);
    expect(after?.items).toEqual(before?.items);
    expect(after?.total).toBe(before?.total);
  });

  it("returns not_found for an unknown draft", async () => {
    const repository = createInMemoryDraftRepository();
    await expect(repository.recordCommitOutcome({
      draftId: "11111111-1111-4111-8111-111111111111",
      userId: USER,
      status: "verified",
    })).resolves.toBe("not_found");
  });

  it("returns not_found for a draft owned by someone else", async () => {
    const repository = createInMemoryDraftRepository();
    await repository.save(USER, readyDraft);
    await repository.approveSelection(approvalMutation());

    await expect(repository.recordCommitOutcome({
      draftId: readyDraft.id,
      userId: "another-user",
      status: "verified",
    })).resolves.toBe("not_found");
  });

  it("returns conflict for a draft that was never approved", async () => {
    const repository = createInMemoryDraftRepository();
    await repository.save(USER, readyDraft);
    await expect(repository.recordCommitOutcome({
      draftId: readyDraft.id,
      userId: USER,
      status: "verified",
    })).resolves.toBe("conflict");
  });

  it("is idempotent across repeated identical outcomes", async () => {
    const repository = createInMemoryDraftRepository();
    await repository.save(USER, readyDraft);
    await repository.approveSelection(approvalMutation());

    await repository.recordCommitOutcome({ draftId: readyDraft.id, userId: USER, status: "verified" });
    await expect(repository.recordCommitOutcome({
      draftId: readyDraft.id,
      userId: USER,
      status: "verified",
    })).resolves.toBe("updated");
  });

  it("rejects a status that is not a terminal commit status", async () => {
    const repository = createInMemoryDraftRepository();
    await repository.save(USER, readyDraft);
    await repository.approveSelection(approvalMutation());

    await expect(repository.recordCommitOutcome({
      draftId: readyDraft.id,
      userId: USER,
      status: "ready" as unknown as "verified",
    })).rejects.toThrow();
  });
});

describe("replacedFromPriceFor", () => {
  const row = { price: 42.5, specialPrice: null };
  const replacement = {
    sourceProductId: "water-1",
    expectedVersion: 1,
    decision: "replaced" as const,
    item: {} as never,
  };

  it("A17-31 captures the effective price the replacement overwrites", () => {
    expect(replacedFromPriceFor(replacement, row)).toBe(42.5);
  });

  it("A17-32 prefers the special price, so both sides of the saving compare alike", () => {
    expect(replacedFromPriceFor(replacement, { price: 42.5, specialPrice: 33 })).toBe(33);
  });

  it("A17-33 records nothing for a kept or removed decision", () => {
    expect(replacedFromPriceFor({ ...replacement, decision: "kept" }, row)).toBeNull();
    expect(
      replacedFromPriceFor(
        { sourceProductId: "water-1", expectedVersion: 1, decision: "removed", item: null },
        row,
      ),
    ).toBeNull();
  });

  it("A17-34 records nothing when the stored row carries no price at all", () => {
    expect(replacedFromPriceFor(replacement, { price: null, specialPrice: null })).toBeNull();
  });
});

