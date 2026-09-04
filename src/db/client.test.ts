import { afterEach, describe, expect, it, vi } from "vitest";

import { createDbClient } from "./client";

describe("createDbClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not bypass invalid server environment validation", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/silpo");
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "invalid");
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-key");
    vi.stubEnv("AGENT_MODEL", "gemini-3.7-flash");
    vi.stubEnv("DATA_MODE", "demo");
    vi.stubEnv("PUBLIC_BASE_URL", "http://localhost:3000");

    expect(() => createDbClient()).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });
});
