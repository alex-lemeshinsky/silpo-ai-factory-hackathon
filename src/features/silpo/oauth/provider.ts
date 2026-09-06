import type {
  OAuthClientInformationContext,
  OAuthClientMetadata as OfficialOAuthClientMetadata,
  OAuthClientProvider as OfficialOAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type {
  OAuthClientInformation as AiSdkOAuthClientInformation,
  OAuthClientMetadata as AiSdkOAuthClientMetadata,
  OAuthTokens as AiSdkOAuthTokens,
} from "@ai-sdk/mcp";

import { getDbClient } from "@/db/client";
import { getServerEnv } from "@/lib/env";
import {
  createPostgresAuthRepository,
  type AuthRepository,
  type ClientRegistration,
  type DiscoveryBinding,
  type OAuthState,
} from "./auth-repository";
import {
  createPostgresTokenVaultStorage,
  createTokenVault,
  type TokenVault,
} from "./token-vault";

export interface SilpoOAuthProviderOptions {
  vault?: TokenVault;
  repository?: AuthRepository;
  publicBaseUrl?: string;
  now?: () => Date;
  claimedState?: OAuthState;
}

export type SilpoOAuthProvider = OfficialOAuthClientProvider & {
  redirectUrl: string | URL;
  clientMetadata: OfficialOAuthClientMetadata & AiSdkOAuthClientMetadata;
  authorizationUrl(): URL | null;
  currentState(): OAuthState;
  setGrantKind(kind: "authorization_code" | "refresh_token"): void;
  tokens(
    ctx?: OAuthClientInformationContext,
  ): Promise<(StoredOAuthTokens & AiSdkOAuthTokens) | undefined>;
  saveTokens(
    tokens: StoredOAuthTokens | AiSdkOAuthTokens,
    ctx?: OAuthClientInformationContext,
  ): Promise<void>;
  clientInformation(
    ctx?: OAuthClientInformationContext,
  ): (StoredOAuthClientInformation & AiSdkOAuthClientInformation) | undefined;
  saveClientInformation(
    clientInformation: StoredOAuthClientInformation | AiSdkOAuthClientInformation,
    ctx?: OAuthClientInformationContext,
  ): Promise<void>;
  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void>;
};

function validatePublicBaseUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("invalid_public_base_url");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("invalid_public_base_url");
  }

  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    throw new Error("invalid_public_base_url");
  }

  if (
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("invalid_public_base_url");
  }

  return parsed.origin;
}

