import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresAuthRepository } from "@/features/silpo/oauth/auth-repository";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/db/schema";

const DRIZZLE_DIR = join(process.cwd(), "drizzle");

// Apply every migration in lexical order so a renamed or added file cannot
// silently drop the tables under test.
const MIGRATIONS = readdirSync(DRIZZLE_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort();

describe("Silpo OAuth Postgres Integration", () => {
  let sqlA: postgres.Sql;
  let sqlB: postgres.Sql;
  let testSchema: string;
  let dbA: ReturnType<typeof drizzle<typeof schema>>;
  let dbB: ReturnType<typeof drizzle<typeof schema>>;
  const encryptionKey = randomBytes(32);

  it("applies the migration that creates the OAuth tables", () => {
    const oauthMigrations = MIGRATIONS.filter((file) => {
      const sql = readFileSync(join(DRIZZLE_DIR, file), "utf8");
      return sql.includes('CREATE TABLE "auth_sessions"');
    });
    expect(oauthMigrations).toHaveLength(1);
  });


  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required when executing tests/integration/silpo-oauth-postgres.test.ts");
    }
    const dbUrl = process.env.DATABASE_URL;
    if (process.env.NODE_ENV === "production") {
      throw new Error("Refusing to run integration tests in production mode");
    }

    testSchema = `test_oauth_${randomBytes(8).toString("hex")}`;

    // Create the test schema with a throwaway connection, then pin search_path
    // on every pooled connection so no statement can leak into "public".
    const admin = postgres(dbUrl, { max: 1 });
    try {
      await admin.unsafe(`CREATE SCHEMA "${testSchema}"`);
    } finally {
      await admin.end();
    }

    sqlA = postgres(dbUrl, { max: 3, connection: { search_path: testSchema } });
    sqlB = postgres(dbUrl, { max: 3, connection: { search_path: testSchema } });

    // Read and apply migrations into testSchema
    for (const file of MIGRATIONS) {
      const rawSql = readFileSync(join(DRIZZLE_DIR, file), "utf8");
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

  it("serializes concurrent flow starts for one user instead of interleaving state and binding", async () => {
    const repoA = createPostgresAuthRepository({ db: dbA, encryptionKey });
    const repoB = createPostgresAuthRepository({ db: dbB, encryptionKey });

    const now = new Date("2026-09-06T10:00:00Z");
    const expiresAt = new Date(now.getTime() + 600000);

    const sessionA = await repoA.createPendingSession({
      handleHash: randomBytes(32).toString("hex"),
      now,
      expiresAt,
    });
    const sessionB = await repoA.createPendingSession({
      handleHash: randomBytes(32).toString("hex"),
      now,
      expiresAt,
      userId: sessionA.userId,
    });

    const settled = await Promise.allSettled([
      repoA.beginFlow({
        userId: sessionA.userId,
        bindingHash: sessionA.handleHash,
        flowId: "flow-pg-concurrent-a",
        state: "state-pg-concurrent-a",
        now,
        expiresAt,
      }),
      repoB.beginFlow({
        userId: sessionB.userId,
        bindingHash: sessionB.handleHash,
        flowId: "flow-pg-concurrent-b",
        state: "state-pg-concurrent-b",
        now,
        expiresAt,
      }),
    ]);

    const flows = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    expect(flows.length).toBeGreaterThanOrEqual(1);

    // The persisted flow secret and browser binding must come from one start.
    const stored = await repoA.readState(sessionA.userId);
    expect(stored).not.toBeNull();
    const bindingForState: Record<string, string> = {
      "state-pg-concurrent-a": sessionA.handleHash,
      "state-pg-concurrent-b": sessionB.handleHash,
    };
    expect(stored!.bindingHash).toBe(bindingForState[stored!.payload.state!]);

    const winners = flows.filter((f) => f.payload.state === stored!.payload.state);
    expect(winners).toHaveLength(1);
    expect(winners[0].version).toBe(stored!.version);

    // A losing start must not be able to write its verifier over the winner.
    for (const loser of flows.filter((f) => f.payload.state !== stored!.payload.state)) {
      await expect(
        repoA.saveState({
          userId: sessionA.userId,
          expectedVersion: loser.version,
          payload: { ...loser.payload, verifier: "loser-verifier" },
        }),
      ).rejects.toThrow();
    }
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

  it("rotates the handle and revokes the pending and previously authenticated sessions on activation", async () => {
    const repo = createPostgresAuthRepository({ db: dbA, encryptionKey });
    const now = new Date("2026-09-06T10:00:00Z");
    const authExpiresAt = new Date(now.getTime() + 604800000);

    const pendingHash = randomBytes(32).toString("hex");
    const authenticatedHash = randomBytes(32).toString("hex");

    const session = await repo.createPendingSession({
      handleHash: pendingHash,
      now,
      expiresAt: new Date(now.getTime() + 600000),
    });

    const flow = await repo.beginFlow({
      userId: session.userId,
      bindingHash: pendingHash,
      flowId: "flow-pg-rotate-1",
      state: "state-pg-rotate-1",
      now,
      expiresAt: new Date(now.getTime() + 600000),
    });

    const claimed = await repo.claimFlow({
      userId: session.userId,
      bindingHash: pendingHash,
      expectedVersion: flow.version,
      now,
    });
    expect(claimed).not.toBeNull();

    const activated = await repo.activateSession({
      oldHandleHash: pendingHash,
      newHandleHash: authenticatedHash,
      userId: session.userId,
      expectedFlowVersion: claimed!.version,
      now,
      expiresAt: authExpiresAt,
    });

    expect(activated.status).toBe("authenticated");
    expect(activated.userId).toBe(session.userId);
    expect(await repo.findSession(pendingHash, now)).toBeNull();
    expect((await repo.findSession(authenticatedHash, now))?.status).toBe("authenticated");

    // Flow secrets are cleared and the flow returns to idle.
    const afterState = await repo.readState(session.userId);
    expect(afterState?.phase).toBe("idle");
    expect(afterState?.bindingHash).toBeNull();
    expect(afterState?.payload.state).toBeNull();
    expect(afterState?.payload.verifier).toBeNull();

    // Reauthorization from the authenticated session must invalidate the old handle.
    const reauthPendingHash = randomBytes(32).toString("hex");
    const rotatedHash = randomBytes(32).toString("hex");

    const reauthSession = await repo.createPendingSession({
      handleHash: reauthPendingHash,
      now,
      expiresAt: new Date(now.getTime() + 600000),
      userId: session.userId,
    });
    expect(reauthSession.userId).toBe(session.userId);

    const reauthFlow = await repo.beginFlow({
      userId: session.userId,
      bindingHash: reauthPendingHash,
      flowId: "flow-pg-rotate-2",
      state: "state-pg-rotate-2",
      now,
      expiresAt: new Date(now.getTime() + 600000),
    });

    const reauthClaimed = await repo.claimFlow({
      userId: session.userId,
      bindingHash: reauthPendingHash,
      expectedVersion: reauthFlow.version,
      now,
    });
    expect(reauthClaimed).not.toBeNull();

    await repo.activateSession({
      oldHandleHash: reauthPendingHash,
      newHandleHash: rotatedHash,
      userId: session.userId,
      expectedFlowVersion: reauthClaimed!.version,
      now,
      expiresAt: authExpiresAt,
    });

    expect(await repo.findSession(reauthPendingHash, now)).toBeNull();
    expect(await repo.findSession(authenticatedHash, now)).toBeNull();
    expect((await repo.findSession(rotatedHash, now))?.status).toBe("authenticated");
  });

  it("rejects rows that violate the documented lifecycle invariants", async () => {
    const repo = createPostgresAuthRepository({ db: dbA, encryptionKey });
    const now = new Date("2026-09-06T10:00:00Z");
    const handleHash = randomBytes(32).toString("hex");

    const session = await repo.createPendingSession({
      handleHash,
      now,
      expiresAt: new Date(now.getTime() + 600000),
    });

    await expect(
      sqlA.unsafe(
        `UPDATE "${testSchema}"."auth_sessions" SET status = 'bogus' WHERE user_id = '${session.userId}'`,
      ),
    ).rejects.toThrow();

    await repo.beginFlow({
      userId: session.userId,
      bindingHash: handleHash,
      flowId: "flow-pg-checks",
      state: "state-pg-checks",
      now,
      expiresAt: new Date(now.getTime() + 600000),
    });

    await expect(
      sqlA.unsafe(
        `UPDATE "${testSchema}"."silpo_oauth_states" SET phase = 'bogus' WHERE user_id = '${session.userId}'`,
      ),
    ).rejects.toThrow();

    await expect(
      sqlA.unsafe(
        `UPDATE "${testSchema}"."silpo_oauth_states" SET version = 0 WHERE user_id = '${session.userId}'`,
      ),
    ).rejects.toThrow();

    await expect(
      sqlA.unsafe(
        `UPDATE "${testSchema}"."silpo_oauth_states" SET binding_hash = NULL WHERE user_id = '${session.userId}'`,
      ),
    ).rejects.toThrow();

    await expect(
      sqlA.unsafe(
        `UPDATE "${testSchema}"."silpo_oauth_states" SET flow_expires_at = NULL WHERE user_id = '${session.userId}'`,
      ),
    ).rejects.toThrow();
  });
});
