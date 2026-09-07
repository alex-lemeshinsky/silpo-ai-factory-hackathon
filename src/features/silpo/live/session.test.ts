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

    if (method !== "notifications/initialized") {
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
    clientInformation: () => undefined,
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

  it("cleans up timeout and abortController when connect or listTools throws", async () => {
    const { fakeFetch } = createMcpFetch({
      tools: [],
      statusQueue: [500],
    });
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    await expect(
      openReadSession({ ...baseOptions(), fetch: fakeFetch }),
    ).rejects.toThrow();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});

