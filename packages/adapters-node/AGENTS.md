# packages/adapters-node guidance

## Scope

- This package owns Node implementations around files, processes, external CLIs, LLM calls, YouTube, X publishing, and browser-draft materialization.
- Keep pure domain rules in `packages/core`.
- Keep CLI UX and command flags in `packages/cli`.

## Context routing

- `src/article/`: main article generation and local article output.
- `src/platform-article/`: optional platform rewrite artifacts.
- `src/wechat-format/`: xiaohu-wechat-format integration.
- `src/notes/`: structured notes generation and storage.
- `src/thread/`, `src/short/`, `src/video-short/`: generated X target artifacts.
- `src/deconstruct/`: clip report and post generation from article/video assets.
- `src/x-publish/`: X API publishing.
- `src/x-articles-draft/`: X Articles browser-draft helpers.
- `src/process/`: process runner, stderr buffering, external command errors.

## Token rules

- Start from the adapter subdirectory that matches the feature; avoid broad reads across all adapters.
- Do not read `dist/` or generated article/download files.
- When touching process execution, inspect `src/process/runner.ts` and the nearest adapter test.
- When adding file outputs, update the local file-store test for that adapter first.

## Minimal verification

- WeChat formatter: `pnpm test packages/adapters-node/src/wechat-format/formatter.test.ts`
- Platform article: `pnpm test packages/adapters-node/src/platform-article`
- Article file output: `pnpm test packages/adapters-node/src/article`
- Process runner: `pnpm test packages/adapters-node/src/process`
- Always run `pnpm run typecheck` after adapter API changes.
