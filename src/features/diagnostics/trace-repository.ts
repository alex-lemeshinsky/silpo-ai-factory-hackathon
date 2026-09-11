import { desc, eq } from "drizzle-orm";

import type { DbClient } from "@/db/client";
import { toolTraces } from "@/db/schema";
import type { DataMode } from "@/features/shared/contracts";
import { sanitizeTrace, type ToolTrace, type ToolTraceSink, type TraceStatus } from "@/lib/logger";

/** What the demo panel is allowed to see. Never a correlation ID or metadata. */
export interface SanitizedTraceRow {
  toolName: string;
  durationMs: number;
  status: TraceStatus;
  at: string;
}

export interface ToolTraceRepository extends ToolTraceSink {
  append(trace: ToolTrace): Promise<void>;
  recent(mode: DataMode, limit: number): Promise<SanitizedTraceRow[]>;
  /** Full records, for tests that must prove nothing sensitive was stored. */
  all(): Promise<ToolTrace[]>;
}

interface StoredTrace {
  trace: ToolTrace;
  createdAt: Date;
}

export function createInMemoryToolTraceRepository(
  now: () => Date = () => new Date(),
): ToolTraceRepository {
  const stored: StoredTrace[] = [];

  return {
    async append(trace: ToolTrace): Promise<void> {
      // Re-sanitized on the way in: a caller reaching the repository directly
      // must not be a way around the logger.
      stored.push({ trace: sanitizeTrace(trace), createdAt: now() });
    },

    async recent(mode: DataMode, limit: number): Promise<SanitizedTraceRow[]> {
      return stored
        .filter((entry) => entry.trace.mode === mode)
        .slice()
        .reverse()
        .slice(0, Math.max(0, Math.trunc(limit)))
        .map((entry) => ({
          toolName: entry.trace.toolName,
          durationMs: entry.trace.durationMs,
          status: entry.trace.status,
          at: entry.createdAt.toISOString(),
        }));
    },

    async all(): Promise<ToolTrace[]> {
      return stored.slice().reverse().map((entry) => structuredClone(entry.trace));
    },
  };
}

export function createPostgresToolTraceRepository(db: DbClient): ToolTraceRepository {
  return {
    async append(trace: ToolTrace): Promise<void> {
      const safe = sanitizeTrace(trace);
      await db.insert(toolTraces).values({
        correlationId: safe.correlationId,
        toolName: safe.toolName,
        mode: safe.mode,
        durationMs: safe.durationMs,
        retryCount: safe.retryCount,
        predictionVersion: safe.predictionVersion,
        sanitizedStatus: safe.status,
        metadata: safe.metadata,
      });
    },

    async recent(mode: DataMode, limit: number): Promise<SanitizedTraceRow[]> {
      const rows = await db
        .select({
          toolName: toolTraces.toolName,
          durationMs: toolTraces.durationMs,
          sanitizedStatus: toolTraces.sanitizedStatus,
          createdAt: toolTraces.createdAt,
        })
        .from(toolTraces)
        .where(eq(toolTraces.mode, mode))
        .orderBy(desc(toolTraces.createdAt))
        .limit(Math.max(0, Math.trunc(limit)));

      // Rows predate nothing, but the columns are nullable, so each one is
      // put back through the sanitizer rather than trusted as read.
      return rows.map((row) => {
        const safe = sanitizeTrace({
          toolName: row.toolName ?? "unknown",
          durationMs: row.durationMs ?? 0,
          status: row.sanitizedStatus ?? "error",
          mode,
        });
        return {
          toolName: safe.toolName,
          durationMs: safe.durationMs,
          status: safe.status,
          at: row.createdAt.toISOString(),
        };
      });
    },

    async all(): Promise<ToolTrace[]> {
      const rows = await db.select().from(toolTraces).orderBy(desc(toolTraces.createdAt));
      return rows.map((row) =>
        sanitizeTrace({
          correlationId: row.correlationId ?? undefined,
          toolName: row.toolName ?? undefined,
          mode: row.mode ?? undefined,
          durationMs: row.durationMs ?? 0,
          retryCount: row.retryCount ?? 0,
          predictionVersion: row.predictionVersion,
          status: row.sanitizedStatus ?? undefined,
          metadata: row.metadata ?? {},
        }),
      );
    },
  };
}
