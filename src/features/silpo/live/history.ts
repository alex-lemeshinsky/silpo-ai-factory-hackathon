import type { z } from "zod";

import {
  CustomerContextSchema,
  RawPurchaseReceiptSchema,
  type CartContext,
  type CustomerContext,
  type PurchaseChannel,
  type RawPurchaseReceipt,
} from "@/features/shared/contracts";

import {
  FamilySchema,
  FoodRestrictionsSchema,
  LoyaltyInfoSchema,
  OfflineOrdersSchema,
  OnlineOrdersSchema,
  OrderSchema,
} from "../schemas/history";
import type { McpSession } from "./session";

/**
 * Bounds the history *request*. The domain window, service-row filtering and
 * deduplication belong to `normalizePurchases`; repeating them here would
 * create a second implementation that can drift from it.
 */
const REQUEST_WINDOW_DAYS = 180;
const REQUEST_WINDOW_MS = REQUEST_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export interface LiveHistoryDeps {
  readSession: McpSession;
  now?: () => Date;
}

export interface LiveHistoryGateway {
  loadPurchaseHistory(context: CartContext): Promise<RawPurchaseReceipt[]>;
  loadCustomerContext(): Promise<CustomerContext>;
}

type SilpoOrder = z.infer<typeof OrderSchema>;

/**
 * Builds a contract receipt field by field. Nothing is spread from the raw
 * payload, so a personal field on the wire has no route into the result.
 *
 * Returns null when the order has no mappable item: the contract requires at
 * least one, and an invalid object is never emitted.
 */
function toReceipt(order: SilpoOrder, channel: PurchaseChannel): RawPurchaseReceipt | null {
  if (order.items.length === 0) {
    return null;
  }

  return RawPurchaseReceiptSchema.parse({
    sourceId: order.id,
    channel,
    purchasedAt: new Date(order.createdAt).toISOString(),
    city: order.city,
    total: order.total,
    items: order.items.map((item) => ({
      sourceId: item.id,
      externalProductId: item.lagerId,
      productId: item.productId,
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      unitPrice: item.price,
    })),
  });
}

export function createLiveHistoryGateway(deps: LiveHistoryDeps): LiveHistoryGateway {
  const { readSession } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    async loadPurchaseHistory(context: CartContext): Promise<RawPurchaseReceipt[]> {
      const dateFrom = new Date(now().getTime() - REQUEST_WINDOW_MS).toISOString();

      const online = await readSession.callTool(
        "silpo_get_my_online_orders",
        { dateFrom },
        OnlineOrdersSchema,
      );
      const offline = await readSession.callTool(
        "silpo_get_my_offline_orders",
        { dateFrom, branchId: context.branchId },
        OfflineOrdersSchema,
      );

      return [
        ...online.orders.map((order) => toReceipt(order, "online")),
        ...offline.orders.map((order) => toReceipt(order, "offline")),
      ].filter((receipt): receipt is RawPurchaseReceipt => receipt !== null);
    },

    async loadCustomerContext(): Promise<CustomerContext> {
      const family = await readSession.callTool("silpo_get_my_family", {}, FamilySchema);
      const restrictions = await readSession.callTool(
        "silpo_get_my_food_restrictions",
        {},
        FoodRestrictionsSchema,
      );
      const loyalty = await readSession.callTool("silpo_get_loyalty_info", {}, LoyaltyInfoSchema);

      return CustomerContextSchema.parse({
        // The guest plus their listed members.
        familySize: family.members.length + 1,
        restrictionKeys: [...new Set(restrictions.restrictions.map((entry) => entry.key))],
        loyaltyBonusAvailable: loyalty.loyalty.bonusAvailable,
      });
    },
  };
}
