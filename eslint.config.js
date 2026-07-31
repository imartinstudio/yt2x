import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "packages/x-article-extension/build.mjs",
      "packages/x-article-extension/scripts/**",
      "packages/x-following-extension/build.mjs",
      "packages/x-following-extension/scripts/**",
      "**/node_modules/**",
      // Python 虚拟环境（demucs 等）自带 vendored JS，不是本仓库源码。
      // git 靠 venv 自动生成的 .venv-*/.gitignore 忽略它们，但 eslint 不看 git 规则。
      "**/.venv*/**",
      "**/*.tsbuildinfo",
      "files/downloads/**",
      "files/articles/**",
      "src/**",
      "coverage/**",
      "**/.hermes/**",
      ".codex/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "no-console": "off",
    },
  },
  prettier,
);
