// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerEnv } from "@/lib/env";
import { getServerEnv } from "@/lib/env";
import { loadDemoBacktest } from "@/features/diagnostics/backtest-service";
import { runRollingBacktest } from "@/features/prediction/backtest";
import type { SilpoGateway } from "@/features/shared/contracts";
import { err, ok } from "@/lib/result";

const demoGatewayModule = {
  loadCount: 0,
  create: vi.fn<() => SilpoGateway>(),
};

vi.mock("@/lib/env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/features/diagnostics/backtest-service", () => ({
  loadDemoBacktest: vi.fn(),
}));

const liveConfig: ServerEnv = {
  NODE_ENV: "test",
  DATA_MODE: "live",
  AGENT_MODEL: "gemini-3.7-flash",
  DATABASE_URL: "postgres://synthetic:synthetic@localhost/synthetic",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  GOOGLE_GENERATIVE_AI_API_KEY: "synthetic-test-key",
  PUBLIC_BASE_URL: "http://localhost:3000",
};

const demoConfig: ServerEnv = {
  ...liveConfig,
  DATA_MODE: "demo",
};

const mockGateway = {} as unknown as SilpoGateway;

describe("GET /api/backtest", () => {
  let GET: typeof import("./route").GET;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    demoGatewayModule.loadCount = 0;
    vi.doMock("@/features/silpo/demo/demo-gateway", () => {
      demoGatewayModule.loadCount += 1;
      return { createDemoSilpoGateway: demoGatewayModule.create };
    });
    vi.mocked(getServerEnv).mockReturnValue(liveConfig);
    ({ GET } = await import("./route"));
  });

  it("B6-10 denies live mode without loading the demo gateway module", async () => {
    expect(demoGatewayModule.loadCount).toBe(0);
    const response = await GET();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(demoGatewayModule.loadCount).toBe(0);
    expect(demoGatewayModule.create).not.toHaveBeenCalled();
    expect(loadDemoBacktest).not.toHaveBeenCalled();
  });

  it("returns 200 in demo mode with report and no-store headers", async () => {
    vi.mocked(getServerEnv).mockReturnValue(demoConfig);
    const mockReport = runRollingBacktest([], { activeCity: "Київ" });
    demoGatewayModule.create.mockReturnValue(mockGateway);
    vi.mocked(loadDemoBacktest).mockResolvedValue(ok(mockReport));

    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const json = await response.json();
    expect(json).toEqual({
      mode: "demo",
      report: mockReport,
    });
    expect(demoGatewayModule.create).toHaveBeenCalledTimes(1);
    expect(loadDemoBacktest).toHaveBeenCalledTimes(1);
    const [, correlationId] = vi.mocked(loadDemoBacktest).mock.calls[0];
    expect(typeof correlationId).toBe("string");
    expect(correlationId.length).toBeGreaterThan(0);
  });

  it("maps needs_slot error to 409", async () => {
    vi.mocked(getServerEnv).mockReturnValue(demoConfig);
    demoGatewayModule.create.mockReturnValue(mockGateway);
    vi.mocked(loadDemoBacktest).mockResolvedValue(
      err({
        code: "needs_slot",
        message: "Оберіть доступний слот для демонстраційного контексту.",
        correlationId: "corr-123",
        retryAfterMs: null,
      }),
    );

    const response = await GET();
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const json = await response.json();
    expect(json.error.code).toBe("needs_slot");
  });

  it("maps invalid_external_data to 500", async () => {
    vi.mocked(getServerEnv).mockReturnValue(demoConfig);
    demoGatewayModule.create.mockReturnValue(mockGateway);
    vi.mocked(loadDemoBacktest).mockResolvedValue(
      err({
        code: "invalid_external_data",
        message: "Не вдалося перевірити демонстраційні дані.",
        correlationId: "corr-123",
        retryAfterMs: null,
      }),
    );

    const response = await GET();
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const json = await response.json();
    expect(json.error.code).toBe("invalid_external_data");
  });

  it("maps unexpected service error to 500", async () => {
    vi.mocked(getServerEnv).mockReturnValue(demoConfig);
    demoGatewayModule.create.mockReturnValue(mockGateway);
    vi.mocked(loadDemoBacktest).mockResolvedValue(
      err({
        code: "unexpected",
        message: "Не вдалося побудувати звіт. Спробуйте ще раз.",
        correlationId: "corr-123",
        retryAfterMs: null,
      }),
    );

    const response = await GET();
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const json = await response.json();
    expect(json.error.code).toBe("unexpected");
  });

  it("handles configuration throw with safe 500 and masks secret sentinel", async () => {
    const sentinel = "CONFIG_SECRET_SENTINEL";
    vi.mocked(getServerEnv).mockImplementation(() => {
      throw new Error(`Config error with secret: ${sentinel}`);
    });

    const response = await GET();
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const bodyText = await response.text();
    expect(bodyText).not.toContain(sentinel);
    const json = JSON.parse(bodyText);
    expect(json.error.code).toBe("unexpected");
  });

  it("handles factory or service throw with safe 500 and masks secret sentinel", async () => {
    vi.mocked(getServerEnv).mockReturnValue(demoConfig);
    const sentinel = "SERVICE_SECRET_SENTINEL";
    demoGatewayModule.create.mockImplementation(() => {
      throw new Error(`Factory error with secret: ${sentinel}`);
    });

    const response = await GET();
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const bodyText = await response.text();
    expect(bodyText).not.toContain(sentinel);
    const json = JSON.parse(bodyText);
    expect(json.error.code).toBe("unexpected");
  });

  it("reads DATA_MODE dynamically per request rather than caching at import", async () => {
    // 1st request: live mode -> 404
    vi.mocked(getServerEnv).mockReturnValue(liveConfig);
    const res1 = await GET();
    expect(res1.status).toBe(404);

    // 2nd request: demo mode -> 200
    vi.mocked(getServerEnv).mockReturnValue(demoConfig);
    const mockReport = runRollingBacktest([], { activeCity: "Київ" });
    demoGatewayModule.create.mockReturnValue(mockGateway);
    vi.mocked(loadDemoBacktest).mockResolvedValue(ok(mockReport));

    const res2 = await GET();
    expect(res2.status).toBe(200);
  });
});
