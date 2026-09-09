import { ZodError } from "zod";

import type { DraftGeneration } from "@/features/agent/draft-agent";
import type { DraftAgentInput, ProposalViolationCode } from "@/features/agent/draft-output";
import { inferNeeds } from "@/features/prediction/score";
import { resolveProducts } from "@/features/products/resolve-products";
import { normalizePurchases } from "@/features/purchases/normalize";
import type {
  CartContext,
  DataMode,
  Draft,
  RawPurchaseReceipt,
  TimeSlot,
} from "@/features/shared/contracts";
import type { SilpoGatewayHandle } from "@/features/silpo/gateway";
import {
  DeliveryTypeUnavailableError,
  NoSavedAddressError,
  SlotUnavailableError,
  SlotVerificationError,
} from "@/features/silpo/live/cart-context";
import { McpCallError, UnadvertisedToolError } from "@/features/silpo/live/session";
import { InvalidExternalDataError } from "@/features/silpo/schemas/common";
import { err, ok, type AppError, type AppErrorCode, type Result } from "@/lib/result";

import { assembleDraft } from "./assemble";
import type { DraftRepository } from "./repository";

/** Matches no receipt, so every purchase takes the other-city weight. */
export const UNKNOWN_CITY = "__unknown__";

const MESSAGES = {
  needs_slot: "Оберіть доступний слот доставки, щоб зібрати чернетку.",
  no_address: "У профілі «Сільпо» немає збереженої адреси доставки. Додайте її та спробуйте ще раз.",
  delivery_unavailable: "Цей спосіб доставки недоступний за вашою адресою.",
  unauthorized: "Не вдалося підтвердити вхід. Увійдіть у «Сільпо» ще раз.",
  rate_limited: "Забагато запитів. Спробуйте трохи пізніше.",
  invalid_external: "«Сільпо» повернуло некоректну відповідь. Спробуйте ще раз.",
  unexpected: "Не вдалося зібрати чернетку. Спробуйте ще раз.",
} as const;

export interface DraftRun {
  draft: Draft;
  cartContext: CartContext;
  loyaltyBonusAvailable: number | null;
  generation: {
    source: "model" | "fallback";
    attempts: number;
    normalizations: readonly ProposalViolationCode[];
  };
}

export interface DraftFailure {
  error: AppError;
  /** Populated only for `needs_slot`; `null` otherwise. */
  availableSlots: TimeSlot[] | null;
}

export interface CreateDraftDeps {
  openGateway: (options: { mode: DataMode; userId: string }) => Promise<SilpoGatewayHandle>;
  generateDraft: (input: DraftAgentInput) => Promise<DraftGeneration>;
  repository: DraftRepository;
  now?: () => Date;
  newDraftId?: () => string;
}

export interface CreateDraftInput {
  userId: string;
  mode: DataMode;
  correlationId: string;
}

/**
 * A second copy of the cart-context route's parser. Two are acceptable;
 * a third should move to a shared module owned by a task that may edit it.
 */
