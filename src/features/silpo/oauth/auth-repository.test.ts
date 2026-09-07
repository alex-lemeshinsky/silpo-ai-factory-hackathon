import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  authSessionSchema,
  createInMemoryAuthRepository,
  oauthStateRowSchema,
  type ClientRegistration,
  type DiscoveryBinding,
  type OAuthPayload,
} from "./auth-repository";

const VALID_HANDLE_A = "a".repeat(64);
const VALID_HANDLE_B = "b".repeat(64);

const SAMPLE_REGISTRATION: ClientRegistration = {
  clientId: "client-123",
  clientSecret: "secret-456",
  clientIdIssuedAt: 1725600000,
  clientSecretExpiresAt: null,
  tokenEndpointAuthMethod: "client_secret_post",
  issuer: "https://auth.silpo.ua",
};

const SAMPLE_DISCOVERY: DiscoveryBinding = {
  issuer: "https://auth.silpo.ua",
  authorizationEndpoint: "https://auth.silpo.ua/oauth2/auth",
  tokenEndpoint: "https://auth.silpo.ua/oauth2/token",
  registrationEndpoint: "https://auth.silpo.ua/oauth2/register",
  resource: "https://mcp.silpo.ua/mcp",
  resourceMetadataUrl: null,
  scopesSupported: ["openid", "offline_access"],
  codeChallengeMethodsSupported: ["S256"],
  tokenEndpointAuthMethodsSupported: ["client_secret_post", "client_secret_basic"],
  responseIssuerRequired: true,
};

