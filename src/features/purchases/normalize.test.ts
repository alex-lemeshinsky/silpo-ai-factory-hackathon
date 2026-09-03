import { describe, expect, it } from "vitest";
import {
  NormalizedReceiptSchema,
  type RawPurchaseReceipt,
} from "@/features/shared/contracts";
import { normalizePurchases } from "./normalize";

const cutoff = "2026-09-02T00:00:00.000Z";

function makeReceipt(overrides: Partial<RawPurchaseReceipt> = {}): RawPurchaseReceipt {
  return {
    sourceId: "receipt-default-1",
    channel: "offline",
    purchasedAt: "2026-08-20T12:00:00.000Z",
    city: "Київ",
    total: 100,
    items: [
      {
        sourceId: "item-1",
        externalProductId: 101,
        productId: "water-still",
        name: "Вода негазована 1.5 л",
        quantity: 2,
        unit: "шт",
        unitPrice: 25,
      },
      {
        sourceId: "item-2",
        externalProductId: 102,
        productId: "bread-wheat",
        name: "Хліб пшеничний 400 г",
        quantity: 1,
        unit: "шт",
        unitPrice: 50,
      },
    ],
    ...overrides,
  };
}

function receiptWith(serviceName: string): RawPurchaseReceipt {
  return {
    sourceId: `receipt-service-${serviceName}`,
    channel: "offline",
    purchasedAt: "2026-08-20T12:00:00.000Z",
    city: "Київ",
    total: 15,
    items: [
      {
        sourceId: "item-service-1",
        externalProductId: 9999,
        productId: null,
        name: serviceName,
        quantity: 1,
        unit: "шт",
        unitPrice: 15,
      },
    ],
  };
}

