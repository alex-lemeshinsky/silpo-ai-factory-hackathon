# Live History and Cart-Context Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the application its first authenticated Silpo business-tool surface — a verified cart context with a valid delivery slot, and normalized purchase history.

**Architecture:** The hardened fetch already inside `oauth/transport.ts` is extracted and shared. A new `live/session.ts` composes it with the official MCP `Client` into two sessions: a read session with one refresh attempt and bounded `429` retry, and a bearer-only write session with no retry code path at all. Zod parsers guard every MCP response. Two gateways map validated responses onto existing shared contracts, and one route exposes slot selection.

**Tech Stack:** TypeScript, Next.js App Router (Node runtime), Zod 4, Vitest, `@modelcontextprotocol/client`, Drizzle/Postgres (only via the existing OAuth repository).

**Spec:** [2026-09-07-live-history-cart-context-design.md](../specs/2026-09-07-live-history-cart-context-design.md)

## Global Constraints

- Use `pnpm` exclusively. Add no production or development dependency.
- Do not edit `src/features/shared/contracts.ts`, `src/lib/env.ts`, `src/db/schema.ts`, `vitest.config.ts`, `package.json`, or `SILPO_MCP.md`.
- Preserve every existing Task 9 behavior. `src/features/silpo/oauth/transport.test.ts` must keep passing unmodified — it is the regression gate for Task 1 and Task 2.
- Start every authenticated MCP session with `tools/list` before any business tool call. Reject any tool name not in the advertised set.
- Retry read-only calls after `429` at most **3** times, using `Retry-After` when present and otherwise **250 / 500 / 1000 ms plus jitter**. A delay that does not fit the remaining operation deadline ends the loop instead of extending it.
- Never automatically retry a cart write. Only `silpo_create_shopping_cart` and `silpo_update_shopping_cart` use the write session.
- Delegate `401` to the OAuth provider for at most one refresh attempt on reads, and zero on writes.
- External MCP response schemas are **not** `.strict()` — Zod strips unknown keys by default so a field Silpo adds is additive. Internal contracts keep their existing `.strict()`.
- Never persist, log, or return phone, email, precise address, loyalty barcode, date of birth, profile IDs, or raw MCP payloads.
- Do not window, filter service rows, or deduplicate history. `normalizePurchases` in `src/features/purchases/normalize.ts` already owns all three.
- **Response field names are provisional.** `SILPO_MCP.md` documents tool names and request parameters, not full response schemas. Field names in this plan come from the documented request parameters and the scenario descriptions. When credentials become available, reconcile every schema against a live `tools/list` and report any mismatch as a spec deviation — do not silently reshape a schema to match whatever arrived.
- **Commit discipline:** work on branch `task-10-live-history-cart-context`. Each task below ends in its own commit on that branch. The final task squashes the branch into one commit on `main` with the backlog's mandated message, `feat: read live Silpo purchase context`.

---

### Task 1: Bounded retry policy

**Files:**
- Create: `src/features/silpo/live/retry.ts`
- Test: `src/features/silpo/live/retry.test.ts`

**Interfaces:**
- Consumes: nothing. This module is pure — no session, transport, or MCP type.
- Produces: `RETRY_ATTEMPT_LIMIT: 3`; `RETRY_BASE_DELAYS_MS: readonly [250, 500, 1000]`; `computeRetryDelayMs(input: RetryDelayInput): number | null`; `isRetryableStatus(status: number): boolean`; `withBoundedRetry<T>(operation: () => Promise<T>, options: BoundedRetryOptions): Promise<T>`; `RetryDelayInput`; `BoundedRetryOptions`; `RetryClassification`.

- [ ] **Step 1: Write the failing tests**

Create `src/features/silpo/live/retry.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import {
  computeRetryDelayMs,
  isRetryableStatus,
  RETRY_ATTEMPT_LIMIT,
  withBoundedRetry,
} from "./retry";

const noJitter = () => 0;

describe("computeRetryDelayMs", () => {
  it("uses the 250/500/1000 ladder when no Retry-After is present", () => {
    const delays = [1, 2, 3].map((attempt) =>
      computeRetryDelayMs({
        attempt,
        retryAfterHeader: null,
        remainingDeadlineMs: 60_000,
        jitter: noJitter,
      }),
    );
    expect(delays).toEqual([250, 500, 1000]);
  });

  it("adds bounded jitter above the base delay", () => {
    const delay = computeRetryDelayMs({
      attempt: 1,
      retryAfterHeader: null,
      remainingDeadlineMs: 60_000,
      jitter: () => 0.5,
    });
    expect(delay).toBeGreaterThan(250);
    expect(delay).toBeLessThanOrEqual(250 + 250);
  });

  it("prefers server-provided Retry-After seconds", () => {
    expect(
      computeRetryDelayMs({
        attempt: 1,
        retryAfterHeader: "2",
        remainingDeadlineMs: 60_000,
        jitter: noJitter,
      }),
    ).toBe(2000);
  });

  it("ignores a malformed or negative Retry-After and falls back to the ladder", () => {
    for (const header of ["soon", "-5", ""]) {
      expect(
        computeRetryDelayMs({
          attempt: 1,
          retryAfterHeader: header,
          remainingDeadlineMs: 60_000,
          jitter: noJitter,
        }),
      ).toBe(250);
    }
  });

  it("returns null when the delay cannot fit the remaining deadline", () => {
    expect(
      computeRetryDelayMs({
        attempt: 1,
        retryAfterHeader: "30",
        remainingDeadlineMs: 1_000,
        jitter: noJitter,
      }),
    ).toBeNull();
  });

  it("returns null once the attempt limit is exceeded", () => {
    expect(
      computeRetryDelayMs({
        attempt: RETRY_ATTEMPT_LIMIT + 1,
        retryAfterHeader: null,
        remainingDeadlineMs: 60_000,
        jitter: noJitter,
      }),
    ).toBeNull();
  });
});

describe("isRetryableStatus", () => {
  it("retries only 429", () => {
    expect(isRetryableStatus(429)).toBe(true);
    for (const status of [200, 400, 401, 403, 500, 503]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });
});

describe("withBoundedRetry", () => {
  const classifyRateLimited = (error: unknown) => ({
    retryable: error instanceof Error && error.message === "429",
    retryAfterHeader: null,
  });

  it("returns the first successful result without sleeping", async () => {
    const sleep = vi.fn(async () => {});
    const operation = vi.fn(async () => "ok");

    const result = await withBoundedRetry(operation, {
      deadlineAt: 60_000,
      now: () => 0,
      sleep,
      classify: classifyRateLimited,
    });

    expect(result).toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a rate-limited operation and returns the eventual success", async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const operation = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("429");
      return "ok";
    });

    const result = await withBoundedRetry(operation, {
      deadlineAt: 60_000,
      now: () => 0,
      sleep,
      classify: classifyRateLimited,
      jitter: noJitter,
    });

    expect(result).toBe("ok");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500]);
  });

  it("gives up after exactly three retries and rethrows the last error", async () => {
    const sleep = vi.fn(async () => {});
    const operation = vi.fn(async () => {
      throw new Error("429");
    });

    await expect(
      withBoundedRetry(operation, {
        deadlineAt: 60_000,
        now: () => 0,
        sleep,
        classify: classifyRateLimited,
        jitter: noJitter,
      }),
    ).rejects.toThrow("429");

    expect(operation).toHaveBeenCalledTimes(RETRY_ATTEMPT_LIMIT + 1);
    expect(sleep).toHaveBeenCalledTimes(RETRY_ATTEMPT_LIMIT);
  });

  it("never retries an error the classifier rejects", async () => {
    const sleep = vi.fn(async () => {});
    const operation = vi.fn(async () => {
      throw new Error("401");
    });

    await expect(
      withBoundedRetry(operation, {
        deadlineAt: 60_000,
        now: () => 0,
        sleep,
        classify: classifyRateLimited,
      }),
    ).rejects.toThrow("401");

    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops retrying when the deadline has passed", async () => {
    const sleep = vi.fn(async () => {});
    const operation = vi.fn(async () => {
      throw new Error("429");
    });

    await expect(
      withBoundedRetry(operation, {
        deadlineAt: 100,
        now: () => 0,
        sleep,
        classify: classifyRateLimited,
        jitter: noJitter,
      }),
    ).rejects.toThrow("429");

    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run src/features/silpo/live/retry.test.ts`
Expected: FAIL — `Failed to resolve import "./retry"`.

- [ ] **Step 3: Implement the module**

Create `src/features/silpo/live/retry.ts`:

```ts
/**
 * Bounded retry policy for read-only Silpo MCP calls.
 *
 * Pure by construction: it knows about attempt counts, delays and deadlines,
 * and nothing about sessions, transports or MCP types. `oauth/transport.ts`
 * imports `computeRetryDelayMs` so the delay ladder is defined exactly once.
 *
 * Cart writes never reach this module — the write session has no retry path.
 */

export const RETRY_ATTEMPT_LIMIT = 3;
export const RETRY_BASE_DELAYS_MS = [250, 500, 1000] as const;

export interface RetryDelayInput {
  /** 1-based attempt number: the first retry is attempt 1. */
  attempt: number;
  retryAfterHeader: string | null;
  remainingDeadlineMs: number;
  /** Returns a value in [0, 1). Injectable so tests are deterministic. */
  jitter?: () => number;
}

/**
 * Returns the delay before the given retry attempt, or null when the caller
 * must stop: the attempt limit is exhausted, or the delay would outlive the
 * operation deadline. A server-supplied Retry-After never extends the
 * deadline; it only ends the loop sooner.
 */
export function computeRetryDelayMs(input: RetryDelayInput): number | null {
  const { attempt, retryAfterHeader, remainingDeadlineMs } = input;
  const jitter = input.jitter ?? Math.random;

  if (!Number.isInteger(attempt) || attempt < 1 || attempt > RETRY_ATTEMPT_LIMIT) {
    return null;
  }

  const base = RETRY_BASE_DELAYS_MS[attempt - 1];
  let delay = base + jitter() * base;

  if (retryAfterHeader !== null && retryAfterHeader.trim().length > 0) {
    const seconds = Number.parseInt(retryAfterHeader.trim(), 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      delay = seconds * 1000;
    }
  }

  if (delay > remainingDeadlineMs) {
    return null;
  }
  return delay;
}

export function isRetryableStatus(status: number): boolean {
  return status === 429;
}

export interface RetryClassification {
  retryable: boolean;
  retryAfterHeader: string | null;
}

export interface BoundedRetryOptions {
  /** Absolute epoch-ms deadline for the whole operation. */
  deadlineAt: number;
  classify: (error: unknown) => RetryClassification;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
  attemptLimit?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `operation`, retrying only errors the classifier marks retryable, at
 * most `attemptLimit` times. The original error is rethrown when the budget
 * or the deadline is exhausted, so callers still see the real failure.
 */
export async function withBoundedRetry<T>(
  operation: () => Promise<T>,
  options: BoundedRetryOptions,
): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const attemptLimit = options.attemptLimit ?? RETRY_ATTEMPT_LIMIT;

  let attempt = 0;

  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attemptLimit) {
        throw error;
      }

      const classification = options.classify(error);
      if (!classification.retryable) {
        throw error;
      }

      attempt += 1;
      const delay = computeRetryDelayMs({
        attempt,
        retryAfterHeader: classification.retryAfterHeader,
        remainingDeadlineMs: options.deadlineAt - now(),
        jitter: options.jitter,
      });

      if (delay === null) {
        throw error;
      }
      await sleep(delay);
    }
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run src/features/silpo/live/retry.test.ts`
Expected: PASS — 12 tests.

