import {
  CartContextSchema,
  TimeSlotSchema,
  UpdateCartContextInputSchema,
  type CartContext,
  type CartContextResult,
  type TimeSlot,
  type UpdateCartContextInput,
} from "@/features/shared/contracts";

import {
  AcknowledgedWriteSchema,
  BranchesSchema,
  CreatedCartSchema,
  DeliveryAddressesSchema,
  DeliveryTypesSchema,
  FoundAddressSchema,
  MyShoppingCartSchema,
  ShoppingCartSchema,
  TimeSlotsSchema,
  type SilpoDeliveryAddress,
  type SilpoShoppingCart,
  type SilpoTimeSlot,
} from "../schemas/cart";
import type { McpSession } from "./session";

/** The guest has no saved delivery address, so no cart can be bootstrapped. */
export class NoSavedAddressError extends Error {
  constructor() {
    super("no_saved_address");
    this.name = "NoSavedAddressError";
  }
}

/** The requested slot is not currently offered or not available. */
export class SlotUnavailableError extends Error {
  constructor(readonly slotId: string) {
    super("needs_slot");
    this.name = "SlotUnavailableError";
  }
}

/** The cart readback did not confirm what was just requested. */
export class SlotVerificationError extends Error {
  constructor() {
    super("slot_verification_failed");
    this.name = "SlotVerificationError";
  }
}

/** No Silpo delivery type at this address matches the requested mode. */
export class DeliveryTypeUnavailableError extends Error {
  constructor(readonly requested: "delivery" | "pickup") {
    super("delivery_type_unavailable");
    this.name = "DeliveryTypeUnavailableError";
  }
}

/**
 * The caller asked for a different delivery address. The backlog requires the
 * cart's address to be copied verbatim from the readback, so this task cannot
 * honour the request — and must say so rather than accept and drop the field.
 */
export class AddressChangeUnsupportedError extends Error {
  constructor() {
    super("address_change_unsupported");
    this.name = "AddressChangeUnsupportedError";
  }
}

export interface LiveCartContextDeps {
  readSession: McpSession;
  writeSession: McpSession;
  now?: () => Date;
}

export interface LiveCartContextGateway {
  loadCartContext(): Promise<CartContextResult>;
  updateCartContext(input: UpdateCartContextInput): Promise<CartContext>;
  getTimeSlots(context: CartContext): Promise<TimeSlot[]>;
}

/**
 * Silpo advertises eight delivery types; the domain contract has two.
 * Only self-pickup is a pickup; every other documented type is a delivery.
 */
export function mapDeliveryType(silpoType: string): "delivery" | "pickup" {
  return silpoType === "SelfPickup" ? "pickup" : "delivery";
}

function toDomainSlot(slot: SilpoTimeSlot): TimeSlot {
  return TimeSlotSchema.parse({
    id: slot.id,
    startsAt: slot.start,
    endsAt: slot.end,
    available: slot.available,
  });
}

/** Builds the single-line address text `silpo_find_address` expects. */
function addressText(address: SilpoDeliveryAddress): string {
  return [address.city, address.street, address.house]
    .filter((part): part is string => Boolean(part))
    .join(", ");
}

