import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defaultExclude, defineConfig } from "vitest/config";

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
    ],
    environment: "jsdom",
    globals: true,
    restoreMocks: true,
    setupFiles: ["./vitest.setup.ts"],
  },
});
