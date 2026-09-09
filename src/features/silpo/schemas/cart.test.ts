import { describe, expect, it } from "vitest";

import {
  DeliveryAddressesSchema,
  DeliveryTypesSchema,
  MyShoppingCartSchema,
  ShoppingCartSchema,
  TimeSlotsSchema,
} from "./cart";

const validCart = {
  id: "cart-1",
  branchId: "branch-7",
  deliveryType: "DeliveryHome",
  timeslot: { start: "2026-09-08T10:00:00Z", end: "2026-09-08T12:00:00Z" },
  address: { addressType: "flat", city: "Київ", street: "Хрещатик", house: "1" },
  shipments: [{ id: "ship-1", items: [] }],
  total: 420.5,
  validations: [],
};

describe("ShoppingCartSchema", () => {
  it("accepts a documented cart shape", () => {
    expect(ShoppingCartSchema.parse(validCart).id).toBe("cart-1");
  });

  it("tolerates unknown fields Silpo may add", () => {
    const parsed = ShoppingCartSchema.parse({ ...validCart, loyaltyExperiment: { flag: true } });
    expect(parsed).not.toHaveProperty("loyaltyExperiment");
    expect(parsed.id).toBe("cart-1");
  });

  it("rejects a missing required field rather than guessing", () => {
    const withoutId = { ...validCart } as Record<string, unknown>;
    delete withoutId.id;
    expect(ShoppingCartSchema.safeParse(withoutId).success).toBe(false);
  });

  it("rejects a mistyped field rather than coercing", () => {
    expect(ShoppingCartSchema.safeParse({ ...validCart, total: "420.5" }).success).toBe(false);
  });
});

describe("MyShoppingCartSchema", () => {
  it("accepts an existing cart", () => {
    expect(MyShoppingCartSchema.parse({ exists: true, cartId: "cart-1" })).toEqual({
      exists: true,
      cartId: "cart-1",
    });
  });

  it("accepts an absent cart with a null id", () => {
    expect(MyShoppingCartSchema.parse({ exists: false, cartId: null }).exists).toBe(false);
  });
});

describe("TimeSlotsSchema", () => {
  it("parses a slot list", () => {
    const parsed = TimeSlotsSchema.parse({
      slots: [
        { id: "slot-1", start: "2026-09-08T10:00:00Z", end: "2026-09-08T12:00:00Z", available: true },
      ],
    });
    expect(parsed.slots).toHaveLength(1);
  });

  it("rejects a non-ISO timestamp", () => {
    const result = TimeSlotsSchema.safeParse({
      slots: [{ id: "slot-1", start: "08.09.2026 10:00", end: "2026-09-08T12:00:00Z", available: true }],
    });
    expect(result.success).toBe(false);
  });
});

describe("DeliveryTypesSchema", () => {
  it("parses delivery types with a nullable branch", () => {
    const parsed = DeliveryTypesSchema.parse({
      deliveryTypes: [
        { deliveryType: "SelfPickup", branchId: null },
        { deliveryType: "DeliveryHome", branchId: "branch-7" },
      ],
    });
    expect(parsed.deliveryTypes[0].branchId).toBeNull();
  });
});

describe("DeliveryAddressesSchema", () => {
  it("parses saved addresses and marks the default", () => {
    const parsed = DeliveryAddressesSchema.parse({
      addresses: [
        { id: "addr-1", isDefault: true, addressType: "flat", city: "Київ", street: "Хрещатик", house: "1", district: null },
      ],
    });
    expect(parsed.addresses[0].isDefault).toBe(true);
  });

  it("accepts an empty address list", () => {
    expect(DeliveryAddressesSchema.parse({ addresses: [] }).addresses).toEqual([]);
  });
});

const cartWithLines = {
  id: "cart-1",
  branchId: "branch-1",
  deliveryType: "DeliveryHome",
  timeslot: { id: "slot-1", start: "2026-09-09T10:00:00Z", end: "2026-09-09T12:00:00Z" },
  address: null,
  shipments: [],
  total: 124.4,
  validations: [],
  products: [
    { productId: "p-1", quantity: 2, price: 24.9, specialPrice: 19.9, available: true },
    { productId: "p-2", quantity: 1, price: 74.6 },
  ],
  checkout: { webUrl: "https://silpo.ua/cart/cart-1", mobileUrl: "https://silpo.ua/app/cart/cart-1" },
};

describe("ShoppingCartSchema cart lines", () => {
  it("parses product lines and defaults optional line fields", () => {
    const parsed = ShoppingCartSchema.parse(cartWithLines);
    expect(parsed.products).toEqual([
      { productId: "p-1", quantity: 2, price: 24.9, specialPrice: 19.9, available: true },
      { productId: "p-2", quantity: 1, price: 74.6, specialPrice: null, available: true },
    ]);
  });

  it("defaults an absent product list and checkout to empty rather than failing", () => {
    const withoutNewFields = Object.fromEntries(
      Object.entries(cartWithLines).filter(([k]) => k !== "products" && k !== "checkout"),
    );
    const parsed = ShoppingCartSchema.parse(withoutNewFields);
    expect(parsed.products).toEqual([]);
    expect(parsed.checkout).toBeNull();
  });

  it("parses checkout links verbatim without judging their scheme", () => {
    const parsed = ShoppingCartSchema.parse(cartWithLines);
    expect(parsed.checkout).toEqual({
      webUrl: "https://silpo.ua/cart/cart-1",
      mobileUrl: "https://silpo.ua/app/cart/cart-1",
    });
  });

  it("rejects a mistyped line quantity rather than coercing it", () => {
    const broken = { ...cartWithLines, products: [{ productId: "p-1", quantity: "2", price: 24.9 }] };
    expect(() => ShoppingCartSchema.parse(broken)).toThrow();
  });

  it("rejects a line without a product ID rather than guessing", () => {
    const broken = { ...cartWithLines, products: [{ quantity: 2, price: 24.9 }] };
    expect(() => ShoppingCartSchema.parse(broken)).toThrow();
  });

  it("tolerates unknown keys inside a product line", () => {
    const extended = {
      ...cartWithLines,
      products: [{ productId: "p-1", quantity: 2, price: 24.9, loyaltyLabel: "нове" }],
    };
    expect(ShoppingCartSchema.parse(extended).products[0].productId).toBe("p-1");
  });
});

