import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createInMemoryAuthRepository } from "../oauth/auth-repository";
import { createSilpoOAuthProvider } from "../oauth/provider";
import { createInMemoryTokenVaultStorage, createTokenVault } from "../oauth/token-vault";

import { InvalidExternalDataError } from "../schemas/common";
import { McpCallError, openReadSession, openWriteSession, UnadvertisedToolError } from "./session";

// Minimal JSON-RPC responder over the streamable HTTP transport.
// `handlers` maps a tool name to the structuredContent it returns.
function createMcpFetch(options: {
  tools: string[];
  handlers?: Record<string, () => unknown>;
  statusQueue?: number[];
  retryAfter?: string;
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
            headers: { "Retry-After": options.retryAfter ?? "0" },
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

const SAMPLE_SERVER_URL = "https://mcp.silpo.ua/mcp";
const SAMPLE_ISSUER = "https://auth.silpo.ua";

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

describe("destination safety", () => {
  it("refuses an insecure server URL before opening anything", async () => {
    const { fakeFetch, calls } = createMcpFetch({ tools: ["t"] });

    await expect(
      openReadSession({
        ...baseOptions(),
        fetch: fakeFetch,
        serverUrl: "http://mcp.silpo.ua/mcp",
      }),
    ).rejects.toThrow("insecure_protocol");
    expect(calls).toEqual([]);
  });

  it("refuses a loopback server URL before opening anything", async () => {
    const { fakeFetch, calls } = createMcpFetch({ tools: ["t"] });

    await expect(
      openWriteSession({
        ...baseOptions(),
        fetch: fakeFetch,
        serverUrl: "https://127.0.0.1/mcp",
      }),
    ).rejects.toThrow("insecure_destination_ip");
    expect(calls).toEqual([]);
  });
});

describe("server retry metadata", () => {
  it("waits the server-provided Retry-After instead of the local ladder", async () => {
    const slept: number[] = [];
    const { fakeFetch } = createMcpFetch({
      tools: ["silpo_get_my_shopping_cart"],
      statusQueue: [200, 200, 429, 429, 429, 429],
      retryAfter: "2",
    });
    const session = await openReadSession({
      ...baseOptions(),
      fetch: fakeFetch,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    await expect(
      session.callTool("silpo_get_my_shopping_cart", {}, z.object({})),
    ).rejects.toThrow();

    // 2 seconds, exactly as the server asked, not 250/500/1000 + jitter.
    expect(slept).toEqual([2000, 2000, 2000]);

    await session.close();
  });

  it("carries the Retry-After onto the error so the route can report it", async () => {
    const { fakeFetch } = createMcpFetch({
      tools: ["silpo_get_my_shopping_cart"],
      statusQueue: [200, 200, 429, 429, 429, 429],
      retryAfter: "3",
    });
    const session = await openReadSession({
      ...baseOptions(),
      fetch: fakeFetch,
      sleep: async () => {},
    });

    const error = await session
      .callTool("silpo_get_my_shopping_cart", {}, z.object({}))
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(McpCallError);
    expect((error as McpCallError).status).toBe(429);
    expect((error as McpCallError).retryAfterHeader).toBe("3");

    await session.close();
  });

  it("falls back to the local ladder when the server sends no Retry-After", async () => {
    const slept: number[] = [];
    const { fakeFetch } = createMcpFetch({
      tools: ["silpo_get_my_shopping_cart"],
      statusQueue: [200, 200, 429, 429, 429, 429],
      retryAfter: "",
    });
    const session = await openReadSession({
      ...baseOptions(),
      fetch: fakeFetch,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    await expect(
      session.callTool("silpo_get_my_shopping_cart", {}, z.object({})),
    ).rejects.toThrow();

    expect(slept).toHaveLength(3);
    expect(slept[0]).toBeGreaterThanOrEqual(250);
    expect(slept[0]).toBeLessThanOrEqual(500);
    expect(slept[1]).toBeGreaterThanOrEqual(500);
    expect(slept[2]).toBeGreaterThanOrEqual(1000);

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

  it("delegates a read 401 to exactly one refresh, and a write 401 to none", async () => {
    // Uses the real provider over in-memory storage rather than a stub: the
    // SDK's auth() path reads clientMetadata, clientInformation and tokens,
    // and a stub that omits any of them makes this test pass vacuously.
    async function buildProvider() {
      const encryptionKey = randomBytes(32);
      const repository = createInMemoryAuthRepository({ encryptionKey });
      const now = new Date("2026-09-07T10:00:00Z");
      const vault = createTokenVault({
        storage: createInMemoryTokenVaultStorage(),
        encryptionKey,
        now: () => now,
      });

      const authSession = await repository.createPendingSession({
        handleHash: randomBytes(32).toString("hex"),
        now,
        expiresAt: new Date(now.getTime() + 600_000),
      });
      await repository.beginFlow({
        userId: authSession.userId,
        bindingHash: authSession.handleHash,
        flowId: "flow-1",
        state: "state-1",
        now,
        expiresAt: new Date(now.getTime() + 600_000),
      });

      const provider = await createSilpoOAuthProvider(authSession.userId, {
        vault,
        repository,
        publicBaseUrl: "https://app.silpo-test.ua",
        now: () => now,
      });

      await provider.saveClientInformation({
        client_id: "test-client-id",
        client_secret: "test-client-secret",
        issuer: SAMPLE_ISSUER,
      });
      await provider.saveTokens({
        access_token: "expired-access-token",
        refresh_token: "test-refresh-token",
        token_type: "Bearer",
      });

      return provider;
    }

    // Serves enough OAuth discovery for a refresh grant to actually be
    // attempted, so the read assertion can tell one refresh from none.
    function createUnauthorizedFetch() {
      const grants: string[] = [];
      const { fakeFetch } = createMcpFetch({
        tools: ["silpo_get_my_shopping_cart", "silpo_update_shopping_cart"],
      });

      const wrapped: typeof fetch = async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        const json = (payload: unknown, status = 200) =>
          new Response(JSON.stringify(payload), {
            status,
            headers: { "Content-Type": "application/json" },
          });

        if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
          return json({ resource: SAMPLE_SERVER_URL, authorization_servers: [SAMPLE_ISSUER] });
        }
        if (
          url.pathname.startsWith("/.well-known/oauth-authorization-server") ||
          url.pathname.startsWith("/.well-known/openid-configuration")
        ) {
          return json({
            issuer: SAMPLE_ISSUER,
            authorization_endpoint: `${SAMPLE_ISSUER}/authorize`,
            token_endpoint: `${SAMPLE_ISSUER}/token`,
            registration_endpoint: `${SAMPLE_ISSUER}/register`,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: ["client_secret_post"],
          });
        }
        if (url.pathname.endsWith("/token")) {
          const raw =
            typeof init?.body === "string" ? init.body : await request.clone().text();
          grants.push(new URLSearchParams(raw).get("grant_type") ?? "unknown");
          // Rejected, so the flow ends in reauthorization instead of looping.
          return json({ error: "invalid_grant" }, 400);
        }

        const body = await request.clone().text();
        const rpc = body ? JSON.parse(body) : {};
        if (rpc.method === "tools/call") {
          return new Response("", { status: 401 });
        }
        return fakeFetch(input, init);
      };

      return {
        wrapped,
        refreshAttempts: () => grants.filter((grant) => grant === "refresh_token").length,
      };
    }

    const read = createUnauthorizedFetch();
    const readSession = await openReadSession({
      provider: await buildProvider(),
      lookupIp: async () => ["203.0.113.10"],
      fetch: read.wrapped,
      sleep: async () => {},
    });
    // Once the single refresh fails, the failure must be reported as an
    // authorization problem so the caller can send the guest to reauthorize,
    // not as an unexplained server error.
    const thrown = await readSession
      .callTool("silpo_get_my_shopping_cart", {}, z.object({}))
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(thrown).toBeInstanceOf(McpCallError);
    expect((thrown as McpCallError).status).toBe(401);
    // Exactly one: proves the delegation happens and that it stays bounded.
    expect(read.refreshAttempts()).toBe(1);
    await readSession.close();

    const write = createUnauthorizedFetch();
    const writeSession = await openWriteSession({
      provider: await buildProvider(),
      lookupIp: async () => ["203.0.113.10"],
      fetch: write.wrapped,
    });
    await expect(
      writeSession.callTool("silpo_update_shopping_cart", {}, z.object({})),
    ).rejects.toThrow();
    expect(write.refreshAttempts()).toBe(0);
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

