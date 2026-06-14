# packages/x-article-extension guidance

## Scope

- This package owns the Chrome MV3 extension that imports Markdown into X Articles drafts.
- It may reuse pure markdown/publish logic from `packages/core`.
- Do not put native CLI orchestration or Node adapter behavior here.

## Context routing

- `src/content/x-articles.ts`: content script entry.
- `src/background/main-world-bridge.ts`: extension/main-world bridge.
- `src/main-world/draft-writer.ts`: main-world editor writing behavior.
- `src/dom/`: X editor locators, insertion, cover upload, file input helpers.
- `src/import/markdown-to-draft-payload.ts`: Markdown import payload shaping.
- `src/render/`: table and mermaid rendering helpers.
- `src/ui/`: import button, dialog, loading UI.
- `src/runtime/`: extension runtime integration.
- `src/files/`: local media handling.

## Token rules

- Do not read `dist/`, built manifests, icon binaries, or generated extension bundles.
- For editor behavior, start in `src/dom/` or `src/main-world/draft-writer.ts`, not every extension file.
- For UI visuals, start in `src/ui/`.
- For Markdown conversion, start in `src/import/markdown-to-draft-payload.ts`.

## Minimal verification

- Package typecheck: `pnpm --filter x-article-extension typecheck`
- Package build: `pnpm --filter x-article-extension build`
- Focused tests can be run with the relevant `*.test.ts` path through the root test command.
