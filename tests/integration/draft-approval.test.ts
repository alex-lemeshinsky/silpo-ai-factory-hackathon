import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import {
  createDemoHandle,
  demoUserIdFor,
  DEMO_SESSION_COOKIE,
  DEMO_SESSION_MAX_AGE_SECONDS,
} from "@/features/drafts/demo-user";
import {
  createInMemoryDraftRepository,
  type DraftRepository,
} from "@/features/drafts/repository";
import {
  approveDraftSelection,
  DraftApprovalInputSchema,
  DraftApprovalResponseSchema,
  type DraftApprovalInput,
} from "@/features/drafts/approval-service";
import {
  DraftSchema,
  ProductCandidateSchema,
  type Draft,
  type ProductCandidate,
} from "@/features/shared/contracts";
import type { ServerEnv } from "@/lib/env";
import { err, ok } from "@/lib/result";

import {
  createApproveDraftPostHandler,
  type ApprovalHandlerDeps,
} from "@/app/api/drafts/[draftId]/approve/handlers";

function makeEnv(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://user:pass@localhost:5432/testdb",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
    GOOGLE_GENERATIVE_AI_API_KEY: "test-api-key",
    AGENT_MODEL: "gemini-3.7-flash",
    DATA_MODE: "demo",
    PUBLIC_BASE_URL: "https://app.silpo-test.ua",
    ...overrides,
  };
}

const DEMO_HANDLE = createDemoHandle();
const APPROVAL_KEY = "00000000-0000-4000-8000-000000000015";

function makeDeps(
  repository: DraftRepository,
  overrides: Partial<ApprovalHandlerDeps> = {},
): ApprovalHandlerDeps {
  return {
    getEnv: () => makeEnv({ DATA_MODE: "demo" }),
    resolveSession: async () => ok({ userId: "live-user" }),
    resolveDemoIdentity: async (handle) => ({
      userId: handle ? demoUserIdFor(handle) : "00000000-0000-4000-8000-00000000de15",
      handle: handle ?? DEMO_HANDLE,
      issued: handle === null,
    }),
    repository: () => repository,
    approve: approveDraftSelection,
    newIdempotencyKey: () => APPROVAL_KEY,
    ...overrides,
  };
}

const context = (draftId: string) => ({ params: Promise.resolve({ draftId }) });

