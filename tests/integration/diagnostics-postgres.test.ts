import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DbClient } from "@/db/client";
import * as schema from "@/db/schema";
import { cartCommits, draftItems, users } from "@/db/schema";
import { createPostgresDecisionRepository } from "@/features/diagnostics/decision-repository";
import { createPostgresToolTraceRepository } from "@/features/diagnostics/trace-repository";
import { createPostgresDraftRepository } from "@/features/drafts/repository";
import {
  DraftItemSchema,
  DraftSchema,
  ProductCandidateSchema,
  VerifiedCartSchema,
  type Draft,
  type DraftItem,
  type ProductCandidate,
} from "@/features/shared/contracts";
import { sanitizeTrace } from "@/lib/logger";

const DRIZZLE_DIR = join(process.cwd(), "drizzle");

// Apply every migration in lexical order so a renamed or added file cannot
// silently drop the tables under test.
const MIGRATIONS = readdirSync(DRIZZLE_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort();

describe("Diagnostics Postgres Integration", () => {
  let sql: postgres.Sql;
  let testSchema: string;
  let db: DbClient;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL is required when executing tests/integration/diagnostics-postgres.test.ts",
      );
    }
    const dbUrl = process.env.DATABASE_URL;
    if (process.env.NODE_ENV === "production") {
      throw new Error("Refusing to run integration tests in production mode");
    }

    testSchema = `test_diagnostics_${randomBytes(8).toString("hex")}`;

    // Create the test schema with a throwaway connection, then pin search_path
    // on every pooled connection so no statement can leak into "public".
    const admin = postgres(dbUrl, { max: 1 });
    try {
      await admin.unsafe(`CREATE SCHEMA "${testSchema}"`);
    } finally {
      await admin.end();
    }

    sql = postgres(dbUrl, { max: 3, connection: { search_path: testSchema } });

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
        await sql.unsafe(statement);
      }
    }

    db = drizzle(sql, { schema });
  });

  afterAll(async () => {
    if (sql && testSchema) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
      await sql.end();
    }
  });

  it("A17-60 applies the migration that adds both diagnostics columns", () => {
    const files = MIGRATIONS.filter((file) => {
      const sql = readFileSync(join(DRIZZLE_DIR, file), "utf8");
      return (
        sql.includes('ADD COLUMN "replaced_from_price"') &&
        sql.includes('ADD COLUMN "prediction_version"')
      );
    });
    expect(files).toHaveLength(1);
  });

  it("A17-61 round-trips a sanitized trace and serves only the requested mode", async () => {
    const repo = createPostgresToolTraceRepository(db);
    await repo.append(
      sanitizeTrace({ toolName: "listTools", mode: "demo", durationMs: 4, status: "ok" }),
    );
    await repo.append(
      sanitizeTrace({
        toolName: "loadPurchaseHistory",
        mode: "demo",
        durationMs: 812,
        status: "ok",
        predictionVersion: "prediction-v1",
        metadata: { itemCount: 7 },
      }),
    );
    await repo.append(
      sanitizeTrace({ toolName: "readCart", mode: "live", durationMs: 9, status: "ok" }),
    );

    const rows = await repo.recent("demo", 20);
    // Order is not asserted here: three inserts can share a `created_at`
    // default down to the microsecond, and a tie would make the assertion
    // flaky. Recency ordering is proven deterministically by A17-14.
    expect(rows.map((row) => row.toolName).sort()).toEqual(["listTools", "loadPurchaseHistory"]);
    expect(rows.find((row) => row.toolName === "loadPurchaseHistory")?.durationMs).toBe(812);
    expect(JSON.stringify(await repo.all())).not.toMatch(/Bearer|380000000000/);
  });

  const candidate = (overrides: Partial<ProductCandidate> = {}): ProductCandidate =>
    ProductCandidateSchema.parse({
      productId: "water-2",
      externalProductId: 202,
      slug: "voda-2",
      name: "Вода негазована 2 л",
      imageUrl: null,
      price: 30,
      specialPrice: null,
      available: true,
      stock: 20,
      step: 1,
      displayRatio: 1,
      nutritionStatus: "insufficient",
      nutrition: null,
      promotions: [],
      ...overrides,
    });

  const sourceItem = (overrides: Partial<DraftItem> = {}): DraftItem =>
    DraftItemSchema.parse({
      productId: "water-1",
      externalProductId: 101,
      name: "Вода негазована 1,5 л",
      imageUrl: null,
      displayRatio: 1,
      quantity: 2,
      price: 45,
      specialPrice: 40,
      stock: 10,
      step: 1,
      confidence: 0.8,
      confidenceBand: "high",
      reasonCodes: ["category_repeat"],
      reason: "Купуєте приблизно раз на 7 днів",
      nutritionStatus: "insufficient",
      promotions: [],
      alternatives: [candidate()],
      ...overrides,
    });

  const readyDraft = (id: string, items: DraftItem[]): Draft =>
    DraftSchema.parse({
      id,
      mode: "demo",
      status: "ready",
      algorithmVersion: "prediction-v1",
      trainingCutoff: "2026-09-02T00:00:00.000Z",
      summary: "Схоже, вода скоро закінчиться",
      items,
      total: items.reduce(
        (sum, item) => sum + item.quantity * (item.specialPrice ?? item.price),
        0,
      ),
      version: 1,
    });

  /** The replacement the user accepts, at 30 ₴ against a proposed 40 ₴. */
  const replacementItem = (source: DraftItem): DraftItem =>
    DraftItemSchema.parse({
      ...source,
      productId: "water-2",
      externalProductId: 202,
      name: "Вода негазована 2 л",
      price: 30,
      specialPrice: null,
      stock: 20,
      alternatives: [],
    });

  async function approveWithReplacement(
    db: DbClient,
    userId: string,
    draftId: string,
  ): Promise<{ replacement: DraftItem; idempotencyKey: string }> {
    const repo = createPostgresDraftRepository(db);
    const source = sourceItem();
    await repo.save(userId, readyDraft(draftId, [source]));

    const replacement = replacementItem(source);
    const idempotencyKey = randomUUID();
    const result = await repo.approveSelection({
      draftId,
      userId,
      expectedDraftVersion: 1,
      approvedDraft: {
        ...readyDraft(draftId, [replacement]),
        status: "confirming",
        version: 2,
      } as Draft & { status: "confirming" },
      decisions: [
        { sourceProductId: "water-1", expectedVersion: 1, decision: "replaced", item: replacement },
      ],
      idempotencyKey,
      approvedAt: new Date("2026-09-10T08:00:00.000Z"),
    });
    expect(result.status).toBe("approved");
    return { replacement, idempotencyKey };
  }

  it("A17-62 captures the price the replacement overwrites, and only for a replacement", async () => {
    const userId = randomUUID();
    await db.insert(users).values({ id: userId });
    const draftId = randomUUID();

    await approveWithReplacement(db, userId, draftId);

    const [row] = await db
      .select({
        productId: draftItems.productId,
        userDecision: draftItems.userDecision,
        replacedFromPrice: draftItems.replacedFromPrice,
      })
      .from(draftItems)
      .where(eq(draftItems.draftId, draftId));

    // The source line proposed 45 ₴ with a 40 ₴ special price; the effective
    // price is what a saving must be measured against.
    expect(row).toMatchObject({
      productId: "water-2",
      userDecision: "replaced",
      replacedFromPrice: 40,
    });

    // A kept decision changes no price and records none.
    const keptUserId = randomUUID();
    await db.insert(users).values({ id: keptUserId });
    const keptDraftId = randomUUID();
    const repo = createPostgresDraftRepository(db);
    const kept = sourceItem();
    await repo.save(keptUserId, readyDraft(keptDraftId, [kept]));
    await repo.approveSelection({
      draftId: keptDraftId,
      userId: keptUserId,
      expectedDraftVersion: 1,
      approvedDraft: {
        ...readyDraft(keptDraftId, [kept]),
        status: "confirming",
        version: 2,
      } as Draft & { status: "confirming" },
      decisions: [
        { sourceProductId: "water-1", expectedVersion: 1, decision: "kept", item: kept },
      ],
      idempotencyKey: randomUUID(),
      approvedAt: new Date("2026-09-10T08:00:00.000Z"),
    });

    const [keptRow] = await db
      .select({ replacedFromPrice: draftItems.replacedFromPrice })
      .from(draftItems)
      .where(eq(draftItems.draftId, keptDraftId));
    expect(keptRow.replacedFromPrice).toBeNull();
  });

  it("A17-63 counts only replacements that reached the cart toward savings", async () => {
    const userId = randomUUID();
    await db.insert(users).values({ id: userId });

    const committedDraftId = randomUUID();
    const uncommittedDraftId = randomUUID();
    const committed = await approveWithReplacement(db, userId, committedDraftId);
    const uncommitted = await approveWithReplacement(db, userId, uncommittedDraftId);

    const verifiedCart = VerifiedCartSchema.parse({
      cartId: "cart-1",
      status: "verified",
      items: [{ productId: "water-2", quantity: 2, unitPrice: 30, available: true }],
      total: 60,
      validations: [],
      checkoutLinks: null,
    });

    await db.insert(cartCommits).values({
      idempotencyKey: committed.idempotencyKey,
      draftId: committedDraftId,
      userId,
      targetQuantities: { "water-2": 2 },
      status: "verified",
      result: { status: "verified", data: { cart: verifiedCart } },
    });

    // The second draft's commit never left `pending`, so nothing landed.
    await db.insert(cartCommits).values({
      idempotencyKey: uncommitted.idempotencyKey,
      draftId: uncommittedDraftId,
      userId,
      targetQuantities: { "water-2": 2 },
      status: "pending",
      result: null,
    });

    const totals = await createPostgresDecisionRepository(db).totalsForUser(userId);

    expect(totals.decidedItemCount).toBe(2);
    expect(totals.replacedItemCount).toBe(2);
    expect(totals.landedReplacements).toEqual([
      { replacedFromPrice: 40, effectivePrice: 30, quantity: 2 },
    ]);
  });

  it("A17-64 counts a pre-migration replacement toward the rate but never toward savings", async () => {
    const userId = randomUUID();
    await db.insert(users).values({ id: userId });
    const draftId = randomUUID();
    const approved = await approveWithReplacement(db, userId, draftId);

    // A row approved before migration 0005 has no recoverable proposed price.
    await db
      .update(draftItems)
      .set({ replacedFromPrice: null })
      .where(eq(draftItems.draftId, draftId));

    await db.insert(cartCommits).values({
      idempotencyKey: approved.idempotencyKey,
      draftId,
      userId,
      targetQuantities: { "water-2": 2 },
      status: "verified",
      result: {
        status: "verified",
        data: {
          cart: VerifiedCartSchema.parse({
            cartId: "cart-2",
            status: "verified",
            items: [{ productId: "water-2", quantity: 2, unitPrice: 30, available: true }],
            total: 60,
            validations: [],
            checkoutLinks: null,
          }),
        },
      },
    });

    const totals = await createPostgresDecisionRepository(db).totalsForUser(userId);

    // The user really did replace it, so the rate must say so. The amount is
    // unknowable, and a zero would understate the saving silently.
    expect(totals.replacedItemCount).toBe(1);
    expect(totals.landedReplacements).toEqual([]);
  });
});
