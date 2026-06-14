# packages/core guidance

## Scope

- This package owns pure domain logic, prompt construction, type contracts, quality checks, and publish transformations.
- No filesystem writes, network calls, browser automation, or external process execution should be added here.
- Keep Node implementations in `packages/adapters-node` and CLI orchestration in `packages/cli`.

## Context routing

- `src/domain/article/`: main article prompt, platform target metadata, platform rewrite prompts.
- `src/domain/thread/`: X thread prompt and types.
- `src/domain/short/`: X short post prompt and types.
- `src/domain/video-short/`: X video-short prompt and types.
- `src/domain/notes/`: structured notes prompt and types.
- `src/domain/deconstruct/`: clip/post planning domain contracts.
- `src/domain/publish/`: markdown transformation and X Articles draft parsing.
- `src/domain/quality/`: pure quality checks and fixtures.
- `src/ports/`: external capability interfaces.

## Token rules

- For prompt changes, read only the relevant `prompts.ts` or `platform-prompts.ts` and its matching test first.
- For publish markdown behavior, start in `src/domain/publish/`; do not inspect CLI publish orchestration unless command behavior changes.
- For quality checks, start in `src/domain/quality/checks.ts` and the focused test fixture.
- Do not read generated `dist/` files.

## Minimal verification

- Article prompts: `pnpm test packages/core/src/domain/article/prompts.test.ts`
- Platform prompts: `pnpm test packages/core/src/domain/article/platform-prompts.test.ts`
- Thread prompts: `pnpm test packages/core/src/domain/thread/prompts.test.ts`
- Publish transforms: `pnpm test packages/core/src/domain/publish`
- Quality checks: `pnpm test packages/core/src/domain/quality`
- Always run `pnpm run typecheck` after exported type changes.
