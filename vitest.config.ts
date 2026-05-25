import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    environmentMatchGlobs: [["packages/chrome-extension/**/*.test.ts", "jsdom"]],
    include: ["packages/**/*.{test,spec}.ts", "tests/**/*.{test,spec}.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["packages/**/src/**/*.ts"],
      exclude: [
        "**/index.ts",
        "**/*.d.ts",
        "**/__fixtures__/**",
        // Commander 注册薄层（`single-stage-projection` 有独立单测，仍不计入覆盖率）
        "**/cli/src/commands/**",
      ],
      thresholds: {
        lines: 75,
        statements: 75,
        functions: 77,
        branches: 72,
      },
    },
  },
  resolve: {
    alias: {
      "@yt2x/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
      "@yt2x/adapters-node": new URL("./packages/adapters-node/src/index.ts", import.meta.url)
        .pathname,
      "@yt2x/chrome-extension": new URL(
        "./packages/chrome-extension/src/content/x-articles.ts",
        import.meta.url,
      ).pathname,
    },
  },
});
