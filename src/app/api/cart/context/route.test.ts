import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveSilpoSession = vi.fn();
const getServerEnv = vi.fn();
const createDemoSilpoGateway = vi.fn();
const createLiveCartContextGateway = vi.fn();
const openReadSession = vi.fn();
const openWriteSession = vi.fn();
const createSilpoOAuthProvider = vi.fn();

vi.mock("@/features/silpo/oauth/service", () => ({ resolveSilpoSession }));
vi.mock("@/lib/env", () => ({ getServerEnv }));
vi.mock("@/features/silpo/demo/demo-gateway", () => ({ createDemoSilpoGateway }));
vi.mock("@/features/silpo/live/cart-context", async () => {
  const actual = await vi.importActual<typeof import("@/features/silpo/live/cart-context")>(
    "@/features/silpo/live/cart-context",
  );
  return { ...actual, createLiveCartContextGateway };
});
vi.mock("@/features/silpo/live/session", async () => {
  const actual = await vi.importActual<typeof import("@/features/silpo/live/session")>(
    "@/features/silpo/live/session",
  );
  return { ...actual, openReadSession, openWriteSession };
});
vi.mock("@/features/silpo/oauth/provider", () => ({ createSilpoOAuthProvider }));

const { POST } = await import("./route");

const validContext = {
  cartId: "cart-1",
  deliveryType: "delivery",
  city: "Київ",
  branchId: "branch-7",
  slot: {
    id: "slot-2",
    startsAt: "2026-09-08T14:00:00Z",
    endsAt: "2026-09-08T16:00:00Z",
    available: true,
  },
};

const body = { deliveryType: "delivery", addressId: null, branchId: "branch-7", slotId: "slot-2" };

function makeRequest(payload: unknown, cookie = "silpo_session=handle-1") {
  return new NextRequest("https://app.silpo-test.ua/api/cart/context", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getServerEnv.mockReturnValue({ DATA_MODE: "live", PUBLIC_BASE_URL: "https://app.silpo-test.ua" });
  resolveSilpoSession.mockResolvedValue({ ok: true, value: { userId: "user-1", expiresAt: new Date() } });
  openReadSession.mockResolvedValue({ close: vi.fn(async () => {}) });
  openWriteSession.mockResolvedValue({ close: vi.fn(async () => {}) });
  createSilpoOAuthProvider.mockResolvedValue({});
});

describe("POST /api/cart/context", () => {
  it("returns the verified context", async () => {
    createLiveCartContextGateway.mockReturnValue({
      updateCartContext: vi.fn(async () => validContext),
    });

    const response = await POST(makeRequest(body));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ mode: "live", context: validContext });
  });

  it("returns 401 without a session", async () => {
    resolveSilpoSession.mockResolvedValue({
      ok: false,
      error: { code: "unauthorized", message: "msg", correlationId: "c", retryAfterMs: null },
    });

    const response = await POST(makeRequest(body, ""));

    expect(response.status).toBe(401);
  });

  it("returns 400 for a malformed body", async () => {
    const response = await POST(makeRequest({ slotId: 42 }));

    expect(response.status).toBe(400);
  });

  it("returns 400 for invalid JSON syntax", async () => {
    const req = new NextRequest("https://app.silpo-test.ua/api/cart/context", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: "silpo_session=handle-1" },
      body: "not a json string",
    });
    const response = await POST(req);

    expect(response.status).toBe(400);
  });

  it("returns 409 when the slot is unavailable", async () => {
    const { SlotUnavailableError } = await vi.importActual<
      typeof import("@/features/silpo/live/cart-context")
    >("@/features/silpo/live/cart-context");
    createLiveCartContextGateway.mockReturnValue({
      updateCartContext: vi.fn(async () => {
        throw new SlotUnavailableError("slot-2");
      }),
    });

    const response = await POST(makeRequest(body));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "needs_slot" } });
  });

  it("returns 429 with retryAfterMs when rate limited", async () => {
    const { McpCallError } = await vi.importActual<typeof import("@/features/silpo/live/session")>(
      "@/features/silpo/live/session",
    );
    createLiveCartContextGateway.mockReturnValue({
      updateCartContext: vi.fn(async () => {
        throw new McpCallError("silpo_update_shopping_cart", 429, "2");
      }),
    });

    const response = await POST(makeRequest(body));

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "rate_limited", retryAfterMs: 2000 },
    });
  });

  it("returns 502 when a Silpo response fails validation", async () => {
    const { InvalidExternalDataError } = await vi.importActual<
      typeof import("@/features/silpo/schemas/common")
    >("@/features/silpo/schemas/common");
    createLiveCartContextGateway.mockReturnValue({
      updateCartContext: vi.fn(async () => {
        throw new InvalidExternalDataError("silpo_get_shopping_cart_by_id");
      }),
    });

    const response = await POST(makeRequest(body));

    expect(response.status).toBe(502);
  });

  it("drives the demo gateway in demo mode", async () => {
    getServerEnv.mockReturnValue({ DATA_MODE: "demo", PUBLIC_BASE_URL: "https://app.silpo-test.ua" });
    const updateCartContext = vi.fn(async () => validContext);
    createDemoSilpoGateway.mockReturnValue({ updateCartContext });

    const response = await POST(makeRequest(body));

    expect(response.status).toBe(200);
    expect(updateCartContext).toHaveBeenCalledTimes(1);
    expect(openReadSession).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ mode: "demo" });
  });

  it("never leaks provider text into an error body", async () => {
    createLiveCartContextGateway.mockReturnValue({
      updateCartContext: vi.fn(async () => {
        throw new Error("https://mcp.silpo.ua/mcp failed: Bearer secret-token-value");
      }),
    });

    const response = await POST(makeRequest(body));
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("secret-token-value");
    expect(text).not.toContain("mcp.silpo.ua");
  });

  it("closes readSession if openWriteSession throws", async () => {
    const closeRead = vi.fn(async () => {});
    openReadSession.mockResolvedValue({ close: closeRead });
    openWriteSession.mockRejectedValue(new Error("write session failed"));

    const response = await POST(makeRequest(body));

    expect(response.status).toBe(500);
    expect(closeRead).toHaveBeenCalledTimes(1);
  });
});