- [ ] **Step 5: Commit**

```bash
git checkout -b task-10-live-history-cart-context
git add src/features/silpo/live/retry.ts src/features/silpo/live/retry.test.ts
git commit -m "feat: add bounded retry policy for Silpo reads"
```

---

### Task 2: Extract the hardened fetch

**Files:**
- Modify: `src/features/silpo/oauth/transport.ts`
- Test: `src/features/silpo/oauth/transport.test.ts` (regression only — do not edit)

**Interfaces:**
- Consumes: `computeRetryDelayMs` from Task 1.
- Produces: `createHardenedFetch(options: HardenedFetchOptions): typeof fetch`; `HardenedFetchOptions`.

The whole point of this task is that **behavior does not change**. `createSilpoOAuthConnection` keeps calling the same logic through the new factory. The existing test file is the gate.

- [ ] **Step 1: Capture the green baseline**

Run: `pnpm vitest run src/features/silpo/oauth/transport.test.ts`
Expected: PASS. Record the test count — the same count must pass at the end of this task.

- [ ] **Step 2: Add the exported options type and factory signature**

In `src/features/silpo/oauth/transport.ts`, add near the other exported interfaces:

```ts
import { computeRetryDelayMs } from "../live/retry";

export interface HardenedFetchOptions {
  serverUrl: URL;
  provider: SilpoOAuthProvider;
  /** Underlying fetch. Injectable for synthetic-network tests. */
  fetch: typeof fetch;
  lookupIp: (hostname: string) => Promise<string[]>;
  requestTimeoutMs: number;
  /** Absolute epoch-ms deadline shared by every request on this connection. */
  operationDeadline: number;
  abortSignal: AbortSignal;
  allowInsecureDevHttp: boolean;
  /**
   * Fetch-level 429 retry. True for the OAuth flow, whose requests are all
   * genuinely read-only. False for live sessions, where read/write is only
   * visible one layer up and retry belongs at the callTool layer.
   */
  retryOn429: boolean;
  /** 1 for read and OAuth flows, 0 for the bearer-only write session. */
  refreshBudget: number;
}
```

- [ ] **Step 3: Move the existing boundFetch body into the factory**

Convert the current `boundFetch` closure inside `createSilpoOAuthConnection` into a top-level exported function. The body is moved **verbatim** except for four substitutions:

1. Every free reference to `serverUrl`, `underlyingFetch`, `lookupIp`, `requestTimeoutMs`, `allowInsecureDevHttp`, `provider`, `connectionAbortController.signal` and `operationDeadline` now reads from `options`.
2. The local `budget` object becomes a function-scoped `let refreshAttempts = 0`, and the guard `if (budget.refreshAttempts >= 1)` becomes `if (refreshAttempts >= options.refreshBudget)`.
3. The `429` block is wrapped in `if (options.retryOn429)`.
4. The inline delay arithmetic — `250 * Math.pow(2, retryCount - 1) + Math.random() * 50`, the `Retry-After` parse, and the `delayMs > operationDeadline - Date.now()` break — is replaced by one call:

```ts
const delay = computeRetryDelayMs({
  attempt: retryCount,
  retryAfterHeader: response.headers.get("Retry-After"),
  remainingDeadlineMs: options.operationDeadline - Date.now(),
});
if (delay === null) {
  break;
}
if (delay > 0) {
  await abortableDelay(delay, options.abortSignal);
}
response = await executeFetch();
```

Declare the factory as:

```ts
export function createHardenedFetch(options: HardenedFetchOptions): typeof fetch {
  let refreshAttempts = 0;
  let codeExchanges = 0;

  return async (input, init) => {
    // ... moved body ...
  };
}
```

- [ ] **Step 4: Rewire createSilpoOAuthConnection to the factory**

Replace the inline `const boundFetch: typeof fetch = async (input, init) => { ... }` with:

```ts
const boundFetch = createHardenedFetch({
  serverUrl,
  provider,
  fetch: underlyingFetch,
  lookupIp,
  requestTimeoutMs,
  operationDeadline,
  abortSignal: connectionAbortController.signal,
  allowInsecureDevHttp,
  retryOn429: true,
  refreshBudget: 1,
});
```

- [ ] **Step 5: Run the regression suite**

Run: `pnpm vitest run src/features/silpo/oauth/transport.test.ts src/features/silpo/live/retry.test.ts`
Expected: PASS with the same transport test count as Step 1. If any transport assertion changed, the extraction altered behavior — revert and redo Step 3 rather than editing the test.

- [ ] **Step 6: Run the full OAuth suite and typecheck**

Run: `pnpm vitest run src/features/silpo/oauth && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/silpo/oauth/transport.ts
git commit -m "refactor: extract hardened MCP fetch factory"
```

---

### Task 3: MCP session foundation

**Files:**
- Create: `src/features/silpo/schemas/common.ts`
- Create: `src/features/silpo/live/session.ts`
- Test: `src/features/silpo/live/session.test.ts`

**Interfaces:**
- Consumes: `createHardenedFetch`, `SILPO_MCP_SERVER_URL`, `SilpoOAuthProvider` from `../oauth/transport`; `withBoundedRetry` from `./retry`.
- Produces: from `common.ts` — `nonEmptyString`, `isoDateTime`, `money`, `InvalidExternalDataError`, `parseToolResult`. From `session.ts` — `McpSession`; `OpenSessionOptions`; `openReadSession(options): Promise<McpSession>`; `openWriteSession(options): Promise<McpSession>`; `UnadvertisedToolError`; `McpCallError`.

`common.ts` lives here rather than with the cart schemas because `callTool` is where every external response is parsed. One boundary, one parser, one error type.

- [ ] **Step 1: Write the failing tests**

Create `src/features/silpo/live/session.test.ts`. `createSyntheticFetch` in `src/features/silpo/oauth/transport.test.ts` is the established pattern for synthetic MCP traffic — read it first and mirror its shape.

```ts
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { InvalidExternalDataError } from "../schemas/common";
import { openReadSession, openWriteSession, UnadvertisedToolError } from "./session";

// Minimal JSON-RPC responder over the streamable HTTP transport.
// `handlers` maps a tool name to the structuredContent it returns.
function createMcpFetch(options: {
  tools: string[];
  handlers?: Record<string, () => unknown>;
  statusQueue?: number[];
}) {
  const calls: { method: string; tool?: string }[] = [];
  let statusIndex = 0;

  const fakeFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = await request.clone().text();
    const rpc = body ? JSON.parse(body) : {};
    const method: string = rpc.method ?? "";
    const tool: string | undefined = rpc.params?.name;
    calls.push({ method, tool });

    const forcedStatus = options.statusQueue?.[statusIndex];
    if (forcedStatus !== undefined) {
      statusIndex += 1;
      if (forcedStatus !== 200) {
        return new Response("", {
          status: forcedStatus,
          headers: { "Retry-After": "0" },
        });
      }
    }

    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    if (method === "initialize") {
      return reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "silpo-fake", version: "1.0.0" },
      });
    }
    if (method === "tools/list") {
      return reply({
        tools: options.tools.map((name) => ({
          name,
          inputSchema: { type: "object" },
        })),
      });
    }
    if (method === "tools/call") {
      const handler = options.handlers?.[tool ?? ""];
      return reply({
        content: [],
        structuredContent: handler ? handler() : {},
      });
    }
    return reply({});
  };

  return { fakeFetch, calls };
}

// A provider stub is sufficient here: token acquisition is Task 9's tested
// concern, and these tests exercise session behavior above it.
function createProviderStub() {
  return {
    tokens: async () => ({ access_token: "test-access-token", token_type: "Bearer" }),
    setGrantKind: vi.fn(),
    invalidateCredentials: vi.fn(async () => {}),
    authorizationUrl: () => null,
    currentState: () => ({ version: 1 }),
  } as never;
}

const baseOptions = () => ({
  provider: createProviderStub(),
  lookupIp: async () => ["203.0.113.10"],
});

describe("openReadSession", () => {
  it("calls tools/list before any business tool", async () => {
    const { fakeFetch, calls } = createMcpFetch({ tools: ["silpo_get_my_shopping_cart"] });
    const session = await openReadSession({ ...baseOptions(), fetch: fakeFetch });

    const methods = calls.map((call) => call.method);
    expect(methods.indexOf("tools/list")).toBeGreaterThanOrEqual(0);
    expect(methods).not.toContain("tools/call");

    await session.close();
  });

  it("exposes the advertised tool set", async () => {
    const { fakeFetch } = createMcpFetch({ tools: ["silpo_get_my_shopping_cart", "silpo_get_time_slots"] });
    const session = await openReadSession({ ...baseOptions(), fetch: fakeFetch });

    expect([...session.advertisedTools].sort()).toEqual([
      "silpo_get_my_shopping_cart",
      "silpo_get_time_slots",
    ]);

    await session.close();
  });

  it("rejects an unadvertised tool without any network call", async () => {
    const { fakeFetch, calls } = createMcpFetch({ tools: ["silpo_get_my_shopping_cart"] });
    const session = await openReadSession({ ...baseOptions(), fetch: fakeFetch });
    const before = calls.length;

    await expect(
      session.callTool("silpo_clear_shopping_cart", {}, z.object({})),
    ).rejects.toBeInstanceOf(UnadvertisedToolError);
    expect(calls.length).toBe(before);

    await session.close();
  });

  it("parses structuredContent through the caller's schema", async () => {
    const { fakeFetch } = createMcpFetch({
      tools: ["silpo_get_my_shopping_cart"],
      handlers: { silpo_get_my_shopping_cart: () => ({ exists: true, cartId: "cart-1", extra: "ignored" }) },
    });
    const session = await openReadSession({ ...baseOptions(), fetch: fakeFetch });

    const result = await session.callTool(
      "silpo_get_my_shopping_cart",
      {},
      z.object({ exists: z.boolean(), cartId: z.string() }),
    );
    expect(result).toEqual({ exists: true, cartId: "cart-1" });

    await session.close();
  });

  it("retries a rate-limited read three times then fails", async () => {
    const { fakeFetch, calls } = createMcpFetch({
      tools: ["silpo_get_my_shopping_cart"],
      // initialize + tools/list succeed, then every tools/call is rate limited.
      statusQueue: [200, 200, 429, 429, 429, 429],
    });
    const session = await openReadSession({
      ...baseOptions(),
      fetch: fakeFetch,
      sleep: async () => {},
    });

    await expect(
      session.callTool("silpo_get_my_shopping_cart", {}, z.object({})),
    ).rejects.toThrow();

    const toolCalls = calls.filter((call) => call.method === "tools/call");
    expect(toolCalls).toHaveLength(4); // 1 initial + 3 retries

    await session.close();
  });
});

describe("openWriteSession", () => {
  it("attempts a rate-limited write exactly once", async () => {
    const { fakeFetch, calls } = createMcpFetch({
      tools: ["silpo_update_shopping_cart"],
      statusQueue: [200, 200, 429, 429, 429, 429],
    });
    const session = await openWriteSession({
      ...baseOptions(),
      fetch: fakeFetch,
      sleep: async () => {},
    });

    await expect(
      session.callTool("silpo_update_shopping_cart", {}, z.object({})),
    ).rejects.toThrow();

    const toolCalls = calls.filter((call) => call.method === "tools/call");
    expect(toolCalls).toHaveLength(1);

    await session.close();
  });

  it("has no retry path even when the operation would be retryable", async () => {
    const { fakeFetch } = createMcpFetch({ tools: ["silpo_create_shopping_cart"] });
    const session = await openWriteSession({ ...baseOptions(), fetch: fakeFetch });

    expect(session.retryEnabled).toBe(false);

    await session.close();
  });
});

// These two pin the real error shapes against the actual MCP client rather
// than against our assumptions about them.
describe("external failure shapes", () => {
  it("rejects a malformed response as invalid external data and does not call again", async () => {
    const { fakeFetch, calls } = createMcpFetch({
      tools: ["silpo_get_my_shopping_cart"],
      // `exists` must be a boolean; the server sends a string.
      handlers: { silpo_get_my_shopping_cart: () => ({ exists: "yes", cartId: "cart-1" }) },
    });
    const session = await openReadSession({
      ...baseOptions(),
      fetch: fakeFetch,
      sleep: async () => {},
    });

    await expect(
      session.callTool(
        "silpo_get_my_shopping_cart",
        {},
        z.object({ exists: z.boolean(), cartId: z.string() }),
      ),
    ).rejects.toBeInstanceOf(InvalidExternalDataError);

    // A schema failure is not retryable: exactly one tools/call.
    expect(calls.filter((call) => call.method === "tools/call")).toHaveLength(1);

    await session.close();
  });

  it("delegates a read 401 to at most one refresh, and a write 401 to none", async () => {
    // Counts POSTs to the token endpoint, which is how a refresh becomes
    // visible. `createSyntheticFetch` in
    // src/features/silpo/oauth/transport.test.ts is the fuller version of
    // this fixture — read it if the OAuth handshake needs more fidelity here.
    function createUnauthorizedFetch() {
      let tokenRequests = 0;
      const { fakeFetch } = createMcpFetch({ tools: ["silpo_get_my_shopping_cart", "silpo_update_shopping_cart"] });

      const wrapped: typeof fetch = async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);

        if (url.pathname.endsWith("/token")) {
          tokenRequests += 1;
          return new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const body = await request.clone().text();
        const rpc = body ? JSON.parse(body) : {};
        if (rpc.method === "tools/call") {
          return new Response("", { status: 401 });
        }
        return fakeFetch(input, init);
      };

      return { wrapped, tokenRequests: () => tokenRequests };
    }

    const read = createUnauthorizedFetch();
    const readSession = await openReadSession({
      ...baseOptions(),
      fetch: read.wrapped,
      sleep: async () => {},
    });
    await expect(
      readSession.callTool("silpo_get_my_shopping_cart", {}, z.object({})),
    ).rejects.toThrow();
    expect(read.tokenRequests()).toBeLessThanOrEqual(1);
    await readSession.close();

    const write = createUnauthorizedFetch();
    const writeSession = await openWriteSession({ ...baseOptions(), fetch: write.wrapped });
    await expect(
      writeSession.callTool("silpo_update_shopping_cart", {}, z.object({})),
    ).rejects.toThrow();
    expect(write.tokenRequests()).toBe(0);
    await writeSession.close();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run src/features/silpo/live/session.test.ts`
