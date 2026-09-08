import { expect, it, vi } from "vitest";

import { createGoogleDraftModel } from "@/features/agent/google-model";

const API_KEY = "test-key-not-a-real-credential";

function geminiResponse(payload: unknown): Response {
  return new Response(
    JSON.stringify({
      candidates: [{
        content: { role: "model", parts: [{ text: JSON.stringify(payload) }] },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function stubFetch(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response();
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const proposal = {
  summary: "Чернетка.",
  items: [{
    productId: "p-1",
    externalProductId: 40123,
    quantity: 1,
    reason: "Ви регулярно купуєте цю категорію.",
    alternativeIds: [],
  }],
};

it("sends the configured model, zero temperature and a closed schema", async () => {
  const { fetch, calls } = stubFetch(() => geminiResponse(proposal));
  const model = createGoogleDraftModel({ apiKey: API_KEY, model: "gemini-3.7-flash", fetch });

  await model.generateProposal({ system: "system", prompt: "prompt" });

  const body = String(calls[0].init.body);
  expect(calls[0].url).toContain("gemini-3.7-flash");
  expect(body).toContain('"temperature":0');
  expect(body).not.toContain("anyOf");
  expect(JSON.stringify(calls[0].init.headers)).toContain(API_KEY);
});

it("asks for a low thinking level", async () => {
  const { fetch, calls } = stubFetch(() => geminiResponse(proposal));
  const model = createGoogleDraftModel({ apiKey: API_KEY, model: "gemini-3.7-flash", fetch });

  await model.generateProposal({ system: "system", prompt: "prompt" });

  expect(String(calls[0].init.body).toLowerCase()).toContain("low");
});

it("returns the generated object for the agent to validate", async () => {
  const { fetch } = stubFetch(() => geminiResponse(proposal));
  const model = createGoogleDraftModel({ apiKey: API_KEY, model: "gemini-3.7-flash", fetch });

  await expect(model.generateProposal({ system: "s", prompt: "p" })).resolves.toMatchObject({
    items: [{ productId: "p-1" }],
  });
});

it("surfaces a malformed response as an error, never as an empty draft", async () => {
  const { fetch } = stubFetch(() => geminiResponse({ nope: true }));
  const model = createGoogleDraftModel({ apiKey: API_KEY, model: "gemini-3.7-flash", fetch });

  await expect(model.generateProposal({ system: "s", prompt: "p" })).rejects.toThrow();
});

it("keeps the API key out of thrown errors", async () => {
  const { fetch } = stubFetch(() => new Response("upstream exploded", { status: 500 }));
  const model = createGoogleDraftModel({ apiKey: API_KEY, model: "gemini-3.7-flash", fetch });

  await expect(model.generateProposal({ system: "s", prompt: "p" }))
    .rejects.toSatisfy((error: unknown) => !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(API_KEY));
});
