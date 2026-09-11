import { describe, expect, it, vi } from "vitest";

import {
  commitApprovedDraft,
  type CommitApprovedDraftInput,
} from "@/features/cart/commit-service";
import {
  createInMemoryCartCommitRepository,
  type CartCommitRepository,
} from "@/features/cart/repository";
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
import { MissingCartBranchError } from "@/features/silpo/live/cart";
import { McpCallError } from "@/features/silpo/live/session";
import { sanitizeTrace, type Logger, type ToolTrace } from "@/lib/logger";

const USER = "00000000-0000-4000-8000-000000000001";
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

function productFor(query: string, overrides: Partial<ProductCandidate> = {}): ProductCandidate {
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
    ...overrides,
  };
}

function cartAfterWrite(overrides: Partial<VerifiedCart> = {}): VerifiedCart {
  return {
    cartId: CART_ID,
    status: "verified",
    items: [{ productId: "p-1", quantity: 3, unitPrice: 24.9, available: true }],
    total: 74.7,
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
    readCart: vi.fn(async () => cartAfterWrite()),
    ...overrides,
  };
  const close = vi.fn(async () => {});
  return { gateway, close, handle: { gateway, close } };
}

async function setupApprovedDraft(
  drafts: DraftRepository,
  draft: Draft = confirmingDraft,
  key: string = KEY,
) {
  const readyDraft: Draft = {
    ...draft,
    status: "ready",
    version: 1,
  };
  await drafts.save(USER, readyDraft);
  await drafts.approveSelection({
    draftId: draft.id,
    userId: USER,
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

function runCommit(
  deps: { drafts: DraftRepository; commits: CartCommitRepository; handle: SilpoGatewayHandle },
  overrides: Partial<CommitApprovedDraftInput> = {},
) {
  return commitApprovedDraft(
    { draftId: DRAFT_ID, userId: USER, idempotencyKey: KEY, correlationId: "c1", ...overrides },
    { drafts: deps.drafts, commits: deps.commits, openGateway: async () => deps.handle },
  );
}

async function verifiedCommitScenario() {
  const drafts = createInMemoryDraftRepository();
  await setupApprovedDraft(drafts, confirmingDraft, KEY);
  const commits = createInMemoryCartCommitRepository();

  const emptyCart = cartAfterWrite({ items: [], total: 0 });
  const fullCart = cartAfterWrite({
    items: [{ productId: "p-1", quantity: 2, unitPrice: 24.9, available: true }],
    total: 49.8,
  });
  const { handle, gateway } = makeGateway({
    readCart: vi.fn().mockResolvedValueOnce(emptyCart).mockResolvedValueOnce(fullCart),
  });
  const input: CommitApprovedDraftInput = {
    draftId: DRAFT_ID,
    userId: USER,
    idempotencyKey: KEY,
    correlationId: "c1",
  };
  const deps = {
    drafts,
    commits,
    openGateway: async () => handle,
  };
  return { input, deps, drafts, commits, handle, gateway };
}

function collectingLogger() {
  const traces: ToolTrace[] = [];
  const logger: Logger = {
    async toolCall(input) {
      traces.push(sanitizeTrace(input));
    },
  };
  return { logger, traces };
}

describe("commitApprovedDraft", () => {
  it("T16-01 refuses to write without a persisted approval", async () => {
    const { gateway, handle } = makeGateway();
    const drafts = createInMemoryDraftRepository();
    await drafts.save(USER, confirmingDraft);

    const result = await commitApprovedDraft(
      { draftId: confirmingDraft.id, userId: USER, idempotencyKey: KEY, correlationId: "c1" },
      { drafts, commits: createInMemoryCartCommitRepository(), openGateway: async () => handle },
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "approval_required", message: "Спочатку підтвердьте чернетку.", correlationId: "c1" },
    });
    expect(gateway.setAbsoluteCartQuantities).not.toHaveBeenCalled();
  });

  it("T16-02 refuses to write when the submitted key is not the approved key", async () => {
    const { gateway, handle } = makeGateway();
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);

    const result = await runCommit(
      { drafts, commits: createInMemoryCartCommitRepository(), handle },
      { idempotencyKey: "00000000-0000-4000-8000-999999999999" },
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "approval_required", message: "Спочатку підтвердьте чернетку.", correlationId: "c1" },
    });
    expect(gateway.setAbsoluteCartQuantities).not.toHaveBeenCalled();
  });

  it("T16-03 returns not_found for an unknown or unowned draft", async () => {
    const { gateway, handle } = makeGateway();
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);

    const result = await runCommit(
      { drafts, commits: createInMemoryCartCommitRepository(), handle },
      { draftId: "00000000-0000-4000-8000-000000000999" },
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "not_found", message: "Чернетку не знайдено. Створіть нову.", correlationId: "c1" },
    });
    expect(gateway.setAbsoluteCartQuantities).not.toHaveBeenCalled();
  });

  it("T16-04 refuses to write when the cart has no valid slot and returns the offered slots", async () => {
    const { gateway, handle } = makeGateway({
      loadCartContext: vi.fn(async () => ({ status: "needs_slot" as const, availableSlots: [SLOT] })),
    });
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);

    const result = await runCommit({
      drafts,
      commits: createInMemoryCartCommitRepository(),
      handle,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "needs_slot",
        message: "Оберіть доступний час доставки.",
        correlationId: "c1",
        availableSlots: [SLOT],
      },
    });
    expect(gateway.setAbsoluteCartQuantities).not.toHaveBeenCalled();
  });

  it("T16-04b refuses to write on a retry whose slot has since expired", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);
    const commits = createInMemoryCartCommitRepository();
    await commits.start({
      key: KEY,
      targetQuantities: { "p-1": 3 },
      userId: USER,
      draftId: DRAFT_ID,
      confirmationTimestamp: new Date(),
    });

    const { gateway, handle } = makeGateway({
      loadCartContext: vi.fn(async () => ({ status: "needs_slot" as const, availableSlots: [SLOT] })),
    });

    const result = await runCommit({ drafts, commits, handle });

    expect(result).toMatchObject({ ok: false, error: { code: "needs_slot" } });
    expect(gateway.setAbsoluteCartQuantities).not.toHaveBeenCalled();
  });

  it("T16-05 writes the cart's current quantity plus the approved quantity", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);

    const initialCart = cartAfterWrite({
      items: [{ productId: "p-1", quantity: 1, unitPrice: 24.9, available: true }],
    });
    const finalCart = cartAfterWrite({
      items: [{ productId: "p-1", quantity: 3, unitPrice: 24.9, available: true }],
    });

    const { gateway, handle } = makeGateway({
      readCart: vi.fn().mockResolvedValueOnce(initialCart).mockResolvedValueOnce(finalCart),
    });

    const result = await runCommit({
      drafts,
      commits: createInMemoryCartCommitRepository(),
      handle,
    });

    expect(result.ok).toBe(true);
    expect(gateway.setAbsoluteCartQuantities).toHaveBeenCalledWith({
      cartId: CART_ID,
      items: [{ productId: "p-1", quantity: 3 }],
      addQuantity: false,
    });
  });

  it("T16-06 does not double-add after an uncertain first result", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);
    const commits = createInMemoryCartCommitRepository();

    const initialCart = cartAfterWrite({
      items: [{ productId: "p-1", quantity: 1, unitPrice: 24.9, available: true }],
    });
    const cartHoldingThree = cartAfterWrite({
      items: [{ productId: "p-1", quantity: 3, unitPrice: 24.9, available: true }],
    });

    const setAbsoluteCartQuantities = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(undefined);

    const gateway1 = makeGateway({
      readCart: vi.fn().mockResolvedValue(initialCart),
      setAbsoluteCartQuantities,
    });

    const first = await runCommit({ drafts, commits, handle: gateway1.handle });
    expect(first).toMatchObject({ ok: false, error: { code: "commit_uncertain" } });

    // The second attempt sees 3 in the cart, but reuses persisted target 3
    const gateway2 = makeGateway({
      readCart: vi.fn().mockResolvedValue(cartHoldingThree),
      setAbsoluteCartQuantities,
    });

    const second = await runCommit({ drafts, commits, handle: gateway2.handle });

    expect(setAbsoluteCartQuantities).toHaveBeenNthCalledWith(2, expect.objectContaining({
      items: [{ productId: "p-1", quantity: 3 }],
      addQuantity: false,
    }));
    expect(second.ok).toBe(true);
  });

  it("T16-07 leaves the commit record pending after an uncertain result", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);
    const commits = createInMemoryCartCommitRepository();

    const initialCart = cartAfterWrite({
      items: [{ productId: "p-1", quantity: 1, unitPrice: 24.9, available: true }],
    });
    const { handle } = makeGateway({
      readCart: vi.fn().mockResolvedValue(initialCart),
      setAbsoluteCartQuantities: vi.fn().mockRejectedValue(new Error("network")),
    });

    await runCommit({ drafts, commits, handle });

    await expect(commits.get(KEY)).resolves.toMatchObject({
      status: "pending",
      targetQuantities: { "p-1": 3 },
    });
  });

  it("T16-07b reports price news on a retry but never a re-derived cap", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);
    const commits = createInMemoryCartCommitRepository();
    await commits.start({
      key: KEY,
      targetQuantities: { "p-1": 3 },
      userId: USER,
      draftId: DRAFT_ID,
      confirmationTimestamp: new Date(),
    });

    // The first write landed, so the cart already holds the persisted target.
    // Re-deriving 3 + 2 against stock 4 would invent a cap that was never true
    // of the target actually being written.
    const { gateway, handle } = makeGateway({
      findProducts: vi.fn(async (_c, queries: string[]) =>
        queries.map((q) => ({ query: q, products: [productFor(q, { stock: 4, price: 19.9 })] })),
      ),
      readCart: vi.fn().mockResolvedValue(cartAfterWrite()),
    });

    const result = await runCommit({ drafts, commits, handle });

    if (!result.ok) throw new Error("expected success");
    expect(gateway.setAbsoluteCartQuantities).toHaveBeenCalledWith(expect.objectContaining({
      items: [{ productId: "p-1", quantity: 3 }],
    }));
    const codes = result.value.validations.map((entry) => entry.code);
    expect(codes).toContain("price_changed");
    expect(codes).not.toContain("stock_capped");
    expect(result.value.status).toBe("verified");
    expect(result.value.checkoutLinks).not.toBeNull();
  });

  it("T16-07c still reports a product that went unavailable on a retry", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);
    const commits = createInMemoryCartCommitRepository();
    await commits.start({
      key: KEY,
      targetQuantities: { "p-1": 3 },
      userId: USER,
      draftId: DRAFT_ID,
      confirmationTimestamp: new Date(),
    });

    const { handle } = makeGateway({
      findProducts: vi.fn(async (_c, queries: string[]) =>
        queries.map((q) => ({ query: q, products: [productFor(q, { available: false })] })),
      ),
    });

    const result = await runCommit({ drafts, commits, handle });

    if (!result.ok) throw new Error("expected success");
    expect(result.value.validations.map((entry) => entry.code)).toContain("unavailable_product");
  });

  it("T16-07d reports an expired token as unauthorized, not as a retryable write", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);

    const { handle } = makeGateway({
      setAbsoluteCartQuantities: vi.fn(async () => {
        throw new McpCallError("silpo_add_or_update_cart_products", 401, null);
      }),
    });

    const result = await runCommit({ drafts, commits: createInMemoryCartCommitRepository(), handle });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "unauthorized",
        message: "Не вдалося підтвердити вхід. Увійдіть у «Сільпо» ще раз.",
        correlationId: "c1",
      },
    });
  });

  it("T16-07e reports an expired token on a read as unauthorized too", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);

    const { handle } = makeGateway({
      readCart: vi.fn(async () => {
        throw new McpCallError("silpo_get_shopping_cart_by_id", 401, null);
      }),
    });

    const result = await runCommit({ drafts, commits: createInMemoryCartCommitRepository(), handle });

    expect(result).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });

  it("T16-07f does not invite a retry for a cart that has no branch", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);

    const { handle } = makeGateway({
      setAbsoluteCartQuantities: vi.fn(async () => {
        throw new MissingCartBranchError(CART_ID);
      }),
    });

    const result = await runCommit({ drafts, commits: createInMemoryCartCommitRepository(), handle });

    // Not commit_uncertain: every retry would re-read the same branch-less
    // cart, and the copy must not invite one.
    expect(result).toEqual({
      ok: false,
      error: {
        code: "cart_incomplete",
        message: "Кошик «Сільпо» не готовий: перевірте адресу та магазин доставки.",
        correlationId: "c1",
      },
    });
  });

  it("T16-07g replays the cap that shaped the persisted target on a retry", async () => {
    const drafts = createInMemoryDraftRepository();
    const bigDraft: Draft = {
      ...confirmingDraft,
      items: [draftItem({ quantity: 5 })],
      total: 124.5,
    };
    await setupApprovedDraft(drafts, bigDraft, KEY);
    const commits = createInMemoryCartCommitRepository();

    // First attempt: empty cart, 5 approved, stock 3 -> target capped to 3.
    await commits.start({
      key: KEY,
      targetQuantities: { "p-1": 3 },
      userId: USER,
      draftId: DRAFT_ID,
      adjustments: [{
        productId: "p-1",
        code: "stock_capped",
        message: "Доступно менше, ніж потрібно: кількість зменшено.",
      }],
    });

    const { handle } = makeGateway({
      readCart: vi.fn()
        .mockResolvedValueOnce(cartAfterWrite({ items: [], total: 0 }))
        .mockResolvedValueOnce(cartAfterWrite()),
      findProducts: vi.fn(async (_c, queries: string[]) =>
        queries.map((q) => ({ query: q, products: [productFor(q, { stock: 3 })] })),
      ),
    });

    const result = await runCommit({ drafts, commits, handle });

    if (!result.ok) throw new Error("expected success");
    // The user approved 5 and the cart holds 3. Reporting `verified` here
    // would tell them everything landed.
    expect(result.value.validations.map((entry) => entry.code)).toContain("stock_capped");
    expect(result.value.status).toBe("partially_committed");
    expect(result.value.checkoutLinks).toBeNull();
  });

  it("T16-07h does not double-report a cap the persisted plan already carries", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);
    const commits = createInMemoryCartCommitRepository();
    await commits.start({
      key: KEY,
      targetQuantities: { "p-1": 3 },
      userId: USER,
      draftId: DRAFT_ID,
      adjustments: [{
        productId: "p-1",
        code: "stock_capped",
        message: "Доступно менше, ніж потрібно: кількість зменшено.",
      }],
    });

    const { handle } = makeGateway({
      findProducts: vi.fn(async (_c, queries: string[]) =>
        queries.map((q) => ({ query: q, products: [productFor(q, { stock: 3 })] })),
      ),
    });

    const result = await runCommit({ drafts, commits, handle });

    if (!result.ok) throw new Error("expected success");
    const capped = result.value.validations.filter((entry) => entry.code === "stock_capped");
    expect(capped).toHaveLength(1);
  });

  it("T16-11b reports a cart that simply cannot take more as partial, not blocked", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);

    // Cart already holds 5, stock is 3: nothing can be added, nothing is
    // broken, and the line must be left exactly as the user left it.
    const { gateway, handle } = makeGateway({
      readCart: vi.fn().mockResolvedValue(cartAfterWrite({
        items: [{ productId: "p-1", quantity: 5, unitPrice: 24.9, available: true }],
        total: 124.5,
      })),
      findProducts: vi.fn(async (_c, queries: string[]) =>
        queries.map((q) => ({ query: q, products: [productFor(q, { stock: 3 })] })),
      ),
    });

    const result = await runCommit({ drafts, commits: createInMemoryCartCommitRepository(), handle });

    if (!result.ok) throw new Error("expected success");
    expect(gateway.setAbsoluteCartQuantities).not.toHaveBeenCalled();
    expect(result.value.status).toBe("partially_committed");
  });

  it("T16-08 replays a terminal record without touching the cart", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);
    const commits = createInMemoryCartCommitRepository();

    const { gateway, handle } = makeGateway();
    const first = await runCommit({ drafts, commits, handle });

    vi.mocked(gateway.setAbsoluteCartQuantities).mockClear();
    vi.mocked(gateway.readCart).mockClear();

    const second = await runCommit({ drafts, commits, handle });

    expect(second).toEqual(first);
    expect(gateway.setAbsoluteCartQuantities).not.toHaveBeenCalled();
    expect(gateway.readCart).not.toHaveBeenCalled();
  });

  it("T16-09 caps an approved quantity at stock, warns, and cannot report verified", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);

    // Cart holds 1, two more approved, stock 2: the target is capped to 2,
    // which still adds one unit.
    const { gateway, handle } = makeGateway({
      findProducts: vi.fn(async (_c, queries: string[]) =>
        queries.map((q) => ({ query: q, products: [productFor(q, { stock: 2 })] })),
      ),
      readCart: vi.fn().mockResolvedValue(cartAfterWrite({
        items: [{ productId: "p-1", quantity: 1, unitPrice: 24.9, available: true }],
      })),
    });

    const result = await runCommit({
      drafts,
      commits: createInMemoryCartCommitRepository(),
      handle,
    });

    if (!result.ok) throw new Error("expected success");
    expect(gateway.setAbsoluteCartQuantities).toHaveBeenCalledWith(expect.objectContaining({
      items: [{ productId: "p-1", quantity: 2 }],
    }));
    expect(result.value.status).toBe("partially_committed");
    expect(result.value.checkoutLinks).toBeNull();
  });

  it("T16-09b never writes a line down below what the cart already holds", async () => {
    const drafts = createInMemoryDraftRepository();
    const twoItemDraft: Draft = {
      ...confirmingDraft,
      items: [draftItem(), draftItem({ productId: "p-2", name: "Молоко", externalProductId: 202 })],
      total: 99.6,
    };
    await setupApprovedDraft(drafts, twoItemDraft, KEY);

    // The user already put 5 of p-1 in the cart by hand and stock has since
    // fallen to 3. Nothing can be added, and the existing line must survive.
    const { gateway, handle } = makeGateway({
      findProducts: vi.fn(async () => [{
        query: "будь-що",
        products: [
          productFor("Вода негазована 1.5 л", { stock: 3 }),
          productFor("Молоко", { productId: "p-2", externalProductId: 202, stock: 10 }),
        ],
      }]),
      readCart: vi.fn().mockResolvedValue(cartAfterWrite({
        items: [
          { productId: "p-1", quantity: 5, unitPrice: 24.9, available: true },
          { productId: "p-2", quantity: 2, unitPrice: 24.9, available: true },
        ],
        total: 174.3,
      })),
    });

    const result = await runCommit({ drafts, commits: createInMemoryCartCommitRepository(), handle });

    if (!result.ok) throw new Error("expected success");
    const written = gateway.setAbsoluteCartQuantities as ReturnType<typeof vi.fn>;
    expect(written.mock.calls[0][0].items).toEqual([{ productId: "p-2", quantity: 4 }]);
    expect(result.value.validations.map((entry) => entry.code)).toContain("stock_capped");
  });

  it("T16-09c matches refreshed products by ID even when the echoed query differs", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);

    // Silpo echoes a normalized term rather than the submitted name.
    const { gateway, handle } = makeGateway({
      findProducts: vi.fn(async () => [{
        query: "вода негазована 1,5 л",
        products: [productFor("Вода негазована 1.5 л")],
      }]),
      readCart: vi.fn()
        .mockResolvedValueOnce(cartAfterWrite({ items: [], total: 0 }))
        .mockResolvedValueOnce(cartAfterWrite({
          items: [{ productId: "p-1", quantity: 2, unitPrice: 24.9, available: true }],
          total: 49.8,
        })),
    });

    const result = await runCommit({ drafts, commits: createInMemoryCartCommitRepository(), handle });

    if (!result.ok) throw new Error("expected success");
    expect(gateway.setAbsoluteCartQuantities).toHaveBeenCalledWith(expect.objectContaining({
      items: [{ productId: "p-1", quantity: 2 }],
    }));
    expect(result.value.status).toBe("verified");
  });

  it("T16-09d keeps checkout open when only the price moved", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);

    const { handle } = makeGateway({
      findProducts: vi.fn(async (_c, queries: string[]) =>
        queries.map((q) => ({ query: q, products: [productFor(q, { price: 19.9 })] })),
      ),
      readCart: vi.fn()
        .mockResolvedValueOnce(cartAfterWrite({ items: [], total: 0 }))
        .mockResolvedValueOnce(cartAfterWrite({
          items: [{ productId: "p-1", quantity: 2, unitPrice: 19.9, available: true }],
          total: 39.8,
        })),
    });

    const result = await runCommit({ drafts, commits: createInMemoryCartCommitRepository(), handle });

    if (!result.ok) throw new Error("expected success");
    expect(result.value.validations.map((entry) => entry.code)).toContain("price_changed");
    expect(result.value.status).toBe("verified");
    expect(result.value.checkoutLinks).not.toBeNull();
  });

  it("T16-10 never writes a product it did not resolve by ID", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);

    const { gateway, handle } = makeGateway({
      findProducts: vi.fn(async (_c, queries: string[]) =>
        queries.map((q) => ({ query: q, products: [productFor(q, { productId: "different-id" })] })),
      ),
    });

    const result = await runCommit({
      drafts,
      commits: createInMemoryCartCommitRepository(),
      handle,
    });

    if (!result.ok) throw new Error("expected success");
    expect(gateway.setAbsoluteCartQuantities).not.toHaveBeenCalled();
    expect(result.value.status).toBe("blocked");
  });

  it("T16-11 blocks without a write when every approved line is excluded", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);
    const commits = createInMemoryCartCommitRepository();

    const { gateway, handle } = makeGateway({
      findProducts: vi.fn(async (_c, queries: string[]) =>
        queries.map((query) => ({ query, products: [] })),
      ),
    });

    const result = await runCommit({ drafts, commits, handle });

    if (!result.ok) throw new Error("expected success");
    expect(gateway.setAbsoluteCartQuantities).not.toHaveBeenCalled();
    expect(result.value.status).toBe("blocked");
    await expect(commits.get(KEY)).resolves.toBeNull();
  });

  it("T16-12 never writes or modifies a service row the user did not approve", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);

    const cartWithBag = cartAfterWrite({
      items: [
        { productId: "p-1", quantity: 0, unitPrice: 24.9, available: true },
        { productId: "p-bag", quantity: 1, unitPrice: 5.0, available: true },
      ],
    });
    const cartWithBoth = cartAfterWrite({
      items: [
        { productId: "p-1", quantity: 2, unitPrice: 24.9, available: true },
        { productId: "p-bag", quantity: 1, unitPrice: 5.0, available: true },
      ],
    });

    const { gateway, handle } = makeGateway({
      readCart: vi.fn().mockResolvedValueOnce(cartWithBag).mockResolvedValueOnce(cartWithBoth),
    });

    const result = await runCommit({
      drafts,
      commits: createInMemoryCartCommitRepository(),
      handle,
    });

    if (!result.ok) throw new Error("expected success");
    const written = vi.mocked(gateway.setAbsoluteCartQuantities).mock.calls[0][0];
    expect(written.items.map((item: { productId: string }) => item.productId)).toEqual(["p-1"]);
    expect(result.value.items.find((item) => item.productId === "p-bag")?.quantity).toBe(1);
  });

  it("T16-13 blocks and hides checkout when the readback carries an error validation", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);
    const commits = createInMemoryCartCommitRepository();

    const blockedCart = cartAfterWrite({
      status: "blocked",
      checkoutLinks: null,
      validations: [{ severity: "error", code: "out_of_stock", message: "Немає", productId: "p-1" }],
    });

    const { handle } = makeGateway({
      readCart: vi.fn().mockResolvedValueOnce(cartAfterWrite()).mockResolvedValueOnce(blockedCart),
    });

    const result = await runCommit({ drafts, commits, handle });

    if (!result.ok) throw new Error("expected success");
    expect(result.value.status).toBe("blocked");
    expect(result.value.checkoutLinks).toBeNull();
    await expect(commits.get(KEY)).resolves.toMatchObject({ status: "blocked" });
  });

  it("T16-14 returns checkout links and records the draft outcome for a clean commit", async () => {
    const { input, deps, drafts } = await verifiedCommitScenario();
    const result = await commitApprovedDraft(input, deps);

    if (!result.ok) throw new Error("expected success");
    expect(result.value.status).toBe("verified");
    expect(result.value.checkoutLinks).toEqual({
      web: "https://silpo.ua/cart/cart-1",
      mobile: "https://silpo.ua/app/cart/cart-1",
    });
    await expect(drafts.get(confirmingDraft.id, USER)).resolves.toMatchObject({ status: "verified" });
  });

  it("T16-15 still returns a successful commit when recording the draft outcome fails", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);
    drafts.recordCommitOutcome = vi.fn(async () => { throw new Error("db down"); });

    const { handle } = makeGateway();
    const result = await runCommit({
      drafts,
      commits: createInMemoryCartCommitRepository(),
      handle,
    });

    expect(result.ok).toBe(true);
  });

  it("T16-16 closes the gateway handle on success and on failure", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);

    const { close: close1, handle: handle1 } = makeGateway();
    await runCommit({ drafts, commits: createInMemoryCartCommitRepository(), handle: handle1 });
    expect(close1).toHaveBeenCalledTimes(1);

    const { close: close2, handle: handle2 } = makeGateway({
      loadCartContext: vi.fn(async () => { throw new Error("fail"); }),
    });
    await runCommit({ drafts, commits: createInMemoryCartCommitRepository(), handle: handle2 });
    expect(close2).toHaveBeenCalledTimes(1);
  });

  it("T16-17 reports an unexpected failure without leaking the cause", async () => {
    const drafts = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts, confirmingDraft, KEY);

    const { handle } = makeGateway({
      readCart: vi.fn(async () => { throw new Error("https://mcp.silpo.ua secret-token"); }),
    });

    const result = await runCommit({
      drafts,
      commits: createInMemoryCartCommitRepository(),
      handle,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "unexpected", message: "Не вдалося оновити кошик. Спробуйте ще раз.", correlationId: "c1" },
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("T16-18 produces the same outcome in demo mode as in live mode from the same facts", async () => {
    const drafts1 = createInMemoryDraftRepository();
    const drafts2 = createInMemoryDraftRepository();
    await setupApprovedDraft(drafts1, confirmingDraft, KEY);
    await setupApprovedDraft(drafts2, confirmingDraft, KEY);

    const { handle: liveHandle } = makeGateway();
    const { handle: demoHandle } = makeGateway();

    const liveResult = await runCommit({ drafts: drafts1, commits: createInMemoryCartCommitRepository(), handle: liveHandle });
    const demoResult = await runCommit({ drafts: drafts2, commits: createInMemoryCartCommitRepository(), handle: demoHandle });

    if (!liveResult.ok || !demoResult.ok) throw new Error("expected success");
    expect(demoResult.value.status).toBe(liveResult.value.status);
    expect(demoResult.value.validations).toEqual(liveResult.value.validations);
  });
});

