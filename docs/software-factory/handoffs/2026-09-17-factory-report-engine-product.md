# Product handoff — `factory report engine`

## Problem
The factory computes five health signals about itself (completion, throughput, silent failures, founder interruption load, cycle time) but they live scattered across `factory/lib/hq/goals.mjs`, `agent-scorecards.mjs`, `cost-ledger.mjs`, and `factory/lib/learning/analyze.mjs`, each with its own read path, and several of them read `objective-state.json` — a debug export, not the transactional authority (`objective-state.sqlite`, per `factory/lib/store/transactional-json.mjs`). There is no single command a human or the browser can run to get one dated, verifiable snapshot of "is the factory healthy," and no guarantee that re-running the same computation twice produces the same bytes.

## Desired outcome
`npm run factory:report` produces one dated JSON snapshot under `dashboard/backend/data/factory/_metrics/` containing the five metrics below, each carrying the exact source path(s) it was computed from. Running it twice against unchanged state is byte-identical. A metric that cannot be computed is `null` with a reason, never `0`. The CLI exits non-zero if any metric is `null`, so a human (or CI) immediately knows the snapshot is incomplete rather than silently trusting a zero. The JSON shape is a stable contract a later browser-facing builder reads directly, with no recomputation.

## Scope

### In
- A new report engine module (location and internal structure are the architect's call) that computes, deterministically:
  1. Objectives-complete fraction
  2. Dispatches-per-merged-task
  3. No-verdict dispatch counts, overall and per stage
  4. Founder interruptions per merged task, split infra vs. product/spend
  5. Cycle time per stage, plus wall time per objective (decomposition to terminal)
- A CLI entry point wired as `npm run factory:report`.
- Reuse of the existing rollup/tally logic in `goals.mjs` (objective progress buckets), `agent-scorecards.mjs` (accepted-outcome tallies, per-dispatch duration, null-not-zero and `confidence` patterns), `cost-ledger.mjs` (deterministic summarization shape), and `learning/analyze.mjs`/`evidence.mjs` (`cycleMs`, decision-event detection) — the *formulas*, not their file-reading code, since those modules read the JSON export and this engine must not.
- A snapshot writer that writes only its own dated file under `_metrics/` and never touches any other factory state file.
- Tests under `factory/test/` (picked up automatically by the existing `factory/test/**/*.test.mjs` glob in `scripts/run-factory-tests.mjs`) proving: byte-identical re-run, null-not-zero on missing/malformed input, and the no-verdict literal-string classification.

### Out
- No dashboard/browser UI for the report (a later builder consumes the JSON contract this task defines).
- No change to `HQ_AUTO_RETRY`, no polling loop, no scheduler.
- No new runtime dependency — the engine reads through the existing SQLite path (`node:sqlite`, already used by `factory/lib/store/sqlite-state.mjs`) or `better-sqlite3` (already a `dashboard/backend` dependency); it must not add a new package to either surface.
- No change to the workflow engine, agent prompts, routing/seat assignment, or the request/result dispatch schema.
- No change to `objective-state.json` / task `state.json` export behavior.

## Grounding notes (confirmed against current code, not assumed)

- **Read path.** `objective-state.sqlite` is the transactional authority; `objective-state.json` is a generated, non-authoritative export written after every commit (`factory/lib/store/transactional-json.mjs`). The `entity` table's `state_json` column holds the full current document; `state.events` inside it is a **windowed tail** (`DEFAULT_EVENTS_WINDOW = 200` in `sqlite-state.mjs`) — the full event history is only guaranteed complete in the `events` table. Any metric that needs full event history (e.g., counting every founder interruption over an objective's life, not just the last 200 events) must read the `events` table, not trust `state.events` alone. This matches the acceptance criterion restricting sources to `entity.state_json` + `events` — and explicitly excludes the `dispatches`/`stages`/`recovery_attempts` projection tables that also exist in that schema, even though they'd be convenient. Worth architect awareness so no one reaches for the shortcut.
- **Dispatch result files are real and already shaped correctly.** `factory/lib/openclaw-protocol.mjs` computes `resultPath = <task-dir>/results/<taskId>-<stage>-<attempt>.json` — exactly the acceptance criterion's path pattern. This task's own machine-result contract is one instance of that shape (`outcome`, and for `decision-required`, a `decision.impact` field drawn from the same vocabulary as `factory/decision-protocol.json`: privacy, spend, public, product-direction, scope, irreversible, security-posture, legal). Recommend treating any `decision-required` result with a declared `impact` as the "product/spend" bucket, and objective-level `node-blocked` events whose blocker text matches the existing infra taxonomy (`factory/lib/failure-classification.mjs`) as the "infra" bucket — both are derivable from the two approved sources without inventing a third.
- **The four "no verdict" literal strings are real but not literally cased.** The actual producers emit `"[openclaw] Could not start the CLI."` (capital C), `"... wrote no result file"`, `"Agent did not write its result file: ..."`, and `"... could not run: ..."` (see `openclaw-protocol.mjs:576`, `openclaw-runner.mjs:29,692,704,728`). Matching must be case-insensitive substring matching against result-file content, not exact-case equality, or every real occurrence will be missed. This is a correctness detail for the builder, not a scope change.
- **`factory:report` is a new script name** — no existing entry in `package.json`; add it alongside the other `factory:*` scripts following the existing `"factory:x": "node scripts/x.mjs"` convention.
- **`dashboard/backend/data/factory` does not exist in a fresh checkout** (state is git-ignored, created at runtime). Tests must build their own fixture tree under a temp dir rather than depend on real data being present — consistent with how the rest of `factory/test/` already works.

