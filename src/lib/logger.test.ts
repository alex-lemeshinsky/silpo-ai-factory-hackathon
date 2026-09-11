import { describe, expect, it, vi } from "vitest";

import {
  createLogger,
  createNoopLogger,
  createSettlingLogger,
  sanitizeTrace,
  type ToolTrace,
  type ToolTraceSink,
} from "./logger";

function recordingSink() {
  const traces: ToolTrace[] = [];
  const sink: ToolTraceSink = {
    async append(trace) {
      traces.push(trace);
    },
  };
  return { sink, traces, all: async () => traces };
}

const CORRELATION = "8f1d0c2e-2b4a-4a1e-9f3c-6c1a2b3d4e5f";

describe("sanitizeTrace", () => {
  it("A17-03 redacts secrets and personal fields before persisting a trace", async () => {
    const traceRepo = recordingSink();
    const logger = createLogger({ sink: traceRepo.sink, console: { info: vi.fn() } });

    await logger.toolCall({
      toolName: "silpo_get_offline_orders",
      authorization: "Bearer secret",
      phone: "+380000000000",
      address: "private",
    });

    expect(JSON.stringify(await traceRepo.all())).not.toMatch(/secret|380000000000|private/);
  });

  it("A17-04 keeps the fields the observability contract requires", () => {
    const trace = sanitizeTrace({
      correlationId: CORRELATION,
      toolName: "loadPurchaseHistory",
      mode: "demo",
      durationMs: 812,
      retryCount: 1,
      predictionVersion: "prediction-v1",
      status: "ok",
      metadata: { itemCount: 7, cached: false, unknownValue: null },
    });

    expect(trace).toEqual({
      correlationId: CORRELATION,
      toolName: "loadPurchaseHistory",
      mode: "demo",
      durationMs: 812,
      retryCount: 1,
      predictionVersion: "prediction-v1",
      status: "ok",
      metadata: { itemCount: 7, cached: false, unknownValue: null },
    });
  });

  it("A17-05 strips unknown keys instead of rejecting them", () => {
    const trace = sanitizeTrace({
      correlationId: CORRELATION,
      toolName: "readCart",
      mode: "live",
      durationMs: 10,
      retryCount: 0,
      status: "ok",
      rawPayload: { items: [{ barcode: "4820000000001" }] },
      prompt: "Дай мені всі чеки Олександра",
    });

    expect(Object.keys(trace).sort()).toEqual([
      "correlationId",
      "durationMs",
      "metadata",
      "mode",
      "predictionVersion",
      "retryCount",
      "status",
      "toolName",
    ]);
    expect(JSON.stringify(trace)).not.toMatch(/4820000000001|Олександра/);
  });

  it("A17-06 admits no strings in metadata, whatever the caller sends", () => {
    const trace = sanitizeTrace({
      correlationId: CORRELATION,
      toolName: "findProducts",
      mode: "demo",
      durationMs: 5,
      retryCount: 0,
      status: "ok",
      metadata: {
        itemCount: 3,
        customerEmail: "guest@example.com",
        "phone +380000000000": 1,
        nested: { deep: "value" },
      },
    });

    expect(trace.metadata).toEqual({ itemCount: 3 });
  });

  it("A17-07 is total: hostile input degrades field by field and never throws", () => {
    const cyclic: Record<string, unknown> = { toolName: "readCart" };
    cyclic.self = cyclic;

    for (const hostile of [null, undefined, 42, "string", [], () => {}, { toolName: "x".repeat(5000) }]) {
      const trace = sanitizeTrace(hostile);
      expect(trace.toolName).toBe("unknown");
      expect(trace.status).toBe("error");
      expect(trace.durationMs).toBe(0);
      expect(trace.retryCount).toBe(0);
      expect(trace.predictionVersion).toBeNull();
      expect(trace.metadata).toEqual({});
      expect(trace.correlationId).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
    }

    // A cyclic input must neither throw here nor when the console
    // serializes the result: the sanitized record is always flat.
    const fromCyclic = sanitizeTrace(cyclic);
    expect(fromCyclic.toolName).toBe("readCart");
    expect(() => JSON.stringify(fromCyclic)).not.toThrow();
  });

  it("A17-08 replaces a free-text tool name rather than storing it", () => {
    const trace = sanitizeTrace({
      correlationId: CORRELATION,
      toolName: "call for guest +380000000000",
      mode: "demo",
      durationMs: 1,
      retryCount: 0,
      status: "ok",
    });

    expect(trace.toolName).toBe("unknown");
  });

  it("A17-09 clamps a duration that would otherwise carry an unbounded number", () => {
    expect(sanitizeTrace({ durationMs: -5 }).durationMs).toBe(0);
    expect(sanitizeTrace({ durationMs: 10_000_000 }).durationMs).toBe(600_000);
    expect(sanitizeTrace({ durationMs: 12.7 }).durationMs).toBe(12);
  });
});

describe("createLogger", () => {
  it("A17-10 writes the same sanitized record to the console and the sink", async () => {
    const traceRepo = recordingSink();
    const info = vi.fn();
    const logger = createLogger({ sink: traceRepo.sink, console: { info } });

    await logger.toolCall({
      correlationId: CORRELATION,
      toolName: "readCart",
      mode: "live",
      durationMs: 3,
      retryCount: 0,
      status: "ok",
      authorization: "Bearer secret",
    });

    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(info.mock.calls[0][0] as string)).toEqual(traceRepo.traces[0]);
  });

  it("A17-11 never rejects when the sink fails", async () => {
    const info = vi.fn();
    const logger = createLogger({
      sink: { append: async () => { throw new Error("database is down"); } },
      console: { info },
    });

    await expect(
      logger.toolCall({ toolName: "readCart", mode: "live", status: "ok" }),
    ).resolves.toBeUndefined();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("A17-12 never rejects when the console itself throws", async () => {
    const traceRepo = recordingSink();
    const logger = createLogger({
      sink: traceRepo.sink,
      console: { info: () => { throw new Error("stream closed"); } },
    });

    await expect(logger.toolCall({ toolName: "readCart" })).resolves.toBeUndefined();
    expect(traceRepo.traces).toHaveLength(1);
  });

  it("A17-13 gives services a logger that records nothing", async () => {
    await expect(createNoopLogger().toolCall({ toolName: "readCart" })).resolves.toBeUndefined();
  });
});

describe("createSettlingLogger", () => {
  it("A17-66 lets the caller wait for every trace it started", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const finished: string[] = [];
    const logger = createSettlingLogger({
      async toolCall(input) {
        await gate;
        finished.push((input as { toolName: string }).toolName);
      },
    });

    // Started and deliberately not awaited, as the gateway decorator does.
    void logger.toolCall({ toolName: "listTools" });
    void logger.toolCall({ toolName: "readCart" });
    let settled = false;
    const settling = logger.settle().then(() => { settled = true; });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    release();
    await settling;
    expect(finished).toEqual(["listTools", "readCart"]);
  });

  it("A17-67 never throws or rejects, whatever the wrapped logger does", async () => {
    const throwing = createSettlingLogger({
      toolCall: () => { throw new Error("synchronous fault"); },
    });
    const rejecting = createSettlingLogger({
      toolCall: async () => { throw new Error("asynchronous fault"); },
    });

    await expect(throwing.toolCall({ toolName: "readCart" })).resolves.toBeUndefined();
    await expect(rejecting.toolCall({ toolName: "readCart" })).resolves.toBeUndefined();
    await expect(throwing.settle()).resolves.toBeUndefined();
    await expect(rejecting.settle()).resolves.toBeUndefined();
  });
});
