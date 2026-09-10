import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import {
  createCartCommitPostHandler,
  type CartCommitHandlerDeps,
} from "@/app/api/cart/commit/handlers";
import {
  commitApprovedDraft,
  type CartCommitFailure,
} from "@/features/cart/commit-service";
import {
  createInMemoryCartCommitRepository,
  type CartCommitRepository,
} from "@/features/cart/repository";
import {
  createDemoHandle,
  demoUserIdFor,
  DEMO_SESSION_COOKIE,
} from "@/features/drafts/demo-user";
import {
  createInMemoryDraftRepository,
  type DraftRepository,
} from "@/features/drafts/repository";
import type {
  Draft,
  DraftItem,
  ProductCandidate,
  SilpoGateway,
  TimeSlot,
  VerifiedCart,
} from "@/features/shared/contracts";
import type { SilpoGatewayHandle } from "@/features/silpo/gateway";
import type { ServerEnv } from "@/lib/env";
import { err, ok } from "@/lib/result";

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
const USER = demoUserIdFor(DEMO_HANDLE);
const DRAFT_ID = "00000000-0000-4000-8000-000000000016";
const KEY = "00000000-0000-4000-8000-000000000a16";
const CART_ID = "cart-1";

const SLOT: TimeSlot = {
  id: "slot-1",
  startsAt: "2026-09-09T10:00:00.000+03:00",
  endsAt: "2026-09-09T12:00:00.000+03:00",
  available: true,
};

const CONTEXT = {
  cartId: CART_ID,
  deliveryType: "delivery" as const,
  city: "Київ",
  branchId: "branch-7",
  slot: SLOT,
};

function draftItem(overrides: Partial<DraftItem> = {}): DraftItem {
  return {
    productId: "p-1",
    externalProductId: 101,
    name: "Вода негазована 1.5 л",
    imageUrl: null,
    displayRatio: 1,
    quantity: 2,
    price: 24.9,
    specialPrice: null,
    stock: 10,
    step: 1,
    confidence: 0.8,
    confidenceBand: "high",
    reasonCodes: ["regular_purchase"],
    reason: "Зазвичай купуєте щотижня.",
    nutritionStatus: "insufficient",
    promotions: [],
    alternatives: [],
    ...overrides,
  };
}

const confirmingDraft: Draft = {
  id: DRAFT_ID,
  mode: "demo",
  status: "confirming",
  algorithmVersion: "prediction-v1",
  trainingCutoff: "2026-09-01T10:00:00.000Z",
  summary: "Чернетка автопілота",
  items: [draftItem()],
  total: 49.8,
  version: 2,
};

function productFor(query: string): ProductCandidate {
  return {
    productId: "p-1",
    externalProductId: 101,
    slug: "voda-1-5",
    name: query,
    imageUrl: null,
    price: 24.9,
    specialPrice: null,
    available: true,
    stock: 10,
    step: 1,
    displayRatio: 1,
    nutritionStatus: "insufficient",
    nutrition: null,
    promotions: [],
  };
}

function cartAfterWrite(overrides: Partial<VerifiedCart> = {}): VerifiedCart {
  return {
    cartId: CART_ID,
    status: "verified",
    items: [{ productId: "p-1", quantity: 2, unitPrice: 24.9, available: true }],
    total: 49.8,
    validations: [],
    checkoutLinks: {
      web: "https://silpo.ua/cart/cart-1",
      mobile: "https://silpo.ua/app/cart/cart-1",
    },
    ...overrides,
  };
}

function makeGateway(overrides: Partial<SilpoGateway> = {}) {
  const gateway: SilpoGateway = {
    listTools: vi.fn(async () => []),
    loadCustomerContext: vi.fn(),
    loadCartContext: vi.fn(async () => ({ status: "ready" as const, context: CONTEXT })),
    updateCartContext: vi.fn(),
    loadPurchaseHistory: vi.fn(),
    findProducts: vi.fn(async (_context, queries: string[]) =>
      queries.map((query) => ({ query, products: [productFor(query)] })),
    ),
    getPromotions: vi.fn(),
    getProductDetails: vi.fn(),
    getSimilarProducts: vi.fn(),
    getReplacements: vi.fn(),
    getTimeSlots: vi.fn(),
    setAbsoluteCartQuantities: vi.fn(async () => {}),
    readCart: vi.fn()
      .mockResolvedValueOnce(cartAfterWrite({ items: [], total: 0 }))
      .mockResolvedValue(cartAfterWrite()),
    ...overrides,
  };
  const close = vi.fn(async () => {});
  return { gateway, close, handle: { gateway, close } };
}

