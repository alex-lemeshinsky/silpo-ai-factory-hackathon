import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defaultExclude, defineConfig } from "vitest/config";

const oauthPostgresTest = "tests/integration/silpo-oauth-postgres.test.ts";
const runOAuthPostgres = process.argv.some(
  (arg) => arg === oauthPostgresTest || arg.endsWith(`/${oauthPostgresTest}`),
);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    exclude: [
      ...defaultExclude,
      "**/.worktrees/**",
      "**/.pnpm-store/**",
      "**/tests/e2e/**",
      ...(runOAuthPostgres ? [] : [oauthPostgresTest]),
    ],
    environment: "jsdom",
    globals: true,
    restoreMocks: true,
    setupFiles: ["./vitest.setup.ts"],
  },
});
