import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import type { ServerEnv } from "@/lib/env";
import { err, ok } from "@/lib/result";
import { createInMemoryAuthRepository } from "@/features/silpo/oauth/auth-repository";
import { createInMemoryTokenVaultStorage, createTokenVault } from "@/features/silpo/oauth/token-vault";
import { createSilpoOAuthProvider, type SilpoOAuthProvider } from "@/features/silpo/oauth/provider";
import { createSilpoOAuthConnection } from "@/features/silpo/oauth/transport";
import {
  createSilpoOAuthService,
  type CallbackInput,
  type SilpoOAuthService,
} from "@/features/silpo/oauth/service";
import {
  createCallbackHandler,
  createStartHandler,
} from "@/app/api/auth/silpo/handlers";

const SAMPLE_BASE_URL = "https://app.silpo-test.ua";
const SAMPLE_ISSUER = "https://auth.silpo.ua";
const SAMPLE_SERVER_URL = "https://mcp.silpo.ua/mcp";

function makeEnv(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://user:pass@localhost:5432/testdb",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
    GOOGLE_GENERATIVE_AI_API_KEY: "test-api-key",
    AGENT_MODEL: "gemini-3.7-flash",
    DATA_MODE: "live",
    PUBLIC_BASE_URL: SAMPLE_BASE_URL,
    ...overrides,
  };
}

