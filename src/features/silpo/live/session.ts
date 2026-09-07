import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { z } from "zod";

import {
  createHardenedFetch,
  SILPO_MCP_SERVER_URL,
  type SilpoOAuthProvider,
} from "../oauth/transport";
import { parseToolResult } from "../schemas/common";
import { isRetryableStatus, withBoundedRetry } from "./retry";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const CLIENT_INFO = { name: "silpo-avtopilot", version: "1.0.0" } as const;

/** A tool name absent from the server's advertised `tools/list` surface. */
export class UnadvertisedToolError extends Error {
  constructor(readonly tool: string) {
    super("invalid_external_data");
    this.name = "UnadvertisedToolError";
  }
}

/** An MCP call that failed, carrying the status when one is recoverable. */
export class McpCallError extends Error {
  constructor(
    readonly tool: string,
    readonly status: number | null,
    readonly retryAfterHeader: string | null,
    options?: { cause?: unknown },
  ) {
    super(status === 429 ? "rate_limited" : "mcp_call_failed", options);
    this.name = "McpCallError";
  }
}

export interface McpSession {
  readonly advertisedTools: ReadonlySet<string>;
  /** True for read sessions, false for the bearer-only write session. */
  readonly retryEnabled: boolean;
  /**
   * Calls one advertised tool and parses its `structuredContent` through
   * `schema`. Parsing lives here so the external boundary is validated in
   * exactly one place.
   */
  callTool<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T>;
  close(): Promise<void>;
}

export interface OpenSessionOptions {
  provider: SilpoOAuthProvider;
  serverUrl?: string | URL;
  fetch?: typeof fetch;
  lookupIp?: (hostname: string) => Promise<string[]>;
  requestTimeoutMs?: number;
  operationTimeoutMs?: number;
  allowInsecureDevHttp?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Recovers the HTTP status from an SDK failure.
 *
 * The SDK's `SdkHttpError` exposes `status`, `statusText` and `text` but not
 * the response headers, so `Retry-After` cannot come from here. The session
 * observes it at the fetch layer instead — see `observeRateLimit` below.
 */
function extractStatus(error: unknown): number | null {
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
  for (const value of [candidate?.status, candidate?.code]) {
    if (typeof value === "number" && value >= 100 && value < 600) {
      return value;
    }
  }
  const message = typeof candidate?.message === "string" ? candidate.message : String(error);
  const match = message.match(/\b(4\d{2}|5\d{2})\b/);
  return match ? Number(match[1]) : null;
}

async function openSession(
  options: OpenSessionOptions,
  policy: { retryEnabled: boolean; refreshBudget: number },
): Promise<McpSession> {
  const serverUrl = new URL(options.serverUrl ?? SILPO_MCP_SERVER_URL);
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const deadlineAt = now() + operationTimeoutMs;

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), operationTimeoutMs);

  const hardenedFetch = createHardenedFetch({
    serverUrl,
    provider: options.provider,
    fetch: options.fetch ?? globalThis.fetch,
    lookupIp: options.lookupIp ?? (async (hostname) => {
      const dns = await import("node:dns/promises");
      const results = await dns.lookup(hostname, { all: true });
      return results.map((entry) => entry.address);
    }),
    requestTimeoutMs,
    operationDeadline: deadlineAt,
    abortSignal: abortController.signal,
    allowInsecureDevHttp: options.allowInsecureDevHttp ?? false,
    // Retry never happens at the fetch layer for live sessions: a read and a
    // cart write are both POST /mcp there, so the two cannot be told apart.
    retryOn429: false,
    refreshBudget: policy.refreshBudget,
  });

  // The SDK drops response headers before an error reaches the caller, so the
  // rate-limit hint is captured here, where the raw Response still exists.
  let observedRetryAfter: string | null = null;
  const observingFetch: typeof fetch = async (input, init) => {
    const response = await hardenedFetch(input, init);
    if (isRetryableStatus(response.status)) {
      const header = response.headers.get("Retry-After");
      observedRetryAfter = header !== null && header.trim().length > 0 ? header : null;
    }
    return response;
  };

  const transport = new StreamableHTTPClientTransport(serverUrl, {
    authProvider: options.provider,
    fetch: observingFetch,
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 30000,
      reconnectionDelayGrowFactor: 1.5,
    },
    onInsufficientScope: "throw",
  });

  const client = new Client(CLIENT_INFO, { capabilities: {} });
  let advertisedTools: Set<string>;
  try {
    await client.connect(transport);

    // Mandatory first operation: never assume the available tool surface.
    const listed = await client.listTools();
    advertisedTools = new Set(listed.tools.map((tool) => tool.name));
  } catch (error) {
    clearTimeout(timeoutId);
    abortController.abort();
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    throw error;
  }

  const close = async () => {
    clearTimeout(timeoutId);
    abortController.abort();
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  };

  return {
    advertisedTools,
    retryEnabled: policy.retryEnabled,

    async callTool<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
      if (!advertisedTools.has(name)) {
        throw new UnadvertisedToolError(name);
      }

      const invoke = async () => {
        // Cleared per attempt so a hint from an earlier call is never reused.
        observedRetryAfter = null;
        let result;
        try {
          result = await client.callTool({ name, arguments: args });
        } catch (error) {
          // Transport and HTTP failures only. A schema failure below is a
          // different category and must not be reported as a call failure.
          const status = extractStatus(error);
          const retryAfterHeader =
            status !== null && isRetryableStatus(status) ? observedRetryAfter : null;
          throw new McpCallError(name, status, retryAfterHeader, { cause: error });
        }
        if (result.isError) {
          throw new McpCallError(name, null, null);
        }
        // Throws InvalidExternalDataError, which is never retryable and maps
        // to 502 at the route.
        return parseToolResult(name, result, schema);
      };

      if (!policy.retryEnabled) {
        return invoke();
      }

      return withBoundedRetry(invoke, {
        deadlineAt,
        now,
        sleep: options.sleep,
        classify: (error) => ({
          retryable:
            error instanceof McpCallError &&
            error.status !== null &&
            isRetryableStatus(error.status),
          retryAfterHeader:
            error instanceof McpCallError ? error.retryAfterHeader : null,
        }),
      });
    },

    close,
  };
}

/** Read session: one refresh attempt, bounded 429 retry at the callTool layer. */
export function openReadSession(options: OpenSessionOptions): Promise<McpSession> {
  return openSession(options, { retryEnabled: true, refreshBudget: 1 });
}

/**
 * Write session: bearer-only. No refresh, and no retry code path to invoke,
 * so a cart write cannot be automatically repeated.
 */
export function openWriteSession(options: OpenSessionOptions): Promise<McpSession> {
  return openSession(options, { retryEnabled: false, refreshBudget: 0 });
}
