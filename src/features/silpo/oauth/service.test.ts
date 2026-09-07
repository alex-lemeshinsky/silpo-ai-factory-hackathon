import { createHash, randomBytes } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { ServerEnv } from "@/lib/env";
import type { AppError, Result } from "@/lib/result";
import { createInMemoryAuthRepository, type OAuthState } from "./auth-repository";
import { createInMemoryTokenVaultStorage, createTokenVault } from "./token-vault";
import { createSilpoOAuthProvider, type SilpoOAuthProvider } from "./provider";
import type { OAuthConnection, OAuthConnectionFactory } from "./transport";
import {
  createSilpoOAuthService,
  resolveSilpoSession,
  type CallbackInput,
  type OAuthCompletion,
  type OAuthFailure,
  type SilpoOAuthService,
} from "./service";

const SAMPLE_BASE_URL = "https://app.silpo-test.ua";
const SAMPLE_ISSUER = "https://auth.silpo.ua";

function makeEnv(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://user:pass@localhost:5432/testdb",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    GOOGLE_GENERATIVE_AI_API_KEY: "test-api-key",
    AGENT_MODEL: "gemini-3.7-flash",
    DATA_MODE: "live",
    PUBLIC_BASE_URL: SAMPLE_BASE_URL,
    ...overrides,
  };
}

class ConnectionSpy implements OAuthConnection {
  provider?: SilpoOAuthProvider;
  beginCalls = 0;
  finishAuthCalls: { code: string; issuer?: string }[] = [];
  probeToolsCalls = 0;
  closeCalls = 0;

  beginResult: "authorized" | "redirect" = "redirect";
  beginError: Error | null = null;
  finishAuthError: Error | null = null;
  probeToolsError: Error | null = null;

  async begin(): Promise<"authorized" | "redirect"> {
    this.beginCalls += 1;
    if (this.beginError) throw this.beginError;
    if (this.beginResult === "redirect" && this.provider) {
      this.provider.redirectToAuthorization(new URL(`${SAMPLE_ISSUER}/authorize?state=sample`));
    }
    return this.beginResult;
  }

  async finishAuth(code: string, issuer?: string): Promise<void> {
    this.finishAuthCalls.push({ code, issuer });
    if (this.finishAuthError) throw this.finishAuthError;
  }