Expected: FAIL — `Failed to resolve import "./session"`.

- [ ] **Step 3: Implement the shared external-boundary helpers**

Create `src/features/silpo/schemas/common.ts`:

```ts
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
```

- [ ] **Step 4: Implement the session module**

Create `src/features/silpo/live/session.ts`:

```ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { z } from "zod";

import {
  createHardenedFetch,
  SILPO_MCP_SERVER_URL,
  type SilpoOAuthProvider,
} from "../oauth/transport";
import { parseToolResult } from "../schemas/common";
import { withBoundedRetry } from "./retry";

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

function extractStatus(error: unknown): { status: number | null; retryAfterHeader: string | null } {
  // The SDK surfaces HTTP failures as errors carrying the status in the
  // message or on the error object, depending on where they originate.
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
  for (const value of [candidate?.status, candidate?.code]) {
    if (typeof value === "number" && value >= 100 && value < 600) {
      return { status: value, retryAfterHeader: null };
    }
  }
  const message = typeof candidate?.message === "string" ? candidate.message : String(error);
  const match = message.match(/\b(4\d{2}|5\d{2})\b/);
  return { status: match ? Number(match[1]) : null, retryAfterHeader: null };
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

  const transport = new StreamableHTTPClientTransport(serverUrl, {
    authProvider: options.provider,
    fetch: hardenedFetch,
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 30000,
      reconnectionDelayGrowFactor: 1.5,
    },
    onInsufficientScope: "throw",
  });

  const client = new Client(CLIENT_INFO, { capabilities: {} });
  await client.connect(transport);

  // Mandatory first operation: never assume the available tool surface.
  const listed = await client.listTools();
  const advertisedTools = new Set(listed.tools.map((tool) => tool.name));

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
        let result;
        try {
          result = await client.callTool({ name, arguments: args });
        } catch (error) {
          // Transport and HTTP failures only. A schema failure below is a
          // different category and must not be reported as a call failure.
          const { status, retryAfterHeader } = extractStatus(error);
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
          retryable: error instanceof McpCallError && error.status === 429,
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
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run src/features/silpo/live/session.test.ts`
Expected: PASS — 9 tests. If the SDK surfaces HTTP status differently than `extractStatus` assumes, fix `extractStatus` against the real error shape; do not weaken the retry-count assertions.

- [ ] **Step 6: Commit**

```bash
git add src/features/silpo/schemas/common.ts src/features/silpo/live/session.ts src/features/silpo/live/session.test.ts
git commit -m "feat: add read and write Silpo MCP sessions"
```

---

### Task 4: External schemas for cart tools

**Files:**
- Create: `src/features/silpo/schemas/cart.ts`
- Test: `src/features/silpo/schemas/cart.test.ts`

**Interfaces:**
- Consumes: `nonEmptyString`, `isoDateTime`, `money` from `./common` (Task 3).
- Produces: from `cart.ts` — `MyShoppingCartSchema`, `ShoppingCartSchema`, `TimeSlotsSchema`, `DeliveryTypesSchema`, `BranchesSchema`, `FoundAddressSchema`, `DeliveryAddressesSchema`, `CreatedCartSchema`, and the inferred types `SilpoShoppingCart`, `SilpoTimeSlot`, `SilpoDeliveryType`, `SilpoBranch`, `SilpoFoundAddress`, `SilpoDeliveryAddress`.

Remember the Global Constraint: these field names are provisional and must be reconciled against a live `tools/list`.

- [ ] **Step 1: Write the failing tests**

Create `src/features/silpo/schemas/cart.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  DeliveryAddressesSchema,
  DeliveryTypesSchema,
  MyShoppingCartSchema,
  ShoppingCartSchema,
  TimeSlotsSchema,
} from "./cart";

const validCart = {
  id: "cart-1",
  branchId: "branch-7",
  deliveryType: "DeliveryHome",
  timeslot: { start: "2026-09-08T10:00:00Z", end: "2026-09-08T12:00:00Z" },
  address: { addressType: "flat", city: "Київ", street: "Хрещатик", house: "1" },
  shipments: [{ id: "ship-1", items: [] }],
  total: 420.5,
  validations: [],
};

describe("ShoppingCartSchema", () => {
  it("accepts a documented cart shape", () => {
    expect(ShoppingCartSchema.parse(validCart).id).toBe("cart-1");
  });

  it("tolerates unknown fields Silpo may add", () => {
    const parsed = ShoppingCartSchema.parse({ ...validCart, loyaltyExperiment: { flag: true } });
    expect(parsed).not.toHaveProperty("loyaltyExperiment");
    expect(parsed.id).toBe("cart-1");
  });

  it("rejects a missing required field rather than guessing", () => {
    const { id: _omitted, ...withoutId } = validCart;
    expect(ShoppingCartSchema.safeParse(withoutId).success).toBe(false);
  });

  it("rejects a mistyped field rather than coercing", () => {
    expect(ShoppingCartSchema.safeParse({ ...validCart, total: "420.5" }).success).toBe(false);
  });
});

describe("MyShoppingCartSchema", () => {
  it("accepts an existing cart", () => {
    expect(MyShoppingCartSchema.parse({ exists: true, cartId: "cart-1" })).toEqual({
      exists: true,
      cartId: "cart-1",
    });
  });

  it("accepts an absent cart with a null id", () => {
    expect(MyShoppingCartSchema.parse({ exists: false, cartId: null }).exists).toBe(false);
  });
});

describe("TimeSlotsSchema", () => {
  it("parses a slot list", () => {
    const parsed = TimeSlotsSchema.parse({
      slots: [
        { id: "slot-1", start: "2026-09-08T10:00:00Z", end: "2026-09-08T12:00:00Z", available: true },
      ],
    });
    expect(parsed.slots).toHaveLength(1);
  });

  it("rejects a non-ISO timestamp", () => {
    const result = TimeSlotsSchema.safeParse({
      slots: [{ id: "slot-1", start: "08.09.2026 10:00", end: "2026-09-08T12:00:00Z", available: true }],
    });
    expect(result.success).toBe(false);
  });
});

describe("DeliveryTypesSchema", () => {
  it("parses delivery types with a nullable branch", () => {
    const parsed = DeliveryTypesSchema.parse({
      deliveryTypes: [
        { deliveryType: "SelfPickup", branchId: null },
        { deliveryType: "DeliveryHome", branchId: "branch-7" },
      ],
    });
    expect(parsed.deliveryTypes[0].branchId).toBeNull();
  });
});

describe("DeliveryAddressesSchema", () => {
  it("parses saved addresses and marks the default", () => {
    const parsed = DeliveryAddressesSchema.parse({
      addresses: [
        { id: "addr-1", isDefault: true, addressType: "flat", city: "Київ", street: "Хрещатик", house: "1", district: null },
      ],
    });
    expect(parsed.addresses[0].isDefault).toBe(true);
  });

  it("accepts an empty address list", () => {
    expect(DeliveryAddressesSchema.parse({ addresses: [] }).addresses).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run src/features/silpo/schemas/cart.test.ts`
Expected: FAIL — `Failed to resolve import "./cart"`.

- [ ] **Step 3: Implement cart.ts**

Create `src/features/silpo/schemas/cart.ts`:

