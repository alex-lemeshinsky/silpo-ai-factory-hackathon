// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEMO_SESSION_COOKIE, createDemoHandle, demoUserIdFor } from "@/features/drafts/demo-user";
import type { DiagnosticsReport } from "@/features/diagnostics/service";
import type { ServerEnv } from "@/lib/env";

vi.mock("@/lib/env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/features/diagnostics/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/diagnostics/service")>()),
  buildDiagnostics: vi.fn(),
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
const demoConfig: ServerEnv = { ...liveConfig, DATA_MODE: "demo" };

const report: DiagnosticsReport = {
  generatedAt: "2026-09-10T08:00:00.000Z",
  backtest: null,
  decisions: {
    decidedItemCount: 0,
    acceptanceRate: null,
    replacementRate: null,
    acceptedReplacementSavings: null,
    landedReplacementCount: 0,
  },
  traces: [{ toolName: "loadPurchaseHistory", durationMs: 812, status: "ok", at: "2026-09-10T07:59:00.000Z" }],
};

const DEMO_HANDLE = createDemoHandle();

function request(cookie?: string): NextRequest {
  const req = new NextRequest("http://localhost:3000/api/demo/diagnostics");
  if (cookie !== undefined) req.cookies.set(DEMO_SESSION_COOKIE, cookie);
  return req;
}

describe("GET /api/demo/diagnostics", () => {
  let GET: typeof import("@/app/api/demo/diagnostics/route").GET;
  let getServerEnv: ReturnType<typeof vi.fn>;
  let buildDiagnostics: ReturnType<typeof vi.fn>;
  const dbCalls = { count: 0 };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    dbCalls.count = 0;
    vi.doMock("@/db/client", () => ({
      getDbClient: () => {
        dbCalls.count += 1;
        return {} as never;
      },
    }));
    ({ getServerEnv } = (await import("@/lib/env")) as never);
    ({ buildDiagnostics } = (await import("@/features/diagnostics/service")) as never);
    buildDiagnostics.mockResolvedValue(report);
    ({ GET } = await import("@/app/api/demo/diagnostics/route"));
  });

  it("A17-46 does not exist in live mode", async () => {
    getServerEnv.mockReturnValue(liveConfig);

    const response = await GET(request());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(buildDiagnostics).not.toHaveBeenCalled();
    // The gate returns before the client is built, so live mode never opens
    // a connection to serve a route that does not exist there.
    expect(dbCalls.count).toBe(0);
  });

  it("A17-47 returns the report in demo mode and forbids caching", async () => {
    getServerEnv.mockReturnValue(demoConfig);

    const response = await GET(request(DEMO_HANDLE));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(await response.json()).toEqual({ mode: "demo", report });
  });

  it("A17-48 scopes decisions to the visitor's own demo identity", async () => {
    getServerEnv.mockReturnValue(demoConfig);

    await GET(request(DEMO_HANDLE));

    expect(buildDiagnostics.mock.calls[0][0]).toBe(demoUserIdFor(DEMO_HANDLE));
  });

  it("A17-49 mints no identity for a visitor without a valid handle", async () => {
    getServerEnv.mockReturnValue(demoConfig);

    const withoutCookie = await GET(request());
    const withGarbage = await GET(request("not-a-handle"));

    expect(withoutCookie.status).toBe(200);
    expect(withGarbage.status).toBe(200);
    expect(buildDiagnostics.mock.calls.map((call) => call[0])).toEqual([null, null]);
  });

  it("A17-50 returns a typed error without echoing the cause", async () => {
    getServerEnv.mockReturnValue(demoConfig);
    buildDiagnostics.mockRejectedValue(new Error("postgres://user:pw@host down"));

    const response = await GET(request(DEMO_HANDLE));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("unexpected");
    expect(JSON.stringify(body)).not.toMatch(/postgres|pw@host/);
  });
});
