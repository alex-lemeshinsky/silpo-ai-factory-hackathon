import type { RawPurchaseItem, RawPurchaseReceipt } from "@/features/shared/contracts";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const MAX_TOTAL_DIFF = 1.0;
const MIN_OVERLAP_RATIO = 0.7;

export function getReceiptExternalProductIds(receipt: RawPurchaseReceipt): Set<number> {
  const set = new Set<number>();
  for (const item of receipt.items) {
    if (item.externalProductId !== null && item.externalProductId !== undefined) {
      set.add(item.externalProductId);
    }
  }
  return set;
}

export function areReceiptsDuplicates(a: RawPurchaseReceipt, b: RawPurchaseReceipt): boolean {
  const timeA = new Date(a.purchasedAt).getTime();
  const timeB = new Date(b.purchasedAt).getTime();
  if (Math.abs(timeA - timeB) > FOUR_HOURS_MS) {
    return false;
  }

  if (Math.abs(a.total - b.total) > MAX_TOTAL_DIFF + 1e-9) {
    return false;
  }

  const idsA = getReceiptExternalProductIds(a);
  const idsB = getReceiptExternalProductIds(b);
  if (idsA.size === 0 || idsB.size === 0) {
    return false;
  }

  let sharedCount = 0;
  for (const id of idsA) {
    if (idsB.has(id)) {
      sharedCount++;
    }
  }

  const overlapRatio = sharedCount / Math.max(idsA.size, idsB.size);
  return overlapRatio >= MIN_OVERLAP_RATIO;
}

function mergeReceiptItems(itemsA: RawPurchaseItem[], itemsB: RawPurchaseItem[]): RawPurchaseItem[] {
  const result: RawPurchaseItem[] = [];
  const seenExternalIds = new Set<number>();

  for (const item of itemsA) {
    if (item.externalProductId !== null) {
      seenExternalIds.add(item.externalProductId);
    }
    result.push({ ...item });
  }

  for (const item of itemsB) {
    if (item.externalProductId !== null) {
      if (seenExternalIds.has(item.externalProductId)) {
        const existing = result.find((x) => x.externalProductId === item.externalProductId);
        if (existing && !existing.productId && item.productId) {
          existing.productId = item.productId;
        }
        continue;
      }
      seenExternalIds.add(item.externalProductId);
    }
    result.push({ ...item });
  }

  return result;
}

export interface DeduplicatedReceiptGroup {
  sourceIds: string[];
  receipt: RawPurchaseReceipt;
}

export function deduplicateReceipts(receipts: RawPurchaseReceipt[]): DeduplicatedReceiptGroup[] {
  const groups: DeduplicatedReceiptGroup[] = [];

  for (const receipt of receipts) {
    let matchedGroup = false;
    for (const group of groups) {
      if (areReceiptsDuplicates(group.receipt, receipt)) {
        if (!group.sourceIds.includes(receipt.sourceId)) {
          group.sourceIds.push(receipt.sourceId);
        }

        const preferIncoming = receipt.channel === "online" && group.receipt.channel === "offline";
        const primary = preferIncoming ? receipt : group.receipt;
        const secondary = preferIncoming ? group.receipt : receipt;

        group.receipt = {
          ...primary,
          city: primary.city ?? secondary.city,
          total: Math.max(primary.total, secondary.total),
          items: mergeReceiptItems(primary.items, secondary.items),
        };
        matchedGroup = true;
        break;
      }
    }

    if (!matchedGroup) {
      groups.push({
        sourceIds: [receipt.sourceId],
        receipt: { ...receipt, items: receipt.items.map((it) => ({ ...it })) },
      });
    }
  }

  return groups;
}