```ts
import { z } from "zod";

import { isoDateTime, money, nonEmptyString } from "./common";

/**
 * External Silpo MCP response schemas.
 *
 * Deliberately NOT `.strict()`. Zod strips unknown keys, so a field Silpo
 * adds is additive rather than an outage. Required fields are still
 * validated: a missing or mistyped one stops the flow instead of letting a
 * guessed shape through. Internal contracts keep their own `.strict()`.
 *
 * Field names follow SILPO_MCP.md's documented request parameters and must
 * be reconciled against a live `tools/list` once credentials exist.
 */

/** Documented values from SILPO_MCP.md. */
export const SILPO_DELIVERY_TYPES = [
  "SelfPickup",
  "DeliveryHome",
  "LongDelivery",
  "DeliveryExpressByPromise",
  "WideAssortDelivery",
  "B2B",
  "PreOrder",
  "NovaPoshta",
] as const;

export const SilpoDeliveryTypeSchema = z.enum(SILPO_DELIVERY_TYPES);
export type SilpoDeliveryTypeName = z.infer<typeof SilpoDeliveryTypeSchema>;

export const SilpoAddressSchema = z.object({
  addressType: nonEmptyString.nullable().default(null),
  city: nonEmptyString.nullable().default(null),
  street: nonEmptyString.nullable().default(null),
  house: nonEmptyString.nullable().default(null),
  district: nonEmptyString.nullable().default(null),
  latitude: z.number().finite().nullable().default(null),
  longitude: z.number().finite().nullable().default(null),
});

export const SilpoCartTimeslotSchema = z.object({
  id: nonEmptyString.nullable().default(null),
  start: isoDateTime,
  end: isoDateTime,
});

export const MyShoppingCartSchema = z.object({
  exists: z.boolean(),
  cartId: nonEmptyString.nullable().default(null),
});
export type SilpoMyShoppingCart = z.infer<typeof MyShoppingCartSchema>;

export const CartValidationSchema = z.object({
  severity: z.string(),
  code: nonEmptyString,
  message: z.string(),
  productId: nonEmptyString.nullable().default(null),
});

export const ShoppingCartSchema = z.object({
  id: nonEmptyString,
  branchId: nonEmptyString.nullable().default(null),
  deliveryType: z.string(),
  timeslot: SilpoCartTimeslotSchema.nullable().default(null),
  address: SilpoAddressSchema.nullable().default(null),
  /** Copied verbatim into an update; never interpreted here. */
  shipments: z.array(z.unknown()).default([]),
  total: money,
  validations: z.array(CartValidationSchema).default([]),
});
export type SilpoShoppingCart = z.infer<typeof ShoppingCartSchema>;

export const SilpoTimeSlotSchema = z.object({
  id: nonEmptyString,
  start: isoDateTime,
  end: isoDateTime,
  available: z.boolean(),
});
export type SilpoTimeSlot = z.infer<typeof SilpoTimeSlotSchema>;

export const TimeSlotsSchema = z.object({
  slots: z.array(SilpoTimeSlotSchema).default([]),
});

export const DeliveryTypesSchema = z.object({
  deliveryTypes: z.array(
    z.object({
      deliveryType: z.string(),
      branchId: nonEmptyString.nullable().default(null),
    }),
  ).default([]),
});
export type SilpoDeliveryType = z.infer<typeof DeliveryTypesSchema>["deliveryTypes"][number];

export const BranchesSchema = z.object({
  branches: z.array(
    z.object({
      id: nonEmptyString,
      name: z.string().default(""),
      hasPickup: z.boolean().default(false),
      hasNovaPoshta: z.boolean().default(false),
    }),
  ).default([]),
});
export type SilpoBranch = z.infer<typeof BranchesSchema>["branches"][number];

export const FoundAddressSchema = z.object({
  latitude: z.number().finite(),
  longitude: z.number().finite(),
  city: nonEmptyString.nullable().default(null),
  street: nonEmptyString.nullable().default(null),
  houseNumber: nonEmptyString.nullable().default(null),
  district: nonEmptyString.nullable().default(null),
});
export type SilpoFoundAddress = z.infer<typeof FoundAddressSchema>;

export const DeliveryAddressesSchema = z.object({
  addresses: z.array(
    z.object({
      id: nonEmptyString,
      isDefault: z.boolean().default(false),
      addressType: nonEmptyString.nullable().default(null),
      city: nonEmptyString.nullable().default(null),
      street: nonEmptyString.nullable().default(null),
      house: nonEmptyString.nullable().default(null),
      district: nonEmptyString.nullable().default(null),
    }),
  ).default([]),
});
export type SilpoDeliveryAddress = z.infer<typeof DeliveryAddressesSchema>["addresses"][number];

export const CreatedCartSchema = z.object({
  cartId: nonEmptyString,
});
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run src/features/silpo/schemas/cart.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/features/silpo/schemas/cart.ts src/features/silpo/schemas/cart.test.ts
git commit -m "feat: add Silpo cart response schemas"
```

---

### Task 5: Cart context bootstrap

**Files:**
- Create: `src/features/silpo/live/cart-context.ts`
- Test: `tests/contract/silpo-cart-context.test.ts`

**Interfaces:**
- Consumes: `McpSession` from Task 3; the cart schemas from Task 4; `CartContextResult`, `CartContextSchema`, `TimeSlot` from `@/features/shared/contracts`.
- Produces: `createLiveCartContextGateway(deps: LiveCartContextDeps): LiveCartContextGateway` with `loadCartContext(): Promise<CartContextResult>` and `getTimeSlots(context: CartContext): Promise<TimeSlot[]>`; `NoSavedAddressError`; `mapDeliveryType(silpoType: string): "delivery" | "pickup"`. `updateCartContext` arrives in Task 6.

- [ ] **Step 1: Write the failing tests**

Create `tests/contract/silpo-cart-context.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import {
  createLiveCartContextGateway,
  mapDeliveryType,
  NoSavedAddressError,
} from "@/features/silpo/live/cart-context";
import { UnadvertisedToolError, type McpSession } from "@/features/silpo/live/session";

const NOW = new Date("2026-09-08T09:00:00Z");

const READ_TOOLS = [
  "silpo_get_my_shopping_cart",
  "silpo_get_shopping_cart_by_id",
  "silpo_get_time_slots",
  "silpo_get_my_delivery_addresses",
  "silpo_find_address",
  "silpo_get_available_delivery_types",
  "silpo_list_branches",
];
const WRITE_TOOLS = ["silpo_create_shopping_cart", "silpo_update_shopping_cart"];

/**
 * A fake session that records call order and returns canned structuredContent.
 * Handlers receive the arguments so a test can assert what was sent.
 */
function createFakeSession(
  tools: string[],
  handlers: Record<string, (args: Record<string, unknown>) => unknown>,
): McpSession & { calls: string[] } {
  const calls: string[] = [];
  const advertisedTools = new Set(tools);

  return {
    calls,
    advertisedTools,
    retryEnabled: true,
    async callTool<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
      if (!advertisedTools.has(name)) throw new UnadvertisedToolError(name);
      calls.push(name);
      const handler = handlers[name];
      if (!handler) throw new Error(`unexpected tool ${name}`);
      return schema.parse(handler(args));
    },
    async close() {},
  };
}

const activeSlot = {
  id: "slot-1",
  start: "2026-09-08T10:00:00Z",
  end: "2026-09-08T12:00:00Z",
  available: true,
};

const cartWithSlot = {
  id: "cart-1",
  branchId: "branch-7",
  deliveryType: "DeliveryHome",
  timeslot: { id: "slot-1", start: activeSlot.start, end: activeSlot.end },
  address: { addressType: "flat", city: "Київ", street: "Хрещатик", house: "1" },
  shipments: [{ id: "ship-1" }],
  total: 0,
  validations: [],
};

describe("mapDeliveryType", () => {
  it("maps SelfPickup to pickup and everything else to delivery", () => {
    expect(mapDeliveryType("SelfPickup")).toBe("pickup");
    for (const type of ["DeliveryHome", "WideAssortDelivery", "NovaPoshta", "B2B"]) {
      expect(mapDeliveryType(type)).toBe("delivery");
    }
  });
});

describe("loadCartContext with an existing cart", () => {
  it("returns a ready context and follows the documented order", async () => {
    const read = createFakeSession(READ_TOOLS, {
      silpo_get_my_shopping_cart: () => ({ exists: true, cartId: "cart-1" }),
      silpo_get_shopping_cart_by_id: () => cartWithSlot,
      silpo_get_time_slots: () => ({ slots: [activeSlot] }),
    });
    const write = createFakeSession(WRITE_TOOLS, {});
    const gateway = createLiveCartContextGateway({ readSession: read, writeSession: write, now: () => NOW });

    const result = await gateway.loadCartContext();

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("unreachable");
    expect(result.context.cartId).toBe("cart-1");
    expect(result.context.deliveryType).toBe("delivery");
    expect(result.context.slot.id).toBe("slot-1");
    expect(read.calls).toEqual([
      "silpo_get_my_shopping_cart",
      "silpo_get_shopping_cart_by_id",
      "silpo_get_time_slots",
    ]);
    expect(write.calls).toEqual([]);
  });

  it("returns needs_slot when the cart slot has already ended", async () => {
    const expired = { ...activeSlot, id: "slot-0", start: "2026-09-07T10:00:00Z", end: "2026-09-07T12:00:00Z" };
    const read = createFakeSession(READ_TOOLS, {
      silpo_get_my_shopping_cart: () => ({ exists: true, cartId: "cart-1" }),
      silpo_get_shopping_cart_by_id: () => ({
        ...cartWithSlot,
        timeslot: { id: expired.id, start: expired.start, end: expired.end },
      }),
      silpo_get_time_slots: () => ({ slots: [activeSlot] }),
    });
    const gateway = createLiveCartContextGateway({
      readSession: read,
      writeSession: createFakeSession(WRITE_TOOLS, {}),
      now: () => NOW,
    });

    const result = await gateway.loadCartContext();

    expect(result.status).toBe("needs_slot");
    if (result.status !== "needs_slot") throw new Error("unreachable");
    expect(result.availableSlots.map((slot) => slot.id)).toEqual(["slot-1"]);
  });

  it("returns needs_slot when the cart slot is absent from the current list", async () => {
    const read = createFakeSession(READ_TOOLS, {
      silpo_get_my_shopping_cart: () => ({ exists: true, cartId: "cart-1" }),
      silpo_get_shopping_cart_by_id: () => cartWithSlot,
      silpo_get_time_slots: () => ({ slots: [{ ...activeSlot, id: "slot-9" }] }),
    });
    const gateway = createLiveCartContextGateway({
      readSession: read,
      writeSession: createFakeSession(WRITE_TOOLS, {}),
      now: () => NOW,
    });

    expect((await gateway.loadCartContext()).status).toBe("needs_slot");
  });

  it("returns needs_slot when the cart has no slot at all", async () => {
    const read = createFakeSession(READ_TOOLS, {
      silpo_get_my_shopping_cart: () => ({ exists: true, cartId: "cart-1" }),
      silpo_get_shopping_cart_by_id: () => ({ ...cartWithSlot, timeslot: null }),
      silpo_get_time_slots: () => ({ slots: [activeSlot] }),
    });
    const gateway = createLiveCartContextGateway({
      readSession: read,
      writeSession: createFakeSession(WRITE_TOOLS, {}),
      now: () => NOW,
    });

    expect((await gateway.loadCartContext()).status).toBe("needs_slot");
  });
});

describe("loadCartContext with no cart", () => {
  const bootstrapHandlers = {
    silpo_get_my_shopping_cart: () => ({ exists: false, cartId: null }),
    silpo_get_my_delivery_addresses: () => ({
      addresses: [
        { id: "addr-2", isDefault: false, city: "Львів", street: "Стрийська", house: "5" },
        { id: "addr-1", isDefault: true, city: "Київ", street: "Хрещатик", house: "1" },
      ],
    }),
    silpo_find_address: () => ({
      latitude: 50.45,
      longitude: 30.52,
      city: "Київ",
      street: "Хрещатик",
      houseNumber: "1",
      district: "Шевченківський",
    }),
    silpo_get_available_delivery_types: () => ({
      deliveryTypes: [{ deliveryType: "DeliveryHome", branchId: "branch-7" }],
    }),
    silpo_get_time_slots: () => ({ slots: [activeSlot] }),
    silpo_get_shopping_cart_by_id: () => cartWithSlot,
  };

  it("runs the documented bootstrap and creates the cart via the write session", async () => {
    const read = createFakeSession(READ_TOOLS, bootstrapHandlers);
    const write = createFakeSession(WRITE_TOOLS, {
      silpo_create_shopping_cart: () => ({ cartId: "cart-1" }),
    });
    const gateway = createLiveCartContextGateway({ readSession: read, writeSession: write, now: () => NOW });

    const result = await gateway.loadCartContext();

    expect(result.status).toBe("ready");
    expect(read.calls).toEqual([
      "silpo_get_my_shopping_cart",
      "silpo_get_my_delivery_addresses",
      "silpo_find_address",
      "silpo_get_available_delivery_types",
      "silpo_get_time_slots",
      "silpo_get_shopping_cart_by_id",
      "silpo_get_time_slots",
    ]);
    expect(write.calls).toEqual(["silpo_create_shopping_cart"]);
  });

  it("uses the guest's default saved address", async () => {
    const findAddress = vi.fn(() => bootstrapHandlers.silpo_find_address());
    const read = createFakeSession(READ_TOOLS, { ...bootstrapHandlers, silpo_find_address: findAddress });
    const write = createFakeSession(WRITE_TOOLS, {
      silpo_create_shopping_cart: () => ({ cartId: "cart-1" }),
    });
    const gateway = createLiveCartContextGateway({ readSession: read, writeSession: write, now: () => NOW });

    await gateway.loadCartContext();

    const [args] = findAddress.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(String(args.text)).toContain("Хрещатик");
    expect(String(args.text)).not.toContain("Стрийська");
  });

  it("calls list_branches only when the delivery type has no branch", async () => {
    const read = createFakeSession(READ_TOOLS, {
      ...bootstrapHandlers,
      silpo_get_available_delivery_types: () => ({
        deliveryTypes: [{ deliveryType: "SelfPickup", branchId: null }],
      }),
      silpo_list_branches: () => ({ branches: [{ id: "branch-3", name: "Сільпо", hasPickup: true }] }),
    });
    const write = createFakeSession(WRITE_TOOLS, {
      silpo_create_shopping_cart: () => ({ cartId: "cart-1" }),
    });
    const gateway = createLiveCartContextGateway({ readSession: read, writeSession: write, now: () => NOW });

    await gateway.loadCartContext();

    expect(read.calls).toContain("silpo_list_branches");
  });

  it("fails with NoSavedAddressError instead of inventing an address", async () => {
    const read = createFakeSession(READ_TOOLS, {
      ...bootstrapHandlers,
      silpo_get_my_delivery_addresses: () => ({ addresses: [] }),
    });
    const write = createFakeSession(WRITE_TOOLS, {});
    const gateway = createLiveCartContextGateway({ readSession: read, writeSession: write, now: () => NOW });

    await expect(gateway.loadCartContext()).rejects.toBeInstanceOf(NoSavedAddressError);
    expect(read.calls).not.toContain("silpo_find_address");
    expect(write.calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run tests/contract/silpo-cart-context.test.ts`
