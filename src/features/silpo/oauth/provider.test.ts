import { randomBytes } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  OAuthClientProvider as OfficialOAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
} from "@modelcontextprotocol/client";
import type { OAuthClientProvider as AiSdkOAuthClientProvider } from "@ai-sdk/mcp";

import { createInMemoryAuthRepository } from "./auth-repository";
import { createInMemoryTokenVaultStorage, createTokenVault } from "./token-vault";
import { createSilpoOAuthProvider, type SilpoOAuthProvider } from "./provider";

// Compile-time conformance assertions:
type AssertAssignable<T, Expected> = [T] extends [Expected] ? true : false;
type AssertTrue<T extends true> = T;
export type _AssertOfficialContract = AssertTrue<AssertAssignable<SilpoOAuthProvider, OfficialOAuthClientProvider>>;
export type _AssertAiSdkContract = AssertTrue<AssertAssignable<SilpoOAuthProvider, AiSdkOAuthClientProvider>>;

const SAMPLE_BASE_URL = "https://app.silpo-test.ua";
const SAMPLE_ISSUER = "https://auth.silpo.ua";

function createHarness(options?: { now?: () => Date; key?: Buffer }) {
  const encryptionKey = options?.key ?? randomBytes(32);
  const repo = createInMemoryAuthRepository({ encryptionKey });
  const vaultStorage = createInMemoryTokenVaultStorage();
  const vault = createTokenVault({
    storage: vaultStorage,
    encryptionKey,
    now: options?.now ?? (() => new Date("2026-09-06T10:00:00Z")),
  });

  return { repo, vault, vaultStorage, encryptionKey };
}

describe("SilpoOAuthProvider conformance", () => {
  it("satisfies official MCP client provider interface", () => {
    expectTypeOf<SilpoOAuthProvider>().toMatchTypeOf<OfficialOAuthClientProvider>();
  });

  it("satisfies AI SDK MCP auth provider interface", () => {
    expectTypeOf<SilpoOAuthProvider>().toMatchTypeOf<AiSdkOAuthClientProvider>();
  });

  it("exports createSilpoOAuthProvider factory", () => {
    expectTypeOf(createSilpoOAuthProvider).toBeFunction();
    expectTypeOf(createSilpoOAuthProvider).returns.resolves.toMatchTypeOf<OfficialOAuthClientProvider>();
  });
});

