import { describe, expect, it, vi } from "vitest";

import type { DbClient } from "@/db/client";

import {
  createDemoHandle,
  demoUserIdFor,
  ensureDemoUser,
  isDemoHandle,
} from "./demo-user";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fakeDb() {
  const onConflictDoNothing = vi.fn(async () => []);
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  return { db: { insert } as unknown as DbClient, insert, values, onConflictDoNothing };
}

describe("createDemoHandle", () => {
  it("mints an unguessable handle of the same shape as the OAuth session handle", () => {
    const first = createDemoHandle();
    const second = createDemoHandle();

    expect(isDemoHandle(first)).toBe(true);
    expect(first).toHaveLength(43);
    expect(first).not.toBe(second);
  });
});

describe("isDemoHandle", () => {
  it("rejects anything the server did not mint", () => {
    for (const value of [null, undefined, "", "short", `${createDemoHandle()}x`, "../../etc/passwd"]) {
      expect(isDemoHandle(value)).toBe(false);
    }
  });
});

describe("demoUserIdFor", () => {
  it("derives a version-4 UUID, so no client value reaches users.id directly", () => {
    const handle = createDemoHandle();

    const userId = demoUserIdFor(handle);

    expect(userId).toMatch(UUID_PATTERN);
    expect(userId).not.toContain(handle);
  });

  it("is stable for one handle and different across handles", () => {
    const handle = createDemoHandle();

    expect(demoUserIdFor(handle)).toBe(demoUserIdFor(handle));
    expect(demoUserIdFor(handle)).not.toBe(demoUserIdFor(createDemoHandle()));
  });
});

describe("ensureDemoUser", () => {
  it("issues a handle when the visitor has none and inserts the derived user", async () => {
    const { db, values, onConflictDoNothing } = fakeDb();

    const identity = await ensureDemoUser(db, null);

    expect(identity.issued).toBe(true);
    expect(isDemoHandle(identity.handle)).toBe(true);
    expect(identity.userId).toBe(demoUserIdFor(identity.handle));
    expect(values).toHaveBeenCalledWith({ id: identity.userId });
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it("keeps a returning visitor on the same identity without reissuing", async () => {
    const { db } = fakeDb();
    const handle = createDemoHandle();

    const first = await ensureDemoUser(db, handle);
    const second = await ensureDemoUser(db, handle);

    expect(first.issued).toBe(false);
    expect(second.issued).toBe(false);
    expect(first.userId).toBe(second.userId);
    expect(first.handle).toBe(handle);
  });

  it("gives two visitors different ids, so one cannot own the other's drafts", async () => {
    const { db } = fakeDb();

    const first = await ensureDemoUser(db, null);
    const second = await ensureDemoUser(db, null);

    expect(first.userId).not.toBe(second.userId);
  });

  it("replaces a malformed cookie rather than trusting it", async () => {
    const { db, values } = fakeDb();

    const identity = await ensureDemoUser(db, "not-a-handle");

    expect(identity.issued).toBe(true);
    expect(identity.handle).not.toBe("not-a-handle");
    expect(values).toHaveBeenCalledWith({ id: identity.userId });
  });
});
