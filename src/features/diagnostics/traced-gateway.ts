import type { DataMode, SilpoGateway } from "@/features/shared/contracts";
import type { Logger } from "@/lib/logger";

export interface TracedGatewayOptions {
  logger: Logger;
  correlationId: string;
  mode: DataMode;
  /** Service-level attempts. MCP-internal retries are not observable here. */
  retryCount?: number;
  now?: () => number;
}

/**
 * One trace per gateway call, in both live and demo mode.
 *
 * The decorator is applied inside the application services rather than at
 * gateway construction, so it needs no route change, and it covers every
 * consumer of the gateway — including `resolveProducts`, which issues most
 * of a draft run's Silpo calls and would be invisible to spans written by
 * hand in the service.
 *
 * Two properties matter more than the trace itself. The original error
 * instance is rethrown untouched, because `McpCallError`, `ZodError`,
 * `InvalidExternalDataError` and `UnadvertisedToolError` are classified by
 * `instanceof` and a wrapped error would silently reclassify a live failure.
 * And a logger fault can neither fail nor delay the call: `toolCall` already
 * cannot reject, and its promise is deliberately not awaited.
 */
export function withTracedGateway(
  gateway: SilpoGateway,
  options: TracedGatewayOptions,
): SilpoGateway {
  const now = options.now ?? (() => Date.now());

  const record = (toolName: string, startedAt: number, status: "ok" | "error"): void => {
    // `toolCall` cannot reject, but a hand-written fake in a test can throw
    // synchronously, and a real call must not depend on it never doing so.
    try {
      void Promise.resolve(
        options.logger.toolCall({
          correlationId: options.correlationId,
          toolName,
          mode: options.mode,
          durationMs: now() - startedAt,
          retryCount: options.retryCount ?? 0,
          status,
        }),
      ).catch(() => {});
    } catch {
      // Intentionally swallowed; see the comment above.
    }
  };

  const traced = {} as Record<string, unknown>;
  for (const toolName of Object.keys(gateway) as Array<keyof SilpoGateway>) {
    const method = gateway[toolName];
    traced[toolName] = async (...args: unknown[]): Promise<unknown> => {
      const startedAt = now();
      try {
        const result = await (method as (...inner: unknown[]) => Promise<unknown>).apply(
          gateway,
          args,
        );
        record(toolName, startedAt, "ok");
        return result;
      } catch (error) {
        record(toolName, startedAt, "error");
        throw error;
      }
    };
  }

  return traced as unknown as SilpoGateway;
}
