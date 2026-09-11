import { describe, expect, it } from "vitest";

import { sanitizeTrace } from "@/lib/logger";

import { createInMemoryToolTraceRepository } from "./trace-repository";

const trace = (overrides: Record<string, unknown> = {}) =>
  sanitizeTrace({
    correlationId: "corr-1",
    toolName: "loadPurchaseHistory",
    mode: "demo",
    durationMs: 100,
    retryCount: 0,
    status: "ok",
    ...overrides,
  });

describe("createInMemoryToolTraceRepository", () => {
  it("A17-14 returns the newest rows first, bounded by the limit", async () => {
    let tick = 0;
    const repo = createInMemoryToolTraceRepository(() => new Date(1_700_000_000_000 + tick++ * 1000));

    await repo.append(trace({ toolName: "listTools" }));
    await repo.append(trace({ toolName: "loadCartContext" }));
    await repo.append(trace({ toolName: "loadPurchaseHistory" }));

    const rows = await repo.recent("demo", 2);
    expect(rows.map((row) => row.toolName)).toEqual(["loadPurchaseHistory", "loadCartContext"]);
  });

  it("A17-15 never returns rows from the other mode", async () => {
    const repo = createInMemoryToolTraceRepository();

    await repo.append(trace({ mode: "live", toolName: "readCart" }));
    await repo.append(trace({ mode: "demo", toolName: "listTools" }));

    expect((await repo.recent("demo", 20)).map((row) => row.toolName)).toEqual(["listTools"]);
  });

  it("A17-16 projects only tool, duration, status and time into a read row", async () => {
    const repo = createInMemoryToolTraceRepository(() => new Date("2026-09-10T08:00:00.000Z"));

    await repo.append(trace({ metadata: { itemCount: 4 }, predictionVersion: "prediction-v1" }));

    expect(await repo.recent("demo", 20)).toEqual([
      {
        toolName: "loadPurchaseHistory",
        durationMs: 100,
        status: "ok",
        at: "2026-09-10T08:00:00.000Z",
      },
    ]);
  });

  it("A17-17 keeps the full record available for redaction evidence", async () => {
    const repo = createInMemoryToolTraceRepository();

    await repo.append(trace({ authorization: "Bearer secret", phone: "+380000000000" } as never));

    expect(JSON.stringify(await repo.all())).not.toMatch(/secret|380000000000/);
  });

  it("defensively re-sanitizes raw objects appended directly without helper and orders newest-first", async () => {
    const repo = createInMemoryToolTraceRepository();

    await repo.append({
      toolName: "readCart",
      authorization: "Bearer secret-cart",
      phone: "+380501234567",
    } as never);

    await repo.append({
      toolName: "commitApprovedDraft",
      secretHeader: "Authorization: Bearer secret-commit",
    } as never);

    const records = await repo.all();
    expect(records).toHaveLength(2);
    expect(records[0]?.toolName).toBe("commitApprovedDraft");
    expect(records[1]?.toolName).toBe("readCart");
    expect(JSON.stringify(records)).not.toMatch(/secret|380501234567/);
  });
});