## Acceptance criteria
(Founder-specified criteria carried forward verbatim; all confirmed observable and testable against the current codebase during this stage.)

- `npm run factory:report` computes: objectives-complete fraction, dispatches-per-merged-task, no-verdict dispatch counts (overall and per stage), founder interruptions per merged task split infra vs product/spend, and cycle time per stage plus wall time per objective (decomposition to terminal).
- All metrics are read only from `dashboard/backend/data/factory/<project>/objectives/<id>/objective-state.sqlite` (`entity.state_json`, `events` table) and `dashboard/backend/data/factory/<project>/tasks/<task>/results/<task>-<stage>-<n>.json`; `state.json` exports are never read as a source of truth.
- A dispatch is classified as "no verdict" by matching its result content against the four literal failure strings (case-insensitive substring match — see grounding note above), never inferred from attempt number.
- Running `npm run factory:report` twice against unchanged state produces byte-identical JSON snapshots under `dashboard/backend/data/factory/_metrics/`.
- Every metric in the output snapshot carries the source path(s) it was computed from, so a human can verify it by hand.
- A metric that cannot be computed is emitted as `null` with a stated `reason` field, never as `0`; a test in the factory suite proves a missing/malformed input surfaces as `null` and not zero.
- The CLI exits non-zero if any metric in the produced snapshot is `null`.
- SQLite databases are opened read-only; the CLI writes only its own snapshot file under `_metrics/`; no other factory state file is modified.
- No change to `HQ_AUTO_RETRY`, no fixed-interval loop is added, and no new runtime dependency is introduced (reuses the existing `better-sqlite3` in `dashboard/backend`, or `node:sqlite` already used by `factory/lib/store/sqlite-state.mjs`).
- `npm run test:factory` passes, including new tests covering the null-not-zero behavior and the no-verdict classification logic.

## Edge cases (for architect/builder attention)
- An objective directory with no `.sqlite` file yet (never dispatched) — must surface as `null`/reason, not crash the whole run or report `0`.
- A task with dispatches but zero result files on disk (crashed before any write) — counts toward "no verdict," not silently dropped.
- A merged task with zero founder interruptions — must report `0` legitimately (a real count, not a missing input) — this is the one place `0` is correct; the null-not-zero rule is about *unavailable* data, not *genuinely-zero* data. Test coverage should distinguish these two.
- `state.events` truncation: a metric spanning an objective's full life must read the `events` table, not `state.events`, once the tail has been windowed (see grounding note).

## Non-goals
- No new UI, no scheduler/loop, no new dependency, no workflow-engine change, no export-format change to `objective-state.json`/`state.json`.

## Open strategic decisions
None. Every ambiguity found during inspection (source-table restriction, literal-string casing, script naming, sqlite driver choice, fixture strategy) was a reversible implementation detail resolvable from the existing codebase and is recorded above as a grounding note for the architect, not a founder decision.
