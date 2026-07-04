import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    environmentMatchGlobs: [
      ["packages/x-article-extension/**/*.test.ts", "jsdom"],
      ["packages/x-following-extension/**/*.test.ts", "jsdom"],
    ],
    include: ["packages/**/*.{test,spec}.ts", "tests/**/*.{test,spec}.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      all: false,
      reporter: ["text", "lcov", "html"],
      include: ["packages/**/src/**/*.ts"],
      exclude: [
        "**/index.ts",
        "**/*.d.ts",
        "**/__fixtures__/**",
        // Commander 注册薄层（`single-stage-projection` 有独立单测，仍不计入覆盖率）
        "**/cli/src/commands/**",
        // 重依赖外部二进制/平台的集成路径，由 smoke/手工验证覆盖
        "**/scene-keyframes.ts",
        "**/scene-quality.ts",
        "**/adapters-node/src/video-short/**",
      ],
      thresholds: {
        // Vitest 3 coverage remapping reports ~1pp lower than v2 on the same suite.
        lines: 72,
        statements: 72,
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
      "@x-article/extension": new URL(
        "./packages/x-article-extension/src/content/x-articles.ts",
        import.meta.url,
      ).pathname,
    },
  },
});
