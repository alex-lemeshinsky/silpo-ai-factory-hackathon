import { describe, expect, it, vi } from "vitest";

import type { DbClient } from "@/db/client";

import { DEMO_USER_ID, ensureDemoUser } from "./demo-user";

function fakeDb() {
  const onConflictDoNothing = vi.fn(async () => []);
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  return { db: { insert } as unknown as DbClient, insert, values, onConflictDoNothing };
}

describe("ensureDemoUser", () => {
  it("uses a well-formed UUID that is not the repository test's draft id", () => {
    expect(DEMO_USER_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(DEMO_USER_ID).not.toBe("00000000-0000-4000-8000-000000000001");
  });

  it("inserts the synthetic user and returns its id", async () => {
    const { db, values, onConflictDoNothing } = fakeDb();

    await expect(ensureDemoUser(db)).resolves.toBe(DEMO_USER_ID);

    expect(values).toHaveBeenCalledWith({ id: DEMO_USER_ID });
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it("is safe to call on every demo run", async () => {
    const { db, onConflictDoNothing } = fakeDb();

    await ensureDemoUser(db);
    await ensureDemoUser(db);

    expect(onConflictDoNothing).toHaveBeenCalledTimes(2);
  });
});
