<!--
  The technical reality an agent must respect before writing code here.
  Maintainer: architect + builder via PR.
-->

# Tech context

## Stack

- Node.js, ES modules (`"type": "module"`). No build step for `factory/` or
  `scripts/`.
- Tests: `node --test` (`node:test` + `node:assert/strict`). Run with
  `npm run test:factory`.
- Dashboard backend under `dashboard/backend/` has its own `node_modules`; the
  root has none.

## Environments

- Local only. There is no production deployment of the factory itself.
- The factory operates on *other* project repos via git worktrees under
  `.openclaw-worktrees/`.
- Runtime state: `dashboard/backend/data/factory/` (gitignored).

## Constraints

- `factory/lib/*` imports Node builtins only — no npm dependencies.
- Do not modify the 7-stage state machine, the dispatch protocol, the JSON
  adapter surface, the request/result schemas, or the `writeHandoff()` signature.
- Preserve the `./run.sh` execution boundary, worktree isolation
  (one writer per branch), and human-merge mode.
- Never write secrets, credentials, or generated personal data into the repo.

## Do not do

- Do not add a second state machine or a new pipeline stage for intelligence
  features — they are inputs and reads only.
- Do not have an agent be the sole reviewer of its own work.
- Do not read context files from outside a project's declared `contextDir`; the
  redaction guard will refuse, and that is intentional.

## Observability

- Durable factory events live in each task's `state.json` `events[]`.
- `npm run factory:smoke` is a live-harness end-to-end check against a
  disposable repo (not a CI gate).
- `node scripts/project-intel.mjs` `show` / `lint` inspect the assembled context.
