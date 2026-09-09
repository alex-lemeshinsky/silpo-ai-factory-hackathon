import type { DbClient } from "@/db/client";
import { users } from "@/db/schema";

/**
 * A synthetic identity, never a real «Сільпо» guest and never derived from
 * one. Demo drafts persist under it so live and demo share exactly one
 * persistence path and Tasks 15–16 need no demo special case.
 */
export const DEMO_USER_ID = "00000000-0000-4000-8000-00000000de10";

/**
 * Idempotent by design: called on every demo run, adds no migration
 * because the row is data rather than schema.
 */
export async function ensureDemoUser(db: DbClient): Promise<string> {
  await db.insert(users).values({ id: DEMO_USER_ID }).onConflictDoNothing();
  return DEMO_USER_ID;
}