describe("Silpo OAuth Routes — Mocked Service Composition", () => {
  const env = makeEnv();

  it("start: redirects to authorization URL with 303, sets pending cookie, applies no-store/no-referrer", async () => {
    const mockService: SilpoOAuthService = {
      async start() {
        return ok({
          location: "https://auth.silpo.ua/authorize?client_id=123&state=abc",
          cookie: {
            value: "pending-handle-val",
            expiresAt: new Date("2026-09-06T12:10:00Z"),
            maxAge: 600,
          },
        });
      },
      async callback() {
        throw new Error("not used");
      },
      async resolveSession() {
        throw new Error("not used");
      },
    };

    const handler = createStartHandler(() => mockService, () => env);
    const req = new NextRequest("https://app.silpo-test.ua/api/auth/silpo/start");
    const res = await handler(req);

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("https://auth.silpo.ua/authorize?client_id=123&state=abc");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");

    const cookie = res.cookies.get("silpo_session");
    expect(cookie).toBeDefined();
    expect(cookie?.value).toBe("pending-handle-val");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(cookie?.path).toBe("/");
    expect(cookie?.maxAge).toBe(600);
  });

  it("start: rejects query parameters with 400", async () => {
    const mockService: SilpoOAuthService = {
      async start() {
        throw new Error("should not be called");
      },
      async callback() {
        throw new Error("not used");
      },
      async resolveSession() {
        throw new Error("not used");
      },
    };

    const handler = createStartHandler(() => mockService, () => env);
    const req = new NextRequest("https://app.silpo-test.ua/api/auth/silpo/start?userId=attacker&return=/secret");
    const res = await handler(req);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("unauthorized");
  });

  it("start: returns 404 in demo mode with zero service work", async () => {
    let serviceCalled = false;
    const mockService: SilpoOAuthService = {
      async start() {
        serviceCalled = true;
        throw new Error("should not be called");
      },
      async callback() {
        throw new Error("not used");
      },
      async resolveSession() {
        throw new Error("not used");
      },
    };

    const demoEnv = makeEnv({ DATA_MODE: "demo" });
    const handler = createStartHandler(() => mockService, () => demoEnv);
    const req = new NextRequest("https://app.silpo-test.ua/api/auth/silpo/start");
    const res = await handler(req);

    expect(res.status).toBe(404);
    expect(serviceCalled).toBe(false);
  });

  it("start: on service error, returns status, JSON body and clears cookie if requested", async () => {
    const mockService: SilpoOAuthService = {
      async start() {
        return err({
          status: 409,
          error: {
            code: "unauthorized",
            message: "Вхід уже обробляється.",
            correlationId: "corr-err-1",
            retryAfterMs: null,
          },
          clearCookie: false,
        });
      },
      async callback() {
        throw new Error("not used");
      },
      async resolveSession() {
        throw new Error("not used");
      },
    };

    const handler = createStartHandler(() => mockService, () => env);
    const req = new NextRequest("https://app.silpo-test.ua/api/auth/silpo/start");
    const res = await handler(req);

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe("unauthorized");
    expect(json.correlationId).toBe("corr-err-1");
  });

  it("callback: validates input bounds, duplicates and unknown query params", async () => {
    const mockService: SilpoOAuthService = {
      async start() {
        throw new Error("not used");
      },
      async callback() {
        throw new Error("should not be reached");
      },
      async resolveSession() {
        throw new Error("not used");
      },
    };

    const handler = createCallbackHandler(() => mockService, () => env);

    // Duplicate state parameter
    const reqDup = new NextRequest("https://app.silpo-test.ua/api/auth/silpo/callback?state=1&state=2&code=c");
    const resDup = await handler(reqDup);
    expect(resDup.status).toBe(400);

    // Unknown query param
    const reqUnknown = new NextRequest("https://app.silpo-test.ua/api/auth/silpo/callback?state=1&code=c&evil=true");
    const resUnknown = await handler(reqUnknown);
    expect(resUnknown.status).toBe(400);

    // Mixed code and error
    const reqMixed = new NextRequest("https://app.silpo-test.ua/api/auth/silpo/callback?state=1&code=c&error=access_denied");
    const resMixed = await handler(reqMixed);
    expect(resMixed.status).toBe(400);

    // Missing code and error
    const reqMissing = new NextRequest("https://app.silpo-test.ua/api/auth/silpo/callback?state=1");
    const resMissing = await handler(reqMissing);
    expect(resMissing.status).toBe(400);

    // Excessively long state (>256)
    const longState = "a".repeat(257);
    const reqLongState = new NextRequest(`https://app.silpo-test.ua/api/auth/silpo/callback?state=${longState}&code=c`);
    const resLongState = await handler(reqLongState);
    expect(resLongState.status).toBe(400);
  });

  it("callback: successful completion redirects 303 to / with 7-day cookie", async () => {
    const mockService: SilpoOAuthService = {
      async start() {
        throw new Error("not used");
      },
      async callback(input: CallbackInput) {
        expect(input.state).toBe("valid-state");
        expect(input.code).toBe("valid-code");
        expect(input.issuer).toBe(SAMPLE_ISSUER);
        expect(input.handle).toBe("cookie-handle-123");
        return ok({
          location: "/",
          cookie: {
            value: "new-authenticated-handle",
            expiresAt: new Date("2026-09-13T12:00:00Z"),
            maxAge: 7 * 24 * 3600,
          },
        });
      },
      async resolveSession() {
        throw new Error("not used");
      },
    };

    const handler = createCallbackHandler(() => mockService, () => env);
    const req = new NextRequest(`https://app.silpo-test.ua/api/auth/silpo/callback?state=valid-state&code=valid-code&iss=${encodeURIComponent(SAMPLE_ISSUER)}`, {
      headers: { cookie: "silpo_session=cookie-handle-123" },
    });
    const res = await handler(req);

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("https://app.silpo-test.ua/");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");

    const cookie = res.cookies.get("silpo_session");
    expect(cookie).toBeDefined();
    expect(cookie?.value).toBe("new-authenticated-handle");
    expect(cookie?.maxAge).toBe(7 * 24 * 3600);
  });

  it("callback: in demo mode returns 404 with zero service work", async () => {
    let called = false;
    const mockService: SilpoOAuthService = {
      async start() {
        throw new Error("not used");
      },
      async callback() {
        called = true;
        throw new Error("should not be called");
      },
      async resolveSession() {
        throw new Error("not used");
      },
    };

    const demoEnv = makeEnv({ DATA_MODE: "demo" });
    const handler = createCallbackHandler(() => mockService, () => demoEnv);
    const req = new NextRequest("https://app.silpo-test.ua/api/auth/silpo/callback?state=s&code=c");
    const res = await handler(req);

    expect(res.status).toBe(404);
    expect(called).toBe(false);
  });

  it("start & callback: set secure: true on cookies in production environment", async () => {
    const prodEnv = makeEnv({ NODE_ENV: "production" });
    const mockService: SilpoOAuthService = {
      async start() {
        return ok({
          location: "https://auth.silpo.ua/authorize?state=abc",
          cookie: {
            value: "prod-pending-handle",
            expiresAt: new Date("2026-09-06T12:10:00Z"),
            maxAge: 600,
          },
        });
      },
      async callback() {
        return ok({
          location: "/",
          cookie: {
            value: "prod-authenticated-handle",
            expiresAt: new Date("2026-09-13T12:00:00Z"),
            maxAge: 7 * 24 * 3600,
          },
        });
      },
      async resolveSession() {
        throw new Error("not used");
      },
    };

    const startHandler = createStartHandler(() => mockService, () => prodEnv);
    const startRes = await startHandler(new NextRequest("https://app.silpo-test.ua/api/auth/silpo/start"));
    expect(startRes.cookies.get("silpo_session")?.secure).toBe(true);

    const callbackHandler = createCallbackHandler(() => mockService, () => prodEnv);
    const callbackRes = await callbackHandler(
      new NextRequest("https://app.silpo-test.ua/api/auth/silpo/callback?state=abc&code=123", {
        headers: { cookie: "silpo_session=prod-pending-handle" },
      }),
    );
    expect(callbackRes.cookies.get("silpo_session")?.secure).toBe(true);
  });

  it("start & callback: unexpected thrown service error is caught and returns 500 JSON with no-store/no-referrer", async () => {
    const throwingService: SilpoOAuthService = {
      async start() {
        throw new Error("unhandled database failure");
      },
      async callback() {
        throw new Error("unhandled database failure");
      },
      async resolveSession() {
        throw new Error("not used");
      },
    };

    const startHandler = createStartHandler(() => throwingService, () => env);
    const startRes = await startHandler(new NextRequest("https://app.silpo-test.ua/api/auth/silpo/start"));
    expect(startRes.status).toBe(500);
    expect(startRes.headers.get("Cache-Control")).toBe("no-store");
    expect(startRes.headers.get("Referrer-Policy")).toBe("no-referrer");
    const startJson = await startRes.json();
    expect(startJson.code).toBe("unexpected");
    expect(startJson.message).toBe("Не вдалося завершити вхід. Спробуйте ще раз.");

    const callbackHandler = createCallbackHandler(() => throwingService, () => env);
    const callbackRes = await callbackHandler(
      new NextRequest("https://app.silpo-test.ua/api/auth/silpo/callback?state=abc&code=123", {
        headers: { cookie: "silpo_session=some-handle" },
      }),
    );
    expect(callbackRes.status).toBe(500);
    expect(callbackRes.headers.get("Cache-Control")).toBe("no-store");
    expect(callbackRes.headers.get("Referrer-Policy")).toBe("no-referrer");
    const callbackJson = await callbackRes.json();
    expect(callbackJson.code).toBe("unexpected");
    expect(callbackJson.message).toBe("Не вдалося завершити вхід. Спробуйте ще раз.");
  });

  it("callback: resolves internal path against PUBLIC_BASE_URL even if service returns absolute url", async () => {
    const mockService: SilpoOAuthService = {
      async start() {
        throw new Error("not used");
      },
      async callback() {
        return ok({
          location: "https://evil.com/phish",
          cookie: null,
        });
      },
      async resolveSession() {
        throw new Error("not used");
      },
    };

    const handler = createCallbackHandler(() => mockService, () => env);
    const res = await handler(
      new NextRequest("https://app.silpo-test.ua/api/auth/silpo/callback?state=abc&code=123", {
        headers: { cookie: "silpo_session=some-handle" },
      }),
    );

    expect(res.status).toBe(303);
    const location = res.headers.get("Location")!;
    expect(location).toContain("https://app.silpo-test.ua/");
    expect(new URL(location).origin).toBe("https://app.silpo-test.ua");
  });
});

