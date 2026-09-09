import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import type { SilpoGateway } from "@/features/shared/contracts";

import {
  createLazyWriteSession,
  createSilpoGateway,
  DRAFT_MCP_OPERATION_TIMEOUT_MS,
  NotImplementedForDraftRunError,
  type SilpoGatewayDeps,
} from "./gateway";
import type { McpSession, OpenSessionOptions } from "./live/session";

interface FakeSession extends McpSession {
  readonly calls: string[];
  closeCount: number;
  closeError: Error | null;
}

function fakeSession(tools: string[] = ["silpo_get_my_shopping_cart"]): FakeSession {
  const session: FakeSession = {
    advertisedTools: new Set(tools),
    retryEnabled: true,
    calls: [],
    closeCount: 0,
    closeError: null,
    async callTool<T>(name: string): Promise<T> {
      session.calls.push(name);
      return undefined as T;
    },
    async close(): Promise<void> {
      session.closeCount += 1;
      if (session.closeError !== null) {
        throw session.closeError;
      }
    },
  };
  return session;
}

function liveOptions(overrides: Partial<SilpoGatewayDeps> = {}) {
  // Insertion order deliberately differs from BOTH sorted and reversed
  // order, so the `listTools` assertion below cannot pass by coincidence.
  const read = fakeSession([
    "silpo_get_time_slots",
    "silpo_find_address",
    "silpo_get_my_shopping_cart",
  ]);
  const write = fakeSession();
  // Typed parameters, so `mock.calls[0][0]` below is `OpenSessionOptions`
  // rather than `never`.
  const openReadSession = vi.fn(async (options: OpenSessionOptions) => {
    void options;
    return read as McpSession;
  });
  const openWriteSession = vi.fn(async (options: OpenSessionOptions) => {
    void options;
    return write as McpSession;
  });
  const createDemoGateway = vi.fn(() => ({}) as SilpoGateway);
  return {
    read,
    write,
    openReadSession,
    openWriteSession,
    createDemoGateway,
    options: {
      mode: "live" as const,
      userId: "user-1",
      publicBaseUrl: "https://app.example.ua",
      deps: {
        createProvider: vi.fn(async () => ({}) as never),
        openReadSession,
        openWriteSession,
        createDemoGateway,
        ...overrides,
      },
    },
  };
}

describe("createLazyWriteSession", () => {
  it("opens nothing until the first tool call", async () => {
    const read = fakeSession(["a", "b"]);
    const open = vi.fn(async () => fakeSession());

    const lazy = createLazyWriteSession(open, read);

    expect(open).not.toHaveBeenCalled();
    expect(lazy.session.retryEnabled).toBe(false);
    expect([...lazy.session.advertisedTools]).toEqual(["a", "b"]);
  });

  it("opens once and reuses the session across calls", async () => {
    const opened = fakeSession();
    const open = vi.fn(async () => opened as McpSession);
    const lazy = createLazyWriteSession(open, fakeSession());

    await lazy.session.callTool("silpo_create_shopping_cart", {}, undefined as never);
    await lazy.session.callTool("silpo_update_shopping_cart", {}, undefined as never);

    expect(open).toHaveBeenCalledTimes(1);
    expect(opened.calls).toEqual(["silpo_create_shopping_cart", "silpo_update_shopping_cart"]);
  });

  it("shares one open between concurrent first calls", async () => {
    const open = vi.fn(async () => fakeSession() as McpSession);
    const lazy = createLazyWriteSession(open, fakeSession());

    await Promise.all([
      lazy.session.callTool("a", {}, undefined as never),
      lazy.session.callTool("b", {}, undefined as never),
    ]);

    expect(open).toHaveBeenCalledTimes(1);
  });

  it("closes nothing when it never opened, and closes once when it did", async () => {
    const opened = fakeSession();
    const lazy = createLazyWriteSession(async () => opened as McpSession, fakeSession());

    await lazy.close();
    expect(opened.closeCount).toBe(0);

    await lazy.session.callTool("a", {}, undefined as never);
    await lazy.close();
    expect(opened.closeCount).toBe(1);
  });

  it("does not throw from close when the open itself failed", async () => {
    const lazy = createLazyWriteSession(async () => {
      throw new Error("no write session");
    }, fakeSession());

    await expect(lazy.session.callTool("a", {}, undefined as never)).rejects.toThrow("no write session");
    await expect(lazy.close()).resolves.toBeUndefined();
  });
});

