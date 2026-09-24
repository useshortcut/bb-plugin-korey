import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-korey",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
