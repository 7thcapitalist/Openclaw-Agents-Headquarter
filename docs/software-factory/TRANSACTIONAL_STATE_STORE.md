# Transactional workflow state store (FCT-P0-02)

Batch 2 of the SFD-2026-010 reliability campaign. Builds on FCT-P0-01
(reliability baseline, merged as #131).

## Problem this closes

Atomic rename (`writeFileSync(tmp)` + `renameSync`) has always prevented a
*torn* write to `state.json`/`objective-state.json` — a reader never sees a
half-written file. It never prevented a *lost update*: two callers each doing
their own `read JSON -> mutate in memory -> write JSON` race freely, and
whichever write lands second silently discards the first caller's change.
Concretely, before this change:

- Two concurrent node completions on the same objective could each read the
  same `objective-state.json`, patch their own node, and write back — the
  loser's patch vanished.
- Two deliveries of the same dispatch result (a genuine retry, or two
  processes) could each apply `ingestResult` independently, advancing the
  workflow twice.
- A founder's approval and an automated retry sweep resuming the same task
  could race the same way.

## What changed

`factory/lib/store/sqlite-state.mjs` is a small, dependency-free transactional
authority built on Node's built-in `node:sqlite` (`DatabaseSync`, WAL mode).
`factory/lib/store/transactional-json.mjs` bridges it to the existing
"one JSON file per task/objective" world so every existing caller keeps its
exact on-disk contract.

**Layout**: for a JSON state file at `.../<dir>/<name>.json`, the database
lives alongside it at `.../<dir>/<name>.sqlite` — one db file per JSON file
(not per directory), so two differently-named state files that happen to
share a directory never collide on the same row. In production this is
always one file per directory anyway (`tasks/<id>/state.json`,
`objectives/<id>/objective-state.json`); the per-file naming exists so a
test fixture that colocates two entities in one temp directory still works
correctly.

**The database is the sole writable authority.** The JSON file is
regenerated after every committed mutation, purely as a human/debug export —
requirement "keep readable JSON as export/debug artifacts only." Nothing
else writes that file directly anymore.

**Schema** (per database file — see `sqlite-state.mjs` for the DDL):

| Table | Purpose |
| --- | --- |
| `meta` | schema version |
| `entity` | the current row: revision, status, current_stage, full `state_json` |
| `state_revisions` | one row per committed revision — audit trail of when/by-what-command |
| `events` | append-only projection of `state.events[]` |
| `commands` | idempotency ledger: `commandId -> the response it produced` |
| `stages` | queryable projection of `state.stages{}` |
| `dispatches` | append-only projection of `state.dispatches[]` |
| `recovery_attempts` | append-only projection of `state.recovery.attempts[]` |
| `quarantine` | corrupt or unreadable rows/files, preserved for inspection |

**The one write primitive** is `mutateEntity(handle, { entityId, commandId,
expectedRevision?, mutate })`. Everything — the event log, the projections,
and the current-state row — commits in one SQLite transaction
(`BEGIN IMMEDIATE` … `COMMIT`):

- `commandId` is required and is the idempotency key. A repeated `commandId`
  short-circuits to the previously recorded response without calling
  `mutate` again — "duplicate requests do not execute twice."
- `expectedRevision`, when given, throws `StaleRevisionError` instead of
  applying the mutation if the current revision has moved — "stale
  expected revisions are rejected."
- `mutate(current)` runs *inside* the transaction, so the read and the write
  are one atomic unit; ordinary callers (`patchNode`-shaped small patches)
  get correctness for free without needing `expectedRevision` at all,
  because `BEGIN IMMEDIATE` already serializes every writer against this
  same file.
- A corrupt `state_json` row is quarantined and removed, not left to fail
  forever; the caller sees `CorruptStateError`.

`transactional-json.mjs` exposes `readTransactionalState(jsonPath)` and
`mutateTransactionalState(jsonPath, { commandId, mutate, expectedRevision?, now? })`.
`factory/lib/task-workflow.mjs`'s `readState`/`writeState` — the two
functions essentially every module in the factory already called — now
delegate to these, so every existing caller (the openclaw protocol layer,
the objective orchestrator, the runner, founder approval, auto-retry, the
CLI scripts) is safe without having to change most of them individually.
Several call sites were changed directly because they benefit from an
explicit idempotency key or `expectedRevision` rather than the generic
pass-through: `openclaw-protocol.mjs` (`prepareDispatch`, `ingestResult`,
`failDispatch`, `recordDispatchAgentId`, `markDispatchRunning` — each keyed
by `dispatchId`), `objective/orchestrator.mjs`'s `patchNode`/`mutate`,
`founderControlPlane.mjs`'s `resolveFounderDecision`, and
`dashboard/backend/lib/overnightQueue.mjs`'s mutators over
`overnight-queue.json` (this closes the exact race named in the original
survey: `runNext`'s completion callback racing a concurrent
add/remove/stop request against the same file).

## Migration

**Nothing is required.** Any code path that calls `readState`/`writeState`/
`readObjState`/`patchNode` already lazily imports a pre-existing legacy JSON
file into the database the first time it is touched
(`ensureImported()` in `transactional-json.mjs`), verbatim — every field,
including `events[]`, `stages{}`, `dispatches[]`, `recovery.attempts[]`,
`blocker`, and `founderApproval*`, is stored as-is inside `state_json`, so
nothing is lost by construction (this isn't a field-by-field remapping).

For an operator who wants one consolidated report up front (before a
release, or after restoring a backup) rather than relying on lazy
first-touch import:

```bash
node scripts/migrate-factory-state.mjs --state-root dashboard/backend/data/factory
node scripts/migrate-factory-state.mjs --state-root dashboard/backend/data/factory --dry-run   # list only, imports nothing
```

It walks the tree for every `state.json`/`objective-state.json`, imports
each, and prints `imported / already current / quarantined` counts plus the
quarantined paths and reasons. **Idempotent**: re-running it after the first
pass reports everything as "already current" and changes nothing (the same
guarantee `importLegacyState()` provides at the row level — a second import
for an entity that already exists is a no-op, verified in
`factory/test/store/migrate-factory-state.test.mjs`). Exits non-zero iff
anything was quarantined.

**A failed migration leaves the original data untouched.** A corrupt legacy
JSON file (fails to parse) is recorded in the `quarantine` table with the
file path and reason; the JSON file on disk is never modified, renamed, or
deleted, and a good file elsewhere is unaffected by one bad file — see the
`migrateFiles` tests.

## Rollback

Reverting this change is a plain code revert, not a data migration, because
the JSON export always mirrors the latest committed revision: at any point
in time, `state.json`/`objective-state.json` on disk is a faithful, current
snapshot, so the pre-existing (and unmodified) `readState`-via-`JSON.parse`
code path would pick up exactly where things left off. Concretely:

1. Revert this PR.
2. No further action is required; the `.sqlite`/`.sqlite-wal`/`.sqlite-shm`
   files become inert and can be deleted at leisure (they are already
   `.gitignore`d, same as the existing `*.db.sqlite*` patterns for
   `dashboard/backend/lib/db.mjs`).
3. If a rollback happens *mid-incident* while a mutation is only partially
   through a transaction, nothing is lost either way: SQLite's WAL makes an
   uncommitted transaction invisible on reopen (see
   `factory/test/store/concurrency.test.mjs`'s "process killed
   mid-transaction" test) — the JSON export on disk reflects the last
   *committed* state, which is exactly what a reverted, JSON-only reader
   would also see.

## Explicitly out of scope for this PR

`dashboard/backend/lib/founderControlPlane.mjs`'s remaining read-modify-write
functions over `control-plane.json` (`setProjectPaused`, `setObjectiveArchived`,
`setInboxItemDismissed`, `recordQuestion`, `updateQuestion`, `saveFounderJob`,
`finishFounderJob`) have the same class of race (independent
read-modify-write, atomic-rename-only) but were not migrated here. Doing so
is mechanically the same pattern established above (and the same one
`overnightQueue.mjs` now uses) — a follow-up task can apply it directly —
but including it here would meaningfully grow this PR's diff and test
surface without being needed for this batch's named acceptance criteria
(all of which are about objective/task/dispatch state; `overnightQueue.mjs`
was included because it sits directly downstream of objective completions
racing the founder's queue controls).
`dashboard/backend/lib/db.mjs` and `sessionStore.mjs` are untouched: they
already use `better-sqlite3` with WAL for an unrelated domain (registered
agents, dashboard sessions) and single-statement writes with no
read-modify-write race to begin with.

The three pre-existing, intentionally-skipped regressions documented in
`docs/software-factory/handoffs/2026-09-09-reliability-overhaul.md` are
unrelated to this change and remain untouched.

## Evidence

- `factory/test/store/sqlite-state.test.mjs` — core engine: CAS/stale-revision
  rejection, idempotent command replay, no-op mutations, rollback on a
  thrown mutate, corrupt-row quarantine, legacy-import idempotency and
  fidelity, schema-version guard, file permissions, identifier validation.
- `factory/test/store/concurrency.test.mjs` — genuine multi-thread/process
  concurrency: 100 concurrent mutations against one entity and, separately,
  against one real `objective-state.json` (no lost updates in either); two
  workers racing to ingest the same duplicate command (effect runs exactly
  once); a real child process killed mid-transaction (last committed state
  survives, the store remains usable afterward).
- `factory/test/store/migrate-factory-state.test.mjs` — the bulk migration
  script: discovery, verbatim import, idempotent re-run, corrupt-file
  quarantine without touching the original bytes or blocking other files.
- `npm run test:factory` — full suite, run clean multiple times; see the PR
  for exact counts and durations.
