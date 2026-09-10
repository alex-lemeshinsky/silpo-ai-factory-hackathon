import { describe, expect, it } from "vitest";
import {
  DraftSchema,
  ProductCandidateSchema,
  type Draft,
  type ProductCandidate,
} from "@/features/shared/contracts";
import {
  approveDraftSelection,
  DraftApprovalInputSchema,
  DraftApprovalResponseSchema,
  type ApproveDraftInput,
  type DraftApprovalInput,
} from "./approval-service";
import {
  createInMemoryDraftRepository,
  type DraftRepository,
} from "./repository";

const replacement: ProductCandidate = ProductCandidateSchema.parse({
  productId: "product-2-alt",
  externalProductId: 202,
  slug: "product-2-alt",
  name: "Кефір",
  imageUrl: null,
  price: 60,
  specialPrice: 50,
  available: true,
  stock: 8,
  step: 1,
  displayRatio: 0.9,
  nutritionStatus: "insufficient",
  nutrition: null,
  promotions: [{ id: "promo-kefir", label: "Акція", price: 50 }],
});

const unavailableReplacement: ProductCandidate = ProductCandidateSchema.parse({
  productId: "product-2-unavail",
  externalProductId: 203,
  slug: "product-2-unavail",
  name: "Кефір Недоступний",
  imageUrl: null,
  price: 60,
  specialPrice: null,
  available: false,
  stock: 0,
  step: 1,
  displayRatio: 1,
  nutritionStatus: "insufficient",
  nutrition: null,
  promotions: [],
});

const sharedAlt: ProductCandidate = ProductCandidateSchema.parse({
  productId: "shared-alt",
  externalProductId: 204,
  slug: "shared-alt",
  name: "Йогурт",
  imageUrl: null,
  price: 40,
  specialPrice: null,
  available: true,
  stock: 10,
  step: 1,
  displayRatio: 1,
  nutritionStatus: "insufficient",
  nutrition: null,
  promotions: [],
});

const editableDraftFixture: Draft = DraftSchema.parse({
  id: "00000000-0000-4000-8000-000000000001",
  mode: "demo",
  status: "ready",
  algorithmVersion: "prediction-v1",
  trainingCutoff: "2026-09-01T10:00:00.000Z",
  summary: "Регулярне поповнення",
  items: [
    {
      productId: "product-1",
      externalProductId: 101,
      name: "Молоко",
      imageUrl: null,
      displayRatio: 1,
      quantity: 2,
      price: 55,
      specialPrice: null,
      stock: 10,
      step: 1,
      confidence: 0.8,
      confidenceBand: "high",
      reasonCodes: ["weekly_cycle"],
      reason: "Купуєте приблизно щотижня",
      nutritionStatus: "insufficient",
      promotions: [],
      alternatives: [],
    },
    {
      productId: "product-2",
      externalProductId: 102,
      name: "Сметана",
      imageUrl: null,
      displayRatio: 1,
      quantity: 1,
      price: 65,
      specialPrice: null,
      stock: 10,
      step: 1,
      confidence: 0.8,
      confidenceBand: "high",
      reasonCodes: ["weekly_cycle"],
      reason: "Купуєте приблизно щотижня",
      nutritionStatus: "insufficient",
      promotions: [],
      alternatives: [replacement, unavailableReplacement, sharedAlt],
    },
    {
      productId: "product-3",
      externalProductId: 103,
      name: "Хліб",
      imageUrl: null,
      displayRatio: 1,
      quantity: 1,
      price: 30,
      specialPrice: null,
      stock: 5,
      step: 1,
      confidence: 0.8,
      confidenceBand: "high",
      reasonCodes: ["weekly_cycle"],
      reason: "Купуєте приблизно щотижня",
      nutritionStatus: "insufficient",
      promotions: [],
      alternatives: [sharedAlt],
    },
  ],
  total: 2 * 55 + 65 + 30,
  version: 1,
});