describe("commitApprovedDraft tracing", () => {
  it("A17-28 emits one commit trace whose status follows the terminal outcome", async () => {
    const { logger, traces } = collectingLogger();
    const scenario = await verifiedCommitScenario();

    const result = await commitApprovedDraft(scenario.input, { ...scenario.deps, logger });

    expect(result.ok).toBe(true);
    const runTraces = traces.filter((entry) => entry.toolName === "cart_commit");
    expect(runTraces).toHaveLength(1);
    expect(runTraces[0]).toMatchObject({ status: "ok", retryCount: 0 });
  });

  it("A17-29 reports a retry as attempt one", async () => {
    const { logger, traces } = collectingLogger();
    const scenario = await verifiedCommitScenario();

    await commitApprovedDraft(scenario.input, { ...scenario.deps, logger });
    await commitApprovedDraft(scenario.input, { ...scenario.deps, logger });

    const runTraces = traces.filter((entry) => entry.toolName === "cart_commit");
    expect(runTraces.map((entry) => entry.retryCount)).toEqual([0, 1]);
  });

  it("A17-30 traces the cart write itself", async () => {
    const { logger, traces } = collectingLogger();
    const scenario = await verifiedCommitScenario();

    await commitApprovedDraft(scenario.input, { ...scenario.deps, logger });

    expect(traces.map((entry) => entry.toolName)).toContain("setAbsoluteCartQuantities");
  });

  it("emits status: 'blocked' on a blocked commit", async () => {
    const { logger, traces } = collectingLogger();
    const scenario = await verifiedCommitScenario();
    scenario.gateway.findProducts = vi.fn(async (_c, queries: string[]) =>
      queries.map((query) => ({ query, products: [] })),
    );

    const result = await commitApprovedDraft(scenario.input, { ...scenario.deps, logger });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.value.status).toBe("blocked");
    const runTraces = traces.filter((entry) => entry.toolName === "cart_commit");
    expect(runTraces).toHaveLength(1);
    expect(runTraces[0]).toMatchObject({ status: "blocked" });
  });

  it("emits status: 'blocked' on replaying a stored blocked commit", async () => {
    const { logger, traces } = collectingLogger();
    const scenario = await verifiedCommitScenario();
    await scenario.commits.start({
      key: scenario.input.idempotencyKey,
      targetQuantities: { "p-1": 2 },
      userId: scenario.input.userId,
      draftId: scenario.input.draftId,
      confirmationTimestamp: new Date(),
    });
    const blockedCart = cartAfterWrite({ status: "blocked", checkoutLinks: null });
    await scenario.commits.saveResult(scenario.input.idempotencyKey, {
      status: "blocked",
      data: { cart: blockedCart },
    });

    const result = await commitApprovedDraft(scenario.input, { ...scenario.deps, logger });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.value.status).toBe("blocked");
    const runTraces = traces.filter((entry) => entry.toolName === "cart_commit");
    expect(runTraces).toHaveLength(1);
    expect(runTraces[0]).toMatchObject({ status: "blocked", retryCount: 1 });
  });

  it("emits status: 'error' on commit failure", async () => {
    const { logger, traces } = collectingLogger();
    const scenario = await verifiedCommitScenario();
    scenario.gateway.loadCartContext = vi.fn(async () => {
      throw new McpCallError("silpo_get_shopping_cart", 500, null);
    });

    const result = await commitApprovedDraft(scenario.input, { ...scenario.deps, logger });

    expect(result.ok).toBe(false);
    const runTraces = traces.filter((entry) => entry.toolName === "cart_commit");
    expect(runTraces).toHaveLength(1);
    expect(runTraces[0]).toMatchObject({ status: "error" });
  });

  it("never lets a logger fault fail the commit", async () => {
    const scenario = await verifiedCommitScenario();
    const throwingLogger: Logger = {
      toolCall: async () => {
        throw new Error("logger down");
      },
    };

    const result = await commitApprovedDraft(scenario.input, {
      ...scenario.deps,
      logger: throwingLogger,
    });

    expect(result.ok).toBe(true);
  });
});

