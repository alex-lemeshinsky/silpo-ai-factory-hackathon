import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "@/db/client";
import {
  createInMemoryDraftRepository,
  createPostgresDraftRepository,
} from "./repository";

describe("DraftRepository (in-memory)", () => {
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
});

describe("DraftRepository (postgres)", () => {
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
});
