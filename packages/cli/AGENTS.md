# packages/cli guidance

## Scope

- This package owns CLI commands, argument parsing, local dashboard server/UI, and native pipeline orchestration.
- Do not put domain prompt logic here; prefer `packages/core/src/domain/*`.
- Do not put Node integration details here unless they are command orchestration; prefer `packages/adapters-node/src/*`.

## Context routing

- Command entry points live in `src/commands/`.
- Pipeline and stage orchestration lives in `src/orchestrator/`.
- Argument parsing lives in `src/args/`.
- Dashboard server/routes/scanning live in `src/commands/dashboard.ts`.
- Dashboard HTML shell lives in `src/commands/dashboard-page.ts`.
- Dashboard CSS lives in `src/commands/dashboard-style.ts`.
- Dashboard browser JS lives in `src/commands/dashboard-client.ts`.

## Token rules

- For Dashboard visual changes, read `src/commands/dashboard-style.ts` first.
- For Dashboard browser interactions, read `src/commands/dashboard-client.ts` first.
- For Dashboard HTML structure, read `src/commands/dashboard-page.ts` first.
- Do not read `dashboard.ts` unless API routes, scan state, or publish-index writes are involved.
- For command flag changes, read the specific command file and matching `src/args/*` file before broader searches.
- For pipeline behavior, start from `src/orchestrator/native-pipeline.ts` or the specific stage file.
- Avoid reading generated `dist/` files.

## Minimal verification

- Dashboard: `pnpm test packages/cli/src/commands/dashboard.test.ts`
- Native article: `pnpm test packages/cli/src/orchestrator/native-article.test.ts`
- Native pipeline: `pnpm test packages/cli/src/orchestrator/native-pipeline.test.ts`
- Publish: `pnpm test packages/cli/src/orchestrator/native-publish.test.ts`
- Always run `pnpm run typecheck` after command or orchestrator type changes.
