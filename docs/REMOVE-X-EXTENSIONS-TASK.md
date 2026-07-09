# 移除 x-article-extension 与 x-following-extension 实现方案

## 背景与结论

移除两个独立的 Chrome 扩展包 `x-article-extension` 与 `x-following-extension`。

排查结论：

- `x-article-extension` 仅单向依赖 `@yt2x/core`；`x-following-extension` 完全独立。
- 没有任何 `packages/cli`、`packages/adapters-node`、`packages/core` 源码 import 这两个包，移除不影响主 pipeline 运行时。
- `packages/cli/tsconfig.json` 的 references 只含 `core` 和 `adapters-node`，无需改动。
- `vitest.config.ts` 中的 alias `@x-article/extension` 仅在配置里定义、无实际使用者，可安全删除。
- `packages/adapters-node/src/x-articles-draft/*`（草稿解析/生成）属于 CLI 侧逻辑，不是扩展包，保留不动。

## 删除目录

- `packages/x-article-extension/`
- `packages/x-following-extension/`
- `videos/x-following-extension-promo/`
- `docs/CHROME-ARTICLE-IMPORT-TASK.md`
- `docs/superpowers/specs/2026-06-04-x-following-extension-redesign.md`
- `docs/superpowers/plans/2026-06-04-x-following-extension-redesign.md`

## 修改配置

1. 根 `package.json`：`build` 脚本改为 `tsc -b --pretty`（移除两个扩展的构建串联）。
2. 根 `tsconfig.json`：`references` 移除 `{ "path": "./packages/x-article-extension" }`。
3. `vitest.config.ts`：
   - 删除 `environmentMatchGlobs` 中两个扩展的 jsdom 匹配；删空后可移除整个 `environmentMatchGlobs`。
   - 删除 `resolve.alias` 中的 `@x-article/extension`。
4. `eslint.config.js`：`ignores` 删除两个扩展的 `build.mjs` 与 `scripts/**` 项（4 行）。
5. `.rgignore`：删除 `packages/x-following-extension/screenshots/`。
6. `pnpm-lock.yaml`：执行 `pnpm install` 自动重生成（会移除 `mermaid`、`@types/chrome` 等仅被扩展使用的依赖）。

## 修改文档

1. 根 `AGENTS.md`：删除「常见任务路由」中 X 扩展相关两行（第 41-42 行）。
2. `docs/CODEMAP.md`：删除扩展相关条目（第 43-50、74-75、85-86 行）。

## 执行顺序

```bash
# 1. 删除包目录与关联素材
rm -rf packages/x-article-extension packages/x-following-extension
rm -rf videos/x-following-extension-promo
rm -f docs/CHROME-ARTICLE-IMPORT-TASK.md
rm -f docs/superpowers/specs/2026-06-04-x-following-extension-redesign.md
rm -f docs/superpowers/plans/2026-06-04-x-following-extension-redesign.md

# 2. 修改上述配置文件与文档

# 3. 重装依赖，刷新 lockfile
pnpm install

# 4. 验证
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm test
```

## 验证预期

- `tsc -b` 不再尝试构建扩展。
- vitest 不再加载扩展的 jsdom 匹配。
- lint / build / test 全绿。

## 分支建议

从最新远端 `main` 切分支 `chore/remove-x-extensions` 后再执行改动。
