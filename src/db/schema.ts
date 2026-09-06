import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { Promotion } from "@/features/shared/contracts";


// 1. users
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  settings: jsonb("settings").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// 2. mcp_connections
export const mcpConnections = pgTable(
  "mcp_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenCiphertext: text("token_ciphertext"),
    tokenIv: text("token_iv"),
    tokenAuthTag: text("token_auth_tag"),
    legacyEncryptedTokens: text("encrypted_tokens"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    scope: text("scope"),
    oauthMetadata: jsonb("oauth_metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("mcp_connections_user_id_envelope_unique")
      .on(table.userId)
      .where(sql`${table.tokenCiphertext} is not null`),
  ],
);

// 3. purchase_receipts
export const purchaseReceipts = pgTable("purchase_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  channel: text("channel"), // "offline" | "online"
  purchasedAt: timestamp("purchased_at", { withTimezone: true }),
  city: text("city"),
  total: doublePrecision("total"),
  externalFingerprint: text("external_fingerprint").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// 4. purchase_items
export const purchaseItems = pgTable("purchase_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  receiptId: uuid("receipt_id")
    .notNull()
    .references(() => purchaseReceipts.id, { onDelete: "cascade" }),
  externalProductId: integer("external_product_id"),
  productId: text("product_id"),
  name: text("name"),
  category: text("category"),
  quantity: doublePrecision("quantity"),
  unit: text("unit"),
  unitPrice: doublePrecision("unit_price"),
});

// 5. product_snapshots
export const productSnapshots = pgTable("product_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  productId: text("product_id"),
  externalProductId: integer("external_product_id"),
  branch: text("branch"),
  price: doublePrecision("price"),
  stock: doublePrecision("stock"),
  attributes: jsonb("attributes").$type<Record<string, unknown>>(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
});

// 6. prediction_runs
export const predictionRuns = pgTable("prediction_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  algorithmVersion: text("algorithm_version"),
  temporalCutoff: timestamp("temporal_cutoff", { withTimezone: true }),
  metrics: jsonb("metrics").$type<Record<string, unknown>>(),
  status: text("status"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// 7. predicted_needs
export const predictedNeeds = pgTable("predicted_needs", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .notNull()
    .references(() => predictionRuns.id, { onDelete: "cascade" }),
  category: text("category"),
  features: jsonb("features").$type<Record<string, unknown>>(),
  confidence: doublePrecision("confidence"),
  reasonCodes: jsonb("reason_codes").$type<string[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// 8. drafts
export const drafts = pgTable("drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  sourceRunId: uuid("source_run_id").references(() => predictionRuns.id, { onDelete: "set null" }),
  mode: text("mode"), // "live" | "demo"
  status: text("status"), // "syncing" | "generating" | "ready" | "confirming" | "partially_committed" | "verified" | "blocked"
  total: doublePrecision("total"),
  version: integer("version"),
  summary: text("summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// 9. draft_items
export const draftItems = pgTable("draft_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  draftId: uuid("draft_id")
    .notNull()
    .references(() => drafts.id, { onDelete: "cascade" }),
  productId: text("product_id"),
  externalProductId: integer("external_product_id"),
  name: text("name"),
  imageUrl: text("image_url"),
  displayRatio: doublePrecision("display_ratio"),
  quantity: doublePrecision("quantity"),
  price: doublePrecision("price"),
  specialPrice: doublePrecision("special_price"),
  stock: doublePrecision("stock"),
  step: doublePrecision("step"),
  reason: text("reason"),
  reasonCodes: jsonb("reason_codes").$type<string[]>(),
  confidence: doublePrecision("confidence"),
  confidenceBand: text("confidence_band"),
  nutritionStatus: text("nutrition_status"),
  userDecision: text("user_decision"),
  version: integer("version"),
  position: integer("position"),
  alternatives: jsonb("alternatives").$type<unknown[]>(),
  promotions: jsonb("promotions").$type<Promotion[]>(),
});

// 10. cart_commits
export const cartCommits = pgTable("cart_commits", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  draftId: uuid("draft_id").references(() => drafts.id, { onDelete: "set null" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  confirmationTimestamp: timestamp("confirmation_timestamp", { withTimezone: true }),
  targetQuantities: jsonb("target_quantities").$type<Record<string, number>>().notNull(),
  status: text("status").notNull(), // "pending" | "partially_committed" | "verified" | "blocked"
  result: jsonb("result"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// 11. tool_traces
export const toolTraces = pgTable("tool_traces", {
  id: uuid("id").primaryKey().defaultRandom(),
  correlationId: text("correlation_id"),
  toolName: text("tool_name"),
  mode: text("mode"),
  durationMs: integer("duration_ms"),
  retryCount: integer("retry_count"),
  sanitizedStatus: text("sanitized_status"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// 12. draft_approvals
export const draftApprovals = pgTable("draft_approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  draftId: uuid("draft_id")
    .notNull()
    .unique()
    .references(() => drafts.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// 13. auth_sessions
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    handleHash: text("handle_hash").notNull().unique(),
    status: text("status").notNull(), // "pending" | "authenticated" | "revoked"
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("auth_sessions_user_id_idx").on(table.userId),
    index("auth_sessions_expires_at_idx").on(table.expiresAt),
  ],
);

// 14. silpo_oauth_states
export const silpoOAuthStates = pgTable(
  "silpo_oauth_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    phase: text("phase").notNull().default("idle"), // "idle" | "pending" | "processing"
    bindingHash: text("binding_hash"),
    flowExpiresAt: timestamp("flow_expires_at", { withTimezone: true }),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
);
