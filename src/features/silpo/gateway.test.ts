import { describe, expect, it, vi } from "vitest";

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
  const read = fakeSession(["silpo_get_my_shopping_cart", "silpo_get_my_online_orders"]);
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
      "silpo_get_my_online_orders",
      "silpo_get_my_shopping_cart",
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