describe("DraftApproval schemas", () => {
  it("T15-06 accepts intent only and rejects browser-supplied product facts", () => {
    const valid = {
      draftVersion: 1,
      items: [
        {
          sourceProductId: "product-1",
          itemVersion: 1,
          selectedProductId: "product-1",
          quantity: 2,
        },
      ],
    };
    expect(DraftApprovalInputSchema.parse(valid)).toEqual(valid);
    expect(() =>
      DraftApprovalInputSchema.parse({
        ...valid,
        total: 1,
        items: [{ ...valid.items[0], price: 0.01, stock: 999 }],
      }),
    ).toThrow();
  });

  it("T15-06 requires null selection and quantity together for removal", () => {
    expect(() =>
      DraftApprovalInputSchema.parse({
        draftVersion: 1,
        items: [
          {
            sourceProductId: "product-1",
            itemVersion: 1,
            selectedProductId: null,
            quantity: 1,
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      DraftApprovalInputSchema.parse({
        draftVersion: 1,
        items: [
          {
            sourceProductId: "product-1",
            itemVersion: 1,
            selectedProductId: "product-1",
            quantity: null,
          },
        ],
      }),
    ).toThrow();

    const validRemoval = {
      draftVersion: 1,
      items: [
        {
          sourceProductId: "product-1",
          itemVersion: 1,
          selectedProductId: null,
          quantity: null,
        },
      ],
    };
    expect(DraftApprovalInputSchema.parse(validRemoval)).toEqual(validRemoval);
  });

  it("rejects duplicate source IDs in items", () => {
    expect(() =>
      DraftApprovalInputSchema.parse({
        draftVersion: 1,
        items: [
          { sourceProductId: "product-1", itemVersion: 1, selectedProductId: "product-1", quantity: 1 },
          { sourceProductId: "product-1", itemVersion: 1, selectedProductId: "product-1", quantity: 2 },
        ],
      }),
    ).toThrow();
  });

  it("validates DraftApprovalResponseSchema uuid requirement", () => {
    expect(
      DraftApprovalResponseSchema.parse({
        idempotencyKey: "00000000-0000-4000-8000-000000000015",
      }),
    ).toEqual({
      idempotencyKey: "00000000-0000-4000-8000-000000000015",
    });

    expect(() =>
      DraftApprovalResponseSchema.parse({
        idempotencyKey: "not-a-uuid",
      }),
    ).toThrow();

    expect(() =>
      DraftApprovalResponseSchema.parse({
        idempotencyKey: "00000000-0000-4000-8000-000000000015",
        extra: true,
      }),
    ).toThrow();
  });
});

describe("approveDraftSelection service", () => {
  it("T15-11 reconstructs snapshots, decisions, total, and version on the server", async () => {
    const repository = createInMemoryDraftRepository();
    await repository.save("user-1", editableDraftFixture);

    const result = await approveDraftSelection(
      {
        draftId: editableDraftFixture.id,
        userId: "user-1",
        correlationId: "corr-15",
        selection: {
          draftVersion: 1,
          items: [
            { sourceProductId: "product-1", itemVersion: 1, selectedProductId: "product-1", quantity: 3 },
            { sourceProductId: "product-2", itemVersion: 1, selectedProductId: "product-2-alt", quantity: 1 },
            { sourceProductId: "product-3", itemVersion: 1, selectedProductId: null, quantity: null },
          ],
        },
      },
      {
        repository,
        newIdempotencyKey: () => "00000000-0000-4000-8000-000000000015",
        now: () => new Date("2026-09-09T10:00:00.000Z"),
      },
    );

    expect(result).toEqual({
      ok: true,
      value: { idempotencyKey: "00000000-0000-4000-8000-000000000015" },
    });
    const approved = await repository.get(editableDraftFixture.id, "user-1");
    expect(approved).toMatchObject({ status: "confirming", version: 2, total: 215 });
    expect(approved?.items.map((item) => item.productId)).toEqual([
      "product-1",
      "product-2-alt",
    ]);
    expect(approved?.items[1]).toMatchObject({
      name: "Кефір",
      price: 60,
      specialPrice: 50,
      confidence: editableDraftFixture.items[1].confidence,
      reason: editableDraftFixture.items[1].reason,
    });
  });

  const cases = [
    ["different owner", "not_found"],
    ["draft not ready", "conflict"],
    ["stale draft version", "conflict"],
    ["stale item version", "conflict"],
    ["missing source item", "invalid_selection"],
    ["extra source item", "invalid_selection"],
    ["all items removed", "invalid_selection"],
    ["duplicate selected product", "invalid_selection"],
    ["replacement outside source allowlist", "invalid_selection"],
    ["quantity zero", "invalid_selection"],
    ["quantity above stock", "invalid_selection"],
    ["quantity misaligned with step", "invalid_selection"],
  ] as const;

  for (const [description, expectedCode] of cases) {
    it(`T15-10 handles safe failure: ${description} -> ${expectedCode}`, async () => {
      const repository = createInMemoryDraftRepository();
      await repository.save("user-1", editableDraftFixture);

      let draftId = editableDraftFixture.id;
      let userId = "user-1";
      const selection: DraftApprovalInput = {
        draftVersion: 1,
        items: [
          { sourceProductId: "product-1", itemVersion: 1, selectedProductId: "product-1", quantity: 2 },
          { sourceProductId: "product-2", itemVersion: 1, selectedProductId: "product-2", quantity: 1 },
          { sourceProductId: "product-3", itemVersion: 1, selectedProductId: "product-3", quantity: 1 },
        ],
      };

      if (description === "different owner") {
        userId = "user-2";
      } else if (description === "draft not ready") {
        const notReadyDraft = DraftSchema.parse({
          ...editableDraftFixture,
          id: "00000000-0000-4000-8000-000000000099",
          status: "syncing",
        });
        await repository.save("user-1", notReadyDraft);
        draftId = notReadyDraft.id;
      } else if (description === "stale draft version") {
        selection.draftVersion = 2;
      } else if (description === "stale item version") {
        selection.items[0] = { ...selection.items[0], itemVersion: 2 };
      } else if (description === "missing source item") {
        selection.items = selection.items.slice(0, 2);
      } else if (description === "extra source item") {
        selection.items.push({
          sourceProductId: "product-extra",
          itemVersion: 1,
          selectedProductId: "product-extra",
          quantity: 1,
        });
      } else if (description === "all items removed") {
        selection.items = selection.items.map((item) => ({
          ...item,
          selectedProductId: null,
          quantity: null,
        }));
      } else if (description === "duplicate selected product") {
        selection.items[1] = {
          ...selection.items[1],
          selectedProductId: "shared-alt",
          quantity: 1,
        };
        selection.items[2] = {
          ...selection.items[2],
          selectedProductId: "shared-alt",
          quantity: 1,
        };
      } else if (description === "replacement outside source allowlist") {
        selection.items[0] = {
          ...selection.items[0],
          selectedProductId: "product-unauthorized",
        };
      } else if (description === "quantity zero") {
        selection.items[0] = {
          ...selection.items[0],
          quantity: 0,
        };
      } else if (description === "quantity above stock") {
        selection.items[0] = {
          ...selection.items[0],
          quantity: 15,
        };
      } else if (description === "quantity misaligned with step") {
        selection.items[0] = {
          ...selection.items[0],
          quantity: 1.5,
        };
      }

      const result = await approveDraftSelection(
        {
          draftId,
          userId,
          correlationId: "corr-15",
          selection,
        },
        { repository },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(expectedCode);
        expect(result.error.correlationId).toBe("corr-15");
        expect(result.error.message).not.toContain(editableDraftFixture.id);
        expect(result.error.message).not.toContain("product-1");
        expect(result.error.message).not.toContain("user-1");
        expect(result.error.message).not.toContain("Error");
        expect(result.error.message).not.toContain("Exception");
      }
    });
  }

  it("rejects unavailable replacement or replacement with stock less than step", async () => {
    const repository = createInMemoryDraftRepository();
    await repository.save("user-1", editableDraftFixture);

    const result = await approveDraftSelection(
      {
        draftId: editableDraftFixture.id,
        userId: "user-1",
        correlationId: "corr-15",
        selection: {
          draftVersion: 1,
          items: [
            { sourceProductId: "product-1", itemVersion: 1, selectedProductId: "product-1", quantity: 2 },
            { sourceProductId: "product-2", itemVersion: 1, selectedProductId: "product-2-unavail", quantity: 1 },
            { sourceProductId: "product-3", itemVersion: 1, selectedProductId: "product-3", quantity: 1 },
          ],
        },
      },
      { repository },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid_selection",
        message: "Перевірте кількість або вибрану заміну.",
        correlationId: "corr-15",
      },
    });
  });

  describe("fake repository mapping", () => {
    const baseInput: ApproveDraftInput = {
      draftId: editableDraftFixture.id,
      userId: "user-1",
      correlationId: "corr-15",
      selection: {
        draftVersion: 1,
        items: [
          { sourceProductId: "product-1", itemVersion: 1, selectedProductId: "product-1", quantity: 2 },
          { sourceProductId: "product-2", itemVersion: 1, selectedProductId: "product-2", quantity: 1 },
          { sourceProductId: "product-3", itemVersion: 1, selectedProductId: "product-3", quantity: 1 },
        ],
      },
    };

    it("maps repository not_found to failure code not_found", async () => {
      const fakeRepo: DraftRepository = {
        save: async () => editableDraftFixture,
        get: async () => editableDraftFixture,
        getApproval: async () => null,
        approveSelection: async () => ({ status: "not_found" }),
        recordCommitOutcome: async () => "updated",
      };

      const result = await approveDraftSelection(baseInput, { repository: fakeRepo });
      expect(result).toEqual({
        ok: false,
        error: {
          code: "not_found",
          message: "Чернетку не знайдено. Створіть нову.",
          correlationId: "corr-15",
        },
      });
    });

    it("maps repository conflict to failure code conflict", async () => {
      const fakeRepo: DraftRepository = {
        save: async () => editableDraftFixture,
        get: async () => editableDraftFixture,
        getApproval: async () => null,
        approveSelection: async () => ({ status: "conflict" }),
        recordCommitOutcome: async () => "updated",
      };

      const result = await approveDraftSelection(baseInput, { repository: fakeRepo });
      expect(result).toEqual({
        ok: false,
        error: {
          code: "conflict",
          message: "Чернетка змінилася. Оновіть сторінку й перевірте вибір ще раз.",
          correlationId: "corr-15",
        },
      });
    });

    it("maps thrown database error to unexpected failure code", async () => {
      const fakeRepo: DraftRepository = {
        save: async () => editableDraftFixture,
        get: async () => editableDraftFixture,
        getApproval: async () => null,
        approveSelection: async () => {
          throw new Error("DB connection failure: raw connection reset");
        },
        recordCommitOutcome: async () => "updated",
      };

      const result = await approveDraftSelection(baseInput, { repository: fakeRepo });
      expect(result).toEqual({
        ok: false,
        error: {
          code: "unexpected",
          message: "Не вдалося підтвердити чернетку. Спробуйте ще раз.",
          correlationId: "corr-15",
        },
      });
      if (!result.ok) {
        expect(result.error.message).not.toContain("DB connection");
        expect(result.error.message).not.toContain("raw connection reset");
      }
    });

    it("handles concurrent already_approved return from repository", async () => {
      const fakeRepo: DraftRepository = {
        save: async () => editableDraftFixture,
        get: async () => editableDraftFixture,
        getApproval: async () => null,
        approveSelection: async () => ({
          status: "already_approved",
          idempotencyKey: "00000000-0000-4000-8000-000000000099",
        }),
        recordCommitOutcome: async () => "updated",
      };

      const result = await approveDraftSelection(baseInput, { repository: fakeRepo });
      expect(result).toEqual({
        ok: true,
        value: { idempotencyKey: "00000000-0000-4000-8000-000000000099" },
      });
    });
  });

  describe("idempotency and defaults", () => {
    const FIRST_KEY = "00000000-0000-4000-8000-000000000001";
    const SECOND_KEY = "00000000-0000-4000-8000-000000000002";

    const firstRequest: ApproveDraftInput = {
      draftId: editableDraftFixture.id,
      userId: "user-1",
      correlationId: "corr-15",
      selection: {
        draftVersion: 1,
        items: [
          { sourceProductId: "product-1", itemVersion: 1, selectedProductId: "product-1", quantity: 2 },
          { sourceProductId: "product-2", itemVersion: 1, selectedProductId: "product-2", quantity: 1 },
          { sourceProductId: "product-3", itemVersion: 1, selectedProductId: "product-3", quantity: 1 },
        ],
      },
    };

    it("T15-13 returns a persisted approval before validating a stale replay", async () => {
      const repository = createInMemoryDraftRepository();
      await repository.save("user-1", editableDraftFixture);
      const first = await approveDraftSelection(firstRequest, {
        repository,
        newIdempotencyKey: () => FIRST_KEY,
      });
      expect(first).toEqual({ ok: true, value: { idempotencyKey: FIRST_KEY } });

      const replay = await approveDraftSelection(
        {
          ...firstRequest,
          selection: { draftVersion: 1, items: [] },
        },
        { repository, newIdempotencyKey: () => SECOND_KEY },
      );

      expect(replay).toEqual({ ok: true, value: { idempotencyKey: FIRST_KEY } });
    });

    it("uses default newIdempotencyKey and now when not provided", async () => {
      const repository = createInMemoryDraftRepository();
      await repository.save("user-1", editableDraftFixture);

      const result = await approveDraftSelection(firstRequest, { repository });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.idempotencyKey).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
      }
    });
  });
});
