import type { DataMode, SilpoGateway } from "@/features/shared/contracts";

import { createDemoSilpoGateway } from "./demo/demo-gateway";
import { createLiveCartContextGateway } from "./live/cart-context";
import { createLiveCatalogGateway } from "./live/catalog";
import { createLiveHistoryGateway } from "./live/history";
import {
  openReadSession,
  openWriteSession,
  type McpSession,
  type OpenSessionOptions,
} from "./live/session";
import { createSilpoOAuthProvider } from "./oauth/provider";
import type { SilpoOAuthProvider } from "./oauth/transport";

/**
 * `openReadSession` defaults to 30 s measured from session open, which was
 * sized for a single cart-context operation. A draft run makes dozens of
 * calls through one session, so the budget is raised deliberately here
 * rather than letting long runs abort by accident.
 */
export const DRAFT_MCP_OPERATION_TIMEOUT_MS = 60_000;

import { createLiveCartGateway } from "./live/cart";

export interface SilpoGatewayHandle {
  gateway: SilpoGateway;
  close(): Promise<void>;
}

/** Every seam the test replaces. Each field defaults to the real thing. */
export interface SilpoGatewayDeps {
  createProvider: (
    userId: string,
    options: { publicBaseUrl: string },
  ) => Promise<SilpoOAuthProvider>;
  openReadSession: (options: OpenSessionOptions) => Promise<McpSession>;
  openWriteSession: (options: OpenSessionOptions) => Promise<McpSession>;
  createDemoGateway: () => SilpoGateway;
  now: () => Date;
}

export interface CreateSilpoGatewayOptions {
  mode: DataMode;
  userId: string;
  publicBaseUrl: string;
  deps?: Partial<SilpoGatewayDeps>;
}

export interface LazyWriteSession {
  session: McpSession;
  close(): Promise<void>;
}

/**
 * A write session that exists only if something writes.
 *
 * `createLiveCartContextGateway` takes both sessions at construction, but
 * the writes a session can reach are cart bootstrapping and the cart commit,
 * and neither happens on most draft runs, so the session is still opened lazily.
 *
 * `retryEnabled` is the literal `false` that `openWriteSession` always
 * sets, so answering it needs no session. `advertisedTools` delegates to
 * the read session: both target the same server under the same identity
 * and each performs its own `tools/list`, so the surfaces are identical,
 * and the real write session re-checks the name inside `callTool` anyway.
 */
export function createLazyWriteSession(
  open: () => Promise<McpSession>,
  read: McpSession,
): LazyWriteSession {
  let pending: Promise<McpSession> | null = null;

  const session: McpSession = {
    get advertisedTools() {
      return read.advertisedTools;
    },
    retryEnabled: false,
    async callTool(name, args, schema) {
      pending ??= open();
      const opened = await pending;
      return opened.callTool(name, args, schema);
    },
    async close() {
      if (pending === null) {
        return;
      }
      // A failed open leaves a rejected promise here; closing must not
      // rethrow it and mask the run's own outcome.
      const opened = await pending.catch(() => null);
      await opened?.close().catch(() => {});
    },
  };

  return { session, close: () => session.close() };
}

async function createLiveGatewayHandle(
  options: CreateSilpoGatewayOptions,
  deps: SilpoGatewayDeps,
): Promise<SilpoGatewayHandle> {
  const provider = await deps.createProvider(options.userId, {
    publicBaseUrl: options.publicBaseUrl,
  });
  const sessionOptions: OpenSessionOptions = {
    provider,
    operationTimeoutMs: DRAFT_MCP_OPERATION_TIMEOUT_MS,
  };

  const readSession = await deps.openReadSession(sessionOptions);
  const lazyWrite = createLazyWriteSession(
    () => deps.openWriteSession(sessionOptions),
    readSession,
  );

  const history = createLiveHistoryGateway({ readSession, now: deps.now });
  const cart = createLiveCartContextGateway({
    readSession,
    writeSession: lazyWrite.session,
    now: deps.now,
  });
  const catalog = createLiveCatalogGateway({ readSession });
  const cartWrite = createLiveCartGateway({
    readSession,
    writeSession: lazyWrite.session,
  });

  const gateway: SilpoGateway = {
    // A cached read of the `tools/list` the session already performed
    // during `connect`, not a second round trip.
    async listTools() {
      return [...readSession.advertisedTools].sort();
    },
    loadCustomerContext: () => history.loadCustomerContext(),
    loadCartContext: () => cart.loadCartContext(),
    updateCartContext: (input) => cart.updateCartContext(input),
    loadPurchaseHistory: (context) => history.loadPurchaseHistory(context),
    findProducts: (context, queries) => catalog.findProducts(context, queries),
    getPromotions: (context) => catalog.getPromotions(context),
    getProductDetails: (context, slug) => catalog.getProductDetails(context, slug),
    getSimilarProducts: (context, slug) => catalog.getSimilarProducts(context, slug),
    getReplacements: (context, slug) => catalog.getReplacements(context, slug),
    getTimeSlots: (context) => cart.getTimeSlots(context),
    setAbsoluteCartQuantities: (input) => cartWrite.setAbsoluteCartQuantities(input),
    readCart: (cartId) => cartWrite.readCart(cartId),
  };

  return {
    gateway,
    async close() {
      await lazyWrite.close();
      await readSession.close().catch(() => {});
    },
  };
}

/**
 * The mode is fixed at creation and never changes afterwards. Live mode
 * cannot reach the demo branch, so a live failure surfaces as an error
 * rather than as silently substituted demo data.
 */
export async function createSilpoGateway(
  options: CreateSilpoGatewayOptions,
): Promise<SilpoGatewayHandle> {
  const deps: SilpoGatewayDeps = {
    createProvider: (userId, providerOptions) =>
      createSilpoOAuthProvider(userId, providerOptions),
    openReadSession,
    openWriteSession,
    createDemoGateway: createDemoSilpoGateway,
    now: () => new Date(),
    ...options.deps,
  };

  if (options.mode === "demo") {
    return { gateway: deps.createDemoGateway(), close: async () => {} };
  }

  return createLiveGatewayHandle(options, deps);
}
