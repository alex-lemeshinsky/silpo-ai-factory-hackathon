import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import {
  createLiveCartContextGateway,
  mapDeliveryType,
  NoSavedAddressError,
  SlotUnavailableError,
  SlotVerificationError,
} from "@/features/silpo/live/cart-context";
import { UnadvertisedToolError, type McpSession } from "@/features/silpo/live/session";
import type { CartContext } from "@/features/shared/contracts";

const NOW = new Date("2026-09-08T09:00:00Z");

const READ_TOOLS = [
  "silpo_get_my_shopping_cart",
  "silpo_get_shopping_cart_by_id",
  "silpo_get_time_slots",
  "silpo_get_my_delivery_addresses",
  "silpo_find_address",
  "silpo_get_available_delivery_types",
  "silpo_list_branches",
];
const WRITE_TOOLS = ["silpo_create_shopping_cart", "silpo_update_shopping_cart"];

/**
 * A fake session that records call order and returns canned structuredContent.
 * Handlers receive the arguments so a test can assert what was sent.
 */
function createFakeSession(
  tools: string[],
  handlers: Record<string, (args: Record<string, unknown>) => unknown>,
  retryEnabled = true,
): McpSession & { calls: string[]; retryEnabled: boolean } {
  const calls: string[] = [];
  const advertisedTools = new Set(tools);

  return {
    calls,
    advertisedTools,
    retryEnabled,
    async callTool<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
      if (!advertisedTools.has(name)) throw new UnadvertisedToolError(name);
      calls.push(name);
      const handler = handlers[name];
      if (!handler) throw new Error(`unexpected tool ${name}`);
      return schema.parse(handler(args));
    },
    async close() {},
  };
}

const activeSlot = {
  id: "slot-1",
  start: "2026-09-08T10:00:00Z",
  end: "2026-09-08T12:00:00Z",
  available: true,
};

const cartWithSlot = {
  id: "cart-1",
  branchId: "branch-7",
  deliveryType: "DeliveryHome",
  timeslot: { id: "slot-1", start: activeSlot.start, end: activeSlot.end },
  address: {
    addressType: "flat",
    city: "Київ",
    street: "Хрещатик",
    house: "1",
    district: null,
    latitude: null,
    longitude: null,
  },
  shipments: [{ id: "ship-1" }],
  total: 0,
  validations: [],
};

describe("mapDeliveryType", () => {
  it("maps SelfPickup to pickup and everything else to delivery", () => {
    expect(mapDeliveryType("SelfPickup")).toBe("pickup");
    for (const type of ["DeliveryHome", "WideAssortDelivery", "NovaPoshta", "B2B"]) {
      expect(mapDeliveryType(type)).toBe("delivery");
    }
  });
});

