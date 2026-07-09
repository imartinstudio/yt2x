# CODEMAP

This map is intentionally short. Use it to route changes before reading code.

## CLI

- `packages/cli/src/index.ts`: command registration entry.
- `packages/cli/src/commands/`: thin command wrappers and local command UIs.
- `packages/cli/src/commands/dashboard.ts`: dashboard server, API routes, local file scanning, status writes.
- `packages/cli/src/commands/dashboard-page.ts`: dashboard HTML shell.
- `packages/cli/src/commands/dashboard-style.ts`: dashboard CSS.
- `packages/cli/src/commands/dashboard-client.ts`: dashboard browser JS.
- `packages/cli/src/orchestrator/`: native pipeline stage orchestration.
- `packages/cli/src/args/`: CLI and pipeline argument parsing.
- `packages/cli/src/config/`: env, dotenv, credentials, monorepo root helpers.

## Core

- `packages/core/src/domain/article/`: article targets, prompts, platform prompt contracts.
- `packages/core/src/domain/thread/`: X thread prompt and types.
- `packages/core/src/domain/short/`: X short post prompt and types.
- `packages/core/src/domain/video-short/`: X video-short prompt and types.
- `packages/core/src/domain/notes/`: structured notes prompt and types.
- `packages/core/src/domain/deconstruct/`: clip/post planning prompt contracts.
- `packages/core/src/domain/publish/`: markdown-to-X transformations and article draft parsing rules.
- `packages/core/src/domain/quality/`: pure quality checks and fixtures.
- `packages/core/src/ports/`: interfaces for external systems.

## Node Adapters

- `packages/adapters-node/src/article/`: article generation, file output, media copy.
- `packages/adapters-node/src/platform-article/`: optional platform rewrite generation and storage.
- `packages/adapters-node/src/wechat-format/`: xiaohu-wechat-format adapter.
- `packages/adapters-node/src/notes/`: notes generation and storage.
- `packages/adapters-node/src/thread/`, `short/`, `video-short/`: target-specific generation and storage.
- `packages/adapters-node/src/deconstruct/`: clip reports and post generation from article clips.
- `packages/adapters-node/src/x-publish/`: X API publishing.
- `packages/adapters-node/src/x-articles-draft/`: browser-draft materialization helpers.
- `packages/adapters-node/src/process/`: process runner and stderr buffering.

## Docs

- `docs/CODEMAP.md`: routing map for code entry points.
- `docs/USAGE.md`: user-facing commands and examples.
- `docs/DATA-CONTRACTS.md`: artifact naming and filesystem contracts.
- `docs/ARCHITECTURE.md`: package responsibilities and data flow.
- `docs/adr/`: accepted decisions.
- `docs/*-TASK.md`: task-specific design docs; read only for that task.

## Common Task Routes

- Dashboard HTML shell: `packages/cli/src/commands/dashboard-page.ts`.
- Dashboard styling/visual bugs: `packages/cli/src/commands/dashboard-style.ts`.
- Dashboard browser interactions: `packages/cli/src/commands/dashboard-client.ts`.
- Dashboard API/status/scanning: `packages/cli/src/commands/dashboard.ts` and `dashboard.test.ts`.
- WeChat formatting: `packages/adapters-node/src/wechat-format/*`, then `packages/cli/src/commands/wechat-format.ts`.
- Platform rewrite prompts: `packages/core/src/domain/article/platform-prompts.ts`.
- Main article prompt: `packages/core/src/domain/article/prompts.ts`.
- Article orchestration: `packages/cli/src/orchestrator/native-article.ts` plus `packages/adapters-node/src/article/*`.
- Pipeline orchestration: `packages/cli/src/orchestrator/native-pipeline.ts`.
- X publish behavior: `packages/cli/src/orchestrator/native-publish.ts` plus `packages/core/src/domain/publish/*`.
- Clip/deconstruct behavior: `packages/cli/src/commands/deconstruct.ts`, `packages/adapters-node/src/deconstruct/*`, `packages/core/src/domain/deconstruct/*`.
- Docs/usage update: `docs/USAGE.md` or `docs/DATA-CONTRACTS.md`; do not scan all task docs.

## Minimal Verification Routes

- Dashboard: `pnpm test packages/cli/src/commands/dashboard.test.ts` and `pnpm run typecheck`.
- WeChat formatter: `pnpm test packages/adapters-node/src/wechat-format/formatter.test.ts` and `pnpm run typecheck`.
- Article/platform prompt rules: `pnpm test packages/core/src/domain/article/platform-prompts.test.ts packages/core/src/domain/article/prompts.test.ts`.
- Publish transforms: `pnpm test packages/core/src/domain/publish`.
- Pipeline argument parsing: `pnpm test packages/cli/src/args packages/cli/src/commands/single-stage-projection.test.ts`.

## Avoid By Default

- `dist/`, `node_modules/`, `*.tsbuildinfo`.
- Generated downloads/articles under `files/`.
- Extension screenshots, promo images, zip bundles, and icon binaries unless the task is specifically about store assets.
- Long `docs/*-TASK.md` files unless the request names that task.
