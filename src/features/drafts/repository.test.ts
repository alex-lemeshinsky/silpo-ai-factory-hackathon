import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "@/db/client";
import { type Draft, DraftSchema } from "@/features/shared/contracts";
import {
  createInMemoryDraftRepository,
  createPostgresDraftRepository,
} from "./repository";

const draftFixture: Draft = {
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
  ],
  total: 110,
  version: 1,
};

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

  it("persists explicit draft approval once", async () => {
    const repo = createInMemoryDraftRepository();
    const result = await repo.approve("draft-1", "user-1", "key-1");
    expect(result).toEqual({ idempotencyKey: "key-1" });

    await expect(repo.approve("draft-1", "user-1", "key-2")).rejects.toThrow("already approved");
  });

  it("is idempotent when re-approving with identical parameters", async () => {
    const repo = createInMemoryDraftRepository();
    const first = await repo.approve("draft-1", "user-1", "key-1");
    const second = await repo.approve("draft-1", "user-1", "key-1");

    expect(first).toEqual({ idempotencyKey: "key-1" });
    expect(second).toEqual({ idempotencyKey: "key-1" });
  });

  it("rejects approval for already approved draft from another user", async () => {
    const repo = createInMemoryDraftRepository();
    await repo.approve("draft-1", "user-1", "key-1");

    await expect(repo.approve("draft-1", "user-2", "key-1")).rejects.toThrow("already approved");
  });

  it("retrieves persisted approval or returns null", async () => {
    const repo = createInMemoryDraftRepository();
    expect(await repo.getApproval("draft-1")).toBeNull();

    await repo.approve("draft-1", "user-1", "key-1");
    const record = await repo.getApproval("draft-1");

    expect(record).not.toBeNull();
    expect(record?.id).toBeDefined();
    expect(typeof record?.id).toBe("string");
    expect(record?.draftId).toBe("draft-1");
    expect(record?.userId).toBe("user-1");
    expect(record?.idempotencyKey).toBe("key-1");
  });

  it("tracks approvals across multiple drafts independently", async () => {
    const repo = createInMemoryDraftRepository();
    await repo.approve("draft-1", "user-1", "key-1");
    await repo.approve("draft-2", "user-2", "key-2");

    expect((await repo.getApproval("draft-1"))?.idempotencyKey).toBe("key-1");
    expect((await repo.getApproval("draft-2"))?.idempotencyKey).toBe("key-2");
  });

  it("rejects using the same idempotency key across different drafts", async () => {
    const repo = createInMemoryDraftRepository();
    await repo.approve("draft-1", "user-1", "shared-key");
    await expect(repo.approve("draft-2", "user-1", "shared-key")).rejects.toThrow("already approved");
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
    const mockDb = {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<Draft>) =>
        callback(tx)),
    } as unknown as DbClient;

    const repo = createPostgresDraftRepository(mockDb);
    await expect(repo.save("user-1", draftFixture)).resolves.toEqual(draftFixture);
    expect(mockDb.transaction).toHaveBeenCalledOnce();
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
    const mockDb = {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<Draft>) =>
        callback(tx)),
    } as unknown as DbClient;
    const repo = createPostgresDraftRepository(mockDb);

    await expect(
      repo.save("user-1", updatedDraft, { expectedVersion: 1 }),
    ).resolves.toEqual(updatedDraft);
    expect(tx.update).toHaveBeenCalledTimes(2);
    expect(tx.delete).toHaveBeenCalledOnce();
  });

  it("loads and validates an owned draft from postgres", async () => {
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
          where: vi.fn(() => ({ orderBy: vi.fn(async () => [storedItem]) })),
        })),
      }));
    const repo = createPostgresDraftRepository({ select } as unknown as DbClient);

    await expect(repo.get(draftFixture.id, "user-1")).resolves.toEqual(draftFixture);
  });

  it("inserts new approval when not exists", async () => {
    const rows: Array<{
      id: string;
      draftId: string;
      userId: string;
      idempotencyKey: string;
      createdAt: Date;
    }> = [];
    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => rows),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(async (val: { draftId: string; userId: string; idempotencyKey: string }) => {
          rows.push({ id: "uuid-1", ...val, createdAt: new Date() });
          return [];
        }),
      })),
    } as unknown as DbClient;

    const repo = createPostgresDraftRepository(mockDb);
    const result = await repo.approve("draft-1", "user-1", "key-1");
    expect(result).toEqual({ idempotencyKey: "key-1" });
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it("returns key when re-approving identical draft in postgres", async () => {
    const rows = [
      {
        id: "uuid-1",
        draftId: "draft-1",
        userId: "user-1",
        idempotencyKey: "key-1",
        createdAt: new Date(),
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
      insert: vi.fn(),
    } as unknown as DbClient;

    const repo = createPostgresDraftRepository(mockDb);
    const result = await repo.approve("draft-1", "user-1", "key-1");
    expect(result).toEqual({ idempotencyKey: "key-1" });
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("rejects when draft is already approved with different key in postgres", async () => {
    const rows = [
      {
        id: "uuid-1",
        draftId: "draft-1",
        userId: "user-1",
        idempotencyKey: "key-1",
        createdAt: new Date(),
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
    await expect(repo.approve("draft-1", "user-1", "key-2")).rejects.toThrow("already approved");
  });

  it("retrieves approval record from postgres", async () => {
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
    const record = await repo.getApproval("draft-1");
    expect(record).toEqual({
      id: "uuid-1",
      draftId: "draft-1",
      userId: "user-1",
      idempotencyKey: "key-1",
      createdAt: now,
    });
  });

  it("rethrows database error when insert fails and draft is not found on recheck", async () => {
    const dbError = new Error("database connection timeout");
    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => []),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(async () => {
          throw dbError;
        }),
      })),
    } as unknown as DbClient;

    const repo = createPostgresDraftRepository(mockDb);
    await expect(repo.approve("draft-1", "user-1", "key-1")).rejects.toThrow(dbError);
  });

  it("handles concurrent insert race condition and succeeds on recheck", async () => {
    let selectCount = 0;
    const concurrentRow = {
      id: "uuid-conc",
      draftId: "draft-conc",
      userId: "user-conc",
      idempotencyKey: "key-conc",
      createdAt: new Date(),
    };

    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => {
              selectCount++;
              return selectCount === 1 ? [] : [concurrentRow];
            }),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(async () => {
          throw new Error("unique constraint violation");
        }),
      })),
    } as unknown as DbClient;

    const repo = createPostgresDraftRepository(mockDb);
    const result = await repo.approve("draft-conc", "user-conc", "key-conc");
    expect(result).toEqual({ idempotencyKey: "key-conc" });
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
    const mockDb = {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<Draft>) => callback(tx)),
    } as unknown as DbClient;

    await createPostgresDraftRepository(mockDb).save("user-1", {
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
});
