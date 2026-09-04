import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "@/db/client";
import {
  createInMemoryCartCommitRepository,
  createPostgresCartCommitRepository,
} from "./repository";

describe("CartCommitRepository (in-memory)", () => {
  it("reuses persisted absolute quantities for a retry", async () => {
    const repo = createInMemoryCartCommitRepository();
    await repo.start({ key: "k1", targetQuantities: { p1: 3 } });
    expect((await repo.get("k1"))?.targetQuantities).toEqual({ p1: 3 });

    // Retry with different quantities should NOT overwrite existing target quantities
    const retried = await repo.start({ key: "k1", targetQuantities: { p1: 5 } });
    expect(retried.targetQuantities).toEqual({ p1: 3 });
    expect((await repo.get("k1"))?.targetQuantities).toEqual({ p1: 3 });
  });

  it("saves initial commit record with pending status and optional metadata", async () => {
    const repo = createInMemoryCartCommitRepository();
    const created = await repo.start({
      key: "k-meta",
      targetQuantities: { "prod-1": 2, "prod-2": 4 },
      userId: "user-123",
      draftId: "draft-456",
    });

    expect(created.id).toBeDefined();
    expect(typeof created.id).toBe("string");
    expect(created.idempotencyKey).toBe("k-meta");
    expect(created.status).toBe("pending");
    expect(created.userId).toBe("user-123");
    expect(created.draftId).toBe("draft-456");
    expect(created.targetQuantities).toEqual({ "prod-1": 2, "prod-2": 4 });
    expect(created.confirmationTimestamp).toBeInstanceOf(Date);

    const explicitTime = new Date("2026-09-01T10:00:00.000Z");
    const withCustomTime = await repo.start({
      key: "k-custom-time",
      targetQuantities: { "prod-1": 1 },
      confirmationTimestamp: explicitTime,
    });
    expect(withCustomTime.confirmationTimestamp).toEqual(explicitTime);
  });

  it("returns null for unknown commit key", async () => {
    const repo = createInMemoryCartCommitRepository();
    expect(await repo.get("non-existent")).toBeNull();
  });

  it("saves commit result and updates status", async () => {
    const repo = createInMemoryCartCommitRepository();
    await repo.start({ key: "k-res", targetQuantities: { p1: 1 } });

    const updated = await repo.saveResult("k-res", {
      status: "verified",
      data: { verifiedCartId: "cart-abc" },
    });

    expect(updated.status).toBe("verified");
    expect(updated.result).toEqual({
      status: "verified",
      data: { verifiedCartId: "cart-abc" },
    });

    const retrieved = await repo.get("k-res");
    expect(retrieved?.status).toBe("verified");
    expect(retrieved?.result).toEqual({
      status: "verified",
      data: { verifiedCartId: "cart-abc" },
    });
  });

  it("throws when saving result for unknown commit key", async () => {
    const repo = createInMemoryCartCommitRepository();
    await expect(
      repo.saveResult("unknown-key", { status: "blocked", data: { error: "out of stock" } })
    ).rejects.toThrow(/not found/i);
  });
});

