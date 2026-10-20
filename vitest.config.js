import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: {
    alias: {
      "/vendor/i18next.js": fileURLToPath(
        new URL("./node_modules/i18next/dist/esm/i18next.js", import.meta.url),
      ),
      "/i18n/locale.js": fileURLToPath(
        new URL("./shared/i18n/locale.js", import.meta.url),
      ),
    },
  },
  test: {
    setupFiles: ["./tests/helpers/i18n.js"],
    include: ["tests/**/*.test.js"],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
