# packages/x-following-extension guidance

## Scope

- This package owns the Chrome MV3 extension for filtering, selecting, and bulk-unfollowing X following lists.
- Keep this package focused on extension UI, DOM interaction, and browser runtime behavior.
- Do not put yt2x CLI, article generation, or Node adapter logic here.

## Context routing

- `src/content/following-manager.ts`: content script orchestration.
- `src/background/background.ts`: background service worker.
- `src/dom/following-filter.ts`: filtering following rows.
- `src/dom/user-cell-checkbox.ts`: checkbox injection and row selection behavior.
- `src/dom/x-session.ts`: X session/page context helpers.
- `src/ui/following-toolbar.ts`: toolbar UI.
- `scripts/smoke-following.mjs`: smoke test script.

## Token rules

- Do not read `dist/`, zip packages, screenshots, promo images, or icon binaries unless explicitly working on store assets.
- For filtering bugs, start in `src/dom/following-filter.ts`.
- For checkbox/selection bugs, start in `src/dom/user-cell-checkbox.ts`.
- For toolbar UI bugs, start in `src/ui/following-toolbar.ts`.
- For smoke test issues, start in `scripts/smoke-following.mjs`.

## Minimal verification

- Package typecheck: `pnpm --filter x-following-extension typecheck`
- Package build: `pnpm --filter x-following-extension build`
- Smoke test when relevant: `node packages/x-following-extension/scripts/smoke-following.mjs`