export function createLiveCartContextGateway(deps: LiveCartContextDeps): LiveCartContextGateway {
  const { readSession, writeSession } = deps;
  const now = deps.now ?? (() => new Date());

  const listSlots = (branchId: string | null, deliveryType: string) =>
    readSession.callTool(
      "silpo_get_time_slots",
      { branchId, deliveryType },
      TimeSlotsSchema,
    );

  const readCart = (cartId: string) =>
    readSession.callTool("silpo_get_shopping_cart_by_id", { cartId }, ShoppingCartSchema);

  /**
   * Decides whether a cart readback is usable. A slot must exist, still be
   * offered, be marked available, and end in the future. Anything else stops
   * cart-dependent work and asks the caller to choose a slot.
   */
  function classify(cart: SilpoShoppingCart, slots: SilpoTimeSlot[]): CartContextResult {
    const availableSlots = slots
      .filter((slot) => slot.available && Date.parse(slot.end) > now().getTime())
      .map(toDomainSlot);
    const cartSlotId = cart.timeslot?.id ?? null;
    const matching = cartSlotId === null
      ? undefined
      : slots.find((slot) => slot.id === cartSlotId);

    const usable =
      matching !== undefined &&
      matching.available &&
      Date.parse(matching.end) > now().getTime();

    if (!usable) {
      return { status: "needs_slot", availableSlots };
    }

    return {
      status: "ready",
      context: CartContextSchema.parse({
        cartId: cart.id,
        deliveryType: mapDeliveryType(cart.deliveryType),
        city: cart.address?.city ?? null,
        branchId: cart.branchId,
        slot: toDomainSlot(matching),
      }),
    };
  }

  /**
   * Returns the Silpo delivery type to use for a requested domain mode.
   *
   * The domain contract has two values where Silpo documents eight, so a
   * request that already matches the cart keeps the cart's exact type; only a
   * genuine mode change consults the available types.
   */
  async function resolveDeliveryType(
    cart: SilpoShoppingCart,
    requested: "delivery" | "pickup",
  ): Promise<string> {
    if (mapDeliveryType(cart.deliveryType) === requested) {
      return cart.deliveryType;
    }

    const latitude = cart.address?.latitude ?? null;
    const longitude = cart.address?.longitude ?? null;
    if (latitude === null || longitude === null) {
      throw new DeliveryTypeUnavailableError(requested);
    }

    const types = await readSession.callTool(
      "silpo_get_available_delivery_types",
      { latitude, longitude },
      DeliveryTypesSchema,
    );
    const match = types.deliveryTypes.find(
      (candidate) => mapDeliveryType(candidate.deliveryType) === requested,
    );
    if (!match) {
      throw new DeliveryTypeUnavailableError(requested);
    }
    return match.deliveryType;
  }

  async function bootstrapCart(): Promise<string> {
    const saved = await readSession.callTool(
      "silpo_get_my_delivery_addresses",
      {},
      DeliveryAddressesSchema,
    );
    const chosen = saved.addresses.find((address) => address.isDefault) ?? saved.addresses[0];
    if (!chosen) {
      throw new NoSavedAddressError();
    }

    const found = await readSession.callTool(
      "silpo_find_address",
      { text: addressText(chosen) },
      FoundAddressSchema,
    );

    const types = await readSession.callTool(
      "silpo_get_available_delivery_types",
      { latitude: found.latitude, longitude: found.longitude },
      DeliveryTypesSchema,
    );
    const preferred = types.deliveryTypes[0];
    if (!preferred) {
      // The guest has an address; nothing is deliverable to it. Reusing the
      // address error here would report the wrong cause.
      throw new DeliveryTypeUnavailableError("delivery");
    }

    let branchId = preferred.branchId;
    if (branchId === null) {
      const branches = await readSession.callTool(
        "silpo_list_branches",
        preferred.deliveryType === "NovaPoshta"
          ? { hasNovaPoshta: true }
          : { hasPickup: true },
        BranchesSchema,
      );
      branchId = branches.branches[0]?.id ?? null;
    }

    const slots = await listSlots(branchId, preferred.deliveryType);
    const firstAvailable = slots.slots.find((slot) => slot.available);

    const created = await writeSession.callTool(
      "silpo_create_shopping_cart",
      {
        addressType: chosen.addressType ?? "house",
        latitude: found.latitude,
        longitude: found.longitude,
        city: found.city,
        street: found.street,
        house: found.houseNumber,
        district: found.district,
        deliveryType: preferred.deliveryType,
        branchId,
        timeslot: firstAvailable
          ? { start: firstAvailable.start, end: firstAvailable.end }
          : null,
      },
      CreatedCartSchema,
    );

    return created.cartId;
  }

  return {
    async loadCartContext(): Promise<CartContextResult> {
      const mine = await readSession.callTool(
        "silpo_get_my_shopping_cart",
        {},
        MyShoppingCartSchema,
      );

      const cartId = mine.exists && mine.cartId ? mine.cartId : await bootstrapCart();
      const cart = await readCart(cartId);
      const slots = await listSlots(cart.branchId, cart.deliveryType);

      return classify(cart, slots.slots);
    },

    async updateCartContext(input: UpdateCartContextInput): Promise<CartContext> {
      const parsed = UpdateCartContextInputSchema.parse(input);

      if (parsed.addressId !== null) {
        throw new AddressChangeUnsupportedError();
      }

      const mine = await readSession.callTool(
        "silpo_get_my_shopping_cart",
        {},
        MyShoppingCartSchema,
      );
      if (!mine.exists || !mine.cartId) {
        throw new SlotUnavailableError(parsed.slotId);
      }

      const cart = await readCart(mine.cartId);
      const deliveryType = await resolveDeliveryType(cart, parsed.deliveryType);
      const branchId = parsed.branchId ?? cart.branchId;

      // Slots are listed for the delivery type being applied, so a mode change
      // is matched against the right set rather than the cart's previous one.
      const slots = await listSlots(branchId, deliveryType);
      const target = slots.slots.find((slot) => slot.id === parsed.slotId);
      if (!target || !target.available) {
        throw new SlotUnavailableError(parsed.slotId);
      }

      // Address and shipments are copied exactly as the cart reported them.
      // Reshaping them here would silently change the delivery the guest
      // already chose.
      await writeSession.callTool(
        "silpo_update_shopping_cart",
        {
          cartId: cart.id,
          branchId,
          deliveryType,
          address: cart.address,
          shipments: cart.shipments,
          timeslot: { start: target.start, end: target.end },
        },
        AcknowledgedWriteSchema,
      );

      // Immediate readback: the write is not trusted until the server agrees.
      const verified = await readCart(cart.id);
      if (verified.timeslot?.id !== parsed.slotId) {
        throw new SlotVerificationError();
      }
      // A context that contradicts the request is never returned as success.
      if (mapDeliveryType(verified.deliveryType) !== parsed.deliveryType) {
        throw new SlotVerificationError();
      }

      return CartContextSchema.parse({
        cartId: verified.id,
        deliveryType: mapDeliveryType(verified.deliveryType),
        city: verified.address?.city ?? null,
        branchId: verified.branchId,
        slot: toDomainSlot(target),
      });
    },

    async getTimeSlots(context: CartContext): Promise<TimeSlot[]> {
      // `CartContext.deliveryType` collapses eight Silpo types into two, so it
      // cannot be reversed: "delivery" could be WideAssortDelivery, NovaPoshta
      // or any other. The cart readback carries the real one.
      const cart = await readCart(context.cartId);
      const slots = await listSlots(cart.branchId, cart.deliveryType);
      return slots.slots.map(toDomainSlot);
    },
  };
}
