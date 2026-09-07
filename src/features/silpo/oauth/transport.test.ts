import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";

import { createInMemoryAuthRepository } from "./auth-repository";
import { createInMemoryTokenVaultStorage, createTokenVault } from "./token-vault";
import { createSilpoOAuthProvider } from "./provider";
import {
  createSilpoOAuthConnection,
  type OAuthConnection,
  type OAuthConnectionFactory,
  ReauthorizationRequired,
  sanitizeAuthorizationHeader,
  SILPO_MCP_SERVER_URL,
} from "./transport";

const SAMPLE_BASE_URL = "https://app.silpo-test.ua";
const SAMPLE_ISSUER = "https://auth.silpo.ua";
const SAMPLE_SERVER_URL = "https://mcp.silpo.ua/mcp";

interface MockNetworkOptions {
  onTokenRequest?: (grantType: string, body: URLSearchParams) => Response | Promise<Response>;
  onMcpRequest?: (req: Request, attempt: number) => Response | undefined | Promise<Response | undefined>;
  lookupIp?: (hostname: string) => Promise<string[]>;
}

function createSyntheticFetch(options: MockNetworkOptions = {}) {
  let mcpAttempt = 0;
  const requests: { url: string; method: string; grantType?: string; headers: Headers }[] = [];

  const fakeFetch: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    const method = req.method.toUpperCase();

    // RFC 9728 OAuth Protected Resource Metadata
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      requests.push({ url: req.url, method, headers: req.headers });
      return new Response(
        JSON.stringify({
          resource: SAMPLE_SERVER_URL,
          authorization_servers: [SAMPLE_ISSUER],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // RFC 8414 Authorization Server Metadata
    if (
      url.pathname.startsWith("/.well-known/oauth-authorization-server") ||
      url.pathname.startsWith("/.well-known/openid-configuration")
    ) {
      requests.push({ url: req.url, method, headers: req.headers });
      return new Response(
        JSON.stringify({
          issuer: SAMPLE_ISSUER,
          authorization_endpoint: `${SAMPLE_ISSUER}/authorize`,
          token_endpoint: `${SAMPLE_ISSUER}/token`,
          registration_endpoint: `${SAMPLE_ISSUER}/register`,
          response_types_supported: ["code"],
          scopes_supported: ["cart:read", "cart:write"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          authorization_response_iss_parameter_supported: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Dynamic Client Registration
    if (url.pathname === "/register" && method === "POST") {
      requests.push({ url: req.url, method, headers: req.headers });
      return new Response(
        JSON.stringify({
          client_id: "synthetic-client-id",
          client_secret: "synthetic-client-secret",
          client_id_issued_at: Math.floor(Date.now() / 1000),
          redirect_uris: [`${SAMPLE_BASE_URL}/api/auth/silpo/callback`],
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }

    // Token Endpoint
    if (url.pathname === "/token" && method === "POST") {
      const cloned = req.clone();
      const bodyText = await cloned.text();
      const params = new URLSearchParams(bodyText);
      const grantType = params.get("grant_type") ?? "unknown";

      requests.push({ url: req.url, method, grantType, headers: req.headers });

      if (options.onTokenRequest) {
        return options.onTokenRequest(grantType, params);
      }

      return new Response(
        JSON.stringify({
          access_token: `token-${grantType}-${randomBytes(8).toString("hex")}`,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: `refresh-${randomBytes(8).toString("hex")}`,
          scope: "cart:read",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // MCP Endpoint
    if (url.pathname === "/mcp") {
      mcpAttempt += 1;
      requests.push({ url: req.url, method, headers: req.headers });

      if (options.onMcpRequest) {
        const customRes = await options.onMcpRequest(req, mcpAttempt);
        if (customRes) return customRes;
      }

      // Default JSON-RPC response for initialize / listTools
      const cloned = req.clone();
      let bodyJson: Record<string, unknown> = {};
      try {
        bodyJson = (await cloned.json()) as Record<string, unknown>;
      } catch {
        // GET for SSE stream
      }

      if (bodyJson.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: bodyJson.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "silpo-synthetic-server", version: "1.0.0" },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (bodyJson.method === "tools/list") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: bodyJson.id,
            result: {
              tools: [
                {
                  name: "silpo_get_cart",
                  description: "Reads current cart",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: bodyJson.id ?? 1, result: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`Unrecognized synthetic network request: ${method} ${req.url}`);
  };

  const safeLookupIp = options.lookupIp ?? (async () => ["93.184.216.34"]); // Synthetic public IP

  return { fakeFetch, requests, safeLookupIp };
}

async function createTestHarness(options?: { now?: Date }) {
  const encryptionKey = randomBytes(32);
  const repo = createInMemoryAuthRepository({ encryptionKey });
  const vaultStorage = createInMemoryTokenVaultStorage();
  const now = options?.now ?? new Date("2026-09-06T10:00:00Z");
  const vault = createTokenVault({
    storage: vaultStorage,
    encryptionKey,
    now: () => now,
  });

  const session = await repo.createPendingSession({
    handleHash: randomBytes(32).toString("hex"),
    now,
    expiresAt: new Date(now.getTime() + 600000),
  });

  await repo.beginFlow({
    userId: session.userId,
    bindingHash: session.handleHash,
    flowId: "flow-1",
    state: "state-1",
    now,
    expiresAt: session.expiresAt,
  });

  const provider = await createSilpoOAuthProvider(session.userId, {
    vault,
    repository: repo,
    publicBaseUrl: SAMPLE_BASE_URL,
    now: () => now,
  });

  return { repo, vault, session, provider, now };
}

describe("Silpo OAuth Transport", () => {
  it("conforms to OAuthConnection and OAuthConnectionFactory types", () => {
    expectTypeOf<OAuthConnection>().toMatchTypeOf<{
      begin(): Promise<"authorized" | "redirect">;
      finishAuth(code: string, issuer?: string): Promise<void>;
      probeTools(): Promise<void>;
      close(): Promise<void>;
    }>();
    expectTypeOf<OAuthConnectionFactory>().toBeFunction();
  });

  it("uses the endpoint documented in SILPO_MCP.md as its default server URL", async () => {
    const doc = readFileSync(join(process.cwd(), "SILPO_MCP.md"), "utf8");
    const documented = doc.match(/\|\s*Endpoint\s*\|\s*`([^`]+)`\s*\|/)?.[1];
    expect(documented).toBe(SILPO_MCP_SERVER_URL);

    const { provider } = await createTestHarness();
    const { fakeFetch, requests, safeLookupIp } = createSyntheticFetch();

    // No serverUrl override: the connection must target the documented endpoint.
    const connection = createSilpoOAuthConnection(provider, {
      fetch: fakeFetch,
      lookupIp: safeLookupIp,
    });

    try {
      await connection.begin();
    } finally {
      await connection.close();
    }

    expect(requests.length).toBeGreaterThan(0);
    expect(new URL(requests[0].url).origin).toBe(new URL(SILPO_MCP_SERVER_URL).origin);
  });

  it("exports ReauthorizationRequired error", () => {
    const err = new ReauthorizationRequired();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ReauthorizationRequired");
  });

  it("decisive refresh test: seeds expired token + refresh token, returns valid refresh then 401 from probe -> unauthorized and exactly 1 refresh", async () => {
    const { provider, vault, session, now } = await createTestHarness();

    // Seed expired token with valid refresh token in vault
    await vault.put(session.userId, {
      accessToken: "expired-access-token",
      refreshToken: "valid-refresh-token",
      clientSecret: "client-secret",
      expiresAt: new Date(now.getTime() - 60000), // expired 1 min ago
      scope: "cart:read",
      oauthMetadata: null,
    });

    const { fakeFetch, requests, safeLookupIp } = createSyntheticFetch({
      onMcpRequest: () => {
        // Return 401 for all MCP requests to simulate revoked/invalidated token
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": 'Bearer error="invalid_token", resource_metadata="https://mcp.silpo.ua/.well-known/oauth-protected-resource"',
          },
        });
      },
    });

    const connection = createSilpoOAuthConnection(provider, {
      serverUrl: SAMPLE_SERVER_URL,
      fetch: fakeFetch,
      lookupIp: safeLookupIp,
    });

    let caughtError: unknown;
    try {
      await connection.probeTools();
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeDefined();
    expect((caughtError as Error).message).toBe("unauthorized");

    // Exactly one refresh_token request was made on the wire
    const refreshRequests = requests.filter((r) => r.grantType === "refresh_token");
    expect(refreshRequests.length).toBe(1);

    await connection.close();
  });

  it("initial 401 -> refresh -> successful read completes probeTools", async () => {
    const { provider, vault, session, now } = await createTestHarness();

    await vault.put(session.userId, {
      accessToken: "initially-invalid-access-token",
      refreshToken: "valid-refresh-token",
      clientSecret: "client-secret",
      expiresAt: new Date(now.getTime() + 3600000),
      scope: "cart:read",
      oauthMetadata: null,
    });

    const { fakeFetch, requests, safeLookupIp } = createSyntheticFetch({
      onMcpRequest: (req) => {
        const authHeader = req.headers.get("Authorization");

        // First attempt with old token fails with 401
        if (authHeader === "Bearer initially-invalid-access-token") {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: {
              "Content-Type": "application/json",
              "WWW-Authenticate": 'Bearer error="invalid_token", resource_metadata="https://mcp.silpo.ua/.well-known/oauth-protected-resource"',
            },
          });
        }

        // With refreshed token, fall through to default initialize / listTools handlers
        return undefined;
      },
    });

    const connection = createSilpoOAuthConnection(provider, {
      serverUrl: SAMPLE_SERVER_URL,
      fetch: fakeFetch,
      lookupIp: safeLookupIp,
    });

    await connection.probeTools();

    const refreshRequests = requests.filter((r) => r.grantType === "refresh_token");
    expect(refreshRequests.length).toBe(1);

    await connection.close();
  });

  it("missing refresh token causes immediate unauthorized without network token request", async () => {
    const { provider, vault, session, now } = await createTestHarness();

    await vault.put(session.userId, {
      accessToken: "expired-access-token",
      refreshToken: null, // NO refresh token
      clientSecret: "client-secret",
      expiresAt: new Date(now.getTime() - 60000),
      scope: "cart:read",
      oauthMetadata: null,
    });

    const { fakeFetch, requests, safeLookupIp } = createSyntheticFetch({
      onMcpRequest: () => {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": 'Bearer error="invalid_token"',
          },
        });
      },
    });

    const connection = createSilpoOAuthConnection(provider, {
      serverUrl: SAMPLE_SERVER_URL,
      fetch: fakeFetch,
      lookupIp: safeLookupIp,
    });

    await expect(connection.probeTools()).rejects.toThrow("unauthorized");

    const tokenRequests = requests.filter((r) => r.grantType !== undefined);
    expect(tokenRequests.length).toBe(0);

    await connection.close();
  });

  it("handles invalid_grant from token endpoint by failing with unauthorized without second try", async () => {
    const { provider, vault, session, now } = await createTestHarness();

    await vault.put(session.userId, {
      accessToken: "expired-access-token",
      refreshToken: "revoked-refresh-token",
      clientSecret: "client-secret",
      expiresAt: new Date(now.getTime() - 60000),
      scope: "cart:read",
      oauthMetadata: null,
    });

    const { fakeFetch, requests, safeLookupIp } = createSyntheticFetch({
      onMcpRequest: () => {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": 'Bearer error="invalid_token"',
          },
        });
      },
      onTokenRequest: () => {
        return new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "Refresh token revoked" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    const connection = createSilpoOAuthConnection(provider, {
      serverUrl: SAMPLE_SERVER_URL,
      fetch: fakeFetch,
      lookupIp: safeLookupIp,
    });

    await expect(connection.probeTools()).rejects.toThrow("unauthorized");

    const refreshRequests = requests.filter((r) => r.grantType === "refresh_token");
    expect(refreshRequests.length).toBe(1);

    expect(await vault.get(session.userId)).toBeNull();

    await connection.close();
  });

  it("handles malformed refresh response by failing without retry", async () => {
    const { provider, vault, session, now } = await createTestHarness();

    await vault.put(session.userId, {
      accessToken: "expired-access-token",
      refreshToken: "valid-refresh-token",
      clientSecret: "client-secret",
      expiresAt: new Date(now.getTime() - 60000),
      scope: "cart:read",
      oauthMetadata: null,
    });

    const { fakeFetch, requests, safeLookupIp } = createSyntheticFetch({
      onMcpRequest: () => {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": 'Bearer error="invalid_token"',
          },
        });
      },
      onTokenRequest: () => {
        return new Response(JSON.stringify({ not_a_valid_token_payload: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const connection = createSilpoOAuthConnection(provider, {
      serverUrl: SAMPLE_SERVER_URL,
      fetch: fakeFetch,
      lookupIp: safeLookupIp,
    });

    await expect(connection.probeTools()).rejects.toThrow();

    const refreshRequests = requests.filter((r) => r.grantType === "refresh_token");
    expect(refreshRequests.length).toBe(1);

    await connection.close();
  });

  it("finishAuth exchanges code once and enforces code exchange budget", async () => {
    const { provider, vault, session } = await createTestHarness();

    const { fakeFetch, requests, safeLookupIp } = createSyntheticFetch();

    const connection = createSilpoOAuthConnection(provider, {
      serverUrl: SAMPLE_SERVER_URL,
      fetch: fakeFetch,
      lookupIp: safeLookupIp,
    });

    const beginResult = await connection.begin();
    expect(beginResult).toBe("redirect");

    await connection.finishAuth("auth-code-123", SAMPLE_ISSUER);

    const codeRequests = requests.filter((r) => r.grantType === "authorization_code");
    expect(codeRequests.length).toBe(1);

    // Tokens were saved in vault
    const stored = await vault.get(session.userId);
    expect(stored).not.toBeNull();
    expect(stored?.accessToken).toMatch(/^token-authorization_code-/);

    // Attempting a second code exchange on the same connection budget throws ReauthorizationRequired / unauthorized
    await expect(
      connection.finishAuth("auth-code-again", SAMPLE_ISSUER),
    ).rejects.toThrow();

    await connection.close();
  });

  it("destination validation rejects private/loopback IP destinations and insecure protocols", async () => {
    const { provider } = await createTestHarness();

    // Insecure http protocol
    expect(() =>
      createSilpoOAuthConnection(provider, {
        serverUrl: "http://mcp.silpo.ua/mcp",
      }),
    ).toThrow();

    // Loopback IP
    expect(() =>
      createSilpoOAuthConnection(provider, {
        serverUrl: "https://127.0.0.1/mcp",
      }),
    ).toThrow();

    // Private IPv4 IP
    expect(() =>
      createSilpoOAuthConnection(provider, {
        serverUrl: "https://192.168.1.50/mcp",
      }),
    ).toThrow();

    // Link-local cloud metadata IP
    expect(() =>
      createSilpoOAuthConnection(provider, {
        serverUrl: "https://169.254.169.254/mcp",
      }),
    ).toThrow();

    // Hostname resolving to private IP via DNS
    const connection = createSilpoOAuthConnection(provider, {
      serverUrl: "https://evil.internal.silpo.ua/mcp",
      lookupIp: async () => ["10.0.0.1"],
      fetch: async () => new Response("ok"),
    });

    await expect(connection.begin()).rejects.toThrow();
  });

  it("redirect escape is blocked when server redirects to internal address", async () => {
    const { provider } = await createTestHarness();

    const redirectingFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url === SAMPLE_SERVER_URL) {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://169.254.169.254/metadata" },
        });
      }
      return new Response("ok");
    };

    const connection = createSilpoOAuthConnection(provider, {
      serverUrl: SAMPLE_SERVER_URL,
      fetch: redirectingFetch,
      lookupIp: async (host) => (host.includes("silpo.ua") ? ["93.184.216.34"] : ["169.254.169.254"]),
    });

    await expect(connection.begin()).rejects.toThrow();
  });

  it("O9-07 strips credentials when a redirect changes origin", async () => {
    const { provider, vault, session, now } = await createTestHarness();

    await vault.put(session.userId, {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      clientSecret: "client-secret",
      expiresAt: new Date(now.getTime() + 3600000),
      scope: "cart:read",
      oauthMetadata: null,
    });

    const foreign: { auth: string | null; cookie: string | null; method: string }[] = [];
    const { fakeFetch, safeLookupIp } = createSyntheticFetch({
      onMcpRequest: (_req, attempt) =>
        attempt === 1
          ? new Response(null, {
              status: 302,
              headers: { Location: "https://relay.example/mcp" },
            })
          : undefined,
    });

    const wrappedFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.origin === "https://relay.example") {
        const headers = new Headers(init?.headers);
        foreign.push({
          auth: headers.get("Authorization"),
          cookie: headers.get("Cookie"),
          method: (init?.method ?? "GET").toUpperCase(),
        });
        return new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return fakeFetch(input, init);
    };

    const connection = createSilpoOAuthConnection(provider, {
      serverUrl: SAMPLE_SERVER_URL,
      fetch: wrappedFetch,
      lookupIp: safeLookupIp,
    });

    await connection.probeTools().catch(() => {});
    await connection.close();

    expect(foreign.length).toBeGreaterThan(0);
    for (const request of foreign) {
      expect(request.auth).toBeNull();
      expect(request.cookie).toBeNull();
      // A POST downgraded to GET carries no body to the new origin either.
      expect(request.method).toBe("GET");
    }
  });

  it("O9-07 refuses to replay a request body to a different origin", async () => {
    const { provider } = await createTestHarness();

    const foreign: string[] = [];
    const { fakeFetch, safeLookupIp } = createSyntheticFetch();

    const wrappedFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.origin === "https://relay.example") {
        foreign.push(url.toString());
        return new Response(
          JSON.stringify({ client_id: "relayed-client", client_secret: "relayed-secret" }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname === "/register") {
        return new Response(null, {
          status: 307,
          headers: { Location: "https://relay.example/register" },
        });
      }
      return fakeFetch(input, init);
    };

    const connection = createSilpoOAuthConnection(provider, {
      serverUrl: SAMPLE_SERVER_URL,
      fetch: wrappedFetch,
      lookupIp: safeLookupIp,
    });

    await expect(connection.begin()).rejects.toThrow(/invalid_external_cross_origin_redirect/);
    await connection.close();

    // The client registration body never reached the redirect target, and no
    // client credential was accepted from it.
    expect(foreign).toEqual([]);
    expect(provider.clientInformation({ issuer: SAMPLE_ISSUER })).toBeUndefined();
  });

  it("O9-06 refuses a Retry-After wait that does not fit the operation deadline", async () => {
    const { provider, vault, session, now } = await createTestHarness();

    await vault.put(session.userId, {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      clientSecret: "client-secret",
      expiresAt: new Date(now.getTime() + 3600000),
      scope: "cart:read",
      oauthMetadata: null,
    });

    let toolListAttempts = 0;
    const { fakeFetch, safeLookupIp } = createSyntheticFetch({
      onMcpRequest: async (req) => {
        const cloned = req.clone();
        let bodyJson: Record<string, unknown> = {};
        try {
          bodyJson = (await cloned.json()) as Record<string, unknown>;
        } catch {
          // GET stream
        }
        if (bodyJson.method === "tools/list") {
          toolListAttempts += 1;
          return new Response(JSON.stringify({ error: "rate_limited" }), {
            status: 429,
            headers: { "Retry-After": "3600" },
          });
        }
        return undefined;
      },
    });

    const connection = createSilpoOAuthConnection(provider, {
      serverUrl: SAMPLE_SERVER_URL,
      fetch: fakeFetch,
      lookupIp: safeLookupIp,
      operationTimeoutMs: 500,
    });

    const startedAt = Date.now();
    await expect(connection.probeTools()).rejects.toThrow();
    await connection.close();

    expect(toolListAttempts).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it("retries read-only 429 responses up to three times with retry metadata", async () => {
    const { provider, vault, session, now } = await createTestHarness();

    await vault.put(session.userId, {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      clientSecret: "client-secret",
      expiresAt: new Date(now.getTime() + 3600000),
      scope: "cart:read",
      oauthMetadata: null,
    });

    let attempts = 0;
    const { fakeFetch, safeLookupIp } = createSyntheticFetch({
      onMcpRequest: async (req) => {
        const cloned = req.clone();
        let bodyJson: Record<string, unknown> = {};
        try {
          bodyJson = (await cloned.json()) as Record<string, unknown>;
        } catch {}

        if (bodyJson.method === "tools/list") {
          attempts += 1;
          if (attempts < 3) {
            return new Response(JSON.stringify({ error: "rate_limited" }), {
              status: 429,
              headers: { "Retry-After": "0" },
            });
          }
        }
        return undefined;
      },
    });

    const connection = createSilpoOAuthConnection(provider, {
      serverUrl: SAMPLE_SERVER_URL,
      fetch: fakeFetch,
      lookupIp: safeLookupIp,
    });

    await connection.probeTools();
    expect(attempts).toBe(3);

    await connection.close();
  });

  it("token endpoint receiving 429 does not retry", async () => {
    const { provider, vault, session, now } = await createTestHarness();

    await vault.put(session.userId, {
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      clientSecret: "client-secret",
      expiresAt: new Date(now.getTime() - 60000),
      scope: "cart:read",
      oauthMetadata: null,
    });

    let tokenAttempts = 0;
    const { fakeFetch, safeLookupIp } = createSyntheticFetch({
      onMcpRequest: () => {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": 'Bearer error="invalid_token"',
          },
        });
      },
      onTokenRequest: () => {
        tokenAttempts += 1;
        return new Response(JSON.stringify({ error: "rate_limited" }), {
          status: 429,
          headers: { "Retry-After": "10" },
        });
      },
    });

    const connection = createSilpoOAuthConnection(provider, {
      serverUrl: SAMPLE_SERVER_URL,
      fetch: fakeFetch,
      lookupIp: safeLookupIp,
    });

    await expect(connection.probeTools()).rejects.toThrow();
    expect(tokenAttempts).toBe(1); // No retry loop on token endpoint

    await connection.close();
  });

  describe("header stripping on discovery/registration vs token requests (Spec O9-07)", () => {
    it("strips Bearer Authorization on discovery endpoints", () => {
      const headers = new Headers({ Authorization: "Bearer some-token", Accept: "application/json" });
      const url = new URL("https://auth.silpo.ua/.well-known/oauth-authorization-server");
      sanitizeAuthorizationHeader(url, headers, false);
      expect(headers.get("Authorization")).toBeNull();
      expect(headers.get("Accept")).toBe("application/json");
    });

    it("strips Bearer Authorization on registration endpoint", () => {
      const headers = new Headers({ Authorization: "Bearer some-token" });
      const url = new URL("https://auth.silpo.ua/register");
      sanitizeAuthorizationHeader(url, headers, false);
      expect(headers.get("Authorization")).toBeNull();
    });

    it("strips Bearer Authorization on token endpoint", () => {
      const headers = new Headers({ Authorization: "Bearer some-token" });
      const url = new URL("https://auth.silpo.ua/token");
      sanitizeAuthorizationHeader(url, headers, true);
      expect(headers.get("Authorization")).toBeNull();
    });

    it("preserves Basic Authorization on token endpoint (client_secret_basic)", () => {
      const headers = new Headers({ Authorization: "Basic dXNlcjpzZWNyZXQ=" });
      const url = new URL("https://auth.silpo.ua/token");
      sanitizeAuthorizationHeader(url, headers, true);
      expect(headers.get("Authorization")).toBe("Basic dXNlcjpzZWNyZXQ=");
    });

    it("preserves Bearer Authorization on standard MCP endpoint", () => {
      const headers = new Headers({ Authorization: "Bearer valid-mcp-token" });
      const url = new URL("https://mcp.silpo.ua/mcp");
      sanitizeAuthorizationHeader(url, headers, false);
      expect(headers.get("Authorization")).toBe("Bearer valid-mcp-token");
    });
  });
});