describe("loadCartContext with an existing cart", () => {
  it("returns a ready context and follows the documented order", async () => {
    const read = createFakeSession(READ_TOOLS, {
      silpo_get_my_shopping_cart: () => ({ exists: true, cartId: "cart-1" }),
      silpo_get_shopping_cart_by_id: () => cartWithSlot,
      silpo_get_time_slots: () => ({ slots: [activeSlot] }),
    });
    const write = createFakeSession(WRITE_TOOLS, {}, false);
    const gateway = createLiveCartContextGateway({ readSession: read, writeSession: write, now: () => NOW });

    const result = await gateway.loadCartContext();

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("unreachable");
    expect(result.context.cartId).toBe("cart-1");
    expect(result.context.deliveryType).toBe("delivery");
    expect(result.context.slot.id).toBe("slot-1");
    expect(read.calls).toEqual([
      "silpo_get_my_shopping_cart",
      "silpo_get_shopping_cart_by_id",
      "silpo_get_time_slots",
    ]);
    expect(write.calls).toEqual([]);
  });

  it("returns needs_slot when the cart slot has already ended", async () => {
    const expired = { ...activeSlot, id: "slot-0", start: "2026-09-07T10:00:00Z", end: "2026-09-07T12:00:00Z" };
    const read = createFakeSession(READ_TOOLS, {
      silpo_get_my_shopping_cart: () => ({ exists: true, cartId: "cart-1" }),
      silpo_get_shopping_cart_by_id: () => ({
        ...cartWithSlot,
        timeslot: { id: expired.id, start: expired.start, end: expired.end },
      }),
      silpo_get_time_slots: () => ({ slots: [activeSlot] }),
    });
    const gateway = createLiveCartContextGateway({
      readSession: read,
      writeSession: createFakeSession(WRITE_TOOLS, {}, false),
      now: () => NOW,
    });

    const result = await gateway.loadCartContext();

    expect(result.status).toBe("needs_slot");
    if (result.status !== "needs_slot") throw new Error("unreachable");
    expect(result.availableSlots.map((slot) => slot.id)).toEqual(["slot-1"]);
  });

  it("returns needs_slot when the cart slot is absent from the current list", async () => {
    const read = createFakeSession(READ_TOOLS, {
      silpo_get_my_shopping_cart: () => ({ exists: true, cartId: "cart-1" }),
      silpo_get_shopping_cart_by_id: () => cartWithSlot,
      silpo_get_time_slots: () => ({ slots: [{ ...activeSlot, id: "slot-9" }] }),
    });
    const gateway = createLiveCartContextGateway({
      readSession: read,
      writeSession: createFakeSession(WRITE_TOOLS, {}, false),
      now: () => NOW,
    });

    expect((await gateway.loadCartContext()).status).toBe("needs_slot");
  });

  it("returns needs_slot when the cart has no slot at all", async () => {
    const read = createFakeSession(READ_TOOLS, {
      silpo_get_my_shopping_cart: () => ({ exists: true, cartId: "cart-1" }),
      silpo_get_shopping_cart_by_id: () => ({ ...cartWithSlot, timeslot: null }),
      silpo_get_time_slots: () => ({ slots: [activeSlot] }),
    });
    const gateway = createLiveCartContextGateway({
      readSession: read,
      writeSession: createFakeSession(WRITE_TOOLS, {}, false),
      now: () => NOW,
    });

    expect((await gateway.loadCartContext()).status).toBe("needs_slot");
  });

  it("excludes expired slots from availableSlots even when available is true", async () => {
    const expiredSlot = {
      id: "slot-expired",
      start: "2026-09-07T10:00:00Z",
      end: "2026-09-07T12:00:00Z",
      available: true,
    };
    const read = createFakeSession(READ_TOOLS, {
      silpo_get_my_shopping_cart: () => ({ exists: true, cartId: "cart-1" }),
      silpo_get_shopping_cart_by_id: () => ({ ...cartWithSlot, timeslot: null }),
      silpo_get_time_slots: () => ({ slots: [expiredSlot, activeSlot] }),
    });
    const gateway = createLiveCartContextGateway({
      readSession: read,
      writeSession: createFakeSession(WRITE_TOOLS, {}, false),
      now: () => NOW,
    });

    const result = await gateway.loadCartContext();

    expect(result.status).toBe("needs_slot");
    if (result.status !== "needs_slot") throw new Error("unreachable");
    expect(result.availableSlots.map((slot) => slot.id)).toEqual(["slot-1"]);
  });
});

