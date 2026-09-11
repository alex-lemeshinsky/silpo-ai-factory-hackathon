import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { buildFallbackProposal } from "@/features/agent/fallback";
import {
  createDemoHandle,
  demoUserIdFor,
  isDemoHandle,
} from "@/features/drafts/demo-user";
import { createInMemoryDraftRepository } from "@/features/drafts/repository";
import { createInMemoryToolTraceRepository } from "@/features/diagnostics/trace-repository";
import { createDemoSilpoGateway } from "@/features/silpo/demo/demo-gateway";
import { McpCallError } from "@/features/silpo/live/session";
import { InvalidExternalDataError } from "@/features/silpo/schemas/common";
import type { ServerEnv } from "@/lib/env";
import { createLogger, createNoopLogger } from "@/lib/logger";
import { err, ok } from "@/lib/result";

import { createDraftsPostHandler, type DraftsHandlerDeps } from "@/app/api/drafts/handlers";

function makeEnv(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://user:pass@localhost:5432/testdb",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
    GOOGLE_GENERATIVE_AI_API_KEY: "test-api-key",
    AGENT_MODEL: "gemini-3.7-flash",
    DATA_MODE: "demo",
    PUBLIC_BASE_URL: "https://app.silpo-test.ua",
    ...overrides,
  };
}

const DEMO_HANDLE = createDemoHandle();

function makeDeps(overrides: Partial<DraftsHandlerDeps> = {}): DraftsHandlerDeps {
  const repository = createInMemoryDraftRepository();
  return {
    getEnv: () => makeEnv(),
    resolveSession: async () => ok({ userId: "live-user" }),
    resolveDemoIdentity: async (cookieValue) =>
      isDemoHandle(cookieValue)
        ? { userId: demoUserIdFor(cookieValue), handle: cookieValue, issued: false }
        : { userId: demoUserIdFor(DEMO_HANDLE), handle: DEMO_HANDLE, issued: true },
    repository: () => repository,
    logger: () => createNoopLogger(),
    openGateway: async () => ({ gateway: createDemoSilpoGateway(), async close() {} }),
    generateDraft: async (input) => ({
      proposal: buildFallbackProposal(input),
      source: "fallback",
      attempts: 0,
      normalizations: [],
    }),
    ...overrides,
  };
}