describe("normalizePurchases", () => {
  it("deduplicates an online order and matching loyalty receipt", () => {
    const onlineOrder: RawPurchaseReceipt = {
      sourceId: "online-order-1",
      channel: "online",
      purchasedAt: "2026-08-20T12:00:00.000Z",
      city: "Київ",
      total: 100,
      items: [
        {
          sourceId: "online-item-1",
          externalProductId: 101,
          productId: "water-still",
          name: "Вода негазована 1.5 л",
          quantity: 2,
          unit: "шт",
          unitPrice: 25,
        },
        {
          sourceId: "online-item-2",
          externalProductId: 102,
          productId: "bread-wheat",
          name: "Хліб пшеничний 400 г",
          quantity: 1,
          unit: "шт",
          unitPrice: 50,
        },
      ],
    };

    const matchingOfflineReceipt: RawPurchaseReceipt = {
      sourceId: "offline-loyalty-1",
      channel: "offline",
      purchasedAt: "2026-08-20T13:30:00.000Z", // within 4 hours
      city: "Київ",
      total: 100.5, // diff <= 1.0 UAH
      items: [
        {
          sourceId: "offline-item-1",
          externalProductId: 101,
          productId: null,
          name: "Вода негазована 1.5 л",
          quantity: 2,
          unit: "шт",
          unitPrice: 25,
        },
        {
          sourceId: "offline-item-2",
          externalProductId: 102,
          productId: null,
          name: "Хліб пшеничний 400 г",
          quantity: 1,
          unit: "шт",
          unitPrice: 50,
        },
      ],
    };

    const result = normalizePurchases([onlineOrder, matchingOfflineReceipt], "Київ", cutoff);
    expect(result).toHaveLength(1);
    expect(result[0]!.sourceIds).toEqual(
      expect.arrayContaining(["online-order-1", "offline-loyalty-1"]),
    );
    expect(result[0]!.items).toHaveLength(2);
  });

  it("keeps distinct receipts that do not meet deduplication criteria", () => {
    const base = makeReceipt({ sourceId: "r1", purchasedAt: "2026-08-20T10:00:00.000Z" });
    const tooLate = makeReceipt({
      sourceId: "r2",
      purchasedAt: "2026-08-20T15:30:00.000Z", // > 4 hours
    });
    const differentTotal = makeReceipt({
      sourceId: "r3",
      purchasedAt: "2026-08-20T11:00:00.000Z",
      total: 200, // diff > 1.0
    });
    const differentProducts = makeReceipt({
      sourceId: "r4",
      purchasedAt: "2026-08-20T11:00:00.000Z",
      items: [
        {
          sourceId: "diff-item-1",
          externalProductId: 555,
          productId: null,
          name: "Кава 250 г",
          quantity: 1,
          unit: "шт",
          unitPrice: 100,
        },
      ],
    });

    const result = normalizePurchases([base, tooLate, differentTotal, differentProducts], "Київ", cutoff);
    expect(result).toHaveLength(4);
  });

  it.each(["Пакет Сільпо", "Послуга доставки", "Доплата за прискорення"])(
    "filters service row %s",
    (name) => {
      expect(normalizePurchases([receiptWith(name)], "Київ", cutoff)[0]!.items).toHaveLength(0);
    },
  );

  it("assigns weight 0.35 outside the active city", () => {
    const odesaReceipt = makeReceipt({
      sourceId: "odesa-1",
      city: "Одеса",
    });

    expect(normalizePurchases([odesaReceipt], "Київ", cutoff)[0]!.locationWeight).toBe(0.35);
  });

  it("assigns weight 1.0 for the active city", () => {
    const kyivReceipt = makeReceipt({
      sourceId: "kyiv-1",
      city: "Київ",
    });

    expect(normalizePurchases([kyivReceipt], "Київ", cutoff)[0]!.locationWeight).toBe(1.0);
  });

  it("assigns weight 0.35 when city is null", () => {
    const noCityReceipt = makeReceipt({
      sourceId: "no-city-1",
      city: null,
    });

    expect(normalizePurchases([noCityReceipt], "Київ", cutoff)[0]!.locationWeight).toBe(0.35);
  });

  it("filters out receipts after cutoff or older than 180 days", () => {
    const afterCutoff = makeReceipt({
      sourceId: "after-cutoff",
      purchasedAt: "2026-09-03T10:00:00.000Z", // after cutoff 2026-09-02
    });
    const withinWindow = makeReceipt({
      sourceId: "within-window",
      purchasedAt: "2026-07-01T10:00:00.000Z", // ~63 days before cutoff
    });
    const tooOld = makeReceipt({
      sourceId: "too-old",
      purchasedAt: "2026-02-01T10:00:00.000Z", // > 180 days before cutoff
    });

    const result = normalizePurchases([afterCutoff, withinWindow, tooOld], "Київ", cutoff);
    expect(result).toHaveLength(1);
    expect(result[0]!.sourceIds).toEqual(["within-window"]);
  });

  it("normalizes item units and cleans whitespace in item names", () => {
    const receipt = makeReceipt({
      items: [
        {
          sourceId: "raw-item-1",
          externalProductId: 101,
          productId: "water-1",
          name: "  Вода  негазована   1.5л  ",
          quantity: 2,
          unit: " ШТ ",
          unitPrice: 25,
        },
      ],
    });

    const result = normalizePurchases([receipt], "Київ", cutoff);
    expect(result[0]!.items[0]!.normalizedName).toBe("Вода негазована 1.5л");
    expect(result[0]!.items[0]!.unit).toBe("шт");
  });

  it("categorizes items using deterministic rule table and defaults to uncategorized", () => {
    const receipt = makeReceipt({
      items: [
        {
          sourceId: "item-w",
          externalProductId: 101,
          productId: null,
          name: "Вода Моршинська негазована 1.5 л",
          quantity: 1,
          unit: "шт",
          unitPrice: 25,
        },
        {
          sourceId: "item-m",
          externalProductId: 103,
          productId: null,
          name: "Молоко Селянське 2.5% 900 г",
          quantity: 1,
          unit: "шт",
          unitPrice: 40,
        },
        {
          sourceId: "item-u",
          externalProductId: 999,
          productId: null,
          name: "Незвичайний сувенірний магніт",
          quantity: 1,
          unit: "шт",
          unitPrice: 100,
        },
      ],
    });

    const result = normalizePurchases([receipt], "Київ", cutoff);
    expect(result[0]!.items[0]!.categoryKey).toBe("water");
    expect(result[0]!.items[1]!.categoryKey).toBe("dairy");
    expect(result[0]!.items[2]!.categoryKey).toBe("uncategorized");
  });

  it("produces valid NormalizedReceipt conforming to NormalizedReceiptSchema with deterministic fingerprint", () => {
    const receipt = makeReceipt();
    const result1 = normalizePurchases([receipt], "Київ", cutoff);
    const result2 = normalizePurchases([receipt], "Київ", cutoff);

    expect(NormalizedReceiptSchema.parse(result1[0])).toBeDefined();
    expect(result1[0]!.externalFingerprint).toBe(result2[0]!.externalFingerprint);
    expect(result1[0]!.externalFingerprint.length).toBeGreaterThan(0);
  });

  it("normalizes real demo fixture history successfully", async () => {
    const fixture = await import("../../../fixtures/demo/silpo-snapshot.json");
    const normalized = normalizePurchases(
      fixture.purchaseHistory as RawPurchaseReceipt[],
      "Київ",
      "2026-09-03T12:00:00.000Z",
    );

    expect(normalized.length).toBeGreaterThan(0);
    for (const receipt of normalized) {
      expect(NormalizedReceiptSchema.parse(receipt)).toBeDefined();
    }
  });
});