describe("loadCartContext with no cart", () => {
  const bootstrapHandlers = {
    silpo_get_my_shopping_cart: () => ({ exists: false, cartId: null }),
    silpo_get_my_delivery_addresses: () => ({
      addresses: [
        { id: "addr-2", isDefault: false, city: "Львів", street: "Стрийська", house: "5" },
        { id: "addr-1", isDefault: true, city: "Київ", street: "Хрещатик", house: "1" },
      ],
    }),
    silpo_find_address: () => ({
      latitude: 50.45,
      longitude: 30.52,
      city: "Київ",
      street: "Хрещатик",
      houseNumber: "1",
      district: "Шевченківський",
    }),
    silpo_get_available_delivery_types: () => ({
      deliveryTypes: [{ deliveryType: "DeliveryHome", branchId: "branch-7" }],
    }),
    silpo_get_time_slots: () => ({ slots: [activeSlot] }),
    silpo_get_shopping_cart_by_id: () => cartWithSlot,
  };

  it("runs the documented bootstrap and creates the cart via the write session", async () => {
    const read = createFakeSession(READ_TOOLS, bootstrapHandlers);
    const write = createFakeSession(
      WRITE_TOOLS,
      {
        silpo_create_shopping_cart: () => ({ cartId: "cart-1" }),
      },
      false,
    );
    const gateway = createLiveCartContextGateway({ readSession: read, writeSession: write, now: () => NOW });

    const result = await gateway.loadCartContext();

    expect(result.status).toBe("ready");
    expect(read.calls).toEqual([
      "silpo_get_my_shopping_cart",
      "silpo_get_my_delivery_addresses",
      "silpo_find_address",
      "silpo_get_available_delivery_types",
      "silpo_get_time_slots",
      "silpo_get_shopping_cart_by_id",
      "silpo_get_time_slots",
    ]);
    expect(write.calls).toEqual(["silpo_create_shopping_cart"]);
  });

  it("uses the guest's default saved address", async () => {
    const findAddress = vi.fn(() => bootstrapHandlers.silpo_find_address());
    const read = createFakeSession(READ_TOOLS, { ...bootstrapHandlers, silpo_find_address: findAddress });
    const write = createFakeSession(
      WRITE_TOOLS,
      {
        silpo_create_shopping_cart: () => ({ cartId: "cart-1" }),
      },
      false,
    );
    const gateway = createLiveCartContextGateway({ readSession: read, writeSession: write, now: () => NOW });

    await gateway.loadCartContext();

    const [args] = findAddress.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(String(args.text)).toContain("Хрещатик");
    expect(String(args.text)).not.toContain("Стрийська");
  });

  it("calls list_branches only when the delivery type has no branch", async () => {
    const read = createFakeSession(READ_TOOLS, {
      ...bootstrapHandlers,
      silpo_get_available_delivery_types: () => ({
        deliveryTypes: [{ deliveryType: "SelfPickup", branchId: null }],
      }),
      silpo_list_branches: () => ({ branches: [{ id: "branch-3", name: "Сільпо", hasPickup: true }] }),
    });
    const write = createFakeSession(
      WRITE_TOOLS,
      {
        silpo_create_shopping_cart: () => ({ cartId: "cart-1" }),
      },
      false,
    );
    const gateway = createLiveCartContextGateway({ readSession: read, writeSession: write, now: () => NOW });

    await gateway.loadCartContext();

    expect(read.calls).toContain("silpo_list_branches");
  });

  it("fails with NoSavedAddressError instead of inventing an address", async () => {
    const read = createFakeSession(READ_TOOLS, {
      ...bootstrapHandlers,
      silpo_get_my_delivery_addresses: () => ({ addresses: [] }),
    });
    const write = createFakeSession(WRITE_TOOLS, {}, false);
    const gateway = createLiveCartContextGateway({ readSession: read, writeSession: write, now: () => NOW });

    await expect(gateway.loadCartContext()).rejects.toBeInstanceOf(NoSavedAddressError);
    expect(read.calls).not.toContain("silpo_find_address");
    expect(write.calls).toEqual([]);
  });
});

describe("getTimeSlots", () => {
  it("delegates to silpo_get_time_slots with delivery type mapping and returns domain TimeSlots", async () => {
    const read = createFakeSession(READ_TOOLS, {
      silpo_get_time_slots: (args) => {
        expect(args).toEqual({ branchId: "branch-7", deliveryType: "DeliveryHome" });
        return { slots: [activeSlot] };
      },
    });
    const write = createFakeSession(WRITE_TOOLS, {}, false);
    const gateway = createLiveCartContextGateway({ readSession: read, writeSession: write, now: () => NOW });

    const context: CartContext = {
      cartId: "cart-1",
      deliveryType: "delivery",
      city: "Київ",
      branchId: "branch-7",
      slot: {
        id: "slot-1",
        startsAt: activeSlot.start,
        endsAt: activeSlot.end,
        available: true,
      },
    };

    const slots = await gateway.getTimeSlots(context);

    expect(slots).toEqual([
      {
        id: "slot-1",
        startsAt: activeSlot.start,
        endsAt: activeSlot.end,
        available: true,
      },
    ]);
    expect(read.calls).toEqual(["silpo_get_time_slots"]);
  });

  it("maps pickup delivery type to SelfPickup", async () => {
    let requestedDeliveryType: unknown;
    const read = createFakeSession(READ_TOOLS, {
      silpo_get_time_slots: (args) => {
        requestedDeliveryType = args.deliveryType;
        return { slots: [] };
      },
    });
    const gateway = createLiveCartContextGateway({
      readSession: read,
      writeSession: createFakeSession(WRITE_TOOLS, {}, false),
      now: () => NOW,
    });

    const context: CartContext = {
      cartId: "cart-1",
      deliveryType: "pickup",
      city: "Київ",
      branchId: "branch-7",
      slot: {
        id: "slot-1",
        startsAt: activeSlot.start,
        endsAt: activeSlot.end,
        available: true,
      },
    };

    await gateway.getTimeSlots(context);
    expect(requestedDeliveryType).toBe("SelfPickup");
  });
});

