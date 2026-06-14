# docs guidance

## Scope

- This directory contains task specs, architecture notes, data contracts, ADRs, and usage docs.
- Prefer `CODEMAP.md` for routing. Do not read long task documents unless the current request names that feature or file.

## Context routing

- `CODEMAP.md`: fastest route to code entry points and minimal verification.
- `USAGE.md`: user-facing commands, flags, and operational examples.
- `DATA-CONTRACTS.md`: filesystem outputs, status files, and artifact naming.
- `ARCHITECTURE.md`: package responsibilities and data flow.
- `ROADMAP.md` and `REFACTOR-STATUS.md`: planning/status only.
- `adr/`: accepted architecture decisions.
- `*-TASK.md`: task-specific design docs; read only when working on that specific task.

## Token rules

- Start from `CODEMAP.md` before opening other docs.
- Do not read every `*-TASK.md` to answer a general architecture or coding question.
- When updating examples, keep YouTube URLs and video IDs as placeholders.
- Avoid quoting large doc sections in final responses.

## Minimal verification

- Docs-only routing changes usually need `pnpm format:check`.
- If docs describe command behavior that code also changed, run the focused code test plus `pnpm run typecheck`.
