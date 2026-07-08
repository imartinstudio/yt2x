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
