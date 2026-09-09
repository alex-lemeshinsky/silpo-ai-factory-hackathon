import { createHash, randomBytes } from "node:crypto";

import type { DbClient } from "@/db/client";
import { users } from "@/db/schema";

/** Opaque per-visitor handle. Demo mode has no OAuth session to reuse. */
export const DEMO_SESSION_COOKIE = "demo_session";

/** 32 random bytes, base64url — the same shape as the OAuth session handle. */
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A demo visitor is remembered for a day; the row is disposable either way. */
export const DEMO_SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

export function createDemoHandle(): string {
  return randomBytes(32).toString("base64url");
}

export function isDemoHandle(value: string | null | undefined): value is string {
  return typeof value === "string" && HANDLE_PATTERN.test(value);
}

/**
 * The database key is derived from the handle rather than being the handle,
 * so a value the client chose never reaches `users.id` directly and an
 * oversized or malformed cookie cannot shape a row. SHA-256 truncated to
 * sixteen bytes with the RFC 4122 version and variant bits set, which is
 * what the `uuid` column requires.
 */
export function demoUserIdFor(handle: string): string {
  const bytes = Buffer.from(
    createHash("sha256").update(`silpo-demo:${handle}`).digest().subarray(0, 16),
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export interface DemoIdentity {
  userId: string;
  handle: string;
  /** True when this request minted the handle, so the caller sets the cookie. */
  issued: boolean;
}

/**
 * One synthetic identity per demo visitor, never a real «Сільпо» guest and
 * never derived from one.
 *
 * A single shared constant would be simpler, but every demo visitor would
 * then own every other visitor's drafts: `DraftRepository.get` scopes by
 * `userId`, so one shared id makes that scope meaningless. Per-visitor ids
 * keep live and demo on exactly one persistence path while leaving the
 * ownership check with something real to check.
 *
 * Idempotent: safe to call on every demo run, and it adds no migration
 * because the row is data rather than schema.
 */
export async function ensureDemoUser(
  db: DbClient,
  cookieValue: string | null,
): Promise<DemoIdentity> {
  const issued = !isDemoHandle(cookieValue);
  const handle = issued ? createDemoHandle() : cookieValue;
  const userId = demoUserIdFor(handle);
  await db.insert(users).values({ id: userId }).onConflictDoNothing();
  return { userId, handle, issued };
}
