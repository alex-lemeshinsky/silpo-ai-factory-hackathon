import { createDemoSilpoGateway } from "@/features/silpo/demo/demo-gateway";

async function loadReadyCart() {
  const result = await createDemoSilpoGateway().loadCartContext();
  if (result.status !== "ready") {
    throw new Error("demo fixture must start with a ready cart");
  }
  return result.context;
}

it("serves the complete demo gateway contract from one validated snapshot", async () => {
  const gateway = createDemoSilpoGateway();
  const cart = await loadReadyCart();

  expect(await gateway.listTools()).toEqual([
    "silpo_get_my_family",
    "silpo_get_my_food_restrictions",
    "silpo_get_loyalty_info",
    "silpo_get_my_shopping_cart",
    "silpo_get_shopping_cart_by_id",
    "silpo_update_shopping_cart",
    "silpo_get_my_online_orders",
    "silpo_get_my_offline_orders",
    "silpo_find_products_batch",
    "silpo_get_promotions",
    "silpo_get_product_details",
    "silpo_get_similar_products",
    "silpo_get_time_slots",
    "silpo_add_or_update_cart_products",
  ]);
  expect(await gateway.loadCustomerContext()).toEqual({
    familySize: 3,
    restrictionKeys: ["no-added-sugar"],
    loyaltyBonusAvailable: 84.5,
  });
  expect(await gateway.loadPurchaseHistory(cart)).toHaveLength(30);
  const searchResults = await gateway.findProducts(cart, ["вода", "молоко"]);
  expect(searchResults).toHaveLength(2);
  expect(searchResults[0]?.query).toBe("вода");
  expect(searchResults[0]?.products).toContainEqual(
    expect.objectContaining({ productId: "demo-water-still-15l" }),
  );
  expect(searchResults[1]?.query).toBe("молоко");
  expect(searchResults[1]?.products).toContainEqual(
    expect.objectContaining({ productId: "demo-milk-25-900g" }),
  );
  expect(await gateway.getPromotions(cart)).toContainEqual({
    id: "demo-promo-oatmeal",
    label: "Демонстраційна знижка",
    price: 42.9,
  });
  expect((await gateway.getProductDetails(cart, "demo-water-still-15l")).productId)
    .toBe("demo-water-still-15l");
  expect(await gateway.getSimilarProducts(cart, "demo-water-still-15l"))
    .toContainEqual(expect.objectContaining({ productId: "demo-water-still-2l" }));
  expect(await gateway.getTimeSlots(cart)).toHaveLength(3);
});

it("returns cloned data so consumers cannot mutate the snapshot", async () => {
  const gateway = createDemoSilpoGateway();
  const cart = await loadReadyCart();
  const first = await gateway.loadPurchaseHistory(cart);

  first[0]!.items.length = 0;

  const second = await gateway.loadPurchaseHistory(cart);
  expect(second[0]!.items.length).toBeGreaterThan(0);
});

it("updates and verifies cart context in memory", async () => {
  const gateway = createDemoSilpoGateway();

  const context = await gateway.updateCartContext({
    deliveryType: "pickup",
    addressId: null,
    branchId: "demo-branch-kyiv-02",
    slotId: "demo-slot-pickup",
  });

  expect(context).toMatchObject({
    deliveryType: "pickup",
    branchId: "demo-branch-kyiv-02",
    slot: { id: "demo-slot-pickup" },
  });
  expect(await gateway.loadCartContext()).toEqual({ status: "ready", context });
});

it("keeps absolute cart mutations scoped to one gateway instance", async () => {
  const firstGateway = createDemoSilpoGateway();
  const secondGateway = createDemoSilpoGateway();

  await firstGateway.setAbsoluteCartQuantities({
    cartId: "demo-cart-ready",
    items: [{ productId: "demo-water-still-15l", quantity: 3 }],
    addQuantity: false,
  });

  expect(await firstGateway.readCart("demo-cart-ready")).toMatchObject({
    status: "verified",
    items: [{ productId: "demo-water-still-15l", quantity: 3 }],
    total: 74.7,
  });
  expect(await secondGateway.readCart("demo-cart-ready")).toMatchObject({
    items: [{ productId: "demo-water-still-15l", quantity: 1 }],
    total: 24.9,
  });
});

it("exposes successful and blocked cart readbacks", async () => {
  const gateway = createDemoSilpoGateway();

  expect(await gateway.readCart("demo-cart-ready")).toMatchObject({
    status: "verified",
    checkoutLinks: {
      web: "https://demo.example.test/cart/demo-cart-ready",
      mobile: "https://demo.example.test/app/cart/demo-cart-ready",
    },
  });
  const blockedCart = await gateway.readCart("demo-cart-blocked");
  expect(blockedCart).toMatchObject({
    status: "blocked",
    checkoutLinks: null,
  });
  expect(blockedCart.validations).toContainEqual(
    expect.objectContaining({ severity: "error", code: "slot_expired" }),
  );
});

it("does not reflect unknown identifiers in adapter errors", async () => {
  const gateway = createDemoSilpoGateway();

  await expect(gateway.readCart("private-cart-id"))
    .rejects.toThrowError(new Error("Unknown demo cart"));
});

it("offers replacements drawn from selectable similar products", async () => {
  const gateway = createDemoSilpoGateway();
  const cart = await loadReadyCart();

  const replacements = await gateway.getReplacements(cart, "demo-water-still-15l");

  expect(replacements.length).toBeGreaterThan(0);
  for (const product of replacements) {
    expect(product.available).toBe(true);
    expect(product.stock).toBeGreaterThan(0);
  }
});

it("returns no replacements for an unknown slug", async () => {
  const gateway = createDemoSilpoGateway();
  const cart = await loadReadyCart();

  expect(await gateway.getReplacements(cart, "demo-unknown-slug")).toEqual([]);
});