function post(body?: unknown, cookies: Record<string, string> = {}): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  const pairs = Object.entries(cookies).map(([name, value]) => `${name}=${value}`);
  if (pairs.length > 0) {
    headers.set("cookie", pairs.join("; "));
  }
  return new NextRequest("https://app.silpo-test.ua/api/drafts", {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("POST /api/drafts", () => {
  it("returns a labeled demo draft with the dashboard's context", async () => {
    const handler = createDraftsPostHandler(makeDeps());

    const response = await handler(post());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(payload.mode).toBe("demo");
    expect(payload.draft.status).toBe("ready");
    expect(payload.draft.items).toHaveLength(3);
    expect(payload.cartContext.cartId).toBe("demo-cart-ready");
    expect(payload.loyaltyBonusAvailable).toBe(84.5);
    expect(payload.generation).toBeUndefined();
  });

  it("requires a session in live mode and opens no gateway without one", async () => {
    const openGateway = vi.fn();
    const handler = createDraftsPostHandler(makeDeps({
      getEnv: () => makeEnv({ DATA_MODE: "live" }),
      resolveSession: async () => err({
        code: "unauthorized" as const,
        message: "no session",
        correlationId: "c",
        retryAfterMs: null,
      }),
      openGateway,
    }));

    const response = await handler(post());
    const payload = await response.json();

    expect(response.status).toBe(401);
    expect(payload.error.code).toBe("unauthorized");
    expect(openGateway).not.toHaveBeenCalled();
  });

  it("cannot be talked into demo mode by a request body", async () => {
    const openGateway = vi.fn(async () => ({
      gateway: createDemoSilpoGateway(),
      async close() {},
    }));
    const handler = createDraftsPostHandler(makeDeps({
      getEnv: () => makeEnv({ DATA_MODE: "live" }),
      openGateway,
    }));

    const response = await handler(
      post({ mode: "demo", userId: "attacker" }, { silpo_session: "session-handle" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.mode).toBe("live");
    expect(openGateway).toHaveBeenCalledWith({ mode: "live", userId: "live-user" });
  });

  it("answers a missing slot with 409 and the slots to choose from", async () => {
    const base = createDemoSilpoGateway();
    const handler = createDraftsPostHandler(makeDeps({
      openGateway: async () => ({
        gateway: {
          ...base,
          async loadCartContext() {
            return {
              status: "needs_slot" as const,
              availableSlots: [{
                id: "slot-1",
                startsAt: "2026-09-09T09:00:00.000Z",
                endsAt: "2026-09-09T11:00:00.000Z",
                available: true,
              }],
            };
          },
        },
        async close() {},
      }),
    }));

    const response = await handler(post());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("needs_slot");
    expect(payload.availableSlots).toHaveLength(1);
  });

  it("passes the rate-limit hint through as 429", async () => {
    const handler = createDraftsPostHandler(makeDeps({
      openGateway: async () => ({
        gateway: {
          ...createDemoSilpoGateway(),
          async listTools() { throw new McpCallError("t", 429, "3"); },
        },
        async close() {},
      }),
    }));

    const response = await handler(post());
    const payload = await response.json();

    expect(response.status).toBe(429);
    expect(payload.error.retryAfterMs).toBe(3000);
  });

  it("reports a malformed Silpo response as 502 without echoing it", async () => {
    const handler = createDraftsPostHandler(makeDeps({
      openGateway: async () => ({
        gateway: {
          ...createDemoSilpoGateway(),
          async listTools() { throw new InvalidExternalDataError("silpo_get_my_shopping_cart"); },
        },
        async close() {},
      }),
    }));

    const response = await handler(post());
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload.error.code).toBe("invalid_external_data");
    expect(JSON.stringify(payload)).not.toContain("silpo_get_my_shopping_cart");
  });

  it("issues a per-visitor demo handle as an HttpOnly cookie on first visit", async () => {
    const handler = createDraftsPostHandler(makeDeps());

    const response = await handler(post());
    const setCookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(200);
    expect(setCookie).toContain(`demo_session=${DEMO_HANDLE}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).toContain("Path=/");
  });

  it("keeps a returning visitor's handle instead of minting a new one", async () => {
    const handler = createDraftsPostHandler(makeDeps());
    const existing = createDemoHandle();

    const response = await handler(post(undefined, { demo_session: existing }));

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("scopes a demo draft to the visitor that generated it", async () => {
    const repository = createInMemoryDraftRepository();
    const handler = createDraftsPostHandler(makeDeps({ repository: () => repository }));
    const visitorA = createDemoHandle();
    const visitorB = createDemoHandle();

    const responseA = await handler(post(undefined, { demo_session: visitorA }));
    const { draft } = await responseA.json();

    // The other visitor cannot load it, because the ids differ.
    await expect(repository.get(draft.id, demoUserIdFor(visitorA))).resolves.not.toBeNull();
    await expect(repository.get(draft.id, demoUserIdFor(visitorB))).resolves.toBeNull();
  });

  it("still sets the demo cookie when the run itself fails", async () => {
    const handler = createDraftsPostHandler(makeDeps({
      openGateway: async () => ({
        gateway: {
          ...createDemoSilpoGateway(),
          async listTools() { throw new McpCallError("t", 429, "3"); },
        },
        async close() {},
      }),
    }));

    const response = await handler(post());

    expect(response.status).toBe(429);
    // Otherwise every retry would mint a new identity and a new user row.
    expect(response.headers.get("set-cookie")).toContain(`demo_session=${DEMO_HANDLE}`);
  });

  it("returns 500 with a safe message when the environment is unusable", async () => {
    const handler = createDraftsPostHandler(makeDeps({
      getEnv: () => { throw new Error("Invalid server environment: DATABASE_URL"); },
    }));

    const response = await handler(post());
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload.error.code).toBe("unexpected");
    expect(JSON.stringify(payload)).not.toContain("DATABASE_URL");
  });

  it("injects the configured logger into createDraftForUser so traces are recorded", async () => {
    const traceRepo = createInMemoryToolTraceRepository();
    const logger = createLogger({ sink: traceRepo });
    const handler = createDraftsPostHandler(
      makeDeps({
        logger: () => logger,
      }),
    );

    const response = await handler(post());
    expect(response.status).toBe(200);

    const allTraces = await traceRepo.all();
    expect(allTraces.length).toBeGreaterThan(0);
    expect(allTraces.some((t) => t.toolName === "draft_run")).toBe(true);
  });
});
