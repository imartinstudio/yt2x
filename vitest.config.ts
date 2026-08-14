import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
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
        // 阈值是跟着度量口径标定的，不是独立的质量目标——v8 覆盖率每次大版本升级
        // 都会重新切分支，同一套测试测出来的数字就变了。历次实测（同一份代码）：
        //   v2 → v3：整体约 -1pp
        //   v3 → v4：lines -0.5、statements -2.1、functions -6.6、branches -9.1
        //            （v4 默认 AST 感知重映射，把以前算作一个的分支拆得更细）
        // 所以下面这组数字对应 vitest 4 的口径，留出约 3pp 余量。降 branches 不等于
        // 放松要求：同一套测试在 v3 下是 78.14%，在 v4 下是 69.04%。
        lines: 72,
        statements: 72,
        functions: 80,
        branches: 66,
      },
    },
  },
  resolve: {
    alias: {
      "@yt2x/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
      "@yt2x/adapters-node": new URL("./packages/adapters-node/src/index.ts", import.meta.url)
        .pathname,
    },
  },
});