describe("CartCommitRepository (postgres)", () => {
  it("rejects malformed persisted quantities at the database boundary", async () => {
    const malformedRecord = {
      id: "commit-uuid-1",
      idempotencyKey: "k-invalid",
      draftId: null,
      userId: null,
      confirmationTimestamp: new Date(),
      targetQuantities: { p1: -3 },
      status: "pending",
      result: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [malformedRecord]),
          })),
        })),
      })),
    } as unknown as DbClient;

    const repo = createPostgresCartCommitRepository(mockDb);
    await expect(repo.get("k-invalid")).rejects.toThrow();
  });

  it("rejects malformed persisted status at the database boundary", async () => {
    const malformedRecord = {
      id: "commit-uuid-1",
      idempotencyKey: "k-invalid-status",
      draftId: null,
      userId: null,
      confirmationTimestamp: new Date(),
      targetQuantities: { p1: 3 },
      status: "complete",
      result: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [malformedRecord]) })),
        })),
      })),
    } as unknown as DbClient;

    const repo = createPostgresCartCommitRepository(mockDb);
    await expect(repo.get("k-invalid-status")).rejects.toThrow();
  });

  it("rejects invalid target quantities before persistence", async () => {
    const repo = createPostgresCartCommitRepository({} as DbClient);

    await expect(
      repo.start({ key: "k-invalid", targetQuantities: { p1: Number.NaN } }),
    ).rejects.toThrow();
  });

  it("inserts new commit record when not exists", async () => {
    const insertedRecord = {
      id: "commit-uuid-1",
      idempotencyKey: "k-pg",
      draftId: null,
      userId: null,
      confirmationTimestamp: null,
      targetQuantities: { p1: 3 },
      status: "pending",
      result: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => []),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => [insertedRecord]),
        })),
      })),
    } as unknown as DbClient;

    const repo = createPostgresCartCommitRepository(mockDb);
    const result = await repo.start({ key: "k-pg", targetQuantities: { p1: 3 } });

    expect(result.idempotencyKey).toBe("k-pg");
    expect(result.status).toBe("pending");
    expect(result.targetQuantities).toEqual({ p1: 3 });
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it("reuses existing commit record on retry in postgres", async () => {
    const existingRecord = {
      id: "commit-uuid-1",
      idempotencyKey: "k-pg",
      draftId: "d1",
      userId: "u1",
      confirmationTimestamp: null,
      targetQuantities: { p1: 3 },
      status: "pending",
      result: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [existingRecord]),
          })),
        })),
      })),
      insert: vi.fn(),
    } as unknown as DbClient;

    const repo = createPostgresCartCommitRepository(mockDb);
    const result = await repo.start({ key: "k-pg", targetQuantities: { p1: 10 } });

    expect(result.targetQuantities).toEqual({ p1: 3 });
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("saves result with update returning in postgres", async () => {
    const updatedRecord = {
      id: "commit-uuid-1",
      idempotencyKey: "k-pg",
      draftId: null,
      userId: null,
      confirmationTimestamp: null,
      targetQuantities: { p1: 3 },
      status: "verified",
      result: { status: "verified", data: { orderId: "123" } },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockDb = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => [updatedRecord]),
          })),
        })),
      })),
    } as unknown as DbClient;

    const repo = createPostgresCartCommitRepository(mockDb);
    const result = await repo.saveResult("k-pg", {
      status: "verified",
      data: { orderId: "123" },
    });

    expect(result.status).toBe("verified");
    expect(result.result).toEqual({ status: "verified", data: { orderId: "123" } });
  });

  it("throws when saveResult does not match any record in postgres", async () => {
    const mockDb = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => []),
          })),
        })),
      })),
    } as unknown as DbClient;

    const repo = createPostgresCartCommitRepository(mockDb);
    await expect(
      repo.saveResult("unknown-key", { status: "blocked" })
    ).rejects.toThrow(/not found/i);
  });

  it("handles concurrent insert race condition and succeeds on recheck in postgres", async () => {
    let selectCount = 0;
    const concurrentRecord = {
      id: "commit-uuid-conc",
      idempotencyKey: "k-conc",
      draftId: null,
      userId: null,
      confirmationTimestamp: new Date(),
      targetQuantities: { p1: 5 },
      status: "pending",
      result: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => {
              selectCount++;
              return selectCount === 1 ? [] : [concurrentRecord];
            }),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => {
            throw new Error("unique constraint violation");
          }),
        })),
      })),
    } as unknown as DbClient;

    const repo = createPostgresCartCommitRepository(mockDb);
    const result = await repo.start({ key: "k-conc", targetQuantities: { p1: 10 } });

    expect(result.idempotencyKey).toBe("k-conc");
    expect(result.targetQuantities).toEqual({ p1: 5 });
  });
});
