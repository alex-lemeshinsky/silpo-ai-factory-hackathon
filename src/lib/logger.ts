import { z } from "zod";

import { DataModeSchema, type DataMode } from "@/features/shared/contracts";

export const TRACE_STATUSES = ["ok", "error", "blocked"] as const;
export type TraceStatus = (typeof TRACE_STATUSES)[number];

/** Server-generated identifiers only. Every `crypto.randomUUID()` matches. */
const CORRELATION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/i;
const VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
const METADATA_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;

/** A single MCP call takes minutes at worst; anything larger is a bug, not data. */
const MAX_DURATION_MS = 600_000;
const MAX_RETRY_COUNT = 10;

export interface ToolTrace {
  correlationId: string;
  toolName: string;
  mode: DataMode;
  durationMs: number;
  retryCount: number;
  predictionVersion: string | null;
  status: TraceStatus;
  metadata: Record<string, number | boolean | null>;
}

const boundedInt = (max: number) =>
  z.coerce.number().finite().transform((value) => Math.min(Math.max(Math.trunc(value), 0), max));

/**
 * Redaction is structural, not a denylist.
 *
 * The object schema strips every key it does not name, so `authorization`,
 * `phone`, `address`, raw prompts and raw MCP payloads have no field to land
 * in. The fields that survive are pattern- or enum-constrained, so none of
 * them admits free text. `metadata` admits numbers, booleans and null and
 * nothing else, which makes personal data unrepresentable rather than
 * filtered — there is no list here for a future author to forget to extend.
 *
 * Every field carries a fallback, so the function is total: a malformed call
 * degrades that one field and still produces the evidence that a fault
 * occurred, instead of throwing inside a `finally` block on a cart write.
 */
const ToolTraceSchema = z.object({
  correlationId: z.string().regex(CORRELATION_PATTERN).catch(() => crypto.randomUUID()),
  toolName: z.string().regex(TOOL_NAME_PATTERN).catch("unknown"),
  mode: DataModeSchema.catch("demo"),
  durationMs: boundedInt(MAX_DURATION_MS).catch(0),
  retryCount: boundedInt(MAX_RETRY_COUNT).catch(0),
  predictionVersion: z.string().regex(VERSION_PATTERN).nullable().catch(null),
  status: z.enum(TRACE_STATUSES).catch("error"),
  // Filtered per entry rather than validated as a whole: a record schema
  // would reject the entire map on one bad key, and a caller that attached
  // one stray string would lose the item count next to it.
  metadata: z.unknown().transform(toSafeMetadata).catch({}),
});

function toSafeMetadata(value: unknown): Record<string, number | boolean | null> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const safe: Record<string, number | boolean | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!METADATA_KEY_PATTERN.test(key)) continue;
    if (entry === null || typeof entry === "boolean") {
      safe[key] = entry;
    } else if (typeof entry === "number" && Number.isFinite(entry)) {
      safe[key] = entry;
    }
    // Everything else — strings above all — is dropped without comment.
  }
  return safe;
}

export function sanitizeTrace(input: unknown): ToolTrace {
  const source = typeof input === "object" && input !== null && !Array.isArray(input) ? input : {};
  const parsed = ToolTraceSchema.safeParse(source);
  // `.catch()` on every field makes a whole-object failure unreachable, but a
  // total function must not depend on that reasoning staying true.
  return parsed.success ? parsed.data : ToolTraceSchema.parse({});
}

export interface ToolTraceSink {
  append(trace: ToolTrace): Promise<void>;
}

export interface Logger {
  toolCall(input: unknown): Promise<void>;
}

/**
 * Console output serializes the same record that is persisted, so there is no
 * path that redacts one destination and not the other.
 *
 * Nothing here can throw or reject. A draft run and a cart write both call
 * this from paths whose failure would be reported to the user, and an
 * observability fault must never become a product fault.
 */
export function createLogger(options: {
  sink: ToolTraceSink;
  console?: Pick<Console, "info">;
}): Logger {
  const target = options.console ?? console;
  return {
    async toolCall(input: unknown): Promise<void> {
      const trace = sanitizeTrace(input);
      try {
        target.info(JSON.stringify(trace));
      } catch {
        // A closed or replaced stream must not suppress persistence.
      }
      try {
        await options.sink.append(trace);
      } catch {
        // Intentionally swallowed; see the comment above.
      }
    },
  };
}

export function createNoopLogger(): Logger {
  return { async toolCall(): Promise<void> {} };
}