function parseRetryAfterMs(header: string | null): number | null {
  if (header === null || header.trim().length === 0) {
    return null;
  }
  const seconds = Number.parseInt(header.trim(), 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

function appError(
  code: AppErrorCode,
  message: string,
  correlationId: string,
  retryAfterMs: number | null = null,
): AppError {
  return { code, message, correlationId, retryAfterMs };
}

function failure(
  code: AppErrorCode,
  message: string,
  correlationId: string,
  options: { retryAfterMs?: number | null; availableSlots?: TimeSlot[] | null } = {},
): DraftFailure {
  return {
    error: appError(code, message, correlationId, options.retryAfterMs ?? null),
    availableSlots: options.availableSlots ?? null,
  };
}

/**
 * The cart's own city, else the guest's most recent receipt that has one,
 * else a sentinel. Deterministic and total: the tie-break on `sourceId`
 * means two receipts sharing a timestamp cannot reorder between runs.
 *
 * This changes only the city weighting. It never writes a city onto a
 * receipt, a product or the draft, and it is not persisted.
 */
export function resolveActiveCity(
  context: CartContext,
  receipts: RawPurchaseReceipt[],
): string {
  if (context.city !== null) {
    return context.city;
  }
  const withCity = receipts.filter((receipt) => receipt.city !== null);
  if (withCity.length === 0) {
    return UNKNOWN_CITY;
  }
  const newest = [...withCity].sort((a, b) => {
    const byTime = Date.parse(b.purchasedAt) - Date.parse(a.purchasedAt);
    return byTime !== 0 ? byTime : a.sourceId.localeCompare(b.sourceId);
  })[0];
  return newest.city as string;
}

/**
 * `SlotUnavailableError` and `SlotVerificationError` are raised only by
 * `updateCartContext`, which this run never calls. They are mapped anyway
 * so a future caller cannot turn a slot problem into an opaque 500, and so
 * this stays a total function over the gateway's error types.
 */
function toFailure(error: unknown, correlationId: string): DraftFailure {
  if (error instanceof SlotUnavailableError || error instanceof SlotVerificationError) {
    return failure("needs_slot", MESSAGES.needs_slot, correlationId, { availableSlots: [] });
  }
  if (error instanceof NoSavedAddressError) {
    return failure("cart_validation_error", MESSAGES.no_address, correlationId);
  }
  if (error instanceof DeliveryTypeUnavailableError) {
    return failure("cart_validation_error", MESSAGES.delivery_unavailable, correlationId);
  }
  if (error instanceof McpCallError && error.status === 401) {
    return failure("unauthorized", MESSAGES.unauthorized, correlationId);
  }
  if (error instanceof McpCallError && error.status === 429) {
    return failure("rate_limited", MESSAGES.rate_limited, correlationId, {
      retryAfterMs: parseRetryAfterMs(error.retryAfterHeader),
    });
  }
  if (
    error instanceof InvalidExternalDataError ||
    error instanceof UnadvertisedToolError ||
    error instanceof ZodError
  ) {
    return failure("invalid_external_data", MESSAGES.invalid_external, correlationId);
  }
  // Provider text, URLs, headers and stack traces never reach the client.
  return failure("unexpected", MESSAGES.unexpected, correlationId);
}

/**
 * One draft run, in the order agent architecture section 5 fixes. Every
 * step's failure is typed; none of them can produce `model_invalid_output`,
 * because `generateDraftWithModel` absorbs model and provider faults and
 * returns a deterministic draft instead.
 */
export async function createDraftForUser(
  input: CreateDraftInput,
  deps: CreateDraftDeps,
): Promise<Result<DraftRun, DraftFailure>> {
  const now = deps.now ?? (() => new Date());
  const newDraftId = deps.newDraftId ?? (() => crypto.randomUUID());
  const runStartedAt = now();
  const { correlationId } = input;

  let handle: SilpoGatewayHandle | undefined;
  try {
    handle = await deps.openGateway({ mode: input.mode, userId: input.userId });
    const { gateway } = handle;

    // Mandatory first operation: never assume the available tool surface.
    const tools = await gateway.listTools();
    if (tools.length === 0) {
      return err(failure("invalid_external_data", MESSAGES.invalid_external, correlationId));
    }

    const contextResult = await gateway.loadCartContext();
    if (contextResult.status === "needs_slot") {
      return err(failure("needs_slot", MESSAGES.needs_slot, correlationId, {
        availableSlots: contextResult.availableSlots,
      }));
    }
    const context = contextResult.context;

    const customerContext = await gateway.loadCustomerContext();
    const rawHistory = await gateway.loadPurchaseHistory(context);

    const activeCity = resolveActiveCity(context, rawHistory);
    const normalized = normalizePurchases(rawHistory, activeCity, runStartedAt);
    const needs = inferNeeds({ receipts: normalized, now: runStartedAt, activeCity });
    const resolvedNeeds = await resolveProducts(needs, context, customerContext, gateway);

    const generation = await deps.generateDraft({
      mode: input.mode,
      resolvedNeeds,
      customerContext,
    });

    const draft = assembleDraft({
      id: newDraftId(),
      mode: input.mode,
      trainingCutoff: runStartedAt.toISOString(),
      proposal: generation.proposal,
      resolvedNeeds,
    });

    const saved = await deps.repository.save(input.userId, draft);

    return ok({
      draft: saved,
      cartContext: context,
      loyaltyBonusAvailable: customerContext.loyaltyBonusAvailable,
      generation: {
        source: generation.source,
        attempts: generation.attempts,
        normalizations: generation.normalizations,
      },
    });
  } catch (error) {
    return err(toFailure(error, correlationId));
  } finally {
    // A failure to close never masks the run's own outcome.
    await handle?.close().catch(() => {});
  }
}