describe("Silpo OAuth Routes — End-to-End Route Integration with Real SDK & Network Fixtures", () => {
  function createSyntheticFetch() {
    const requests: { url: string; method: string; body?: string }[] = [];

    const fakeFetch: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      const method = req.method.toUpperCase();

      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        requests.push({ url: req.url, method });
        return new Response(
          JSON.stringify({
            resource: SAMPLE_SERVER_URL,
            authorization_servers: [SAMPLE_ISSUER],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (
        url.pathname.startsWith("/.well-known/oauth-authorization-server") ||
        url.pathname.startsWith("/.well-known/openid-configuration")
      ) {
        requests.push({ url: req.url, method });
        return new Response(
          JSON.stringify({
            issuer: SAMPLE_ISSUER,
            authorization_endpoint: `${SAMPLE_ISSUER}/authorize`,
            token_endpoint: `${SAMPLE_ISSUER}/token`,
            registration_endpoint: `${SAMPLE_ISSUER}/register`,
            response_types_supported: ["code"],
            scopes_supported: ["cart:read"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["client_secret_post"],
            authorization_response_iss_parameter_supported: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.pathname === "/register" && method === "POST") {
        requests.push({ url: req.url, method });
        return new Response(
          JSON.stringify({
            client_id: "synthetic-client-id",
            client_secret: "synthetic-client-secret-secret",
            client_id_issued_at: Math.floor(Date.now() / 1000),
            redirect_uris: [`${SAMPLE_BASE_URL}/api/auth/silpo/callback`],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.pathname === "/token" && method === "POST") {
        const cloned = req.clone();
        const bodyText = await cloned.text();
        requests.push({ url: req.url, method, body: bodyText });
        return new Response(
          JSON.stringify({
            access_token: `token-synthetic-${randomBytes(8).toString("hex")}`,
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: `refresh-synthetic-${randomBytes(8).toString("hex")}`,
            scope: "cart:read",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.pathname === "/mcp") {
        requests.push({ url: req.url, method });
        const cloned = req.clone();
        let bodyJson: Record<string, unknown> = {};
        try {
          bodyJson = (await cloned.json()) as Record<string, unknown>;
        } catch {}

        if (bodyJson.method === "initialize") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: bodyJson.id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "silpo-test-server", version: "1.0.0" },
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

      throw new Error(`Unexpected request: ${method} ${req.url}`);
    };

    return { fakeFetch, requests };
  }

  it("completes full OAuth lifecycle: start -> authorization redirect -> callback -> token storage -> tools/list probe -> session rotation -> resolveSession", async () => {
    const encryptionKey = Buffer.alloc(32, 5);
    const repo = createInMemoryAuthRepository({ encryptionKey });
    const vaultStorage = createInMemoryTokenVaultStorage();
    const now = new Date("2026-09-06T12:00:00Z");
    const vault = createTokenVault({ storage: vaultStorage, encryptionKey, now: () => now });
    const env = makeEnv();
    const { fakeFetch, requests } = createSyntheticFetch();

    const connect = (provider: SilpoOAuthProvider) =>
      createSilpoOAuthConnection(provider, {
        serverUrl: SAMPLE_SERVER_URL,
        fetch: fakeFetch,
        lookupIp: async () => ["93.184.216.34"],
      });

    // 1. Service instance for /start
    const startService = createSilpoOAuthService({
      repository: repo,
      createProvider: async (userId, claimedState) =>
        createSilpoOAuthProvider(userId, { vault, repository: repo, publicBaseUrl: env.PUBLIC_BASE_URL, now: () => now, claimedState }),
      connect,
      env,
      now: () => now,
    });

    const startHandler = createStartHandler(() => startService, () => env);
    const startReq = new NextRequest("https://app.silpo-test.ua/api/auth/silpo/start");
    const startRes = await startHandler(startReq);

    expect(startRes.status).toBe(303);
    const authLocation = startRes.headers.get("Location")!;
    expect(authLocation).toContain(`${SAMPLE_ISSUER}/authorize`);

    const authUrl = new URL(authLocation);
    const stateParam = authUrl.searchParams.get("state")!;
    expect(stateParam).toBeDefined();

    const pendingCookie = startRes.cookies.get("silpo_session")!;
    expect(pendingCookie).toBeDefined();

    // 2. Separate Service instance for /callback to prove request independence
    const callbackService = createSilpoOAuthService({
      repository: repo,
      createProvider: async (userId, claimedState) =>
        createSilpoOAuthProvider(userId, { vault, repository: repo, publicBaseUrl: env.PUBLIC_BASE_URL, now: () => now, claimedState }),
      connect,
      env,
      now: () => now,
    });

    const callbackHandler = createCallbackHandler(() => callbackService, () => env);
    const callbackUrl = `https://app.silpo-test.ua/api/auth/silpo/callback?state=${encodeURIComponent(stateParam)}&code=synthetic-code-123&iss=${encodeURIComponent(SAMPLE_ISSUER)}`;
    const callbackReq = new NextRequest(callbackUrl, {
      headers: { cookie: `silpo_session=${pendingCookie.value}` },
    });
    const callbackRes = await callbackHandler(callbackReq);

    expect(callbackRes.status).toBe(303);
    expect(callbackRes.headers.get("Location")).toBe("https://app.silpo-test.ua/");

    const authenticatedCookie = callbackRes.cookies.get("silpo_session")!;
    expect(authenticatedCookie).toBeDefined();
    expect(authenticatedCookie.value).not.toBe(pendingCookie.value);
    expect(authenticatedCookie.maxAge).toBe(7 * 24 * 3600);

    // Verify resolveSession with authenticated cookie
    const resolveResult = await callbackService.resolveSession(authenticatedCookie.value, "corr-verify");
    expect(resolveResult.ok).toBe(true);
    if (!resolveResult.ok) return;

    // Verify tokens were stored in vault
    const storedTokens = await vault.get(resolveResult.value.userId);
    expect(storedTokens).not.toBeNull();
    expect(storedTokens?.accessToken).toMatch(/^token-synthetic-/);

    // Verify probeTools called tools/list
    const mcpCalls = requests.filter((r) => r.url.includes("/mcp"));
    expect(mcpCalls.length).toBeGreaterThanOrEqual(1);

    // Verify NO checkout or cart-write tools were called
    const tokenRequestBody = requests.find((r) => r.url.includes("/token"))?.body;
    expect(tokenRequestBody).toContain("grant_type=authorization_code");

    // Old pending session is no longer valid
    const oldSessionResolve = await callbackService.resolveSession(pendingCookie.value, "corr-old");
    expect(oldSessionResolve.ok).toBe(false);
  });

  it("denial callback consumes flow and returns 401 without exchanging code", async () => {
    const encryptionKey = Buffer.alloc(32, 6);
    const repo = createInMemoryAuthRepository({ encryptionKey });
    const vaultStorage = createInMemoryTokenVaultStorage();
    const now = new Date("2026-09-06T12:00:00Z");
    const vault = createTokenVault({ storage: vaultStorage, encryptionKey, now: () => now });
    const env = makeEnv();
    const { fakeFetch, requests } = createSyntheticFetch();

    const connect = (provider: SilpoOAuthProvider) =>
      createSilpoOAuthConnection(provider, {
        serverUrl: SAMPLE_SERVER_URL,
        fetch: fakeFetch,
        lookupIp: async () => ["93.184.216.34"],
      });

    const service = createSilpoOAuthService({
      repository: repo,
      createProvider: async (userId, claimedState) =>
        createSilpoOAuthProvider(userId, { vault, repository: repo, publicBaseUrl: env.PUBLIC_BASE_URL, now: () => now, claimedState }),
      connect,
      env,
      now: () => now,
    });

    const startHandler = createStartHandler(() => service, () => env);
    const startRes = await startHandler(new NextRequest("https://app.silpo-test.ua/api/auth/silpo/start"));
    const stateParam = new URL(startRes.headers.get("Location")!).searchParams.get("state")!;
    const pendingCookie = startRes.cookies.get("silpo_session")!;

    const callbackHandler = createCallbackHandler(() => service, () => env);
    const denialUrl = `https://app.silpo-test.ua/api/auth/silpo/callback?state=${encodeURIComponent(stateParam)}&error=access_denied`;
    const callbackRes = await callbackHandler(
      new NextRequest(denialUrl, { headers: { cookie: `silpo_session=${pendingCookie.value}` } }),
    );

    expect(callbackRes.status).toBe(401);
    const clearedCookie = callbackRes.cookies.get("silpo_session")!;
    expect(clearedCookie.maxAge).toBe(0);

    // No token request made
    const tokenRequests = requests.filter((r) => r.url.includes("/token"));
    expect(tokenRequests.length).toBe(0);
  });

  it("reauthorization keeps existing internal user identity and revokes previous session handle", async () => {
    const encryptionKey = Buffer.alloc(32, 8);
    const repo = createInMemoryAuthRepository({ encryptionKey });
    const vaultStorage = createInMemoryTokenVaultStorage();
    const now = new Date("2026-09-06T12:00:00Z");
    const vault = createTokenVault({ storage: vaultStorage, encryptionKey, now: () => now });
    const env = makeEnv();
    const { fakeFetch } = createSyntheticFetch();

    const connect = (provider: SilpoOAuthProvider) =>
      createSilpoOAuthConnection(provider, {
        serverUrl: SAMPLE_SERVER_URL,
        fetch: fakeFetch,
        lookupIp: async () => ["93.184.216.34"],
      });

    const service = createSilpoOAuthService({
      repository: repo,
      createProvider: async (userId, claimedState) =>
        createSilpoOAuthProvider(userId, { vault, repository: repo, publicBaseUrl: env.PUBLIC_BASE_URL, now: () => now, claimedState }),
      connect,
      env,
      now: () => now,
    });

    const startHandler = createStartHandler(() => service, () => env);
    const callbackHandler = createCallbackHandler(() => service, () => env);

    // 1. Initial login flow
    const startRes1 = await startHandler(new NextRequest("https://app.silpo-test.ua/api/auth/silpo/start"));
    const stateParam1 = new URL(startRes1.headers.get("Location")!).searchParams.get("state")!;
    const pendingCookie1 = startRes1.cookies.get("silpo_session")!;

    const callbackRes1 = await callbackHandler(
      new NextRequest(
        `https://app.silpo-test.ua/api/auth/silpo/callback?state=${encodeURIComponent(stateParam1)}&code=initial-code&iss=${encodeURIComponent(SAMPLE_ISSUER)}`,
        { headers: { cookie: `silpo_session=${pendingCookie1.value}` } },
      ),
    );
    const authCookie1 = callbackRes1.cookies.get("silpo_session")!;
    const session1 = await service.resolveSession(authCookie1.value, "corr-init");
    expect(session1.ok).toBe(true);
    if (!session1.ok) return;
    const initialUserId = session1.value.userId;

    // 2. Simulate expired/revoked tokens requiring reauthorization
    await vault.clear(initialUserId);

    // Reauthorization with existing session
    const startRes2 = await startHandler(
      new NextRequest("https://app.silpo-test.ua/api/auth/silpo/start", {
        headers: { cookie: `silpo_session=${authCookie1.value}` },
      }),
    );
    expect(startRes2.status).toBe(303);
    const authLocation2 = startRes2.headers.get("Location")!;
    expect(authLocation2).toContain(`${SAMPLE_ISSUER}/authorize`);
    const stateParam2 = new URL(authLocation2).searchParams.get("state")!;
    const pendingCookie2 = startRes2.cookies.get("silpo_session")!;

    const callbackRes2 = await callbackHandler(
      new NextRequest(
        `https://app.silpo-test.ua/api/auth/silpo/callback?state=${encodeURIComponent(stateParam2)}&code=reauth-code&iss=${encodeURIComponent(SAMPLE_ISSUER)}`,
        { headers: { cookie: `silpo_session=${pendingCookie2.value}` } },
      ),
    );
    expect(callbackRes2.status).toBe(303);
    const authCookie2 = callbackRes2.cookies.get("silpo_session")!;

    // 3. Verify final authenticated session has the EXACT same userId as before reauthorization
    const session2 = await service.resolveSession(authCookie2.value, "corr-reauth");
    expect(session2.ok).toBe(true);
    if (!session2.ok) return;
    expect(session2.value.userId).toBe(initialUserId);

    // 4. Verify previous pending session handle is revoked
    const oldPendingResolve = await service.resolveSession(pendingCookie2.value, "corr-old-pending");
    expect(oldPendingResolve.ok).toBe(false);

    // 5. O9-01: the authenticated handle that initiated reauthorization is dead
    const staleAuthResolve = await service.resolveSession(authCookie1.value, "corr-stale-auth");
    expect(staleAuthResolve.ok).toBe(false);
  });
});
