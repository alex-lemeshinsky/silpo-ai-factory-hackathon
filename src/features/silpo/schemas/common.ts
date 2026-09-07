import { z } from "zod";

export const nonEmptyString = z.string().trim().min(1);
export const isoDateTime = z.string().datetime({ offset: true });
export const money = z.number().finite().nonnegative();

/**
 * A Silpo response that did not match its schema. Carries the tool name for
 * diagnostics and nothing from the payload, so no external content can leak
 * into a log line or an HTTP response.
 */
export class InvalidExternalDataError extends Error {
  constructor(readonly tool: string, options?: { cause?: unknown }) {
    super("invalid_external_data", options);
    this.name = "InvalidExternalDataError";
  }
}

/**
 * Parses the `structuredContent` envelope of an MCP tool result. Every
 * external Silpo response passes through here, so the boundary is validated
 * in exactly one place.
 */
export function parseToolResult<T>(tool: string, result: unknown, schema: z.ZodType<T>): T {
  const envelope = result as { structuredContent?: unknown } | null | undefined;
  if (!envelope || typeof envelope !== "object" || !("structuredContent" in envelope)) {
    throw new InvalidExternalDataError(tool);
  }
  const parsed = schema.safeParse(envelope.structuredContent);
  if (!parsed.success) {
    throw new InvalidExternalDataError(tool, { cause: parsed.error });
  }
  return parsed.data;
}