describe("SilpoOAuthProvider implementation", () => {
  it("persists PKCE code verifier and reconstructs it on a fresh provider instance", async () => {
    const { repo, vault } = createHarness();
    const now = new Date("2026-09-06T10:00:00Z");
    const session = await repo.createPendingSession({
      handleHash: "a".repeat(64),
      now,
      expiresAt: new Date(now.getTime() + 600000),
    });
    await repo.beginFlow({
      userId: session.userId,
      bindingHash: session.handleHash,
      flowId: "flow-1",
      state: "state-123",
      now,
      expiresAt: session.expiresAt,
    });

    const provider1 = await createSilpoOAuthProvider(session.userId, {
      vault,
      repository: repo,
      publicBaseUrl: SAMPLE_BASE_URL,
      now: () => now,
    });

    await provider1.saveCodeVerifier("synthetic-code-verifier-s256");

    // Fresh provider instance over the same repository
    const provider2 = await createSilpoOAuthProvider(session.userId, {
      vault,
      repository: repo,
      publicBaseUrl: SAMPLE_BASE_URL,
      now: () => now,
    });

    expect(await provider2.codeVerifier()).toBe("synthetic-code-verifier-s256");

    // Raw state is encrypted: does not contain plaintext verifier
    const raw = repo.rawState(session.userId);
    expect(raw?.ciphertext.includes("synthetic-code-verifier-s256")).toBe(false);
  });

  it("saves client registration with client secret before any vault tokens exist", async () => {
    const { repo, vault, vaultStorage } = createHarness();
    const now = new Date("2026-09-06T10:00:00Z");
    const session = await repo.createPendingSession({
      handleHash: "a".repeat(64),
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

    const provider1 = await createSilpoOAuthProvider(session.userId, {
      vault,
      repository: repo,
      publicBaseUrl: SAMPLE_BASE_URL,
      now: () => now,
    });

    const clientInfo: StoredOAuthClientInformation = {
      client_id: "dyn-client-id-1",
      client_secret: "super-secret-client-secret",
      client_id_issued_at: 1725600000,
      client_secret_expires_at: 0,
      token_endpoint_auth_method: "client_secret_post",
      issuer: SAMPLE_ISSUER,
    };

    await provider1.saveClientInformation?.(clientInfo, { issuer: SAMPLE_ISSUER });

    // Vault should not have any token rows yet
    expect(vaultStorage.raw(session.userId)).toHaveLength(0);

    // Fresh provider reconstructs client information with matching issuer
    const provider2 = await createSilpoOAuthProvider(session.userId, {
      vault,
      repository: repo,
      publicBaseUrl: SAMPLE_BASE_URL,
      now: () => now,
    });

    const loaded = await provider2.clientInformation({ issuer: SAMPLE_ISSUER });
    expect(loaded?.client_id).toBe("dyn-client-id-1");
    expect(loaded?.client_secret).toBe("super-secret-client-secret");
    expect(loaded?.issuer).toBe(SAMPLE_ISSUER);

    // Mismatched issuer returns undefined
    expect(await provider2.clientInformation({ issuer: "https://evil.issuer.com" })).toBeUndefined();
  });

  it("derives exact redirect URL and captures authorization redirect", async () => {
    const { repo, vault } = createHarness();
    const now = new Date("2026-09-06T10:00:00Z");
    const session = await repo.createPendingSession({
      handleHash: "a".repeat(64),
      now,
      expiresAt: new Date(now.getTime() + 600000),
    });

    const provider = await createSilpoOAuthProvider(session.userId, {
      vault,
      repository: repo,
      publicBaseUrl: "https://portal.silpo-app.ua",
      now: () => now,
    });

    expect(provider.redirectUrl?.toString()).toBe("https://portal.silpo-app.ua/api/auth/silpo/callback");
    expect(provider.clientMetadata.redirect_uris[0].toString()).toBe(
      "https://portal.silpo-app.ua/api/auth/silpo/callback",
    );

    // Capture auth URL
    expect(provider.authorizationUrl()).toBeNull();
    const authUrl = new URL("https://auth.silpo.ua/oauth2/auth?client_id=xyz&response_type=code");
    await provider.redirectToAuthorization(authUrl);
    expect(provider.authorizationUrl()?.toString()).toBe(authUrl.toString());
  });

  it("rejects ambiguous publicBaseUrl with query, fragment, credentials, or path", async () => {
    const { repo, vault } = createHarness();
    const now = new Date("2026-09-06T10:00:00Z");
    const session = await repo.createPendingSession({
      handleHash: "a".repeat(64),
      now,
      expiresAt: new Date(now.getTime() + 600000),
    });

    await expect(
      createSilpoOAuthProvider(session.userId, {
        vault,
        repository: repo,
        publicBaseUrl: "https://portal.silpo-app.ua/subpath",
        now: () => now,
      }),
    ).rejects.toThrow("invalid_public_base_url");

    await expect(
      createSilpoOAuthProvider(session.userId, {
        vault,
        repository: repo,
        publicBaseUrl: "https://portal.silpo-app.ua?query=1",
        now: () => now,
      }),
    ).rejects.toThrow("invalid_public_base_url");

    await expect(
      createSilpoOAuthProvider(session.userId, {
        vault,
        repository: repo,
        publicBaseUrl: "https://portal.silpo-app.ua#fragment",
        now: () => now,
      }),
    ).rejects.toThrow("invalid_public_base_url");
  });

  it("manages token lifecycle, validates token type, and respects grant kinds for refresh tokens", async () => {
    let currentTime = new Date("2026-09-06T10:00:00Z");
    const { repo, vault } = createHarness({ now: () => currentTime });
    const session = await repo.createPendingSession({
      handleHash: "a".repeat(64),
      now: currentTime,
      expiresAt: new Date(currentTime.getTime() + 600000),
    });
    await repo.beginFlow({
      userId: session.userId,
      bindingHash: session.handleHash,
      flowId: "flow-1",
      state: "state-1",
      now: currentTime,
      expiresAt: session.expiresAt,
    });

    const provider = await createSilpoOAuthProvider(session.userId, {
      vault,
      repository: repo,
      publicBaseUrl: SAMPLE_BASE_URL,
      now: () => currentTime,
    });

    // Save client info first
    await provider.saveClientInformation?.({
      client_id: "client-1",
      client_secret: "secret-1",
      issuer: SAMPLE_ISSUER,
    });

    // Rejects non-Bearer token type
    await expect(
      provider.saveTokens({
        access_token: "tok-1",
        token_type: "mac",
        expires_in: 3600,
        issuer: SAMPLE_ISSUER,
      }),
    ).rejects.toThrow("invalid_token_type");

    // Initial grant saves tokens with refresh token
    provider.setGrantKind("authorization_code");
    await provider.saveTokens({
      access_token: "tok-initial",
      token_type: "Bearer",
      refresh_token: "ref-initial",
      expires_in: 3600,
      scope: "cart:read",
      issuer: SAMPLE_ISSUER,
    });

    const storedTokens = await provider.tokens();
    expect(storedTokens?.access_token).toBe("tok-initial");
    expect(storedTokens?.refresh_token).toBe("ref-initial");
    expect(storedTokens?.expires_in).toBe(3600);

    // Fast forward 1800s: remaining expires_in is 1800
    currentTime = new Date("2026-09-06T10:30:00Z");
    const midTokens = await provider.tokens();
    expect(midTokens?.expires_in).toBe(1800);

    // Refresh grant where server omits replacement refresh token: preserves old one
    provider.setGrantKind("refresh_token");
    await provider.saveTokens({
      access_token: "tok-refreshed",
      token_type: "Bearer",
      expires_in: 3600,
      issuer: SAMPLE_ISSUER,
    });

    const afterRefreshTokens = await provider.tokens();
    expect(afterRefreshTokens?.access_token).toBe("tok-refreshed");
    expect(afterRefreshTokens?.refresh_token).toBe("ref-initial"); // preserved!

    // Fresh authorization code grant that omits refresh token does NOT preserve old one
    provider.setGrantKind("authorization_code");
    await provider.saveTokens({
      access_token: "tok-authcode-2",
      token_type: "Bearer",
      expires_in: 3600,
      issuer: SAMPLE_ISSUER,
    });

    const afterAuthCodeTokens = await provider.tokens();
    expect(afterAuthCodeTokens?.access_token).toBe("tok-authcode-2");
    expect(afterAuthCodeTokens?.refresh_token).toBeUndefined(); // NOT preserved
  });

  it("persists and restores RFC 9728 and AS discovery state", async () => {
    const { repo, vault } = createHarness();
    const now = new Date("2026-09-06T10:00:00Z");
    const session = await repo.createPendingSession({
      handleHash: "a".repeat(64),
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

    const provider1 = await createSilpoOAuthProvider(session.userId, {
      vault,
      repository: repo,
      publicBaseUrl: SAMPLE_BASE_URL,
      now: () => now,
    });

    const discovery: OAuthDiscoveryState = {
      authorizationServerUrl: SAMPLE_ISSUER,
      resourceMetadataUrl: "https://api.silpo.ua/.well-known/oauth-protected-resource",
      authorizationServerMetadata: {
        issuer: SAMPLE_ISSUER,
        authorization_endpoint: "https://auth.silpo.ua/authorize",
        token_endpoint: "https://auth.silpo.ua/token",
        registration_endpoint: "https://auth.silpo.ua/register",
        scopes_supported: ["cart:read", "cart:write"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        authorization_response_iss_parameter_supported: true,
        response_types_supported: ["code"],
      },
      resourceMetadata: { resource: "https://api.silpo.ua/mcp" },
    };

    await provider1.saveDiscoveryState?.(discovery);

    // Fresh provider restores discovery
    const provider2 = await createSilpoOAuthProvider(session.userId, {
      vault,
      repository: repo,
      publicBaseUrl: SAMPLE_BASE_URL,
      now: () => now,
    });

    const restored = await provider2.discoveryState?.();
    expect(restored?.authorizationServerUrl).toBe(SAMPLE_ISSUER);
    expect(restored?.authorizationServerMetadata?.issuer).toBe(SAMPLE_ISSUER);
    expect(restored?.authorizationServerMetadata?.authorization_endpoint).toBe("https://auth.silpo.ua/authorize");
    expect(restored?.authorizationServerMetadata?.token_endpoint).toBe("https://auth.silpo.ua/token");
    expect(restored?.authorizationServerMetadata?.registration_endpoint).toBe("https://auth.silpo.ua/register");
    expect(restored?.authorizationServerMetadata?.authorization_response_iss_parameter_supported).toBe(true);
  });

  it("handles credential invalidation by scope", async () => {
    const { repo, vault } = createHarness();
    const now = new Date("2026-09-06T10:00:00Z");
    const session = await repo.createPendingSession({
      handleHash: "a".repeat(64),
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

    await provider.saveCodeVerifier("verifier-1");
    await provider.saveClientInformation?.({
      client_id: "c1",
      issuer: SAMPLE_ISSUER,
    });
    await provider.saveTokens({
      access_token: "a1",
      token_type: "Bearer",
      issuer: SAMPLE_ISSUER,
    });

    // Invalidate tokens only
    await provider.invalidateCredentials?.("tokens");
    expect(await provider.tokens()).toBeUndefined();
    expect(await provider.codeVerifier()).toBe("verifier-1");

    // Invalidate verifier only
    await provider.invalidateCredentials?.("verifier");
    await expect(provider.codeVerifier()).rejects.toThrow();

    // Invalidate client (also clears tokens if any)
    await provider.invalidateCredentials?.("client");
    expect(await provider.clientInformation({ issuer: SAMPLE_ISSUER })).toBeUndefined();
  });
});