describe("updateCartContext", () => {
  const chosenSlot = {
    id: "slot-2",
    start: "2026-09-08T14:00:00Z",
    end: "2026-09-08T16:00:00Z",
    available: true,
  };

  function buildGateway(overrides: {
    slots?: (typeof chosenSlot)[];
    slotsAfterUpdate?: typeof chosenSlot;
    cartAfterUpdate?: Record<string, unknown>;
  } = {}) {
    const updated = overrides.slotsAfterUpdate ?? chosenSlot;
    let readbackCount = 0;
    const updateArgs: Record<string, unknown>[] = [];

    const read = createFakeSession(READ_TOOLS, {
      silpo_get_my_shopping_cart: () => ({ exists: true, cartId: "cart-1" }),
      silpo_get_shopping_cart_by_id: () => {
        readbackCount += 1;
        if (readbackCount === 1) return cartWithSlot;
        return (
          overrides.cartAfterUpdate ?? {
            ...cartWithSlot,
            timeslot: { id: updated.id, start: updated.start, end: updated.end },
          }
        );
      },
      silpo_get_time_slots: () => ({ slots: overrides.slots ?? [activeSlot, chosenSlot] }),
    });

    const write = createFakeSession(
      WRITE_TOOLS,
      {
        silpo_update_shopping_cart: (args) => {
          updateArgs.push(args);
          return { cartId: "cart-1" };
        },
      },
      false,
    );

    const gateway = createLiveCartContextGateway({
      readSession: read,
      writeSession: write,
      now: () => NOW,
    });
    return { gateway, read, write, updateArgs };
  }

  const input = {
    deliveryType: "delivery" as const,
    addressId: null,
    branchId: "branch-7",
    slotId: "slot-2",
  };

  it("returns the verified context after an immediate readback", async () => {
    const { gateway, read } = buildGateway();

    const context = await gateway.updateCartContext(input);

    expect(context.slot.id).toBe("slot-2");
    // Read, update, then read again to verify.
    expect(read.calls.filter((call) => call === "silpo_get_shopping_cart_by_id")).toHaveLength(2);
  });

  it("copies address and shipments verbatim from the readback", async () => {
    const { gateway, updateArgs } = buildGateway();

    await gateway.updateCartContext(input);

    expect(updateArgs[0].address).toEqual(cartWithSlot.address);
    expect(updateArgs[0].shipments).toEqual(cartWithSlot.shipments);
  });

  it("rejects a slot that is not currently available", async () => {
    const { gateway, write } = buildGateway();

    await expect(
      gateway.updateCartContext({ ...input, slotId: "slot-unknown" }),
    ).rejects.toBeInstanceOf(SlotUnavailableError);
    expect(write.calls).toEqual([]);
  });

  it("rejects a slot that is in the slot list but has available: false", async () => {
    const unavailableSlot = {
      id: "slot-unavailable",
      start: "2026-09-08T18:00:00Z",
      end: "2026-09-08T20:00:00Z",
      available: false,
    };
    const { gateway, write } = buildGateway({
      slots: [activeSlot, chosenSlot, unavailableSlot],
    });

    await expect(
      gateway.updateCartContext({ ...input, slotId: "slot-unavailable" }),
    ).rejects.toBeInstanceOf(SlotUnavailableError);
    expect(write.calls).toEqual([]);
  });

  it("fails when the readback slot differs from the requested slot", async () => {
    const { gateway } = buildGateway({
      cartAfterUpdate: {
        ...cartWithSlot,
        timeslot: { id: "slot-1", start: activeSlot.start, end: activeSlot.end },
      },
    });

    await expect(gateway.updateCartContext(input)).rejects.toBeInstanceOf(SlotVerificationError);
  });

  it("never retries the cart write", async () => {
    const { gateway, write } = buildGateway();

    await gateway.updateCartContext(input);

    expect(write.calls).toEqual(["silpo_update_shopping_cart"]);
    expect(write.retryEnabled).toBe(false);
  });
});
