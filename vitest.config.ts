import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defaultExclude, defineConfig } from "vitest/config";

const postgresTests = [
  "tests/integration/silpo-oauth-postgres.test.ts",
  "tests/integration/diagnostics-postgres.test.ts",
];
const excludedPostgresTests = postgresTests.filter(
  (file) => !process.argv.some((arg) => arg === file || arg.endsWith(`/${file}`)),
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
      ...excludedPostgresTests,
    ],
    environment: "jsdom",
    globals: true,
    restoreMocks: true,
    setupFiles: ["./vitest.setup.ts"],
  },
});