export async function createSilpoOAuthProvider(
  userId: string,
  options?: SilpoOAuthProviderOptions,
): Promise<SilpoOAuthProvider> {
  const now = options?.now ?? (() => new Date());

  const baseUrl = options?.publicBaseUrl
    ? validatePublicBaseUrl(options.publicBaseUrl)
    : validatePublicBaseUrl(getServerEnv().PUBLIC_BASE_URL);

  const vault =
    options?.vault ??
    createTokenVault({
      storage: createPostgresTokenVaultStorage(getDbClient()),
    });

  const repository =
    options?.repository ??
    createPostgresAuthRepository({
      db: getDbClient(),
      encryptionKey: Buffer.from(getServerEnv().TOKEN_ENCRYPTION_KEY, "base64"),
    });

  let state: OAuthState;
  if (options?.claimedState) {
    state = options.claimedState;
  } else {
    const read = await repository.readState(userId);
    if (!read) {
      state = {
        userId,
        version: 1,
        phase: "idle",
        bindingHash: null,
        flowExpiresAt: null,
        payload: {
          version: 1,
          flowId: null,
          state: null,
          verifier: null,
          registration: null,
          discovery: null,
        },
      };
    } else {
      state = read;
    }
  }

  let capturedAuthUrl: URL | null = null;
  let currentGrantKind: "authorization_code" | "refresh_token" = "authorization_code";

  const callbackUrl = new URL("/api/auth/silpo/callback", baseUrl).toString();

  const provider: SilpoOAuthProvider = {
    get redirectUrl(): string {
      return callbackUrl;
    },

    get clientMetadata(): OfficialOAuthClientMetadata & AiSdkOAuthClientMetadata {
      return {
        redirect_uris: [callbackUrl],
        client_name: "Inventory Autopilot",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post",
        application_type: "web",
      };
    },

    state(): string {
      if (!state.payload.state) {
        throw new Error("oauth_state_missing");
      }
      return state.payload.state;
    },

    async codeVerifier(): Promise<string> {
      if (!state.payload.verifier) {
        throw new Error("code_verifier_missing");
      }
      return state.payload.verifier;
    },

    async saveCodeVerifier(codeVerifier: string): Promise<void> {
      state.payload.verifier = codeVerifier;
      const saved = await repository.saveState({
        userId,
        expectedVersion: state.version,
        payload: state.payload,
      });
      state = saved;
    },

    redirectToAuthorization(authorizationUrl: URL): void {
      capturedAuthUrl = authorizationUrl;
    },

    authorizationUrl(): URL | null {
      return capturedAuthUrl;
    },

    currentState(): OAuthState {
      return state;
    },

    setGrantKind(kind: "authorization_code" | "refresh_token"): void {
      currentGrantKind = kind;
    },

    clientInformation(
      ctx?: OAuthClientInformationContext,
    ): (StoredOAuthClientInformation & AiSdkOAuthClientInformation) | undefined {
      const reg = state.payload.registration;
      if (!reg) return undefined;
      if (ctx?.issuer && reg.issuer !== ctx.issuer) return undefined;

      return {
        client_id: reg.clientId,
        client_secret: reg.clientSecret ?? undefined,
        client_id_issued_at: reg.clientIdIssuedAt ?? undefined,
        client_secret_expires_at: reg.clientSecretExpiresAt ?? undefined,
        token_endpoint_auth_method: reg.tokenEndpointAuthMethod,
        issuer: reg.issuer,
      };
    },

    async saveClientInformation(
      clientInformation: StoredOAuthClientInformation | AiSdkOAuthClientInformation,
      ctx?: OAuthClientInformationContext,
    ): Promise<void> {
      const issuer =
        ("issuer" in clientInformation && clientInformation.issuer) ||
        ctx?.issuer ||
        state.payload.discovery?.issuer;
      if (!issuer) {
        throw new Error("missing_issuer");
      }

      const tokenEndpointAuthMethod =
        "token_endpoint_auth_method" in clientInformation &&
        typeof clientInformation.token_endpoint_auth_method === "string"
          ? (clientInformation.token_endpoint_auth_method as
              | "none"
              | "client_secret_post"
              | "client_secret_basic")
          : "client_secret_post";

      const reg: ClientRegistration = {
        clientId: clientInformation.client_id,
        clientSecret: clientInformation.client_secret ?? null,
        clientIdIssuedAt: clientInformation.client_id_issued_at ?? null,
        clientSecretExpiresAt: clientInformation.client_secret_expires_at ?? null,
        tokenEndpointAuthMethod,
        issuer,
      };

      state.payload.registration = reg;
      const saved = await repository.saveState({
        userId,
        expectedVersion: state.version,
        payload: state.payload,
      });
      state = saved;
    },

    async tokens(
      ctx?: OAuthClientInformationContext,
    ): Promise<(StoredOAuthTokens & AiSdkOAuthTokens) | undefined> {
      const stored = await vault.get(userId);
      if (!stored) return undefined;

      const currentIssuer =
        state.payload.discovery?.issuer ?? state.payload.registration?.issuer;
      if (ctx?.issuer && currentIssuer && ctx.issuer !== currentIssuer) {
        return undefined;
      }

      let expiresIn: number | undefined = undefined;
      if (stored.expiresAt) {
        const remainingSeconds = Math.floor(
          (stored.expiresAt.getTime() - now().getTime()) / 1000,
        );
        expiresIn = Math.max(0, remainingSeconds);
      }

      return {
        access_token: stored.accessToken,
        token_type: "Bearer",
        refresh_token: stored.refreshToken ?? undefined,
        expires_in: expiresIn,
        scope: stored.scope ?? undefined,
        issuer: currentIssuer,
      };
    },

    async saveTokens(
      tokens: StoredOAuthTokens | AiSdkOAuthTokens,
    ): Promise<void> {
      if (tokens.token_type.toLowerCase() !== "bearer") {
        throw new Error("invalid_token_type");
      }

      let refreshTokenToStore: string | null = tokens.refresh_token ?? null;
      if (currentGrantKind === "refresh_token" && !refreshTokenToStore) {
        const existing = await vault.get(userId);
        if (existing?.refreshToken) {
          refreshTokenToStore = existing.refreshToken;
        }
      }

      let expiresAt: Date | null = null;
      if (tokens.expires_in !== undefined) {
        if (!Number.isFinite(tokens.expires_in) || tokens.expires_in < 0) {
          throw new Error("invalid_token_expiry");
        }
        expiresAt = new Date(now().getTime() + tokens.expires_in * 1000);
      }

      await vault.put(userId, {
        accessToken: tokens.access_token,
        refreshToken: refreshTokenToStore,
        clientSecret: state.payload.registration?.clientSecret ?? null,
        expiresAt,
        scope: tokens.scope ?? null,
        oauthMetadata: null,
      });

      currentGrantKind = "authorization_code";
    },

    discoveryState(): OAuthDiscoveryState | undefined {
      const disc = state.payload.discovery;
      if (!disc) return undefined;

      return {
        authorizationServerUrl: disc.issuer,
        resourceMetadataUrl: disc.resourceMetadataUrl ?? undefined,
        authorizationServerMetadata: {
          issuer: disc.issuer,
          authorization_endpoint: disc.authorizationEndpoint,
          token_endpoint: disc.tokenEndpoint,
          registration_endpoint: disc.registrationEndpoint ?? undefined,
          scopes_supported: disc.scopesSupported,
          code_challenge_methods_supported: disc.codeChallengeMethodsSupported,
          token_endpoint_auth_methods_supported: disc.tokenEndpointAuthMethodsSupported,
          authorization_response_iss_parameter_supported: disc.responseIssuerRequired,
          response_types_supported: ["code"],
        },
        resourceMetadata: {
          resource: disc.resource,
        },
      };
    },

    async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
      const asMeta = discoveryState.authorizationServerMetadata;
      const issuer = asMeta?.issuer ?? discoveryState.authorizationServerUrl;
      const authorizationEndpoint = asMeta?.authorization_endpoint
        ? String(asMeta.authorization_endpoint)
        : `${issuer}/oauth2/auth`;
      const tokenEndpoint = asMeta?.token_endpoint
        ? String(asMeta.token_endpoint)
        : `${issuer}/oauth2/token`;
      const registrationEndpoint = asMeta?.registration_endpoint
        ? String(asMeta.registration_endpoint)
        : null;

      const binding: DiscoveryBinding = {
        issuer,
        authorizationEndpoint,
        tokenEndpoint,
        registrationEndpoint,
        resource: discoveryState.resourceMetadata?.resource ?? "https://api.silpo.ua/mcp",
        resourceMetadataUrl: discoveryState.resourceMetadataUrl ?? null,
        scopesSupported: asMeta?.scopes_supported ?? [],
        codeChallengeMethodsSupported: asMeta?.code_challenge_methods_supported ?? [],
        tokenEndpointAuthMethodsSupported: asMeta?.token_endpoint_auth_methods_supported ?? [],
        responseIssuerRequired: Boolean(asMeta?.authorization_response_iss_parameter_supported),
      };

      state.payload.discovery = binding;
      const saved = await repository.saveState({
        userId,
        expectedVersion: state.version,
        payload: state.payload,
      });
      state = saved;
    },

    async invalidateCredentials(
      scope: "all" | "client" | "tokens" | "verifier" | "discovery",
    ): Promise<void> {
      if (scope === "tokens") {
        await vault.clear(userId);
        return;
      }
      if (scope === "verifier") {
        state.payload.verifier = null;
        const saved = await repository.saveState({
          userId,
          expectedVersion: state.version,
          payload: state.payload,
        });
        state = saved;
        return;
      }
      if (scope === "discovery") {
        state.payload.discovery = null;
        const saved = await repository.saveState({
          userId,
          expectedVersion: state.version,
          payload: state.payload,
        });
        state = saved;
        return;
      }
      if (scope === "client") {
        state.payload.registration = null;
        await vault.clear(userId);
        const saved = await repository.saveState({
          userId,
          expectedVersion: state.version,
          payload: state.payload,
        });
        state = saved;
        return;
      }
      if (scope === "all") {
        state.payload.verifier = null;
        state.payload.discovery = null;
        state.payload.registration = null;
        await vault.clear(userId);
        const saved = await repository.saveState({
          userId,
          expectedVersion: state.version,
          payload: state.payload,
        });
        state = saved;
        return;
      }
    },
  };

  return provider;
}