describe("AuthRepository", () => {
  it("allows only one claimant of a live bound flow", async () => {
    const repo = createInMemoryAuthRepository({ encryptionKey: randomBytes(32) });
    const now = new Date("2026-09-06T09:00:00Z");
    const session = await repo.createPendingSession({
      handleHash: VALID_HANDLE_A,
      now,
      expiresAt: new Date(now.getTime() + 600000),
    });
    const flow = await repo.beginFlow({
      userId: session.userId,
      bindingHash: session.handleHash,
      flowId: "flow-1",
      state: "synthetic-state",
      now,
      expiresAt: session.expiresAt,
    });
    const input = {
      userId: session.userId,
      bindingHash: session.handleHash,
      expectedVersion: flow.version,
      now,
    };
    const results = await Promise.all([repo.claimFlow(input), repo.claimFlow(input)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  describe("session lifecycle", () => {
    it("creates a pending session with generated user and returns it by handleHash", async () => {
      const repo = createInMemoryAuthRepository({ encryptionKey: randomBytes(32) });
      const now = new Date("2026-09-06T09:00:00Z");
      const expiresAt = new Date(now.getTime() + 600000);

      const session = await repo.createPendingSession({
        handleHash: VALID_HANDLE_A,
        now,
        expiresAt,
      });

      expect(session.id).toBeDefined();
      expect(session.userId).toMatch(/^[0-9a-f-]{36}$/);
      expect(session.handleHash).toBe(VALID_HANDLE_A);
      expect(session.status).toBe("pending");
      expect(session.expiresAt).toEqual(expiresAt);

      const found = await repo.findSession(VALID_HANDLE_A, now);
      expect(found).toEqual(session);
    });

    it("rejects non-64-character-hex handleHash", async () => {
      const repo = createInMemoryAuthRepository({ encryptionKey: randomBytes(32) });
      const now = new Date("2026-09-06T09:00:00Z");

      await expect(
        repo.createPendingSession({
          handleHash: "invalid-hash",
          now,
          expiresAt: new Date(now.getTime() + 600000),
        }),
      ).rejects.toThrow();
    });

    it("treats session as expired when now is at or after expiresAt", async () => {
      const repo = createInMemoryAuthRepository({ encryptionKey: randomBytes(32) });
      const now = new Date("2026-09-06T09:00:00Z");
      const expiresAt = new Date("2026-09-06T09:10:00Z");

      await repo.createPendingSession({
        handleHash: VALID_HANDLE_A,
        now,
        expiresAt,
      });

      // Before expiry
      expect(await repo.findSession(VALID_HANDLE_A, new Date("2026-09-06T09:09:59Z"))).not.toBeNull();
      // Exact boundary
      expect(await repo.findSession(VALID_HANDLE_A, expiresAt)).toBeNull();
      // After expiry
      expect(await repo.findSession(VALID_HANDLE_A, new Date("2026-09-06T09:10:01Z"))).toBeNull();
    });

    it("excludes revoked sessions from findSession", async () => {
      const repo = createInMemoryAuthRepository({ encryptionKey: randomBytes(32) });
      const now = new Date("2026-09-06T09:00:00Z");
      const session = await repo.createPendingSession({
        handleHash: VALID_HANDLE_A,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      const flow = await repo.beginFlow({
        userId: session.userId,
        bindingHash: VALID_HANDLE_A,
        flowId: "flow-1",
        state: "state-1",
        now,
        expiresAt: session.expiresAt,
      });

      const claimed = await repo.claimFlow({
        userId: session.userId,
        bindingHash: VALID_HANDLE_A,
        expectedVersion: flow.version,
        now,
      });
      expect(claimed).not.toBeNull();

      await repo.activateSession({
        oldHandleHash: VALID_HANDLE_A,
        newHandleHash: VALID_HANDLE_B,
        userId: session.userId,
        expectedFlowVersion: claimed!.version,
        now,
        expiresAt: new Date(now.getTime() + 604800000),
      });

      // Old session is revoked and cannot be found
      expect(await repo.findSession(VALID_HANDLE_A, now)).toBeNull();
      // New session is authenticated and can be found
      const newSession = await repo.findSession(VALID_HANDLE_B, now);
      expect(newSession?.status).toBe("authenticated");
    });
  });

  describe("row validation and session revocation", () => {
    it("O9-02 rejects stored rows that violate the documented lifecycle", () => {
      expect(
        authSessionSchema.safeParse({
          id: "3f1d1a5e-2c9a-4f2b-9d3e-1c2b3a4d5e6f",
          userId: "3f1d1a5e-2c9a-4f2b-9d3e-1c2b3a4d5e6f",
          handleHash: VALID_HANDLE_A,
          status: "authenticated",
          expiresAt: new Date(),
        }).success,
      ).toBe(true);

      // Unknown status, malformed hash and non-date expiry are all refused.
      expect(
        authSessionSchema.safeParse({
          id: "3f1d1a5e-2c9a-4f2b-9d3e-1c2b3a4d5e6f",
          userId: "3f1d1a5e-2c9a-4f2b-9d3e-1c2b3a4d5e6f",
          handleHash: VALID_HANDLE_A,
          status: "logged-in",
          expiresAt: new Date(),
        }).success,
      ).toBe(false);
      expect(
        authSessionSchema.safeParse({
          id: "3f1d1a5e-2c9a-4f2b-9d3e-1c2b3a4d5e6f",
          userId: "3f1d1a5e-2c9a-4f2b-9d3e-1c2b3a4d5e6f",
          handleHash: "not-a-hash",
          status: "pending",
          expiresAt: new Date(),
        }).success,
      ).toBe(false);

      const validState = {
        userId: "3f1d1a5e-2c9a-4f2b-9d3e-1c2b3a4d5e6f",
        version: 2,
        phase: "pending" as const,
        bindingHash: VALID_HANDLE_A,
        flowExpiresAt: new Date(),
      };
      expect(oauthStateRowSchema.safeParse(validState).success).toBe(true);
      expect(
        oauthStateRowSchema.safeParse({ ...validState, phase: "halfway" }).success,
      ).toBe(false);
      expect(oauthStateRowSchema.safeParse({ ...validState, version: 0 }).success).toBe(false);
      // An active flow without a browser binding or an expiry is not a valid row.
      expect(
        oauthStateRowSchema.safeParse({ ...validState, bindingHash: null }).success,
      ).toBe(false);
      expect(
        oauthStateRowSchema.safeParse({ ...validState, flowExpiresAt: null }).success,
      ).toBe(false);
      expect(
        oauthStateRowSchema.safeParse({
          ...validState,
          phase: "idle",
          bindingHash: null,
          flowExpiresAt: null,
        }).success,
      ).toBe(true);
    });

    it("O9-01 revokes every handle the user holds when a new handle is installed", async () => {
      const repo = createInMemoryAuthRepository({ encryptionKey: randomBytes(32) });
      const now = new Date("2026-09-06T09:00:00Z");
      const reauthPending = "c".repeat(64);
      const rotated = "d".repeat(64);

      const first = await repo.createPendingSession({
        handleHash: VALID_HANDLE_A,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      const activate = async (oldHash: string, newHash: string) => {
        const flow = await repo.beginFlow({
          userId: first.userId,
          bindingHash: oldHash,
          flowId: `flow-${oldHash.slice(0, 4)}`,
          state: `state-${oldHash.slice(0, 4)}`,
          now,
          expiresAt: new Date(now.getTime() + 600000),
        });
        const claimed = await repo.claimFlow({
          userId: first.userId,
          bindingHash: oldHash,
          expectedVersion: flow.version,
          now,
        });
        expect(claimed).not.toBeNull();
        await repo.activateSession({
          oldHandleHash: oldHash,
          newHandleHash: newHash,
          userId: first.userId,
          expectedFlowVersion: claimed!.version,
          now,
          expiresAt: new Date(now.getTime() + 604800000),
        });
      };

      await activate(VALID_HANDLE_A, VALID_HANDLE_B);
      expect((await repo.findSession(VALID_HANDLE_B, now))?.status).toBe("authenticated");

      // Reauthorization runs through a fresh pending handle for the same user.
      await repo.createPendingSession({
        handleHash: reauthPending,
        now,
        expiresAt: new Date(now.getTime() + 600000),
        userId: first.userId,
      });
      await activate(reauthPending, rotated);

      expect(await repo.findSession(VALID_HANDLE_A, now)).toBeNull();
      expect(await repo.findSession(VALID_HANDLE_B, now)).toBeNull();
      expect(await repo.findSession(reauthPending, now)).toBeNull();
      expect((await repo.findSession(rotated, now))?.status).toBe("authenticated");
    });
  });

  describe("flow lifecycle and concurrency", () => {
    it("begins a flow, updates state with optimistic versioning, and reads decrypted payload", async () => {
      const repo = createInMemoryAuthRepository({ encryptionKey: randomBytes(32) });
      const now = new Date("2026-09-06T09:00:00Z");
      const session = await repo.createPendingSession({
        handleHash: VALID_HANDLE_A,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      const flow = await repo.beginFlow({
        userId: session.userId,
        bindingHash: VALID_HANDLE_A,
        flowId: "flow-1",
        state: "state-1",
        now,
        expiresAt: session.expiresAt,
      });

      expect(flow.phase).toBe("pending");
      expect(flow.bindingHash).toBe(VALID_HANDLE_A);
      expect(flow.version).toBeGreaterThan(0);
      expect(flow.payload.flowId).toBe("flow-1");
      expect(flow.payload.state).toBe("state-1");

      // Save updated state (e.g. verifier and registration)
      const updatedPayload: OAuthPayload = {
        ...flow.payload,
        verifier: "pkce-verifier-123",
        registration: SAMPLE_REGISTRATION,
        discovery: SAMPLE_DISCOVERY,
      };

      const saved = await repo.saveState({
        userId: session.userId,
        expectedVersion: flow.version,
        payload: updatedPayload,
      });

      expect(saved.version).toBe(flow.version + 1);
      expect(saved.payload.verifier).toBe("pkce-verifier-123");
      expect(saved.payload.registration).toEqual(SAMPLE_REGISTRATION);
      expect(saved.payload.discovery).toEqual(SAMPLE_DISCOVERY);

      // Re-read state
      const read = await repo.readState(session.userId);
      expect(read?.payload).toEqual(saved.payload);
      expect(read?.version).toBe(saved.version);
    });

    it("rejects saveState when expectedVersion does not match", async () => {
      const repo = createInMemoryAuthRepository({ encryptionKey: randomBytes(32) });
      const now = new Date("2026-09-06T09:00:00Z");
      const session = await repo.createPendingSession({
        handleHash: VALID_HANDLE_A,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      const flow = await repo.beginFlow({
        userId: session.userId,
        bindingHash: VALID_HANDLE_A,
        flowId: "flow-1",
        state: "state-1",
        now,
        expiresAt: session.expiresAt,
      });

      await expect(
        repo.saveState({
          userId: session.userId,
          expectedVersion: flow.version + 99,
          payload: flow.payload,
        }),
      ).rejects.toThrow();
    });

    it("preserves encrypted registration and discovery when replacing a flow in beginFlow", async () => {
      const repo = createInMemoryAuthRepository({ encryptionKey: randomBytes(32) });
      const now = new Date("2026-09-06T09:00:00Z");
      const session = await repo.createPendingSession({
        handleHash: VALID_HANDLE_A,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      const firstFlow = await repo.beginFlow({
        userId: session.userId,
        bindingHash: VALID_HANDLE_A,
        flowId: "flow-1",
        state: "state-1",
        now,
        expiresAt: session.expiresAt,
      });

      await repo.saveState({
        userId: session.userId,
        expectedVersion: firstFlow.version,
        payload: {
          ...firstFlow.payload,
          registration: SAMPLE_REGISTRATION,
          discovery: SAMPLE_DISCOVERY,
        },
      });

      // Begin a replacement flow (e.g. user retried)
      const secondFlow = await repo.beginFlow({
        userId: session.userId,
        bindingHash: VALID_HANDLE_A,
        flowId: "flow-2",
        state: "state-2",
        now,
        expiresAt: session.expiresAt,
      });

      expect(secondFlow.payload.flowId).toBe("flow-2");
      expect(secondFlow.payload.state).toBe("state-2");
      expect(secondFlow.payload.registration).toEqual(SAMPLE_REGISTRATION);
      expect(secondFlow.payload.discovery).toEqual(SAMPLE_DISCOVERY);
    });

    it("refuses beginFlow when unexpired flow is already in processing phase", async () => {
      const repo = createInMemoryAuthRepository({ encryptionKey: randomBytes(32) });
      const now = new Date("2026-09-06T09:00:00Z");
      const session = await repo.createPendingSession({
        handleHash: VALID_HANDLE_A,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      const flow = await repo.beginFlow({
        userId: session.userId,
        bindingHash: VALID_HANDLE_A,
        flowId: "flow-1",
        state: "state-1",
        now,
        expiresAt: session.expiresAt,
      });

      await repo.claimFlow({
        userId: session.userId,
        bindingHash: VALID_HANDLE_A,
        expectedVersion: flow.version,
        now,
      });

      // Claimed flow is now in processing; new beginFlow must be rejected with safe error
      await expect(
        repo.beginFlow({
          userId: session.userId,
          bindingHash: VALID_HANDLE_A,
          flowId: "flow-2",
          state: "state-2",
          now,
          expiresAt: session.expiresAt,
        }),
      ).rejects.toThrow();
    });

    it("finishFlow clears pending flow secrets and returns to idle", async () => {
      const repo = createInMemoryAuthRepository({ encryptionKey: randomBytes(32) });
      const now = new Date("2026-09-06T09:00:00Z");
      const session = await repo.createPendingSession({
        handleHash: VALID_HANDLE_A,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      const flow = await repo.beginFlow({
        userId: session.userId,
        bindingHash: VALID_HANDLE_A,
        flowId: "flow-1",
        state: "state-1",
        now,
        expiresAt: session.expiresAt,
      });

      const saved = await repo.saveState({
        userId: session.userId,
        expectedVersion: flow.version,
        payload: {
          ...flow.payload,
          verifier: "pkce-verifier",
          registration: SAMPLE_REGISTRATION,
          discovery: SAMPLE_DISCOVERY,
        },
      });

      const finished = await repo.finishFlow({
        userId: session.userId,
        expectedVersion: saved.version,
      });
      expect(finished).toBe(true);

      const state = await repo.readState(session.userId);
      expect(state?.phase).toBe("idle");
      expect(state?.bindingHash).toBeNull();
      expect(state?.flowExpiresAt).toBeNull();
      expect(state?.payload.flowId).toBeNull();
      expect(state?.payload.state).toBeNull();
      expect(state?.payload.verifier).toBeNull();
      // Registration & discovery retained
      expect(state?.payload.registration).toEqual(SAMPLE_REGISTRATION);
      expect(state?.payload.discovery).toEqual(SAMPLE_DISCOVERY);
    });

    it("activation rolls back and throws if expectedFlowVersion does not match", async () => {
      const repo = createInMemoryAuthRepository({ encryptionKey: randomBytes(32) });
      const now = new Date("2026-09-06T09:00:00Z");
      const session = await repo.createPendingSession({
        handleHash: VALID_HANDLE_A,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      const flow = await repo.beginFlow({
        userId: session.userId,
        bindingHash: VALID_HANDLE_A,
        flowId: "flow-1",
        state: "state-1",
        now,
        expiresAt: session.expiresAt,
      });

      const claimed = await repo.claimFlow({
        userId: session.userId,
        bindingHash: VALID_HANDLE_A,
        expectedVersion: flow.version,
        now,
      });

      await expect(
        repo.activateSession({
          oldHandleHash: VALID_HANDLE_A,
          newHandleHash: VALID_HANDLE_B,
          userId: session.userId,
          expectedFlowVersion: claimed!.version + 99,
          now,
          expiresAt: new Date(now.getTime() + 604800000),
        }),
      ).rejects.toThrow();

      // Old session is still pending, not revoked
      const sessionStillPending = await repo.findSession(VALID_HANDLE_A, now);
      expect(sessionStillPending?.status).toBe("pending");
      // New session was not created
      expect(await repo.findSession(VALID_HANDLE_B, now)).toBeNull();
    });
  });

  describe("security and cryptographic isolation", () => {
    it("encrypts state with user-scoped AAD and stores valid sealed bytes", async () => {
      const key = randomBytes(32);
      const repo = createInMemoryAuthRepository({ encryptionKey: key });
      const now = new Date("2026-09-06T09:00:00Z");

      const session1 = await repo.createPendingSession({
        handleHash: VALID_HANDLE_A,
        now,
        expiresAt: new Date(now.getTime() + 600000),
      });

      await repo.beginFlow({
        userId: session1.userId,
        bindingHash: VALID_HANDLE_A,
        flowId: "flow-1",
        state: "state-1",
        now,
        expiresAt: session1.expiresAt,
      });

      // Raw inspection reveals valid sealed bytes
      const raw1 = repo.rawState(session1.userId);
      expect(raw1).not.toBeNull();
      expect(typeof raw1!.ciphertext).toBe("string");
      expect(typeof raw1!.iv).toBe("string");
      expect(typeof raw1!.authTag).toBe("string");

      // Verify rawSession clone
      const rawSess = repo.rawSession(VALID_HANDLE_A);
      expect(rawSess?.userId).toBe(session1.userId);
    });

    it("createPendingSession reuses provided userId and validates malformed userId", async () => {
      const repo = createInMemoryAuthRepository({ encryptionKey: randomBytes(32) });
      const now = new Date("2026-09-06T09:00:00Z");
      const existingUserId = "e6b772c2-8bbd-4e92-9445-d8cf7135e690";

      const session = await repo.createPendingSession({
        handleHash: VALID_HANDLE_A,
        now,
        expiresAt: new Date(now.getTime() + 600000),
        userId: existingUserId,
      });
      expect(session.userId).toBe(existingUserId);

      // Malformed userId throws validation error
      await expect(
        repo.createPendingSession({
          handleHash: VALID_HANDLE_B,
          now,
          expiresAt: new Date(now.getTime() + 600000),
          userId: "not-a-uuid",
        }),
      ).rejects.toThrow();
    });
  });
});