function post(draftId: string, body: unknown, cookies: Record<string, string> = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  const cookie = Object.entries(cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest(`https://app.silpo-test.ua/api/drafts/${draftId}/approve`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const candidate: ProductCandidate = ProductCandidateSchema.parse({
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
      alternatives: [candidate],
    },
  ],
  total: 2 * 55 + 65,
  version: 1,
});

const validSelection: DraftApprovalInput = {
  draftVersion: 1,
  items: [
    {
      sourceProductId: "product-1",
      itemVersion: 1,
      selectedProductId: "product-1",
      quantity: 2,
    },
    {
      sourceProductId: "product-2",
      itemVersion: 1,
      selectedProductId: "product-2-alt",
      quantity: 1,
    },
  ],
};

describe("POST /api/drafts/[draftId]/approve", () => {
  it("T15-14 persists an owned demo selection and returns one key", async () => {
    const repository = createInMemoryDraftRepository();
    const handle = createDemoHandle();
    const userId = demoUserIdFor(handle);
    await repository.save(userId, editableDraftFixture);
    const handler = createApproveDraftPostHandler(makeDeps(repository));

    const response = await handler(
      post(editableDraftFixture.id, validSelection, { demo_session: handle }),
      context(editableDraftFixture.id),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ idempotencyKey: APPROVAL_KEY });
    expect(DraftApprovalResponseSchema.safeParse(body).success).toBe(true);
    expect(DraftApprovalInputSchema.safeParse(validSelection).success).toBe(true);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    await expect(
      repository.getApproval(editableDraftFixture.id, userId),
    ).resolves.toMatchObject({ idempotencyKey: APPROVAL_KEY });
  });

  it("T15-13 returns the first key for a repeated POST", async () => {
    const repository = createInMemoryDraftRepository();
    const handle = createDemoHandle();
    const userId = demoUserIdFor(handle);
    await repository.save(userId, editableDraftFixture);
    const handler = createApproveDraftPostHandler(makeDeps(repository));
    const draftId = editableDraftFixture.id;
    const cookies = { demo_session: handle };

    const first = await handler(post(draftId, validSelection, cookies), context(draftId));
    const second = await handler(post(draftId, validSelection, cookies), context(draftId));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual({ idempotencyKey: APPROVAL_KEY });
    expect(await second.json()).toEqual({ idempotencyKey: APPROVAL_KEY });
  });

  describe("table-driven status codes and safe error contracts", () => {
    it.each([
      {
        name: "invalid UUID draftId",
        draftId: "not-a-uuid",
        body: validSelection,
        mode: "demo",
        setup: async () => {},
        expectedStatus: 400,
        expectedCode: "invalid_selection",
        expectedMessage: "Некоректний запит.",
      },
      {
        name: "unreadable JSON body",
        draftId: editableDraftFixture.id,
        body: "invalid-json-{",
        mode: "demo",
        setup: async () => {},
        expectedStatus: 400,
        expectedCode: "invalid_selection",
        expectedMessage: "Некоректний запит.",
      },
      {
        name: "extra product facts in selection body",
        draftId: editableDraftFixture.id,
        body: {
          ...validSelection,
          price: 100,
          items: [
            {
              ...validSelection.items[0],
              price: 10,
              stock: 50,
            },
            validSelection.items[1],
          ],
        },
        mode: "demo",
        setup: async () => {},
        expectedStatus: 400,
        expectedCode: "invalid_selection",
        expectedMessage: "Некоректний запит.",
      },
      {
        name: "missing live session in live mode",
        draftId: editableDraftFixture.id,
        body: validSelection,
        mode: "live",
        setup: async () => {},
        expectedStatus: 401,
        expectedCode: "unauthorized",
        expectedMessage: "Не вдалося підтвердити вхід. Увійдіть у «Сільпо» ще раз.",
      },
      {
        name: "non-owned or missing draft",
        draftId: "00000000-0000-4000-8000-999999999999",
        body: validSelection,
        mode: "demo",
        setup: async () => {},
        expectedStatus: 404,
        expectedCode: "not_found",
        expectedMessage: "Чернетку не знайдено. Створіть нову.",
      },
      {
        name: "stale draft version (conflict)",
        draftId: editableDraftFixture.id,
        body: { ...validSelection, draftVersion: 99 },
        mode: "demo",
        setup: async (repo: DraftRepository, userId: string) => {
          await repo.save(userId, editableDraftFixture);
        },
        expectedStatus: 409,
        expectedCode: "conflict",
        expectedMessage: "Чернетка змінилася. Оновіть сторінку й перевірте вибір ще раз.",
      },
      {
        name: "invalid quantity exceeding stock",
        draftId: editableDraftFixture.id,
        body: {
          draftVersion: 1,
          items: [
            {
              sourceProductId: "product-1",
              itemVersion: 1,
              selectedProductId: "product-1",
              quantity: 999,
            },
            validSelection.items[1],
          ],
        },
        mode: "demo",
        setup: async (repo: DraftRepository, userId: string) => {
          await repo.save(userId, editableDraftFixture);
        },
        expectedStatus: 422,
        expectedCode: "invalid_selection",
        expectedMessage: "Перевірте кількість або вибрану заміну.",
      },
      {
        name: "injected database or server failure",
        draftId: editableDraftFixture.id,
        body: validSelection,
        mode: "demo",
        setup: async (repo: DraftRepository, userId: string) => {
          await repo.save(userId, editableDraftFixture);
        },
        overrideApprove: async () => {
          throw new Error("connection to postgresql://secret:5432 failed");
        },
        expectedStatus: 500,
        expectedCode: "unexpected",
        expectedMessage: "Не вдалося підтвердити чернетку. Спробуйте ще раз.",
      },
    ])(
      "answers $name with status $expectedStatus and safe body",
      async ({
        draftId,
        body,
        mode,
        setup,
        overrideApprove,
        expectedStatus,
        expectedCode,
        expectedMessage,
      }) => {
        const repository = createInMemoryDraftRepository();
        const handle = createDemoHandle();
        const userId = demoUserIdFor(handle);
        await setup(repository, userId);

        const deps = makeDeps(repository, {
          getEnv: () => makeEnv({ DATA_MODE: mode as "demo" | "live" }),
          resolveSession: async () =>
            mode === "live"
              ? err({
                  code: "unauthorized",
                  message: "No session",
                  correlationId: "c-live",
                  retryAfterMs: null,
                })
              : ok({ userId: "live-user" }),
          ...(overrideApprove ? { approve: overrideApprove } : {}),
        });
        const handler = createApproveDraftPostHandler(deps);

        const cookies: Record<string, string> =
          mode === "demo" ? { demo_session: handle } : {};
        const response = await handler(post(draftId, body, cookies), context(draftId));
        const payload = await response.json();

        expect(response.status).toBe(expectedStatus);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");

        expect(payload).toEqual({
          error: {
            code: expectedCode,
            message: expectedMessage,
            correlationId: expect.any(String),
          },
        });

        // Safe error assertions: no leaked IDs, handles, DB error strings, or env values
        const serialized = JSON.stringify(payload);
        expect(serialized).not.toContain("product-1");
        expect(serialized).not.toContain("product-2");
        expect(serialized).not.toContain(handle);
        expect(serialized).not.toContain("postgresql://");
        expect(serialized).not.toContain("secret");
        expect(serialized).not.toContain("test-api-key");
      },
    );
  });

  describe("security and identity isolation", () => {
    it("rejects client attempts to pass mode or userId in request body", async () => {
      const repository = createInMemoryDraftRepository();
      const handle = createDemoHandle();
      const userId = demoUserIdFor(handle);
      await repository.save(userId, editableDraftFixture);
      const handler = createApproveDraftPostHandler(makeDeps(repository));

      const maliciousBody = {
        ...validSelection,
        mode: "live",
        userId: "attacker-user-id",
      };

      const response = await handler(
        post(editableDraftFixture.id, maliciousBody, { demo_session: handle }),
        context(editableDraftFixture.id),
      );

      expect(response.status).toBe(400);
      const payload = await response.json();
      expect(payload.error.code).toBe("invalid_selection");
      expect(payload.error.message).toBe("Некоректний запит.");
    });

    it("in live mode, calls resolveSession with silpo_session and ignores demo_session cookie", async () => {
      const repository = createInMemoryDraftRepository();
      const resolveSession = vi.fn(async (handle: string | null) => {
        void handle;
        return ok({ userId: "live-user" });
      });
      const approve = vi.fn(async () => ok({ idempotencyKey: APPROVAL_KEY }));

      const handler = createApproveDraftPostHandler(
        makeDeps(repository, {
          getEnv: () => makeEnv({ DATA_MODE: "live" }),
          resolveSession,
          approve,
        }),
      );

      const response = await handler(
        post(editableDraftFixture.id, validSelection, {
          silpo_session: "live-session-token",
          demo_session: "ignored-demo-handle",
        }),
        context(editableDraftFixture.id),
      );

      expect(response.status).toBe(200);
      expect(resolveSession).toHaveBeenCalledWith("live-session-token");
      expect(approve).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "live-user" }),
        expect.anything(),
      );
    });

    it("in demo mode, never calls resolveSession", async () => {
      const repository = createInMemoryDraftRepository();
      const handle = createDemoHandle();
      const userId = demoUserIdFor(handle);
      await repository.save(userId, editableDraftFixture);
      const resolveSession = vi.fn();

      const handler = createApproveDraftPostHandler(
        makeDeps(repository, {
          getEnv: () => makeEnv({ DATA_MODE: "demo" }),
          resolveSession,
        }),
      );

      const response = await handler(
        post(editableDraftFixture.id, validSelection, { demo_session: handle }),
        context(editableDraftFixture.id),
      );

      expect(response.status).toBe(200);
      expect(resolveSession).not.toHaveBeenCalled();
    });

    it("issues demo cookie with HttpOnly, SameSite=lax, Path=/, and MaxAge on first visit", async () => {
      const repository = createInMemoryDraftRepository();
      await repository.save(
        "00000000-0000-4000-8000-00000000de15",
        editableDraftFixture,
      );
      const handler = createApproveDraftPostHandler(
        makeDeps(repository, {
          getEnv: () => makeEnv({ DATA_MODE: "demo", NODE_ENV: "production" }),
        }),
      );

      // No cookie sent: first visit
      const response = await handler(
        post(editableDraftFixture.id, validSelection, {}),
        context(editableDraftFixture.id),
      );

      expect(response.status).toBe(200);
      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain(`${DEMO_SESSION_COOKIE}=${DEMO_HANDLE}`);
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=lax");
      expect(setCookie).toContain("Path=/");
      expect(setCookie).toContain("Secure");
      expect(setCookie).toContain(`Max-Age=${DEMO_SESSION_MAX_AGE_SECONDS}`);
    });

    it("keeps existing demo handle and does not set a new cookie", async () => {
      const repository = createInMemoryDraftRepository();
      const handle = createDemoHandle();
      const userId = demoUserIdFor(handle);
      await repository.save(userId, editableDraftFixture);
      const handler = createApproveDraftPostHandler(makeDeps(repository));

      const response = await handler(
        post(editableDraftFixture.id, validSelection, { demo_session: handle }),
        context(editableDraftFixture.id),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("attaches issued demo cookie even when approval fails", async () => {
      const repository = createInMemoryDraftRepository();
      // No draft saved in repository, so approve will return not_found
      const handler = createApproveDraftPostHandler(makeDeps(repository));

      const response = await handler(
        post(editableDraftFixture.id, validSelection, {}),
        context(editableDraftFixture.id),
      );

      expect(response.status).toBe(404);
      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain(`${DEMO_SESSION_COOKIE}=${DEMO_HANDLE}`);
    });

    it("attaches issued demo cookie even when repository throws 500", async () => {
      const repository = createInMemoryDraftRepository();
      const handler = createApproveDraftPostHandler(
        makeDeps(repository, {
          approve: async () => {
            throw new Error("Injected DB failure");
          },
        }),
      );

      const response = await handler(
        post(editableDraftFixture.id, validSelection, {}),
        context(editableDraftFixture.id),
      );

      expect(response.status).toBe(500);
      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain(`${DEMO_SESSION_COOKIE}=${DEMO_HANDLE}`);
    });

    it("performs no MCP, cart write, or gateway calls and leaves global fetch uncalled", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const repository = createInMemoryDraftRepository();
      const handle = createDemoHandle();
      const userId = demoUserIdFor(handle);
      await repository.save(userId, editableDraftFixture);

      const deps = makeDeps(repository);
      // Assert that ApprovalHandlerDeps type does not include openGateway or cart functions
      expect("openGateway" in deps).toBe(false);
      expect("cartGateway" in deps).toBe(false);

      const handler = createApproveDraftPostHandler(deps);
      await handler(
        post(editableDraftFixture.id, validSelection, { demo_session: handle }),
        context(editableDraftFixture.id),
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });
});