Expected: FAIL — cannot resolve `@/features/silpo/live/cart-context`.

- [ ] **Step 3: Implement the gateway**

Create `src/features/silpo/live/cart-context.ts`:

```ts
import {
  CartContextSchema,
  TimeSlotSchema,
  type CartContext,
  type CartContextResult,
  type TimeSlot,
} from "@/features/shared/contracts";

import {
  BranchesSchema,
  CreatedCartSchema,
  DeliveryAddressesSchema,
  DeliveryTypesSchema,
  FoundAddressSchema,
  MyShoppingCartSchema,
  ShoppingCartSchema,
  TimeSlotsSchema,
  type SilpoDeliveryAddress,
  type SilpoShoppingCart,
  type SilpoTimeSlot,
} from "../schemas/cart";
import type { McpSession } from "./session";

/** The guest has no saved delivery address, so no cart can be bootstrapped. */
export class NoSavedAddressError extends Error {
  constructor() {
    super("no_saved_address");
    this.name = "NoSavedAddressError";
  }
}

export interface LiveCartContextDeps {
  readSession: McpSession;
  writeSession: McpSession;
  now?: () => Date;
}

export interface LiveCartContextGateway {
  loadCartContext(): Promise<CartContextResult>;
  getTimeSlots(context: CartContext): Promise<TimeSlot[]>;
}

/**
 * Silpo advertises eight delivery types; the domain contract has two.
 * Only self-pickup is a pickup; every other documented type is a delivery.
 */
export function mapDeliveryType(silpoType: string): "delivery" | "pickup" {
  return silpoType === "SelfPickup" ? "pickup" : "delivery";
}

function toDomainSlot(slot: SilpoTimeSlot): TimeSlot {
  return TimeSlotSchema.parse({
    id: slot.id,
    startsAt: slot.start,
    endsAt: slot.end,
    available: slot.available,
  });
}

/** Builds the single-line address text `silpo_find_address` expects. */
function addressText(address: SilpoDeliveryAddress): string {
  return [address.city, address.street, address.house]
    .filter((part): part is string => Boolean(part))
    .join(", ");
}

export function createLiveCartContextGateway(deps: LiveCartContextDeps): LiveCartContextGateway {
  const { readSession, writeSession } = deps;
  const now = deps.now ?? (() => new Date());

  const listSlots = (branchId: string | null, deliveryType: string) =>
    readSession.callTool(
      "silpo_get_time_slots",
      { branchId, deliveryType },
      TimeSlotsSchema,
    );

  const readCart = (cartId: string) =>
    readSession.callTool("silpo_get_shopping_cart_by_id", { cartId }, ShoppingCartSchema);

  /**
   * Decides whether a cart readback is usable. A slot must exist, still be
   * offered, be marked available, and end in the future. Anything else stops
   * cart-dependent work and asks the caller to choose a slot.
   */
  function classify(cart: SilpoShoppingCart, slots: SilpoTimeSlot[]): CartContextResult {
    const availableSlots = slots.filter((slot) => slot.available).map(toDomainSlot);
    const cartSlotId = cart.timeslot?.id ?? null;
    const matching = cartSlotId === null
      ? undefined
      : slots.find((slot) => slot.id === cartSlotId);

    const usable =
      matching !== undefined &&
      matching.available &&
      Date.parse(matching.end) > now().getTime();

    if (!usable) {
      return { status: "needs_slot", availableSlots };
    }

    return {
      status: "ready",
      context: CartContextSchema.parse({
        cartId: cart.id,
        deliveryType: mapDeliveryType(cart.deliveryType),
        city: cart.address?.city ?? null,
        branchId: cart.branchId,
        slot: toDomainSlot(matching),
      }),
    };
  }

  async function bootstrapCart(): Promise<string> {
    const saved = await readSession.callTool(
      "silpo_get_my_delivery_addresses",
      {},
      DeliveryAddressesSchema,
    );
    const chosen = saved.addresses.find((address) => address.isDefault) ?? saved.addresses[0];
    if (!chosen) {
      throw new NoSavedAddressError();
    }

    const found = await readSession.callTool(
      "silpo_find_address",
      { text: addressText(chosen) },
      FoundAddressSchema,
    );

    const types = await readSession.callTool(
      "silpo_get_available_delivery_types",
      { latitude: found.latitude, longitude: found.longitude },
      DeliveryTypesSchema,
    );
    const preferred = types.deliveryTypes[0];
    if (!preferred) {
      throw new NoSavedAddressError();
    }

    let branchId = preferred.branchId;
    if (branchId === null) {
      const branches = await readSession.callTool(
        "silpo_list_branches",
        preferred.deliveryType === "NovaPoshta"
          ? { hasNovaPoshta: true }
          : { hasPickup: true },
        BranchesSchema,
      );
      branchId = branches.branches[0]?.id ?? null;
    }

    const slots = await listSlots(branchId, preferred.deliveryType);
    const firstAvailable = slots.slots.find((slot) => slot.available);

    const created = await writeSession.callTool(
      "silpo_create_shopping_cart",
      {
        addressType: chosen.addressType ?? "house",
        latitude: found.latitude,
        longitude: found.longitude,
        city: found.city,
        street: found.street,
        house: found.houseNumber,
        district: found.district,
        deliveryType: preferred.deliveryType,
        branchId,
        timeslot: firstAvailable
          ? { start: firstAvailable.start, end: firstAvailable.end }
          : null,
      },
      CreatedCartSchema,
    );

    return created.cartId;
  }

  return {
    async loadCartContext(): Promise<CartContextResult> {
      const mine = await readSession.callTool(
        "silpo_get_my_shopping_cart",
        {},
        MyShoppingCartSchema,
      );

      const cartId = mine.exists && mine.cartId ? mine.cartId : await bootstrapCart();
      const cart = await readCart(cartId);
      const slots = await listSlots(cart.branchId, cart.deliveryType);

      return classify(cart, slots.slots);
    },

    async getTimeSlots(context: CartContext): Promise<TimeSlot[]> {
      const slots = await listSlots(context.branchId, context.deliveryType);
      return slots.slots.map(toDomainSlot);
    },
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run tests/contract/silpo-cart-context.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/features/silpo/live/cart-context.ts tests/contract/silpo-cart-context.test.ts
git commit -m "feat: bootstrap and verify live Silpo cart context"
```

---

### Task 6: Slot selection with verified readback

**Files:**
- Modify: `src/features/silpo/live/cart-context.ts`
- Modify: `tests/contract/silpo-cart-context.test.ts`

