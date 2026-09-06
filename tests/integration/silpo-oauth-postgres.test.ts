import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresAuthRepository } from "@/features/silpo/oauth/auth-repository";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/db/schema";

const MIGRATIONS = [
  "0000_opposite_imperial_guard.sql",
  "0001_flat_arclight.sql",
  "0002_silpo_oauth.sql",
];

describe("Silpo OAuth Postgres Integration", () => {
  let sqlA: postgres.Sql;
  let sqlB: postgres.Sql;
  let testSchema: string;
  let dbA: ReturnType<typeof drizzle<typeof schema>>;
  let dbB: ReturnType<typeof drizzle<typeof schema>>;
  const encryptionKey = randomBytes(32);

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required when executing tests/integration/silpo-oauth-postgres.test.ts");
    }
    const dbUrl = process.env.DATABASE_URL;
    if (process.env.NODE_ENV === "production") {
      throw new Error("Refusing to run integration tests in production mode");
    }

    testSchema = `test_oauth_${randomBytes(8).toString("hex")}`;

    sqlA = postgres(dbUrl, { max: 3 });
    sqlB = postgres(dbUrl, { max: 3 });

    // Create test schema
    await sqlA.unsafe(`CREATE SCHEMA "${testSchema}"`);
    await sqlA.unsafe(`SET search_path = "${testSchema}"`);
    await sqlB.unsafe(`SET search_path = "${testSchema}"`);

    // Read and apply migrations into testSchema
    const drizzleDir = join(process.cwd(), "drizzle");
    for (const file of MIGRATIONS) {
      const rawSql = readFileSync(join(drizzleDir, file), "utf8");
      // Rewrite any "public". references to testSchema so nothing escapes
      const scopedSql = rawSql.replaceAll('"public".', `"${testSchema}".`);
      if (scopedSql.includes('"public".')) {
        throw new Error(`Migration ${file} escapes test schema into public`);
      }

      const statements = scopedSql
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const statement of statements) {
        await sqlA.unsafe(statement);
      }
    }

    dbA = drizzle(sqlA, { schema });
    dbB = drizzle(sqlB, { schema });
  });

  afterAll(async () => {
    if (sqlA && testSchema) {
      await sqlA.unsafe(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
      await sqlA.end();
    }
    if (sqlB) {
      await sqlB.end();
    }
  });

  it("handles concurrent claims between two distinct connections with exactly one winner", async () => {
    const repoA = createPostgresAuthRepository({ db: dbA, encryptionKey });
    const repoB = createPostgresAuthRepository({ db: dbB, encryptionKey });

    const now = new Date("2026-09-06T10:00:00Z");
    const handleHash = randomBytes(32).toString("hex");

    const session = await repoA.createPendingSession({
      handleHash,
      now,
      expiresAt: new Date(now.getTime() + 600000),
    });

    const flow = await repoA.beginFlow({
      userId: session.userId,
      bindingHash: handleHash,
      flowId: "flow-pg-1",
      state: "state-pg-1",
      now,
      expiresAt: session.expiresAt,
    });

    const claimInput = {
      userId: session.userId,
      bindingHash: handleHash,
      expectedVersion: flow.version,
      now,
    };

    // Run claims concurrently across two different DB connections
    const [resA, resB] = await Promise.all([
      repoA.claimFlow(claimInput),
      repoB.claimFlow(claimInput),
    ]);

    const winners = [resA, resB].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.phase).toBe("processing");
  });

  it("cascades user deletion to auth_sessions and silpo_oauth_states", async () => {
    const repo = createPostgresAuthRepository({ db: dbA, encryptionKey });
    const now = new Date("2026-09-06T10:00:00Z");
    const handleHash = randomBytes(32).toString("hex");

    const session = await repo.createPendingSession({
      handleHash,
      now,
      expiresAt: new Date(now.getTime() + 600000),
    });

    await repo.beginFlow({
      userId: session.userId,
      bindingHash: handleHash,
      flowId: "flow-pg-2",
      state: "state-pg-2",
      now,
      expiresAt: session.expiresAt,
    });

    // Delete the user
    await sqlA.unsafe(`DELETE FROM "${testSchema}"."users" WHERE id = '${session.userId}'`);

    // Verify cascaded deletion
    const sessionRows = await sqlA.unsafe(
      `SELECT * FROM "${testSchema}"."auth_sessions" WHERE user_id = '${session.userId}'`,
    );
    expect(sessionRows).toHaveLength(0);

    const stateRows = await sqlA.unsafe(
      `SELECT * FROM "${testSchema}"."silpo_oauth_states" WHERE user_id = '${session.userId}'`,
    );
    expect(stateRows).toHaveLength(0);
  });

  it("enforces unique constraint on handle_hash", async () => {
    const repo = createPostgresAuthRepository({ db: dbA, encryptionKey });
    const now = new Date("2026-09-06T10:00:00Z");
    const duplicateHash = randomBytes(32).toString("hex");

    await repo.createPendingSession({
      handleHash: duplicateHash,
      now,
      expiresAt: new Date(now.getTime() + 600000),
    });

    await expect(
      repo.createPendingSession({
        handleHash: duplicateHash,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      }),
    ).rejects.toThrow();
  });

  it("rolls back session rotation if flow version does not match during activation", async () => {
    const repo = createPostgresAuthRepository({ db: dbA, encryptionKey });
    const now = new Date("2026-09-06T10:00:00Z");
    const oldHash = randomBytes(32).toString("hex");
    const newHash = randomBytes(32).toString("hex");

    const session = await repo.createPendingSession({
      handleHash: oldHash,
      now,
      expiresAt: new Date(now.getTime() + 600000),
    });

    const flow = await repo.beginFlow({
      userId: session.userId,
      bindingHash: oldHash,
      flowId: "flow-pg-3",
      state: "state-pg-3",
      now,
      expiresAt: session.expiresAt,
    });

    const claimed = await repo.claimFlow({
      userId: session.userId,
      bindingHash: oldHash,
      expectedVersion: flow.version,
      now,
    });
    expect(claimed).not.toBeNull();

    // Attempt activation with wrong expectedFlowVersion
    await expect(
      repo.activateSession({
        oldHandleHash: oldHash,
        newHandleHash: newHash,
        userId: session.userId,
        expectedFlowVersion: claimed!.version + 99,
        now,
        expiresAt: new Date(now.getTime() + 604800000),
      }),
    ).rejects.toThrow();

    // Old session must still be pending, not revoked
    const oldSession = await repo.findSession(oldHash, now);
    expect(oldSession?.status).toBe("pending");

    // New session must not exist
    const newSession = await repo.findSession(newHash, now);
    expect(newSession).toBeNull();
  });

  it("prevents post-restart replay of old flow claim", async () => {
    const repo = createPostgresAuthRepository({ db: dbA, encryptionKey });
    const now = new Date("2026-09-06T10:00:00Z");
    const handleHash = randomBytes(32).toString("hex");

    const session = await repo.createPendingSession({
      handleHash,
      now,
      expiresAt: new Date(now.getTime() + 600000),
    });

    const flow = await repo.beginFlow({
      userId: session.userId,
      bindingHash: handleHash,
      flowId: "flow-pg-4",
      state: "state-pg-4",
      now,
      expiresAt: session.expiresAt,
    });

    const firstClaim = await repo.claimFlow({
      userId: session.userId,
      bindingHash: handleHash,
      expectedVersion: flow.version,
      now,
    });
    expect(firstClaim).not.toBeNull();

    // Simulate "restart" by creating a fresh repo instance
    const restartedRepo = createPostgresAuthRepository({ db: dbB, encryptionKey });

    // Replay claim must fail
    const replayClaim = await restartedRepo.claimFlow({
      userId: session.userId,
      bindingHash: handleHash,
      expectedVersion: flow.version,
      now,
    });
    expect(replayClaim).toBeNull();
  });
});