  async probeTools(): Promise<void> {
    this.probeToolsCalls += 1;
    if (this.probeToolsError) throw this.probeToolsError;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

describe("Silpo OAuth Service", () => {
  it("conforms to SilpoOAuthService interface", () => {
    expectTypeOf<SilpoOAuthService>().toMatchTypeOf<{
      start(handle: string | null, correlationId: string): Promise<Result<OAuthCompletion, OAuthFailure>>;
      callback(input: CallbackInput, correlationId: string): Promise<Result<OAuthCompletion, OAuthFailure>>;
      resolveSession(handle: string | null, correlationId: string): Promise<Result<{ userId: string; expiresAt: Date }, AppError>>;
    }>();
  });

  async function createServiceHarness(options?: {
    now?: Date;
    env?: ServerEnv;
    connectionSpy?: ConnectionSpy;
  }) {
    const encryptionKey = Buffer.alloc(32, 7);
    const repo = createInMemoryAuthRepository({ encryptionKey });
    const vaultStorage = createInMemoryTokenVaultStorage();
    const now = options?.now ?? new Date("2026-09-06T12:00:00Z");
    const vault = createTokenVault({
      storage: vaultStorage,
      encryptionKey,
      now: () => now,
    });
    const env = options?.env ?? makeEnv();
    const spy = options?.connectionSpy ?? new ConnectionSpy();

    let handleCounter = 0;
    const randomHandle = () => `test-handle-${++handleCounter}-${randomBytes(16).toString("hex")}`;

    const createProvider = async (userId: string, claimedState?: OAuthState) => {
      return createSilpoOAuthProvider(userId, {
        vault,
        repository: repo,
        publicBaseUrl: env.PUBLIC_BASE_URL,
        now: () => now,
        claimedState,
      });
    };

    const connect: OAuthConnectionFactory = (p) => { spy.provider = p; return spy; };

    const service = createSilpoOAuthService({
      repository: repo,
      createProvider,
      connect,
      env,
      now: () => now,
      randomHandle,
    });

    return { service, repo, vault, env, spy, now, randomHandle };
  }

  describe("start()", () => {
    it("starts fresh login flow when no session exists: creates pending session + flow, calls begin(), redirects to authorization URL with 10-min cookie", async () => {
      const spy = new ConnectionSpy();
      const { service, repo } = await createServiceHarness({ connectionSpy: spy });

      const result = await service.start(null, "corr-start-1");
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(spy.beginCalls).toBe(1);
      expect(spy.closeCalls).toBe(1);
      expect(result.value.location).toContain("authorize");
      expect(result.value.cookie).toBeDefined();
      expect(result.value.cookie?.maxAge).toBe(600); // 10 minutes

      // Verify pending session in repo
      const handleHash = createHash("sha256").update(result.value.cookie!.value).digest("hex");
      const session = await repo.findSession(handleHash, new Date("2026-09-06T12:00:00Z"));
      expect(session).not.toBeNull();
      expect(session?.status).toBe("pending");
    });

    it("already authorized: calls begin() which returns authorized, calls probeTools(), activates session with new 7-day handle and redirects to /", async () => {
      const spy = new ConnectionSpy();
      spy.beginResult = "authorized";
      const { service, repo } = await createServiceHarness({ connectionSpy: spy });

      const result = await service.start(null, "corr-start-2");
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(spy.beginCalls).toBe(1);
      expect(spy.probeToolsCalls).toBe(1);
      expect(spy.closeCalls).toBe(1);
      expect(result.value.location).toBe("/");
      expect(result.value.cookie).toBeDefined();
      expect(result.value.cookie?.maxAge).toBe(7 * 24 * 3600); // 7 days

      // Session in repo is authenticated
      const newHash = createHash("sha256").update(result.value.cookie!.value).digest("hex");
      const session = await repo.findSession(newHash, new Date("2026-09-06T12:00:00Z"));
      expect(session).not.toBeNull();
      expect(session?.status).toBe("authenticated");
    });

    it("returns 409 conflict when an existing flow is processing and unexpired", async () => {
      const now = new Date("2026-09-06T12:00:00Z");
      const { service, repo } = await createServiceHarness({ now });

      // Create an existing session
      const handle = "existing-handle-123";
      const handleHash = createHash("sha256").update(handle).digest("hex");
      const session = await repo.createPendingSession({
        handleHash,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      // Begin a flow and claim it to put it into 'processing'
      const state = await repo.beginFlow({
        userId: session.userId,
        bindingHash: handleHash,
        flowId: "flow-1",
        state: "state-1",
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });
      await repo.claimFlow({
        userId: session.userId,
        bindingHash: handleHash,
        expectedVersion: state.version,
        now,
      });

      // Attempt start with the same session
      const result = await service.start(handle, "corr-start-3");
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.status).toBe(409);
      expect(result.error.error.code).toBe("unauthorized");
      expect(result.error.error.message).toContain("Вхід уже обробляється");
      expect(result.error.clearCookie).toBe(false);
    });

    it("returns 404 without repository or network work in demo mode", async () => {
      const spy = new ConnectionSpy();
      const env = makeEnv({ DATA_MODE: "demo" });
      const { service } = await createServiceHarness({ env, connectionSpy: spy });

      const result = await service.start(null, "corr-demo-start");
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.status).toBe(404);
      expect(spy.beginCalls).toBe(0);
    });

    it("closes connection when begin() throws an error", async () => {
      const spy = new ConnectionSpy();
      spy.beginError = new Error("network_error");
      const { service } = await createServiceHarness({ connectionSpy: spy });

      const result = await service.start(null, "corr-start-err");
      expect(result.ok).toBe(false);
      expect(spy.closeCalls).toBe(1);
    });
  });

  describe("callback()", () => {
    it("valid success callback: claims flow, calls finishAuth, calls probeTools, rotates session with activateSession, returns 303 to / with 7-day cookie", async () => {
      const now = new Date("2026-09-06T12:00:00Z");
      const spy = new ConnectionSpy();
      const { service, repo } = await createServiceHarness({ now, connectionSpy: spy });

      // Seed a pending session and flow
      const handle = "pending-cookie-handle-1";
      const handleHash = createHash("sha256").update(handle).digest("hex");
      const session = await repo.createPendingSession({
        handleHash,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      await repo.beginFlow({
        userId: session.userId,
        bindingHash: handleHash,
        flowId: "flow-100",
        state: "state-secret-abc",
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      const result = await service.callback(
        {
          handle,
          state: "state-secret-abc",
          code: "auth-code-999",
          issuer: SAMPLE_ISSUER,
          denied: false,
        },
        "corr-cb-1",
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(spy.finishAuthCalls.length).toBe(1);
      expect(spy.finishAuthCalls[0]).toEqual({ code: "auth-code-999", issuer: SAMPLE_ISSUER });
      expect(spy.probeToolsCalls).toBe(1);
      expect(spy.closeCalls).toBe(1);
      expect(result.value.location).toBe("/");
      expect(result.value.cookie?.maxAge).toBe(7 * 24 * 3600);

      // Verify old session revoked and new session authenticated
      const oldSession = await repo.findSession(handleHash, now);
      expect(oldSession).toBeNull(); // findSession filters out revoked

      const newHash = createHash("sha256").update(result.value.cookie!.value).digest("hex");
      const newSession = await repo.findSession(newHash, now);
      expect(newSession).not.toBeNull();
      expect(newSession?.status).toBe("authenticated");
    });

    it("reauthorization: when authenticated user calls start() and completes callback(), retains same userId and revokes previous session handle", async () => {
      const now = new Date("2026-09-06T12:00:00Z");
      const spy = new ConnectionSpy();
      const { service, repo } = await createServiceHarness({ now, connectionSpy: spy });

      // 1. Establish an existing authenticated session for user
      const initialHandle = "authenticated-cookie-handle-0";
      const initialHandleHash = createHash("sha256").update(initialHandle).digest("hex");
      const initialSession = await repo.createPendingSession({
        handleHash: initialHandleHash,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      const initialFlow = await repo.beginFlow({
        userId: initialSession.userId,
        bindingHash: initialHandleHash,
        flowId: "flow-init",
        state: "state-init",
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      const claimedInit = await repo.claimFlow({
        userId: initialSession.userId,
        bindingHash: initialHandleHash,
        expectedVersion: initialFlow.version,
        now,
      });

      const existingAuthHandle = "authenticated-cookie-handle-existing";
      const existingAuthHash = createHash("sha256").update(existingAuthHandle).digest("hex");
      await repo.activateSession({
        oldHandleHash: initialHandleHash,
        newHandleHash: existingAuthHash,
        userId: initialSession.userId,
        expectedFlowVersion: claimedInit!.version,
        now,
        expiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
      });

      const existingResolved = await service.resolveSession(existingAuthHandle, "corr-pre");
      expect(existingResolved.ok).toBe(true);
      if (!existingResolved.ok) return;
      const originalUserId = existingResolved.value.userId;

      // 2. Authenticated user initiates reauthorization (/start)
      const startResult = await service.start(existingAuthHandle, "corr-reauth-start");
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const pendingHandle = startResult.value.cookie!.value;
      const pendingHash = createHash("sha256").update(pendingHandle).digest("hex");

      // Verify the pending session was created for the SAME userId
      const pendingSession = await repo.findSession(pendingHash, now);
      expect(pendingSession).not.toBeNull();
      expect(pendingSession?.userId).toBe(originalUserId);

      // Read actual state from flowState
      const flowState = await repo.readState(originalUserId);
      expect(flowState).not.toBeNull();
      const actualState = flowState!.payload.state!;

      // 3. User completes callback (/callback)
      const callbackResult = await service.callback(
        {
          handle: pendingHandle,
          state: actualState,
          code: "reauth-auth-code-123",
          issuer: SAMPLE_ISSUER,
          denied: false,
        },
        "corr-reauth-cb",
      );

      expect(callbackResult.ok).toBe(true);
      if (!callbackResult.ok) return;

      const finalHandle = callbackResult.value.cookie!.value;
      const finalResolved = await service.resolveSession(finalHandle, "corr-reauth-final");
      expect(finalResolved.ok).toBe(true);
      if (!finalResolved.ok) return;

      // Final authenticated session has the EXACT SAME userId as before reauthorization
      expect(finalResolved.value.userId).toBe(originalUserId);

      // Previous pending session handle is revoked
      const oldPendingSession = await repo.findSession(pendingHash, now);
      expect(oldPendingSession).toBeNull();

      // O9-01: the authenticated handle that initiated reauthorization must not
      // outlive the rotation, or a copied cookie stays valid for seven days.
      expect(await repo.findSession(existingAuthHash, now)).toBeNull();
      const staleResolved = await service.resolveSession(existingAuthHandle, "corr-reauth-stale");
      expect(staleResolved.ok).toBe(false);
    });

    it("state mismatch: timing-safe comparison fails, does NOT call finishAuth or activateSession, does NOT consume flow, clearCookie is false", async () => {
      const now = new Date("2026-09-06T12:00:00Z");
      const spy = new ConnectionSpy();
      const { service, repo } = await createServiceHarness({ now, connectionSpy: spy });

      const handle = "pending-cookie-handle-2";
      const handleHash = createHash("sha256").update(handle).digest("hex");
      const session = await repo.createPendingSession({
        handleHash,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      await repo.beginFlow({
        userId: session.userId,
        bindingHash: handleHash,
        flowId: "flow-101",
        state: "correct-state-val",
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      const result = await service.callback(
        {
          handle,
          state: "wrong-state-val",
          code: "auth-code-999",
          denied: false,
        },
        "corr-cb-2",
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.status).toBe(400);
      expect(result.error.clearCookie).toBe(false);
      expect(spy.finishAuthCalls.length).toBe(0);

      // Pending flow was NOT consumed
      const flowState = await repo.readState(session.userId);
      expect(flowState?.phase).toBe("pending");
    });

    it("denial: finishes/clears flow without exchanging code and returns 401 with clearCookie=true", async () => {
      const now = new Date("2026-09-06T12:00:00Z");
      const spy = new ConnectionSpy();
      const { service, repo } = await createServiceHarness({ now, connectionSpy: spy });

      const handle = "pending-cookie-handle-3";
      const handleHash = createHash("sha256").update(handle).digest("hex");
      const session = await repo.createPendingSession({
        handleHash,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      await repo.beginFlow({
        userId: session.userId,
        bindingHash: handleHash,
        flowId: "flow-102",
        state: "correct-state-val",
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      const result = await service.callback(
        {
          handle,
          state: "correct-state-val",
          denied: true,
        },
        "corr-cb-3",
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.status).toBe(401);
      expect(result.error.clearCookie).toBe(true);
      expect(spy.finishAuthCalls.length).toBe(0);

      // Flow was reset to idle
      const flowState = await repo.readState(session.userId);
      expect(flowState?.phase).toBe("idle");
    });

    it("expired flow returns 401 unauthorized and clearCookie=true", async () => {
      const now = new Date("2026-09-06T12:00:00Z");
      const spy = new ConnectionSpy();
      const { service, repo } = await createServiceHarness({ now, connectionSpy: spy });

      const handle = "pending-cookie-handle-4";
      const handleHash = createHash("sha256").update(handle).digest("hex");
      const session = await repo.createPendingSession({
        handleHash,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      // Flow expired 1 second ago
      await repo.beginFlow({
        userId: session.userId,
        bindingHash: handleHash,
        flowId: "flow-103",
        state: "state-exp",
        now,
        expiresAt: new Date(now.getTime() - 1000),
      });

      const result = await service.callback(
        {
          handle,
          state: "state-exp",
          code: "auth-code-123",
          denied: false,
        },
        "corr-cb-4",
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.status).toBe(401);
      expect(result.error.clearCookie).toBe(true);
      expect(spy.finishAuthCalls.length).toBe(0);
    });

    it("duplicated callback (at-most-one claimant): second callback fails claimFlow, no second finishAuth or activation", async () => {
      const now = new Date("2026-09-06T12:00:00Z");
      const spy = new ConnectionSpy();
      const { service, repo } = await createServiceHarness({ now, connectionSpy: spy });

      const handle = "pending-cookie-handle-5";
      const handleHash = createHash("sha256").update(handle).digest("hex");
      const session = await repo.createPendingSession({
        handleHash,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      await repo.beginFlow({
        userId: session.userId,
        bindingHash: handleHash,
        flowId: "flow-104",
        state: "state-dup",
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      const input = {
        handle,
        state: "state-dup",
        code: "auth-code-dup",
        denied: false,
      };

      // First callback succeeds
      const first = await service.callback(input, "corr-cb-dup-1");
      expect(first.ok).toBe(true);
      expect(spy.finishAuthCalls.length).toBe(1);

      // Second callback fails
      const second = await service.callback(input, "corr-cb-dup-2");
      expect(second.ok).toBe(false);
      expect(spy.finishAuthCalls.length).toBe(1); // Still exactly 1
    });

    it("injected finishAuth failure closes connection and does not activate session", async () => {
      const now = new Date("2026-09-06T12:00:00Z");
      const spy = new ConnectionSpy();
      spy.finishAuthError = new Error("unauthorized");
      const { service, repo } = await createServiceHarness({ now, connectionSpy: spy });

      const handle = "pending-cookie-handle-6";
      const handleHash = createHash("sha256").update(handle).digest("hex");
      const session = await repo.createPendingSession({
        handleHash,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      await repo.beginFlow({
        userId: session.userId,
        bindingHash: handleHash,
        flowId: "flow-105",
        state: "state-err",
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      const result = await service.callback(
        {
          handle,
          state: "state-err",
          code: "auth-code-err",
          denied: false,
        },
        "corr-cb-err",
      );

      expect(result.ok).toBe(false);
      expect(spy.closeCalls).toBe(1);
    });

    it("wrong browser: callback with cookie handle for User B while flow belongs to User A returns 401 and does not call finishAuth or write tokens", async () => {
      const now = new Date("2026-09-06T12:00:00Z");
      const spy = new ConnectionSpy();
      const { service, repo, vault } = await createServiceHarness({ now, connectionSpy: spy });

      // User A starts flow
      const handleA = "pending-handle-user-A";
      const hashA = createHash("sha256").update(handleA).digest("hex");
      const sessionA = await repo.createPendingSession({
        handleHash: hashA,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });
      await repo.beginFlow({
        userId: sessionA.userId,
        bindingHash: hashA,
        flowId: "flow-A",
        state: "state-user-A",
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      // User B has a separate session
      const handleB = "pending-handle-user-B";
      const hashB = createHash("sha256").update(handleB).digest("hex");
      const sessionB = await repo.createPendingSession({
        handleHash: hashB,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      // Callback arrives in browser B (handleB) with state and code from User A's flow
      const result = await service.callback(
        {
          handle: handleB,
          state: "state-user-A",
          code: "auth-code-user-A",
          denied: false,
        },
        "corr-wrong-browser",
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.status).toBe(401);
      expect(spy.finishAuthCalls.length).toBe(0);

      // Verify no tokens in vault for either user
      expect(await vault.get(sessionA.userId)).toBeNull();
      expect(await vault.get(sessionB.userId)).toBeNull();
    });

    it("injected claimFlow failure returns 401 and does not call finishAuth or activateSession", async () => {
      const now = new Date("2026-09-06T12:00:00Z");
      const spy = new ConnectionSpy();
      const { service, repo } = await createServiceHarness({ now, connectionSpy: spy });

      const handle = "pending-cookie-claim-fail";
      const handleHash = createHash("sha256").update(handle).digest("hex");
      const session = await repo.createPendingSession({
        handleHash,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });
      await repo.beginFlow({
        userId: session.userId,
        bindingHash: handleHash,
        flowId: "flow-claim-fail",
        state: "state-claim-fail",
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      // Injected claimFlow failure: returns null
      repo.claimFlow = async () => null;

      const result = await service.callback(
        {
          handle,
          state: "state-claim-fail",
          code: "code-claim-fail",
          denied: false,
        },
        "corr-claim-fail",
      );

      expect(result.ok).toBe(false);
      expect(spy.finishAuthCalls.length).toBe(0);
    });

    it("injected vault.put failure closes connection, returns error, and does not activate session", async () => {
      const now = new Date("2026-09-06T12:00:00Z");
      const spy = new ConnectionSpy();
      spy.finishAuth = async () => {
        throw new Error("vault_storage_disk_full");
      };
      const { service, repo } = await createServiceHarness({ now, connectionSpy: spy });

      const handle = "pending-cookie-vault-fail";
      const handleHash = createHash("sha256").update(handle).digest("hex");
      const session = await repo.createPendingSession({
        handleHash,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });
      await repo.beginFlow({
        userId: session.userId,
        bindingHash: handleHash,
        flowId: "flow-vault-fail",
        state: "state-vault-fail",
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      const result = await service.callback(
        {
          handle,
          state: "state-vault-fail",
          code: "code-vault-fail",
          denied: false,
        },
        "corr-vault-fail",
      );

      expect(result.ok).toBe(false);
      expect(spy.closeCalls).toBe(1);
      const state = await repo.readState(session.userId);
      expect(state?.phase).toBe("processing");
    });

    it("injected probeTools failure closes connection, returns error, and does not activate session", async () => {
      const now = new Date("2026-09-06T12:00:00Z");
      const spy = new ConnectionSpy();
      spy.probeToolsError = new Error("probe_timeout_error");
      const { service, repo } = await createServiceHarness({ now, connectionSpy: spy });

      const handle = "pending-cookie-probe-fail";
      const handleHash = createHash("sha256").update(handle).digest("hex");
      const session = await repo.createPendingSession({
        handleHash,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });
      await repo.beginFlow({
        userId: session.userId,
        bindingHash: handleHash,
        flowId: "flow-probe-fail",
        state: "state-probe-fail",
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      const result = await service.callback(
        {
          handle,
          state: "state-probe-fail",
          code: "code-probe-fail",
          denied: false,
        },
        "corr-probe-fail",
      );

      expect(result.ok).toBe(false);
      expect(spy.closeCalls).toBe(1);
    });

    it("injected activateSession failure returns 500 failure and closes connection", async () => {
      const now = new Date("2026-09-06T12:00:00Z");
      const spy = new ConnectionSpy();
      const { service, repo } = await createServiceHarness({ now, connectionSpy: spy });

      const handle = "pending-cookie-activate-fail";
      const handleHash = createHash("sha256").update(handle).digest("hex");
      const session = await repo.createPendingSession({
        handleHash,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });
      await repo.beginFlow({
        userId: session.userId,
        bindingHash: handleHash,
        flowId: "flow-activate-fail",
        state: "state-activate-fail",
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      repo.activateSession = async () => {
        throw new Error("database_connection_lost");
      };

      const result = await service.callback(
        {
          handle,
          state: "state-activate-fail",
          code: "code-activate-fail",
          denied: false,
        },
        "corr-activate-fail",
      );

      expect(result.ok).toBe(false);
      expect(spy.closeCalls).toBe(1);
      if (result.ok) return;
      expect(result.error.status).toBe(500);
      expect(result.error.error.code).toBe("unexpected");
    });

    it("secret sentinel masking: synthetic secrets do not appear anywhere in error responses or messages", async () => {
      const now = new Date("2026-09-06T12:00:00Z");
      const spy = new ConnectionSpy();
      const SECRET_SENTINEL = "super-secret-token-sentinel-12345";
      spy.finishAuthError = new Error(`upstream failed with token: ${SECRET_SENTINEL}`);
      const { service, repo } = await createServiceHarness({ now, connectionSpy: spy });

      const handle = "pending-cookie-sentinel";
      const handleHash = createHash("sha256").update(handle).digest("hex");
      const session = await repo.createPendingSession({
        handleHash,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });
      await repo.beginFlow({
        userId: session.userId,
        bindingHash: handleHash,
        flowId: "flow-sentinel",
        state: "state-sentinel",
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      const result = await service.callback(
        {
          handle,
          state: "state-sentinel",
          code: "auth-code-sentinel",
          denied: false,
        },
        "corr-sentinel",
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;

      const serialized = JSON.stringify(result.error);
      expect(serialized).not.toContain(SECRET_SENTINEL);
    });
  });

  describe("resolveSession()", () => {
    it("resolves valid authenticated session to userId and expiresAt", async () => {
      const now = new Date("2026-09-06T12:00:00Z");
      const { service, repo } = await createServiceHarness({ now });

      const handle = "auth-session-handle-1";
      const handleHash = createHash("sha256").update(handle).digest("hex");
      const session = await repo.createPendingSession({
        handleHash,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      // Activate session
      const state = await repo.beginFlow({
        userId: session.userId,
        bindingHash: handleHash,
        flowId: "flow-1",
        state: "s",
        now,
        expiresAt: session.expiresAt,
      });
      const claimed = await repo.claimFlow({
        userId: session.userId,
        bindingHash: handleHash,
        expectedVersion: state.version,
        now,
      });

      const newHandle = "activated-handle-1";
      const newHash = createHash("sha256").update(newHandle).digest("hex");
      const expiresAt = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
      await repo.activateSession({
        oldHandleHash: handleHash,
        newHandleHash: newHash,
        userId: session.userId,
        expectedFlowVersion: claimed!.version,
        now,
        expiresAt,
      });

      const res = await service.resolveSession(newHandle, "corr-res-1");
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.userId).toBe(session.userId);
      expect(res.value.expiresAt.getTime()).toBe(expiresAt.getTime());
    });

    it("rejects null, empty, whitespace, or missing handle", async () => {
      const { service } = await createServiceHarness();

      expect((await service.resolveSession(null, "c")).ok).toBe(false);
      expect((await service.resolveSession("", "c")).ok).toBe(false);
      expect((await service.resolveSession("   ", "c")).ok).toBe(false);
    });

    it("rejects pending, revoked, or unknown handle", async () => {
      const now = new Date("2026-09-06T12:00:00Z");
      const { service, repo } = await createServiceHarness({ now });

      // Pending handle
      const pendingHandle = "pending-only-handle";
      const pendingHash = createHash("sha256").update(pendingHandle).digest("hex");
      await repo.createPendingSession({
        handleHash: pendingHash,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      const resPending = await service.resolveSession(pendingHandle, "c");
      expect(resPending.ok).toBe(false);

      // Unknown handle
      const resUnknown = await service.resolveSession("unknown-handle-random", "c");
      expect(resUnknown.ok).toBe(false);
    });

    it("rejects expired session", async () => {
      const now = new Date("2026-09-06T12:00:00Z");
      const { service, repo } = await createServiceHarness({ now });

      const handle = "handle-to-expire";
      const handleHash = createHash("sha256").update(handle).digest("hex");
      const session = await repo.createPendingSession({
        handleHash,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      const state = await repo.beginFlow({
        userId: session.userId,
        bindingHash: handleHash,
        flowId: "f",
        state: "s",
        now,
        expiresAt: session.expiresAt,
      });
      const claimed = await repo.claimFlow({
        userId: session.userId,
        bindingHash: handleHash,
        expectedVersion: state.version,
        now,
      });

      const newHandle = "activated-expired";
      const newHash = createHash("sha256").update(newHandle).digest("hex");
      const pastExpiry = new Date(now.getTime() - 1000); // Already expired
      await repo.activateSession({
        oldHandleHash: handleHash,
        newHandleHash: newHash,
        userId: session.userId,
        expectedFlowVersion: claimed!.version,
        now,
        expiresAt: pastExpiry,
      });

      const res = await service.resolveSession(newHandle, "c");
      expect(res.ok).toBe(false);
    });
  });

  describe("resolveSilpoSession export", () => {
    it("delegates to service.resolveSession with generated correlation ID", async () => {
      const res = await resolveSilpoSession(null);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("unauthorized");
        expect(res.error.correlationId).toBeDefined();
      }
    });

    it("resolves valid session when options are passed", async () => {
      const { repo, now } = await createServiceHarness();
      const handle = "valid-resolve-export-handle";
      const handleHash = createHash("sha256").update(handle).digest("hex");
      const session = await repo.createPendingSession({
        handleHash,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      const state = await repo.beginFlow({
        userId: session.userId,
        bindingHash: handleHash,
        flowId: "f-exp",
        state: "s-exp",
        now,
        expiresAt: session.expiresAt,
      });
      const claimed = await repo.claimFlow({
        userId: session.userId,
        bindingHash: handleHash,
        expectedVersion: state.version,
        now,
      });

      const activeHandle = "active-export-handle";
      const activeHash = createHash("sha256").update(activeHandle).digest("hex");
      const expiresAt = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
      await repo.activateSession({
        oldHandleHash: handleHash,
        newHandleHash: activeHash,
        userId: session.userId,
        expectedFlowVersion: claimed!.version,
        now,
        expiresAt,
      });

      const res = await resolveSilpoSession(activeHandle, { repository: repo, now: () => now });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.userId).toBe(session.userId);
    });
  });
});
