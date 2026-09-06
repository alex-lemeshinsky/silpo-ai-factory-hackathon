import dns from "node:dns/promises";
import net from "node:net";
import {
  auth,
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";

import type { createSilpoOAuthProvider } from "./provider";

export type SilpoOAuthProvider = Awaited<ReturnType<typeof createSilpoOAuthProvider>>;

export interface OAuthConnection {
  begin(): Promise<"authorized" | "redirect">;
  finishAuth(code: string, issuer?: string): Promise<void>;
  probeTools(): Promise<void>;
  close(): Promise<void>;
}

export type OAuthConnectionFactory = (provider: SilpoOAuthProvider) => OAuthConnection;

export class ReauthorizationRequired extends Error {
  constructor(message = "reauthorization_required") {
    super(message);
    this.name = "ReauthorizationRequired";
  }
}

export interface CreateSilpoOAuthConnectionOptions {
  serverUrl?: string | URL;
  fetch?: typeof fetch;
  lookupIp?: (hostname: string) => Promise<string[]>;
  requestTimeoutMs?: number;
  operationTimeoutMs?: number;
  allowInsecureDevHttp?: boolean;
}

const DEFAULT_SERVER_URL = "https://api.silpo.ua/mcp";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;

function isPrivateOrLoopbackIp(raw: string): boolean {
  let normalized = raw.toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }

  // Normalize IPv4-mapped IPv6 (::ffff:127.0.0.1)
  if (normalized.startsWith("::ffff:")) {
    normalized = normalized.slice(7);
  }

  if (net.isIP(normalized) === 0) {
    return false;
  }

  // IPv4 checks
  if (net.isIP(normalized) === 4) {
    const parts = normalized.split(".").map(Number);
    if (parts.length !== 4) return true;
    const [a, b] = parts;
    // 0.0.0.0/8
    if (a === 0) return true;
    // Loopback 127.0.0.0/8
    if (a === 127) return true;
    // Private 10.0.0.0/8
    if (a === 10) return true;
    // Private 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // Private 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // Link-local / Cloud metadata 169.254.0.0/16
    if (a === 169 && b === 254) return true;
    // Broadcast 255.255.255.255
    if (parts.every((p) => p === 255)) return true;
    return false;
  }

  // IPv6 checks
  if (normalized === "::" || normalized === "::1") return true;
  // Unique local fc00::/7 (fc00:: - fdff::)
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  // Link-local fe80::/10 (fe80:: - febf::)
  if (/^fe[89ab]/i.test(normalized)) return true;

  return false;
}

async function validateDestination(
  url: URL,
  lookupIp: (hostname: string) => Promise<string[]>,
  allowInsecureDevHttp = false,
): Promise<void> {
  const isHttp = url.protocol === "http:";
  const isHttps = url.protocol === "https:";

  if (!isHttps) {
    if (!isHttp || !allowInsecureDevHttp) {
      throw new Error("insecure_protocol");
    }
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (!isLocal) {
      throw new Error("insecure_protocol");
    }
  }

  // Check hostname if it's already an IP
  if (isPrivateOrLoopbackIp(url.hostname)) {
    throw new Error("insecure_destination_ip");
  }

  // Resolve hostname via DNS to verify resolved IP is not private/loopback
  const ips = await lookupIp(url.hostname);
  if (!ips || ips.length === 0) {
    throw new Error("dns_resolution_failed");
  }

  for (const ip of ips) {
    if (isPrivateOrLoopbackIp(ip)) {
      throw new Error(`insecure_destination_ip: ${ip}`);
    }
  }
}

async function defaultLookupIp(hostname: string): Promise<string[]> {
  const results = await dns.lookup(hostname, { all: true });
  return results.map((r) => r.address);
}

export function sanitizeAuthorizationHeader(
  url: URL,
  headers: Headers,
  isTokenRequest: boolean = false,
): void {
  const authHeader = headers.get("Authorization");
  if (!authHeader) return;
  const isBearerAuth = authHeader.trim().toLowerCase().startsWith("bearer ");

  const isDiscovery = url.pathname.includes("/.well-known/");
  const isRegistration =
    url.pathname.endsWith("/register") || url.pathname.includes("/register");
  const isTokenEndpoint =
    isTokenRequest || url.pathname.endsWith("/token") || url.pathname.includes("/token");

  if (isDiscovery || isRegistration || isTokenEndpoint) {
    if (isBearerAuth) {
      headers.delete("Authorization");
    }
  }
}