describe("createSilpoGateway", () => {
  it("returns the demo gateway without opening any session", async () => {
    const demo = {} as SilpoGateway;
    const createDemoGateway = vi.fn(() => demo);
    const openReadSession = vi.fn();

    const handle = await createSilpoGateway({
      mode: "demo",
      userId: "unused",
      publicBaseUrl: "https://app.example.ua",
      deps: { createDemoGateway, openReadSession },
    });

    expect(handle.gateway).toBe(demo);
    expect(openReadSession).not.toHaveBeenCalled();
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it("never falls back to the demo gateway in live mode", async () => {
    const { options, createDemoGateway } = liveOptions();

    await createSilpoGateway(options);

    expect(createDemoGateway).not.toHaveBeenCalled();
  });

  it("opens the read session with the draft run's raised budget", async () => {
    const { options, openReadSession } = liveOptions();

    await createSilpoGateway(options);

    expect(DRAFT_MCP_OPERATION_TIMEOUT_MS).toBe(60_000);
    expect(openReadSession).toHaveBeenCalledTimes(1);
    expect(openReadSession.mock.calls[0][0]).toMatchObject({
      operationTimeoutMs: DRAFT_MCP_OPERATION_TIMEOUT_MS,
    });
  });

  it("opens no write session while only reading", async () => {
    const { options, openWriteSession } = liveOptions();

    const handle = await createSilpoGateway(options);
    await handle.gateway.listTools();

    expect(openWriteSession).not.toHaveBeenCalled();
  });

  it("reports the advertised surface, sorted", async () => {
    const { options } = liveOptions();

    const handle = await createSilpoGateway(options);

    expect(await handle.gateway.listTools()).toEqual([
      "silpo_find_address",
      "silpo_get_my_shopping_cart",
      "silpo_get_time_slots",
    ]);
  });

  it("closes the read session and survives a failing close", async () => {
    const { options, read } = liveOptions();
    read.closeError = new Error("socket already gone");

    const handle = await createSilpoGateway(options);

    await expect(handle.close()).resolves.toBeUndefined();
    expect(read.closeCount).toBe(1);
  });

  it("refuses the two cart-write methods that belong to Task 16", async () => {
    const { options } = liveOptions();
    const handle = await createSilpoGateway(options);

    await expect(handle.gateway.readCart("cart-1")).rejects.toThrow(NotImplementedForDraftRunError);
    await expect(
      handle.gateway.setAbsoluteCartQuantities({ cartId: "cart-1", items: [{ productId: "p", quantity: 1 }], addQuantity: false }),
    ).rejects.toThrow(NotImplementedForDraftRunError);
  });
});

/**
 * The composition's own wiring, driven through the real live gateways with
 * canned tool results — the pattern `tests/contract/silpo-cart-context.test.ts`
 * established.
 *
 * The fakes above return `undefined` from `callTool`, which cannot survive
 * the live gateways' Zod parsing, so they can only exercise `listTools` and
 * the Task 16 stubs. Without this block a refactor could pass the *read*
 * session where the write session belongs and every test would still pass —
 * silently making `silpo_create_shopping_cart` retryable and breaking
 * "Never automatically retry a cart write" (AGENTS.md).
 */
describe("createSilpoGateway live composition", () => {
  const NOW = new Date("2026-09-08T09:00:00Z");

  const READ_TOOLS = [
    "silpo_get_my_shopping_cart",
    "silpo_get_shopping_cart_by_id",
    "silpo_get_time_slots",
    "silpo_get_my_delivery_addresses",
    "silpo_find_address",
    "silpo_get_available_delivery_types",
    "silpo_get_my_online_orders",
    "silpo_get_my_offline_orders",
  ];
  const WRITE_TOOLS = ["silpo_create_shopping_cart", "silpo_update_shopping_cart"];

  const activeSlot = {
    id: "slot-1",
    start: "2026-09-08T10:00:00Z",
    end: "2026-09-08T12:00:00Z",
    available: true,
  };

  const cartWithSlot = {
    id: "cart-1",
    branchId: "branch-7",
    deliveryType: "DeliveryHome",
    timeslot: { id: "slot-1", start: activeSlot.start, end: activeSlot.end },
    address: {
      addressType: "flat",
      city: "Київ",
      street: "Хрещатик",
      house: "1",
      district: null,
      latitude: 50.45,
      longitude: 30.52,
    },
    shipments: [{ id: "ship-1" }],
    total: 0,
    validations: [],
  };

  const onlineOrder = {
    id: "order-1",
    createdAt: "2026-08-20T10:00:00Z",
    city: "Київ",
    total: 120,
    items: [{
      id: "order-1-item-1",
      lagerId: 1001,
      productId: "p-1",
      name: "Молоко",
      quantity: 1,
      unit: "шт",
      price: 120,
    }],
  };

  interface CannedSession extends McpSession {
    readonly calls: string[];
    closeCount: number;
  }

  function cannedSession(
    tools: string[],
    handlers: Record<string, () => unknown>,
    retryEnabled: boolean,
  ): CannedSession {
    const session: CannedSession = {
      advertisedTools: new Set(tools),
      retryEnabled,
      calls: [],
      closeCount: 0,
      async callTool<T>(name: string, _args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
        session.calls.push(name);
        const handler = handlers[name];
        if (!handler) {
          throw new Error(`unexpected tool ${name}`);
        }
        return schema.parse(handler());
      },
      async close(): Promise<void> {
        session.closeCount += 1;
      },
    };
    return session;
  }

  function compose(readHandlers: Record<string, () => unknown>) {
    const read = cannedSession(READ_TOOLS, readHandlers, true);
    const write = cannedSession(
      WRITE_TOOLS,
      { silpo_create_shopping_cart: () => ({ cartId: "cart-1" }) },
      false,
    );
    const openWriteSession = vi.fn(async () => write as McpSession);
    return {
      read,
      write,
      openWriteSession,
      handle: createSilpoGateway({
        mode: "live",
        userId: "user-1",
        publicBaseUrl: "https://app.example.ua",
        deps: {
          createProvider: vi.fn(async () => ({}) as never),
          openReadSession: async () => read as McpSession,
          openWriteSession,
          now: () => NOW,
        },
      }),
    };
  }

  const existingCartHandlers = {
    silpo_get_my_shopping_cart: () => ({ exists: true, cartId: "cart-1" }),
    silpo_get_shopping_cart_by_id: () => cartWithSlot,
    silpo_get_time_slots: () => ({ slots: [activeSlot] }),
  };

  const bootstrapHandlers = {
    ...existingCartHandlers,
    silpo_get_my_shopping_cart: () => ({ exists: false, cartId: null }),
    silpo_get_my_delivery_addresses: () => ({
      addresses: [{ id: "addr-1", isDefault: true, city: "Київ", street: "Хрещатик", house: "1" }],
    }),
    silpo_find_address: () => ({
      latitude: 50.45,
      longitude: 30.52,
      city: "Київ",
      street: "Хрещатик",
      houseNumber: "1",
      district: "Шевченківський",
    }),
    silpo_get_available_delivery_types: () => ({
      deliveryTypes: [{ deliveryType: "DeliveryHome", branchId: "branch-7" }],
    }),
  };

  it("resolves a ready cart context through the composed cart gateway", async () => {
    const { handle, read, openWriteSession } = compose(existingCartHandlers);

    const result = await (await handle).gateway.loadCartContext();

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("unreachable");
    expect(result.context.cartId).toBe("cart-1");
    expect(result.context.city).toBe("Київ");
    expect(read.calls).toEqual([
      "silpo_get_my_shopping_cart",
      "silpo_get_shopping_cart_by_id",
      "silpo_get_time_slots",
    ]);
    // The read-only path never pays for a write session.
    expect(openWriteSession).not.toHaveBeenCalled();
  });

  it("sends the cart bootstrap write to the write session, never the read one", async () => {
    const { handle, read, write, openWriteSession } = compose(bootstrapHandlers);

    const result = await (await handle).gateway.loadCartContext();

    expect(result.status).toBe("ready");
    expect(openWriteSession).toHaveBeenCalledTimes(1);
    expect(write.calls).toEqual(["silpo_create_shopping_cart"]);
    expect(read.calls).not.toContain("silpo_create_shopping_cart");
    // The session the write landed on must be the non-retrying one, or the
    // bootstrap becomes an automatically retried cart write.
    expect(write.retryEnabled).toBe(false);
  });

  it("closes both sessions once the write session has been opened", async () => {
    const { handle, read, write } = compose(bootstrapHandlers);
    const opened = await handle;

    await opened.gateway.loadCartContext();
    await opened.close();

    expect(write.closeCount).toBe(1);
    expect(read.closeCount).toBe(1);
  });

  it("returns purchase history through the composed history gateway", async () => {
    const { handle } = compose({
      ...existingCartHandlers,
      silpo_get_my_online_orders: () => ({ orders: [onlineOrder] }),
      silpo_get_my_offline_orders: () => ({ orders: [] }),
    });
    const opened = await handle;
    const context = await opened.gateway.loadCartContext();
    if (context.status !== "ready") throw new Error("unreachable");

    const receipts = await opened.gateway.loadPurchaseHistory(context.context);

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ sourceId: "order-1", channel: "online", city: "Київ" });
  });
});