**Interfaces:**
- Consumes: everything from Task 5.
- Produces: `updateCartContext(input: UpdateCartContextInput): Promise<CartContext>` on `LiveCartContextGateway`; `SlotUnavailableError`; `SlotVerificationError`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/contract/silpo-cart-context.test.ts`:

```ts
describe("updateCartContext", () => {
  const chosenSlot = {
    id: "slot-2",
    start: "2026-09-08T14:00:00Z",
    end: "2026-09-08T16:00:00Z",
    available: true,
  };

  function buildGateway(overrides: {
    slotsAfterUpdate?: typeof chosenSlot;
    cartAfterUpdate?: Record<string, unknown>;
  } = {}) {
    const updated = overrides.slotsAfterUpdate ?? chosenSlot;
    let readbackCount = 0;
    const updateArgs: Record<string, unknown>[] = [];

    const read = createFakeSession(READ_TOOLS, {
      silpo_get_my_shopping_cart: () => ({ exists: true, cartId: "cart-1" }),
      silpo_get_shopping_cart_by_id: () => {
        readbackCount += 1;
        if (readbackCount === 1) return cartWithSlot;
        return (
          overrides.cartAfterUpdate ?? {
            ...cartWithSlot,
            timeslot: { id: updated.id, start: updated.start, end: updated.end },
          }
        );
      },
      silpo_get_time_slots: () => ({ slots: [activeSlot, chosenSlot] }),
    });

    const write = createFakeSession(WRITE_TOOLS, {
      silpo_update_shopping_cart: (args) => {
        updateArgs.push(args);
        return { cartId: "cart-1" };
      },
    });

    const gateway = createLiveCartContextGateway({
      readSession: read,
      writeSession: write,
      now: () => NOW,
    });
    return { gateway, read, write, updateArgs };
  }

  const input = {
    deliveryType: "delivery" as const,
    addressId: null,
    branchId: "branch-7",
    slotId: "slot-2",
  };

  it("returns the verified context after an immediate readback", async () => {
    const { gateway, read } = buildGateway();

    const context = await gateway.updateCartContext(input);

    expect(context.slot.id).toBe("slot-2");
    // Read, update, then read again to verify.
    expect(read.calls.filter((call) => call === "silpo_get_shopping_cart_by_id")).toHaveLength(2);
  });

  it("copies address and shipments verbatim from the readback", async () => {
    const { gateway, updateArgs } = buildGateway();

    await gateway.updateCartContext(input);

    expect(updateArgs[0].address).toEqual(cartWithSlot.address);
    expect(updateArgs[0].shipments).toEqual(cartWithSlot.shipments);
  });

  it("rejects a slot that is not currently available", async () => {
    const { gateway, write } = buildGateway();

    await expect(
      gateway.updateCartContext({ ...input, slotId: "slot-unknown" }),
    ).rejects.toBeInstanceOf(SlotUnavailableError);
    expect(write.calls).toEqual([]);
  });

  it("fails when the readback slot differs from the requested slot", async () => {
    const { gateway } = buildGateway({
      cartAfterUpdate: {
        ...cartWithSlot,
        timeslot: { id: "slot-1", start: activeSlot.start, end: activeSlot.end },
      },
    });

    await expect(gateway.updateCartContext(input)).rejects.toBeInstanceOf(SlotVerificationError);
  });

  it("never retries the cart write", async () => {
    const { gateway, write } = buildGateway();

    await gateway.updateCartContext(input);

    expect(write.calls).toEqual(["silpo_update_shopping_cart"]);
    expect(write.retryEnabled).toBe(false);
  });
});
```

Update the two imports at the top of the file to include the new errors:

```ts
import {
  createLiveCartContextGateway,
  mapDeliveryType,
  NoSavedAddressError,
  SlotUnavailableError,
  SlotVerificationError,
} from "@/features/silpo/live/cart-context";
```

Also change the write-session fake so `retryEnabled` reflects reality — in `createFakeSession`, replace the hard-coded `retryEnabled: true` with a parameter:

```ts
function createFakeSession(
  tools: string[],
  handlers: Record<string, (args: Record<string, unknown>) => unknown>,
  retryEnabled = true,
): McpSession & { calls: string[] } {
```

and construct write sessions as `createFakeSession(WRITE_TOOLS, { ... }, false)` throughout the file.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run tests/contract/silpo-cart-context.test.ts`
Expected: FAIL — `SlotUnavailableError` is not exported.

- [ ] **Step 3: Add the errors and the method**

In `src/features/silpo/live/cart-context.ts`, add after `NoSavedAddressError`:

```ts
/** The requested slot is not currently offered or not available. */
export class SlotUnavailableError extends Error {
  constructor(readonly slotId: string) {
    super("needs_slot");
    this.name = "SlotUnavailableError";
  }
}

/** The cart readback did not confirm the slot that was just requested. */
export class SlotVerificationError extends Error {
  constructor() {
    super("slot_verification_failed");
    this.name = "SlotVerificationError";
  }
}
```

Add `updateCartContext` to the `LiveCartContextGateway` interface:

```ts
export interface LiveCartContextGateway {
  loadCartContext(): Promise<CartContextResult>;
  updateCartContext(input: UpdateCartContextInput): Promise<CartContext>;
  getTimeSlots(context: CartContext): Promise<TimeSlot[]>;
}
```

Import the input contract:

```ts
import {
  CartContextSchema,
  TimeSlotSchema,
  UpdateCartContextInputSchema,
  type CartContext,
  type CartContextResult,
  type TimeSlot,
  type UpdateCartContextInput,
} from "@/features/shared/contracts";
```

Add the implementation to the returned object, after `loadCartContext`:

```ts
    async updateCartContext(input: UpdateCartContextInput): Promise<CartContext> {
      const parsed = UpdateCartContextInputSchema.parse(input);

      const mine = await readSession.callTool(
        "silpo_get_my_shopping_cart",
        {},
        MyShoppingCartSchema,
      );
      if (!mine.exists || !mine.cartId) {
        throw new SlotUnavailableError(parsed.slotId);
      }

      const cart = await readCart(mine.cartId);
      const slots = await listSlots(parsed.branchId ?? cart.branchId, cart.deliveryType);
      const target = slots.slots.find((slot) => slot.id === parsed.slotId);
      if (!target || !target.available) {
        throw new SlotUnavailableError(parsed.slotId);
      }

      // Address and shipments are copied exactly as the cart reported them.
      // Reshaping them here would silently change the delivery the guest
      // already chose.
      await writeSession.callTool(
        "silpo_update_shopping_cart",
        {
          cartId: cart.id,
          branchId: parsed.branchId ?? cart.branchId,
          address: cart.address,
          shipments: cart.shipments,
          timeslot: { start: target.start, end: target.end },
        },
        CreatedCartSchema,
      );

      // Immediate readback: the write is not trusted until the server agrees.
      const verified = await readCart(cart.id);
      if (verified.timeslot?.id !== parsed.slotId) {
        throw new SlotVerificationError();
      }

      return CartContextSchema.parse({
        cartId: verified.id,
        deliveryType: mapDeliveryType(verified.deliveryType),
        city: verified.address?.city ?? null,
        branchId: verified.branchId,
        slot: toDomainSlot(target),
      });
    },
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run tests/contract/silpo-cart-context.test.ts`
Expected: PASS — 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/features/silpo/live/cart-context.ts tests/contract/silpo-cart-context.test.ts
git commit -m "feat: verify Silpo slot selection with immediate readback"
```

---

### Task 7: History and customer context

**Files:**
- Create: `src/features/silpo/schemas/history.ts`
- Create: `src/features/silpo/live/history.ts`
- Test: `tests/contract/silpo-history.test.ts`

**Interfaces:**
- Consumes: `McpSession` from Task 3; `nonEmptyString`/`isoDateTime`/`money` from Task 4's `common.ts`; `RawPurchaseReceipt`, `CustomerContext`, `CartContext` from `@/features/shared/contracts`.
- Produces: `createLiveHistoryGateway(deps: LiveHistoryDeps): LiveHistoryGateway` with `loadPurchaseHistory(context: CartContext): Promise<RawPurchaseReceipt[]>` and `loadCustomerContext(): Promise<CustomerContext>`; the schemas `OnlineOrdersSchema`, `OfflineOrdersSchema`, `FamilySchema`, `FoodRestrictionsSchema`, `LoyaltyInfoSchema`.

Recall the Global Constraint: **do not** window, filter service rows, or deduplicate here. `normalizePurchases` already owns all three.

- [ ] **Step 1: Write the failing tests**

Create `tests/contract/silpo-history.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { RawPurchaseReceiptSchema, type CartContext } from "@/features/shared/contracts";
import { createLiveHistoryGateway } from "@/features/silpo/live/history";
import { UnadvertisedToolError, type McpSession } from "@/features/silpo/live/session";

const NOW = new Date("2026-09-08T09:00:00Z");

const HISTORY_TOOLS = [
  "silpo_get_my_online_orders",
  "silpo_get_my_offline_orders",
  "silpo_get_my_family",
  "silpo_get_my_food_restrictions",
  "silpo_get_loyalty_info",
];

function createFakeSession(
  tools: string[],
  handlers: Record<string, (args: Record<string, unknown>) => unknown>,
): McpSession & { calls: { tool: string; args: Record<string, unknown> }[] } {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const advertisedTools = new Set(tools);

  return {
    calls,
    advertisedTools,
    retryEnabled: true,
    async callTool<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
      if (!advertisedTools.has(name)) throw new UnadvertisedToolError(name);
      calls.push({ tool: name, args });
      const handler = handlers[name];
      if (!handler) throw new Error(`unexpected tool ${name}`);
      return schema.parse(handler(args));
    },
    async close() {},
  };
}

const context: CartContext = {
  cartId: "cart-1",
  deliveryType: "delivery",
  city: "Київ",
  branchId: "branch-7",
  slot: {
    id: "slot-1",
    startsAt: "2026-09-08T10:00:00Z",
    endsAt: "2026-09-08T12:00:00Z",
    available: true,
  },
};

const onlineOrders = {
  orders: [
    {
      id: "online-1",
      createdAt: "2026-09-01T08:30:00Z",
      city: "Київ",
      total: 240.5,
      items: [
        { id: "oi-1", lagerId: 40123, name: "Молоко 2.5%", quantity: 2, unit: "шт", price: 45.25 },
        { id: "oi-2", lagerId: 40124, name: "Пакет фасувальний", quantity: 1, unit: "шт", price: 2 },
      ],
    },
  ],
};

const offlineOrders = {
  orders: [
    {
      id: "offline-1",
      createdAt: "2026-08-20T17:05:00Z",
      city: "Львів",
      total: 88,
      items: [{ id: "fi-1", lagerId: 50999, name: "Хліб житній", quantity: 1, unit: "шт", price: 32 }],
    },
  ],
};

describe("loadPurchaseHistory", () => {
  const handlers = {
    silpo_get_my_online_orders: () => onlineOrders,
    silpo_get_my_offline_orders: () => offlineOrders,
  };

  it("returns online and offline receipts as valid contract objects", async () => {
    const session = createFakeSession(HISTORY_TOOLS, handlers);
    const gateway = createLiveHistoryGateway({ readSession: session, now: () => NOW });

    const receipts = await gateway.loadPurchaseHistory(context);

    expect(receipts).toHaveLength(2);
    expect(() => RawPurchaseReceiptSchema.array().parse(receipts)).not.toThrow();
    expect(receipts.map((receipt) => receipt.channel).sort()).toEqual(["offline", "online"]);
  });

  it("maps lagerId to externalProductId", async () => {
    const session = createFakeSession(HISTORY_TOOLS, handlers);
    const gateway = createLiveHistoryGateway({ readSession: session, now: () => NOW });

    const receipts = await gateway.loadPurchaseHistory(context);
    const online = receipts.find((receipt) => receipt.channel === "online");

    expect(online?.items.map((item) => item.externalProductId)).toEqual([40123, 40124]);
  });

  it("keeps service rows for normalizePurchases to filter", async () => {
    const session = createFakeSession(HISTORY_TOOLS, handlers);
    const gateway = createLiveHistoryGateway({ readSession: session, now: () => NOW });

    const receipts = await gateway.loadPurchaseHistory(context);
    const online = receipts.find((receipt) => receipt.channel === "online");

    expect(online?.items.map((item) => item.name)).toContain("Пакет фасувальний");
  });

  it("preserves ISO UTC timestamps", async () => {
    const session = createFakeSession(HISTORY_TOOLS, handlers);
    const gateway = createLiveHistoryGateway({ readSession: session, now: () => NOW });

    const receipts = await gateway.loadPurchaseHistory(context);

    for (const receipt of receipts) {
      expect(receipt.purchasedAt).toMatch(/Z$/);
    }
  });

  it("bounds the request to roughly 180 days instead of filtering locally", async () => {
    const session = createFakeSession(HISTORY_TOOLS, handlers);
    const gateway = createLiveHistoryGateway({ readSession: session, now: () => NOW });

    await gateway.loadPurchaseHistory(context);

    const online = session.calls.find((call) => call.tool === "silpo_get_my_online_orders");
    expect(String(online?.args.dateFrom)).toBe("2026-03-12T09:00:00.000Z");
  });

  it("passes the verified branch context to offline orders", async () => {
    const session = createFakeSession(HISTORY_TOOLS, handlers);
    const gateway = createLiveHistoryGateway({ readSession: session, now: () => NOW });

    await gateway.loadPurchaseHistory(context);

    const offline = session.calls.find((call) => call.tool === "silpo_get_my_offline_orders");
    expect(offline?.args.branchId).toBe("branch-7");
  });

  it("drops a receipt whose items cannot be mapped", async () => {
    const session = createFakeSession(HISTORY_TOOLS, {
      silpo_get_my_online_orders: () => ({
        orders: [{ id: "online-2", createdAt: "2026-09-01T08:30:00Z", city: "Київ", total: 0, items: [] }],
      }),
      silpo_get_my_offline_orders: () => ({ orders: [] }),
    });
    const gateway = createLiveHistoryGateway({ readSession: session, now: () => NOW });

    expect(await gateway.loadPurchaseHistory(context)).toEqual([]);
  });
});

