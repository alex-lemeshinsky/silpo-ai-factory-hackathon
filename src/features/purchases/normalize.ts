import { createHash } from "node:crypto";
import {
  type NormalizedPurchaseItem,
  NormalizedPurchaseItemSchema,
  type NormalizedReceipt,
  NormalizedReceiptSchema,
  type RawPurchaseReceipt,
  RawPurchaseReceiptSchema,
} from "@/features/shared/contracts";
import {
  categorizeItem,
  isServiceItem,
  normalizeItemName,
  normalizeUnit,
} from "./categorize";
import { deduplicateReceipts } from "./deduplicate";

const HISTORY_WINDOW_DAYS = 180;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const HISTORY_WINDOW_MS = HISTORY_WINDOW_DAYS * MS_PER_DAY;

export function normalizePurchases(
  receipts: RawPurchaseReceipt[],
  activeCity: string,
  cutoff: string | Date,
): NormalizedReceipt[] {
  // Validate external input at boundary
  const validatedReceipts = RawPurchaseReceiptSchema.array().parse(receipts);

  const cutoffTime = new Date(cutoff).getTime();
  const windowStartTime = cutoffTime - HISTORY_WINDOW_MS;

  // Filter by cutoff and 180-day history window
  const windowedReceipts = validatedReceipts.filter((receipt) => {
    const purchasedAtTime = new Date(receipt.purchasedAt).getTime();
    return purchasedAtTime <= cutoffTime && purchasedAtTime >= windowStartTime;
  });

  // Deduplicate matching online/offline receipts
  const deduplicatedGroups = deduplicateReceipts(windowedReceipts);

  const normalizedReceipts: NormalizedReceipt[] = deduplicatedGroups.map((group) => {
    const receipt = group.receipt;

    // Filter service rows (bags, delivery, priority fees, etc.)
    const nonServiceItems = receipt.items.filter((item) => !isServiceItem(item.name));

    const items: NormalizedPurchaseItem[] = nonServiceItems.map((item) =>
      NormalizedPurchaseItemSchema.parse({
        sourceId: item.sourceId,
        externalProductId: item.externalProductId,
        productId: item.productId,
        name: item.name,
        normalizedName: normalizeItemName(item.name),
        categoryKey: categorizeItem(item.name),
        quantity: item.quantity,
        unit: normalizeUnit(item.unit),
        unitPrice: item.unitPrice,
      }),
    );

    const isCityActive =
      receipt.city !== null &&
      receipt.city.trim().toLowerCase() === activeCity.trim().toLowerCase();
    const locationWeight = isCityActive ? 1.0 : 0.35;

    const sortedSourceIds = [...group.sourceIds].sort();
    const fingerprintContent = `${sortedSourceIds.join(",")}|${receipt.channel}|${receipt.purchasedAt}|${receipt.total}`;
    const externalFingerprint = createHash("sha256").update(fingerprintContent).digest("hex");

    return NormalizedReceiptSchema.parse({
      sourceIds: group.sourceIds,
      channel: receipt.channel,
      purchasedAt: receipt.purchasedAt,
      city: receipt.city,
      total: receipt.total,
      locationWeight,
      externalFingerprint,
      items,
    });
  });

  return normalizedReceipts;
}