export function createSilpoOAuthConnection(
  provider: SilpoOAuthProvider,
  options: CreateSilpoOAuthConnectionOptions = {},
): OAuthConnection {
  const serverUrl = new URL(options.serverUrl ?? DEFAULT_SERVER_URL);
  const underlyingFetch = options.fetch ?? globalThis.fetch;
  const lookupIp = options.lookupIp ?? defaultLookupIp;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  const allowInsecureDevHttp = options.allowInsecureDevHttp ?? false;

  // Immediate synchronous destination check for serverUrl scheme and IP literal
  if (serverUrl.protocol !== "https:") {
    if (
      !allowInsecureDevHttp ||
      serverUrl.protocol !== "http:" ||
      (serverUrl.hostname !== "localhost" && serverUrl.hostname !== "127.0.0.1")
    ) {
      throw new Error("insecure_protocol");
    }
  }
  if (isPrivateOrLoopbackIp(serverUrl.hostname)) {
    throw new Error("insecure_destination_ip");
  }

  // Budget tracking across the connection
  const budget = {
    refreshAttempts: 0,
    codeExchanges: 0,
  };

  const connectionAbortController = new AbortController();
  const operationTimeoutId = setTimeout(() => {
    connectionAbortController.abort(new Error("operation_timed_out"));
  }, operationTimeoutMs);

  let activeClient: Client | null = null;
  let activeTransport: StreamableHTTPClientTransport | null = null;

  // Create bound fetch with destination validation, budget guarding, 429 retries, and timeouts
  const boundFetch: typeof fetch = async (input, init) => {
    let currentUrl = new URL(
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : input.toString(),
    );

    let currentInit = init ?? (input instanceof Request ? input : {});
    let redirectCount = 0;
    const MAX_REDIRECTS = 5;

    while (redirectCount <= MAX_REDIRECTS) {
      await validateDestination(currentUrl, lookupIp, allowInsecureDevHttp);

      const method = (
        currentInit.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();

      // Read normalized fetch request body with URLSearchParams only for token endpoint
      let isTokenRequest = false;
      let isRefreshGrant = false;
      let isCodeExchange = false;

      const headers = new Headers(
        currentInit.headers ?? (input instanceof Request ? input.headers : {}),
      );

      if (method === "POST") {
        let bodyText: string | null = null;
        if (typeof currentInit.body === "string") {
          bodyText = currentInit.body;
        } else if (currentInit.body instanceof URLSearchParams) {
          bodyText = currentInit.body.toString();
        } else if (input instanceof Request) {
          try {
            const clonedReq = input.clone();
            bodyText = await clonedReq.text();
          } catch {
            // body not cloned / already consumed
          }
        }

        if (bodyText) {
          try {
            const params = new URLSearchParams(bodyText);
            const grantType = params.get("grant_type");
            if (grantType) {
              isTokenRequest = true;
              if (grantType === "refresh_token") {
                isRefreshGrant = true;
              } else if (grantType === "authorization_code") {
                isCodeExchange = true;
              }
            }
          } catch {
            // not form data
          }
        }
      }

      if (isRefreshGrant) {
        if (budget.refreshAttempts >= 1) {
          throw new ReauthorizationRequired();
        }
        budget.refreshAttempts += 1;
        provider.setGrantKind("refresh_token");
      }

      if (isCodeExchange) {
        if (budget.codeExchanges >= 1) {
          throw new ReauthorizationRequired();
        }
        budget.codeExchanges += 1;
        provider.setGrantKind("authorization_code");
      }

      sanitizeAuthorizationHeader(currentUrl, headers, isTokenRequest);

      // Timeouts
      const requestAbort = new AbortController();
      const timeoutId = setTimeout(() => requestAbort.abort(), requestTimeoutMs);

      const onConnectionAbort = () => requestAbort.abort();
      connectionAbortController.signal.addEventListener("abort", onConnectionAbort, {
        once: true,
      });

      let response: Response;
      try {
        const executeFetch = async () => {
          return await underlyingFetch(currentUrl.toString(), {
            ...currentInit,
            headers,
            signal: requestAbort.signal,
            redirect: "manual",
          });
        };

        response = await executeFetch();

        // 429 Handling: Retry read-only MCP operations at most three times
        const isMcpReadOnly =
          currentUrl.pathname === serverUrl.pathname && !isTokenRequest;

        if (response.status === 429 && isMcpReadOnly) {
          let retryCount = 0;
          while (response.status === 429 && retryCount < 3) {
            retryCount += 1;
            const retryAfterHeader = response.headers.get("Retry-After");
            let delayMs = 250 * Math.pow(2, retryCount - 1) + Math.random() * 50;
            if (retryAfterHeader) {
              const seconds = Number.parseInt(retryAfterHeader, 10);
              if (!Number.isNaN(seconds) && seconds >= 0) {
                delayMs = seconds * 1000;
              }
            }
            if (delayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
            response = await executeFetch();
          }
        }
      } finally {
        clearTimeout(timeoutId);
        connectionAbortController.signal.removeEventListener(
          "abort",
          onConnectionAbort,
        );
      }

      // Handle redirect manually to enforce destination validation on each hop
      if (
        response.status === 301 ||
        response.status === 302 ||
        response.status === 303 ||
        response.status === 307 ||
        response.status === 308
      ) {
        const location = response.headers.get("Location");
        if (!location) {
          return response;
        }
        currentUrl = new URL(location, currentUrl);
        redirectCount += 1;
        if (redirectCount > MAX_REDIRECTS) {
          throw new Error("too_many_redirects");
        }
        // Change method to GET for 301/302/303 per HTTP spec
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method === "POST")
        ) {
          currentInit = { ...currentInit, method: "GET", body: undefined };
        }
        continue;
      }

      return response;
    }

    throw new Error("too_many_redirects");
  };

  const connection: OAuthConnection = {
    async begin(): Promise<"authorized" | "redirect"> {
      try {
        const authResult = await auth(provider, {
          serverUrl,
          fetchFn: boundFetch,
          skipIssuerMetadataValidation: false,
        });

        if (authResult === "AUTHORIZED") {
          return "authorized";
        }
        return "redirect";
      } catch (error) {
        if (
          error instanceof ReauthorizationRequired ||
          error instanceof UnauthorizedError ||
          (error instanceof Error &&
            (error.name === "UnauthorizedError" ||
              error.message.toLowerCase().includes("unauthorized")))
        ) {
          await Promise.resolve(provider.invalidateCredentials("tokens")).catch(() => {});
          if (provider.authorizationUrl()) {
            return "redirect";
          }
          throw new Error("unauthorized");
        }
        throw error;
      }
    },

    async finishAuth(code: string, issuer?: string): Promise<void> {
      const transport = new StreamableHTTPClientTransport(serverUrl, {
        authProvider: provider,
        fetch: boundFetch,
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 30000,
          reconnectionDelayGrowFactor: 1.5,
        },
        onInsufficientScope: "throw",
      });

      try {
        await transport.finishAuth(code, issuer);
      } catch (error) {
        if (
          error instanceof ReauthorizationRequired ||
          error instanceof UnauthorizedError ||
          (error instanceof Error &&
            (error.name === "UnauthorizedError" ||
              error.message.includes("401") ||
              error.message.toLowerCase().includes("unauthorized")))
        ) {
          await Promise.resolve(provider.invalidateCredentials("tokens")).catch(() => {});
          throw new Error("unauthorized");
        }
        throw error;
      } finally {
        await transport.close().catch(() => {});
      }
    },

    async probeTools(): Promise<void> {
      const transport = new StreamableHTTPClientTransport(serverUrl, {
        authProvider: provider,
        fetch: boundFetch,
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 30000,
          reconnectionDelayGrowFactor: 1.5,
        },
        onInsufficientScope: "throw",
      });
      activeTransport = transport;

      const client = new Client(
        { name: "silpo-avtopilot", version: "1.0.0" },
        { capabilities: {} },
      );
      activeClient = client;

      try {
        await client.connect(transport);
        await client.listTools();
      } catch (error) {
        if (
          error instanceof ReauthorizationRequired ||
          error instanceof UnauthorizedError ||
          (error instanceof Error &&
            (error.name === "UnauthorizedError" ||
              error.message.includes("401") ||
              error.message.toLowerCase().includes("unauthorized")))
        ) {
          await Promise.resolve(provider.invalidateCredentials("tokens")).catch(() => {});
          throw new Error("unauthorized");
        }
        throw error;
      } finally {
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
        activeClient = null;
        activeTransport = null;
      }
    },

    async close(): Promise<void> {
      clearTimeout(operationTimeoutId);
      connectionAbortController.abort();
      if (activeClient) {
        await activeClient.close().catch(() => {});
        activeClient = null;
      }
      if (activeTransport) {
        await activeTransport.close().catch(() => {});
        activeTransport = null;
      }
    },
  };

  return connection;
}

export function createDefaultOAuthConnectionFactory(
  options: CreateSilpoOAuthConnectionOptions = {},
): OAuthConnectionFactory {
  return (provider: SilpoOAuthProvider) =>
    createSilpoOAuthConnection(provider, options);
}