describe("loadCustomerContext", () => {
  it("returns only family size, restriction keys and loyalty bonus", async () => {
    const session = createFakeSession(HISTORY_TOOLS, {
      silpo_get_my_family: () => ({
        members: [
          { id: "m-1", name: "Олена", relation: "child", birthDate: "2018-04-02" },
          { id: "m-2", name: "Барсик", relation: "pet" },
        ],
      }),
      silpo_get_my_food_restrictions: () => ({
        restrictions: [{ key: "lactose_free", title: "Без лактози" }],
      }),
      silpo_get_loyalty_info: () => ({
        loyalty: { cardNumber: "1234567890123", barcode: "9998887776665", bonusAvailable: 42.5, isEnabled: true },
      }),
    });
    const gateway = createLiveHistoryGateway({ readSession: session, now: () => NOW });

    const customer = await gateway.loadCustomerContext();

    // Family size counts the guest plus their listed members.
    expect(customer.familySize).toBe(3);
    expect(customer.restrictionKeys).toEqual(["lactose_free"]);
    expect(customer.loyaltyBonusAvailable).toBe(42.5);
    expect(Object.keys(customer).sort()).toEqual([
      "familySize",
      "loyaltyBonusAvailable",
      "restrictionKeys",
    ]);
  });

  it("carries no personal field into the returned value", async () => {
    const session = createFakeSession(HISTORY_TOOLS, {
      silpo_get_my_family: () => ({
        members: [{ id: "m-1", name: "Олена", relation: "child", birthDate: "2018-04-02" }],
      }),
      silpo_get_my_food_restrictions: () => ({ restrictions: [] }),
      silpo_get_loyalty_info: () => ({
        loyalty: { cardNumber: "1234567890123", barcode: "9998887776665", bonusAvailable: 0, isEnabled: true },
      }),
    });
    const gateway = createLiveHistoryGateway({ readSession: session, now: () => NOW });

    const serialized = JSON.stringify(await gateway.loadCustomerContext());

    for (const secret of ["Олена", "2018-04-02", "1234567890123", "9998887776665", "m-1"]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run tests/contract/silpo-history.test.ts`
Expected: FAIL — cannot resolve `@/features/silpo/live/history`.

- [ ] **Step 3: Implement the schemas**

Create `src/features/silpo/schemas/history.ts`:

```ts
import { z } from "zod";

import { isoDateTime, money, nonEmptyString } from "./common";

/**
 * External Silpo history and profile responses. Not `.strict()`, for the same
 * reason as the cart schemas: an added Silpo field must not be an outage.
 *
 * Personal fields present on the wire (names, birth dates, card numbers,
 * barcodes) are deliberately absent from these schemas. What is not parsed
 * cannot be carried forward by accident.
 */

export const OrderItemSchema = z.object({
  id: nonEmptyString,
  lagerId: z.number().int().nonnegative().nullable().default(null),
  productId: nonEmptyString.nullable().default(null),
  name: nonEmptyString,
  quantity: z.number().finite().positive(),
  unit: nonEmptyString.nullable().default(null),
  price: money,
});

export const OrderSchema = z.object({
  id: nonEmptyString,
  createdAt: isoDateTime,
  city: nonEmptyString.nullable().default(null),
  total: money,
  items: z.array(OrderItemSchema).default([]),
});

export const OnlineOrdersSchema = z.object({
  orders: z.array(OrderSchema).default([]),
});

export const OfflineOrdersSchema = z.object({
  orders: z.array(OrderSchema).default([]),
});

export const FamilySchema = z.object({
  // Only the count matters. Names and birth dates are not parsed.
  members: z.array(z.object({ relation: z.string().default("") })).default([]),
});

export const FoodRestrictionsSchema = z.object({
  restrictions: z.array(z.object({ key: nonEmptyString })).default([]),
});

export const LoyaltyInfoSchema = z.object({
  // Card number and barcode are not parsed.
  loyalty: z.object({
    bonusAvailable: money.nullable().default(null),
    isEnabled: z.boolean().default(false),
  }),
});
```

- [ ] **Step 4: Implement the gateway**

Create `src/features/silpo/live/history.ts`:

```ts
import type { z } from "zod";

import {
  CustomerContextSchema,
  RawPurchaseReceiptSchema,
  type CartContext,
  type CustomerContext,
  type PurchaseChannel,
  type RawPurchaseReceipt,
} from "@/features/shared/contracts";

import {
  FamilySchema,
  FoodRestrictionsSchema,
  LoyaltyInfoSchema,
  OfflineOrdersSchema,
  OnlineOrdersSchema,
  OrderSchema,
} from "../schemas/history";
import type { McpSession } from "./session";

/**
 * Bounds the history *request*. The domain window, service-row filtering and
 * deduplication belong to `normalizePurchases`; repeating them here would
 * create a second implementation that can drift from it.
 */
const REQUEST_WINDOW_DAYS = 180;
const REQUEST_WINDOW_MS = REQUEST_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export interface LiveHistoryDeps {
  readSession: McpSession;
  now?: () => Date;
}

export interface LiveHistoryGateway {
  loadPurchaseHistory(context: CartContext): Promise<RawPurchaseReceipt[]>;
  loadCustomerContext(): Promise<CustomerContext>;
}

type SilpoOrder = z.infer<typeof OrderSchema>;

/**
 * Builds a contract receipt field by field. Nothing is spread from the raw
 * payload, so a personal field on the wire has no route into the result.
 *
 * Returns null when the order has no mappable item: the contract requires at
 * least one, and an invalid object is never emitted.
 */
function toReceipt(order: SilpoOrder, channel: PurchaseChannel): RawPurchaseReceipt | null {
  if (order.items.length === 0) {
    return null;
  }

  return RawPurchaseReceiptSchema.parse({
    sourceId: order.id,
    channel,
    purchasedAt: new Date(order.createdAt).toISOString(),
    city: order.city,
    total: order.total,
    items: order.items.map((item) => ({
      sourceId: item.id,
      externalProductId: item.lagerId,
      productId: item.productId,
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      unitPrice: item.price,
    })),
  });
}

export function createLiveHistoryGateway(deps: LiveHistoryDeps): LiveHistoryGateway {
  const { readSession } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    async loadPurchaseHistory(context: CartContext): Promise<RawPurchaseReceipt[]> {
      const dateFrom = new Date(now().getTime() - REQUEST_WINDOW_MS).toISOString();

      const online = await readSession.callTool(
        "silpo_get_my_online_orders",
        { dateFrom },
        OnlineOrdersSchema,
      );
      const offline = await readSession.callTool(
        "silpo_get_my_offline_orders",
        { dateFrom, branchId: context.branchId },
        OfflineOrdersSchema,
      );

      return [
        ...online.orders.map((order) => toReceipt(order, "online")),
        ...offline.orders.map((order) => toReceipt(order, "offline")),
      ].filter((receipt): receipt is RawPurchaseReceipt => receipt !== null);
    },

    async loadCustomerContext(): Promise<CustomerContext> {
      const family = await readSession.callTool("silpo_get_my_family", {}, FamilySchema);
      const restrictions = await readSession.callTool(
        "silpo_get_my_food_restrictions",
        {},
        FoodRestrictionsSchema,
      );
      const loyalty = await readSession.callTool("silpo_get_loyalty_info", {}, LoyaltyInfoSchema);

      return CustomerContextSchema.parse({
        // The guest plus their listed members.
        familySize: family.members.length + 1,
        restrictionKeys: [...new Set(restrictions.restrictions.map((entry) => entry.key))],
        loyaltyBonusAvailable: loyalty.loyalty.bonusAvailable,
      });
    },
  };
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run tests/contract/silpo-history.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 6: Commit**

```bash
git add src/features/silpo/schemas/history.ts src/features/silpo/live/history.ts tests/contract/silpo-history.test.ts
git commit -m "feat: read live Silpo history and customer context"
```

---

### Task 8: Cart context route

**Files:**
- Create: `src/app/api/cart/context/route.ts`
- Test: `src/app/api/cart/context/route.test.ts`

**Interfaces:**
- Consumes: `resolveSilpoSession` from `@/features/silpo/oauth/service`; `createLiveCartContextGateway` from Task 6; `createDemoSilpoGateway`; `getServerEnv`.
- Produces: `POST(request: NextRequest): Promise<Response>`.

Follow `src/app/api/backtest/route.ts` for the established route shape: `dynamic`, `runtime`, `no-store` headers, `AppError` bodies.

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/cart/context/route.test.ts`:

```ts
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveSilpoSession = vi.fn();
const getServerEnv = vi.fn();
const createDemoSilpoGateway = vi.fn();
const createLiveCartContextGateway = vi.fn();
const openReadSession = vi.fn();
const openWriteSession = vi.fn();
const createSilpoOAuthProvider = vi.fn();

vi.mock("@/features/silpo/oauth/service", () => ({ resolveSilpoSession }));
vi.mock("@/lib/env", () => ({ getServerEnv }));
vi.mock("@/features/silpo/demo/demo-gateway", () => ({ createDemoSilpoGateway }));
vi.mock("@/features/silpo/live/cart-context", async () => {
  const actual = await vi.importActual<typeof import("@/features/silpo/live/cart-context")>(
    "@/features/silpo/live/cart-context",
  );
  return { ...actual, createLiveCartContextGateway };
});
vi.mock("@/features/silpo/live/session", () => ({ openReadSession, openWriteSession }));
vi.mock("@/features/silpo/oauth/provider", () => ({ createSilpoOAuthProvider }));

const { POST } = await import("./route");

const validContext = {
  cartId: "cart-1",
  deliveryType: "delivery",
  city: "Київ",
  branchId: "branch-7",
  slot: {
    id: "slot-2",
    startsAt: "2026-09-08T14:00:00Z",
    endsAt: "2026-09-08T16:00:00Z",
    available: true,
  },
};

const body = { deliveryType: "delivery", addressId: null, branchId: "branch-7", slotId: "slot-2" };

function makeRequest(payload: unknown, cookie = "silpo_session=handle-1") {
  return new NextRequest("https://app.silpo-test.ua/api/cart/context", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getServerEnv.mockReturnValue({ DATA_MODE: "live", PUBLIC_BASE_URL: "https://app.silpo-test.ua" });
  resolveSilpoSession.mockResolvedValue({ ok: true, value: { userId: "user-1", expiresAt: new Date() } });
  openReadSession.mockResolvedValue({ close: vi.fn(async () => {}) });
  openWriteSession.mockResolvedValue({ close: vi.fn(async () => {}) });
  createSilpoOAuthProvider.mockResolvedValue({});
});

describe("POST /api/cart/context", () => {
  it("returns the verified context", async () => {
    createLiveCartContextGateway.mockReturnValue({
      updateCartContext: vi.fn(async () => validContext),
    });

    const response = await POST(makeRequest(body));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ mode: "live", context: validContext });
  });

  it("returns 401 without a session", async () => {
    resolveSilpoSession.mockResolvedValue({
      ok: false,
      error: { code: "unauthorized", message: "msg", correlationId: "c", retryAfterMs: null },
    });

    const response = await POST(makeRequest(body, ""));

    expect(response.status).toBe(401);
  });

  it("returns 400 for a malformed body", async () => {
    const response = await POST(makeRequest({ slotId: 42 }));

    expect(response.status).toBe(400);
  });

  it("returns 409 when the slot is unavailable", async () => {
    const { SlotUnavailableError } = await vi.importActual<
      typeof import("@/features/silpo/live/cart-context")
    >("@/features/silpo/live/cart-context");
    createLiveCartContextGateway.mockReturnValue({
      updateCartContext: vi.fn(async () => {
        throw new SlotUnavailableError("slot-2");
      }),
    });

    const response = await POST(makeRequest(body));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "needs_slot" } });
  });

  it("returns 429 with retryAfterMs when rate limited", async () => {
    const { McpCallError } = await vi.importActual<typeof import("@/features/silpo/live/session")>(
      "@/features/silpo/live/session",
    );
    createLiveCartContextGateway.mockReturnValue({
      updateCartContext: vi.fn(async () => {
        throw new McpCallError("silpo_update_shopping_cart", 429, "2");
      }),
    });

    const response = await POST(makeRequest(body));

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "rate_limited" } });
  });

  it("returns 502 when a Silpo response fails validation", async () => {
    const { InvalidExternalDataError } = await vi.importActual<
      typeof import("@/features/silpo/schemas/common")
    >("@/features/silpo/schemas/common");
    createLiveCartContextGateway.mockReturnValue({
      updateCartContext: vi.fn(async () => {
        throw new InvalidExternalDataError("silpo_get_shopping_cart_by_id");
      }),
    });

    const response = await POST(makeRequest(body));

    expect(response.status).toBe(502);
  });

  it("drives the demo gateway in demo mode", async () => {
    getServerEnv.mockReturnValue({ DATA_MODE: "demo", PUBLIC_BASE_URL: "https://app.silpo-test.ua" });
    const updateCartContext = vi.fn(async () => validContext);
    createDemoSilpoGateway.mockReturnValue({ updateCartContext });

    const response = await POST(makeRequest(body));

    expect(response.status).toBe(200);
    expect(updateCartContext).toHaveBeenCalledTimes(1);
    expect(openReadSession).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ mode: "demo" });
  });

  it("never leaks provider text into an error body", async () => {
    createLiveCartContextGateway.mockReturnValue({
      updateCartContext: vi.fn(async () => {
        throw new Error("https://mcp.silpo.ua/mcp failed: Bearer secret-token-value");
      }),
    });

    const response = await POST(makeRequest(body));
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("secret-token-value");
    expect(text).not.toContain("mcp.silpo.ua");
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run src/app/api/cart/context/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Implement the route**

Create `src/app/api/cart/context/route.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { UpdateCartContextInputSchema } from "@/features/shared/contracts";
import { createLiveCartContextGateway, SlotUnavailableError } from "@/features/silpo/live/cart-context";
import { McpCallError, openReadSession, openWriteSession } from "@/features/silpo/live/session";
import { InvalidExternalDataError } from "@/features/silpo/schemas/common";
import { resolveSilpoSession } from "@/features/silpo/oauth/service";
import { getServerEnv } from "@/lib/env";
import type { AppError } from "@/lib/result";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

const MSG_UNAUTHORIZED = "Не вдалося підтвердити вхід. Увійдіть у «Сільпо» ще раз.";
const MSG_MALFORMED = "Некоректний запит. Оновіть сторінку та спробуйте ще раз.";
const MSG_NEEDS_SLOT = "Оберіть доступний слот доставки.";
const MSG_RATE_LIMITED = "Забагато запитів. Спробуйте трохи пізніше.";
const MSG_INVALID_EXTERNAL = "«Сільпо» повернуло некоректну відповідь. Спробуйте ще раз.";
const MSG_UNEXPECTED = "Не вдалося оновити контекст кошика. Спробуйте ще раз.";

function fail(status: number, code: AppError["code"], message: string, correlationId: string, retryAfterMs: number | null = null) {
  const error: AppError = { code, message, correlationId, retryAfterMs };
  return Response.json({ error }, { status, headers });
}

export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = randomUUID();

  try {
    const env = getServerEnv();

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return fail(400, "unexpected", MSG_MALFORMED, correlationId);
    }

    const parsed = UpdateCartContextInputSchema.safeParse(payload);
    if (!parsed.success) {
      return fail(400, "unexpected", MSG_MALFORMED, correlationId);
    }

    // Demo mode drives the same call through the demo gateway so live and
    // demo return the same shape and the demo label is preserved.
    if (env.DATA_MODE === "demo") {
      const { createDemoSilpoGateway } = await import("@/features/silpo/demo/demo-gateway");
      const context = await createDemoSilpoGateway().updateCartContext(parsed.data);
      return Response.json({ mode: "demo", context }, { status: 200, headers });
    }

    const handle = request.cookies.get("silpo_session")?.value ?? null;
    const session = await resolveSilpoSession(handle);
    if (!session.ok) {
      return fail(401, "unauthorized", MSG_UNAUTHORIZED, correlationId);
    }

    const { createSilpoOAuthProvider } = await import("@/features/silpo/oauth/provider");
    const provider = await createSilpoOAuthProvider(session.value.userId, {
      publicBaseUrl: env.PUBLIC_BASE_URL,
    });

    const readSession = await openReadSession({ provider });
    const writeSession = await openWriteSession({ provider });

    try {
      const gateway = createLiveCartContextGateway({ readSession, writeSession });
      const context = await gateway.updateCartContext(parsed.data);
      return Response.json({ mode: "live", context }, { status: 200, headers });
    } finally {
      await readSession.close().catch(() => {});
      await writeSession.close().catch(() => {});
    }
  } catch (error) {
    if (error instanceof SlotUnavailableError) {
      return fail(409, "needs_slot", MSG_NEEDS_SLOT, correlationId);
    }
    if (error instanceof McpCallError && error.status === 429) {
      return fail(429, "rate_limited", MSG_RATE_LIMITED, correlationId, null);
    }
    if (error instanceof InvalidExternalDataError) {
      return fail(502, "invalid_external_data", MSG_INVALID_EXTERNAL, correlationId);
    }
    // Every other failure is reported as a safe message. Provider text, URLs
    // and headers never reach the client.
    return fail(500, "unexpected", MSG_UNEXPECTED, correlationId);
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run src/app/api/cart/context/route.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/cart/context/route.ts src/app/api/cart/context/route.test.ts
git commit -m "feat: expose verified cart context route"
```

---

### Task 9: Documentation, full verification, and the mandated commit

**Files:**
- Modify: `docs/project-architecture.md`
- Modify: `docs/tasks.md`

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: no code. One squashed commit on `main`.

- [ ] **Step 1: Record the session module in the architecture doc**

In `docs/project-architecture.md` §5, in the `SilpoOAuthService` bullet list, add after the `transport.ts` bullet:

```markdown
- `live/session.ts`: read- і write-сесії MCP поверх спільного hardened fetch із `transport.ts`; обов'язковий `tools/list` на старті сесії та відмова від будь-якого нерекламованого tool;
- `live/retry.ts`: чистий bounded-retry (250/500/1000 ms + jitter, максимум три спроби), єдине джерело драбини затримок у репозиторії.
```

- [ ] **Step 2: Correct the retry-policy section**

In `docs/project-architecture.md` §9, replace the bullet that assigns the bearer-only write transport to Task 16:

```markdown
- Операції запису кошика використовують окремий bearer-only транспорт (`openWriteSession`) без авто-відновлення чи refresh/retry: 401 на записі негайно повертає контроль без повторного оновлення токенів чи повторного виклику мутації. Транспорт уводить Task 10 (перший запис кошика — встановлення контексту доставки); Task 16 використовує його без змін.
- Retry для read-only викликів виконується на рівні `callTool`, а не fetch: у HTTP-шарі read і cart write однаково є `POST /mcp` і не розрізняються. Write-сесія не має коду retry взагалі.
```

- [ ] **Step 3: Record the ownership expansion in the backlog**

In `docs/tasks.md`, in the Task 10 **Files:** block, add:

```markdown
- Create: `src/features/silpo/live/session.ts` (controller-approved addition)
- Test: `src/features/silpo/live/session.test.ts` (controller-approved addition)
- Test: `src/features/silpo/live/retry.test.ts` (controller-approved addition)
- Test: `src/features/silpo/schemas/cart.test.ts` (controller-approved addition)
- Test: `src/app/api/cart/context/route.test.ts` (controller-approved addition)
- Modify: `src/features/silpo/oauth/transport.ts` (controller-approved: extract `createHardenedFetch`)
```

Then check off Task 10's six step boxes and add a line under them:

```markdown
Виконано 2026-09-07. Специфікація: [design](./superpowers/specs/2026-09-07-live-history-cart-context-design.md). Read-only live smoke не виконано — немає облікових даних.
```

- [ ] **Step 4: Run every gate**

Run each and record the real output:

```bash
pnpm vitest run tests/contract/silpo-history.test.ts tests/contract/silpo-cart-context.test.ts
```

```bash
pnpm test
```

```bash
pnpm typecheck && pnpm lint && pnpm build
```

Expected: PASS for all. A failure here is a real defect — fix the code, never the assertion.

- [ ] **Step 5: Confirm the OAuth regression explicitly**

Run: `pnpm vitest run src/features/silpo/oauth`
Expected: PASS with the same test count as before Task 2. This is the evidence that extracting the hardened fetch changed no behavior.

- [ ] **Step 6: Squash onto main with the mandated message**

```bash
git checkout main
git merge --squash task-10-live-history-cart-context
git commit -m "feat: read live Silpo purchase context"
```

- [ ] **Step 7: Commit the documentation**

Documentation that changes a rule belongs with the behavior change, so stage the doc edits before the squash commit if they are not already included:

```bash
git status --short
git log --oneline -1
```

Confirm the working tree is clean apart from the user-owned `.gitignore` change, and report the commit hash.

---

## Handoff Report

The implementer's report must include:

- changed files;
- the exact commands run and their real output, including the before/after OAuth test counts from Task 2 and Task 9 Step 5;
- **the outstanding verification gap:** no Silpo credentials exist in this environment, so the read-only live smoke against `https://mcp.silpo.ua/mcp` has not been run. Every schema field name in Tasks 4 and 7 remains provisional until reconciled against a live `tools/list`. Task 10 is not claimed to be proven against the real MCP server;
- the commit hash.