async function setupApprovedDraft(
  drafts: DraftRepository,
  userId: string = USER,
  draft: Draft = confirmingDraft,
  key: string = KEY,
) {
  const readyDraft: Draft = { ...draft, status: "ready", version: 1 };
  await drafts.save(userId, readyDraft);
  await drafts.approveSelection({
    draftId: draft.id,
    userId,
    expectedDraftVersion: 1,
    approvedDraft: { ...draft, status: "confirming", version: 2 },
    decisions: draft.items.map((item) => ({
      sourceProductId: item.productId,
      expectedVersion: 1,
      decision: "kept" as const,
      item,
    })),
    idempotencyKey: key,
    approvedAt: new Date("2026-09-09T10:00:00.000Z"),
  });
}

function post(body: unknown, cookies: Record<string, string> = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  const cookie = Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join("; ");
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest("https://app.silpo-test.ua/api/cart/commit", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function makeDeps(
  deps: {
    drafts: DraftRepository;
    commits: CartCommitRepository;
    gatewayHandle: SilpoGatewayHandle;
  },
  overrides: Partial<CartCommitHandlerDeps> = {},
): CartCommitHandlerDeps {
  return {
    getEnv: () => makeEnv({ DATA_MODE: "demo" }),
    resolveSession: async () => ok({ userId: "live-user" }),
    resolveDemoIdentity: async (handle) => ({
      userId: handle ? demoUserIdFor(handle) : USER,
      handle: handle ?? DEMO_HANDLE,
      issued: handle === null,
    }),
    drafts: () => deps.drafts,
    commits: () => deps.commits,
    openGateway: async () => deps.gatewayHandle,
    commit: commitApprovedDraft,
    ...overrides,
  };
}

describe("POST /api/cart/commit", () => {
  it("T16-19 returns the verified cart for an approved demo draft", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts);
    const commits = createInMemoryCartCommitRepository();
    const { handle } = makeGateway();

    const handler = createCartCommitPostHandler(makeDeps({ drafts, commits, gatewayHandle: handle }));
    const response = await handler(post({ draftId: DRAFT_ID, idempotencyKey: KEY }, { [DEMO_SESSION_COOKIE]: DEMO_HANDLE }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      cartId: "cart-1",
      status: "verified",
      checkoutLinks: { web: expect.stringContaining("https://") },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("T16-20 replays the stored result for a repeated POST without a second write", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts);
    const commits = createInMemoryCartCommitRepository();
    const { gateway, handle } = makeGateway();

    const handler = createCartCommitPostHandler(makeDeps({ drafts, commits, gatewayHandle: handle }));
    const cookies = { [DEMO_SESSION_COOKIE]: DEMO_HANDLE };

    const first = await handler(post({ draftId: DRAFT_ID, idempotencyKey: KEY }, cookies));
    const second = await handler(post({ draftId: DRAFT_ID, idempotencyKey: KEY }, cookies));

    expect(await second.json()).toEqual(await first.json());
    expect(gateway.setAbsoluteCartQuantities).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a malformed JSON body", "not json", 400],
    ["a non-UUID draft ID", { draftId: "abc", idempotencyKey: KEY }, 400],
    ["a non-UUID key", { draftId: DRAFT_ID, idempotencyKey: "abc" }, 400],
    ["an unknown extra field", { draftId: DRAFT_ID, idempotencyKey: KEY, quantity: 99 }, 400],
  ])("T16-21 rejects %s with %s", async (_label, body, status) => {
    const drafts = createInMemoryDraftRepository();
    const commits = createInMemoryCartCommitRepository();
    const { handle } = makeGateway();
    const handler = createCartCommitPostHandler(makeDeps({ drafts, commits, gatewayHandle: handle }));

    const response = await handler(post(body, { [DEMO_SESSION_COOKIE]: DEMO_HANDLE }));
    expect(response.status).toBe(status);
  });

  it("T16-22 returns 401 when a live session cannot be resolved", async () => {
    const drafts = createInMemoryDraftRepository();
    const commits = createInMemoryCartCommitRepository();
    const { handle } = makeGateway();

    const handler = createCartCommitPostHandler(makeDeps({ drafts, commits, gatewayHandle: handle }, {
      getEnv: () => makeEnv({ DATA_MODE: "live" }),
      resolveSession: async () => err({ code: "unauthorized", message: "x", correlationId: "c", retryAfterMs: null }),
    }));

    const response = await handler(post({ draftId: DRAFT_ID, idempotencyKey: KEY }));
    expect(response.status).toBe(401);
  });

  it.each([
    ["not_found", 404],
    ["approval_required", 409],
    ["needs_slot", 409],
    ["unauthorized", 401],
    ["cart_incomplete", 409],
    ["commit_uncertain", 502],
    ["unexpected", 500],
  ] as const)("T16-23 maps every service failure code to its status: %s -> %i", async (code, expectedStatus) => {
    const drafts = createInMemoryDraftRepository();
    const commits = createInMemoryCartCommitRepository();
    const { handle } = makeGateway();

    const handler = createCartCommitPostHandler(makeDeps({ drafts, commits, gatewayHandle: handle }, {
      commit: vi.fn(async () => err<CartCommitFailure>({ code, message: "msg", correlationId: "c1" })),
    }));

    const response = await handler(post({ draftId: DRAFT_ID, idempotencyKey: KEY }, { [DEMO_SESSION_COOKIE]: DEMO_HANDLE }));
    expect(response.status).toBe(expectedStatus);
  });

  it("T16-24 returns the offered slots in the needs_slot body", async () => {
    const drafts = createInMemoryDraftRepository();
    const commits = createInMemoryCartCommitRepository();
    const { handle } = makeGateway();

    const handler = createCartCommitPostHandler(makeDeps({ drafts, commits, gatewayHandle: handle }, {
      commit: vi.fn(async () => err<CartCommitFailure>({
        code: "needs_slot",
        message: "Оберіть час",
        correlationId: "c1",
        availableSlots: [SLOT],
      })),
    }));

    const response = await handler(post({ draftId: DRAFT_ID, idempotencyKey: KEY }, { [DEMO_SESSION_COOKIE]: DEMO_HANDLE }));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatchObject({ code: "needs_slot", availableSlots: [SLOT] });
  });

  it("T16-25 ignores a client-supplied user ID and mode", async () => {
    const drafts = createInMemoryDraftRepository();
    const commits = createInMemoryCartCommitRepository();
    const { handle } = makeGateway();

    const handler = createCartCommitPostHandler(makeDeps({ drafts, commits, gatewayHandle: handle }));
    const response = await handler(post({
      draftId: DRAFT_ID,
      idempotencyKey: KEY,
      userId: "someone-else",
      mode: "live",
    }, { [DEMO_SESSION_COOKIE]: DEMO_HANDLE }));

    expect(response.status).toBe(400);
  });

  it("T16-26 never calls resolveSession in demo mode and never reads the demo cookie in live mode", async () => {
    const demoDrafts = createInMemoryDraftRepository();
    await setupApprovedDraft(demoDrafts, USER);
    const commits = createInMemoryCartCommitRepository();
    const { handle } = makeGateway();

    const resolveSession = vi.fn(async () => ok({ userId: "live-user" }));
    const resolveDemoIdentity = vi.fn(async () => ({
      userId: USER,
      handle: DEMO_HANDLE,
      issued: false,
    }));

    // Demo mode:
    const demoHandler = createCartCommitPostHandler(makeDeps({ drafts: demoDrafts, commits, gatewayHandle: handle }, {
      getEnv: () => makeEnv({ DATA_MODE: "demo" }),
      resolveSession,
      resolveDemoIdentity,
    }));
    await demoHandler(post({ draftId: DRAFT_ID, idempotencyKey: KEY }, { [DEMO_SESSION_COOKIE]: DEMO_HANDLE }));
    expect(resolveSession).not.toHaveBeenCalled();
    expect(resolveDemoIdentity).toHaveBeenCalledTimes(1);
    resolveDemoIdentity.mockClear();

    // Live mode:
    const liveDrafts = createInMemoryDraftRepository();
    await setupApprovedDraft(liveDrafts, "live-user");
    const liveHandler = createCartCommitPostHandler(makeDeps({ drafts: liveDrafts, commits, gatewayHandle: handle }, {
      getEnv: () => makeEnv({ DATA_MODE: "live" }),
      resolveSession,
      resolveDemoIdentity,
    }));
    await liveHandler(post({ draftId: DRAFT_ID, idempotencyKey: KEY }, { silpo_session: "session-val" }));
    expect(resolveDemoIdentity).not.toHaveBeenCalled();
    expect(resolveSession).toHaveBeenCalledTimes(1);
  });

  it("T16-27 issues the demo cookie with the same policy as draft creation", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts);
    const commits = createInMemoryCartCommitRepository();
    const { handle } = makeGateway();

    const handler = createCartCommitPostHandler(makeDeps({ drafts, commits, gatewayHandle: handle }, {
      resolveDemoIdentity: async () => ({
        userId: USER,
        handle: DEMO_HANDLE,
        issued: true,
      }),
    }));

    const response = await handler(post({ draftId: DRAFT_ID, idempotencyKey: KEY }));
    const cookie = response.cookies.get(DEMO_SESSION_COOKIE);
    expect(cookie).toMatchObject({
      name: DEMO_SESSION_COOKIE,
      value: DEMO_HANDLE,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
  });

  it("T16-28 never leaks a cause into an error body", async () => {
    const drafts = createInMemoryDraftRepository();
    const commits = createInMemoryCartCommitRepository();
    const { handle } = makeGateway();

    const handler = createCartCommitPostHandler(makeDeps({ drafts, commits, gatewayHandle: handle }, {
      commit: vi.fn(async () => { throw new Error("https://mcp.silpo.ua?token=secret123"); }),
    }));

    const response = await handler(post({ draftId: DRAFT_ID, idempotencyKey: KEY }, { [DEMO_SESSION_COOKIE]: DEMO_HANDLE }));
    expect(response.status).toBe(500);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("correlationId");
    expect(body).not.toMatch(/https?:\/\//);
    expect(body).not.toContain("token");
  });
});
