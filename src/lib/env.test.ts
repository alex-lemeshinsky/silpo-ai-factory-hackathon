import { getServerEnv } from "@/lib/env";

function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://inventory.test/database",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    GOOGLE_GENERATIVE_AI_API_KEY: "synthetic-google-key",
    AGENT_MODEL: "gemini-3.7-flash",
    DATA_MODE: "demo",
    PUBLIC_BASE_URL: "https://inventory.test",
    ...overrides,
  };
  return base as unknown as NodeJS.ProcessEnv;
}

it("parses valid synthetic server configuration", () => {
  expect(getServerEnv(validEnv())).toMatchObject({
    NODE_ENV: "test",
    AGENT_MODEL: "gemini-3.7-flash",
    DATA_MODE: "demo",
    PUBLIC_BASE_URL: "https://inventory.test",
  });
});

it("applies safe defaults", () => {
  const source = validEnv() as Record<string, string | undefined>;
  delete source.NODE_ENV;
  delete source.AGENT_MODEL;
  delete source.DATA_MODE;

  expect(getServerEnv(source as NodeJS.ProcessEnv)).toMatchObject({
    NODE_ENV: "development",
    AGENT_MODEL: "gemini-3.7-flash",
    DATA_MODE: "live",
  });
});

it("requires the Gemini key", () => {
  const source = validEnv();
  delete source.GOOGLE_GENERATIVE_AI_API_KEY;

  expect(() => getServerEnv(source)).toThrow(/GOOGLE_GENERATIVE_AI_API_KEY/);
});

it("requires the public base URL", () => {
  const source = validEnv();
  delete source.PUBLIC_BASE_URL;

  expect(() => getServerEnv(source)).toThrow(/PUBLIC_BASE_URL/);
});

it("names PUBLIC_BASE_URL when the URL is malformed", () => {
  expect(() => getServerEnv(validEnv({ PUBLIC_BASE_URL: "not-a-url" }))).toThrow(
    /PUBLIC_BASE_URL/,
  );
});

it("rejects invalid data mode", () => {
  expect(() => getServerEnv(validEnv({ DATA_MODE: "automatic" }))).toThrow(/DATA_MODE/);
});

it("requires a 32-byte decoded encryption key", () => {
  expect(() =>
    getServerEnv(validEnv({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(31).toString("base64") })),
  ).toThrow(/TOKEN_ENCRYPTION_KEY/);
});

it("requires a Postgres database URL", () => {
  expect(() => getServerEnv(validEnv({ DATABASE_URL: "https://database.test" }))).toThrow(
    /DATABASE_URL/,
  );
});

it("requires HTTPS for the production public URL", () => {
  expect(() =>
    getServerEnv(validEnv({ NODE_ENV: "production", PUBLIC_BASE_URL: "http://inventory.test" })),
  ).toThrow(/PUBLIC_BASE_URL/);
});

it("does not echo a supplied secret in validation errors", () => {
  const suppliedSecret = "not-valid-base64-secret";
  let thrown: unknown;

  try {
    getServerEnv(validEnv({ TOKEN_ENCRYPTION_KEY: suppliedSecret }));
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).not.toContain(suppliedSecret);
});
