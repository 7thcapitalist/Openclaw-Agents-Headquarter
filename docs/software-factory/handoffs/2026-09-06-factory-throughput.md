# Handoff — factory throughput & independence

Branch: `factory/throughput-and-independence` · Date: 2026-09-06

## What changed

### Concurrent review phase (in-repo, tested)
- `factory/lib/openclaw-runner.mjs`: new `runConcurrentGroupIfReady()`, called
  from `runToTerminal`. When a task is parked at the head of a concurrent group
  (default `["reviewer","qa","security"]`) with the rest pending, all three
  `openclaw agent` calls fire at once against the frozen post-builder branch;
  results are then fed back through the **unchanged** engine one stage at a time.
  A member failure routes to builder exactly as before; speculative siblings are
  discarded. Fully sequential fallback whenever the fan-out does not apply.
- `factory/lib/openclaw-protocol.mjs`: extracted `computeDispatchPaths()` so the
  fan-out and `prepareDispatch` derive identical dispatch ids / result paths.
- `factory/lib/handoff.mjs`: `writeHandoff` takes an optional `stage` override
  (2 lines) so a group member's handoff can be written before it is
  `currentStage`.
- `factory/factory.config.json`: `openclawIntegration.concurrentGroups`
  (`[["reviewer","qa","security"]]`; set `[]` to force sequential).
- The workflow state machine, its gates, and all pre-existing tests are untouched.

### Second model for the review side (script — run against live config)
- `scripts/apply-review-model-routing.mjs` / `revert-review-model-routing.mjs`:
  re-route `architect`/`reviewer`/`qa`/`security` in `~/.openclaw/openclaw.json`
  to `github-copilot/gpt-4.1` primary + `openai/gpt-5.4-mini` fallback. Backs up
  to `~/.openclaw/openclaw.json.before-review-routing`; idempotent; `--dry-run`.
  **Not applied** — founder runs it, then `openclaw daemon restart`.
- `docs/software-factory/REVIEW_MODEL_ROUTING.md` explains why / how / caveats.
- Restores builder≠reviewer independence and moves design+review load off the
  single OpenAI seat.

### Concurrent independent tasks (in-repo, tested)
- `scripts/factory-run-many.mjs`: run N independent factory tasks with a
  `--concurrency` cap. No engine change — each task already has its own state,
  worktree and `factory/<id>` branch.

### Session hygiene (script — run against live runtime)
- `scripts/prune-factory-sessions.mjs`: deletes transient factory-dispatch /
  probe sessions older than `--max-age-hours` (default 24) and runs
  `openclaw sessions cleanup`. Dry-run by default; `--apply` to act. Never touches
  `agent:main:main`. Dry-run identified 22 stale sessions (factory tasks from
  ~3 days ago). **Not applied.**

### Dashboard honesty
- `factory/agents.json`: removed the hardcoded `"status":"idle"` from every entry
  (runtime state, not registry data — the "Today" view already overlays live
  status via `buildAgentActivity`).

### Decision Card
- `docs/software-factory/decision-cards/DC-2026-001-model-seat-capacity.md`:
  second OpenAI seat / plan upgrade vs. staying on the no-spend mitigation.
  Recommends the no-spend path now.

### package.json
- `factory:run-many`, `factory:prune-sessions`, `factory:route-review`.

## Verification performed

| Check | Result |
|---|---|
| `npm run test:factory` | **206 / 206 pass** (200 baseline + `openclaw-runner-concurrent.test.mjs` (4) + `factory-run-many.test.mjs` (2)). |
| `npm run factory:smoke:github` (hermetic: real engine, real git, real fan-out path, mock agents) | **pass** — reaches `merge-ready`, branch committed + pushed, remote `main` untouched. |
| concurrent test | asserts the three review `execute` calls' wall-clock windows overlap; engine still emits `stage-pass` per stage and reaches `merge-ready`; a failing member routes to builder and the retry re-runs the group. |
| run-many test | two independent local pipelines reach `merge-ready` with overlapping execution windows; `runPool` honours the concurrency cap. |
| `scripts/apply-review-model-routing.mjs --dry-run` | prints the intended 4-agent diff; wrote nothing (config md5 unchanged, no backup created). |
| `scripts/prune-factory-sessions.mjs` (dry-run) | listed 22 prunable sessions; `agent:main:main` excluded. |
| `npm run factory:smoke` (real 7-agent) | **BLOCKED at stage `product`**: `openai/gpt-5.4-mini: Provider openai is in cooldown (rate_limit)`. `openclaw models`: seat `grazicmm@hotmail.com` **5h window 0% left, cooldown 3h**. This is finding #2 live, not a regression — the run never reached the fan-out. Re-run after the cooldown, ideally after applying the review-model routing script. |

## Unresolved risks

- **Copilot auth** `github-copilot/gpt-4.1` shows `[indeterminate]` in
  `openclaw models`. Works today for `main`/`research`/`learning`; the
  `openai/gpt-5.4-mini` fallback covers a miss, but if the OpenAI seat is also in
  cooldown that fallback is dead too.
- **`product` / `release` have bare-string OpenAI models with no fallback** — the
  pipeline cannot even start during an OpenAI cooldown (exactly what blocked the
  smoke). Not in this task's scope; see "recommended next".
- **Fan-out assumes reviewers never write** to the worktree (`writeAccess:false`
  in `factory.config.json`). If that ever changes, concurrent review members
  could race on the tree.
- The `openclaw.json` routing and the session prune are **out-of-repo, manual**
  steps — they are scripts, not applied.
- Real end-to-end (real agents + real fan-out timing) is unverified pending the
  OpenAI cooldown.

## Recommended next

1. Founder: apply `scripts/apply-review-model-routing.mjs` + `openclaw daemon
   restart`, then re-run `npm run factory:smoke` once the OpenAI cooldown clears
   — this both unblocks the smoke and gives the first real fan-out timing.
2. Extend the routing script (or a sibling) to give `product` and `release` a
   `github-copilot/gpt-4.1` fallback so the pipeline survives an OpenAI cooldown.
3. Spike: wire `runtime.acp.agent:"claude"` to the installed Claude Code CLI so
   the review agents run on the Claude subscription instead of Copilot.
4. Onboard LifeMax as a real `factory/<id>` task (it has never run through the
   engine — no `state.json` under `dashboard/backend/data/factory/`).
5. Engine phase-group refactor for general multi-stage DAG parallelism (the
   runner-level fan-out only covers the one review group).
6. Add a `cron` for `prune-factory-sessions.mjs --apply`; wire the legacy
   `/api/hq` seed views to `buildAgentActivity`.
7. Decide DC-2026-001 (paid model capacity).

## Reviewer

Not self-reviewed for merge. Needs an independent pass on
`runConcurrentGroupIfReady` (result-file / attempt-number interplay with
`prepareDispatch`, failure routing, orphan cleanup) before merge to `main`.

---

# Round 2 (same branch / PR)

## Applied live to `~/.openclaw/openclaw.json` (backed up + reversible)

- `scripts/apply-review-model-routing.mjs` **run**. Backup:
  `~/.openclaw/openclaw.json.before-review-routing`. Daemon restarted.
  - `architect`/`reviewer`/`qa`/`security`: primary `github-copilot/gpt-4.1`,
    fallback `openai/gpt-5.4-mini`.
  - `product`/`release`: primary `openai/gpt-5.4-mini` (unchanged), fallback
    `github-copilot/gpt-4.1` — so the pipeline can start/finish during an OpenAI
    cooldown (`product` had no fallback before).
  - Verified: `openclaw agent --agent reviewer -m PROBE_OK` → session shows
    `model gpt-4.1 / provider github-copilot / runtime openclaw` (was
    `gpt-5.6-sol / openai / codex`). `product` probe succeeded.
  - Revert: `node scripts/revert-review-model-routing.mjs && openclaw daemon restart`.
- `scripts/prune-factory-sessions.mjs --apply` **run** — deleted 22 stale
  factory/probe sessions (86 → ~70). `agent:main:main` untouched.

## Repo changes (this commit)

- `scripts/apply-review-model-routing.mjs` — now also gives `product`/`release`
  a Copilot fallback (table-driven).
- `scripts/factory-doctor.mjs` (new) + `npm run factory:doctor` — read-only
  health check: OpenAI quota/cooldown, Copilot readiness, session bloat, the
  `acpx.config.agents` gap, whether any task has run through the engine, gateway.
  Live output right now: **✗ OpenAI seat in cooldown (5h 0% left), ! Copilot
  [indeterminate], ! acpx has no claude/codex mapping** — everything else ✓.
- `scripts/prune-factory-sessions.mjs` — `cleanup` is now per-agent (the global
  form errored on a multi-agent install).
- `scripts/factory-run-many.mjs` — `--state-root` / `runMany({stateRoot})` so a
  run does not write factory state into the HQ repo's own data dir.
- `dashboard/backend/lib/hqStore.mjs` — `readHqState` now surfaces the real
  `factory/agents.json` roster + live status for `/api/hq` and
  `/api/hq/command-center` instead of the empty seed collection (guarded
  fallback).
- `factory/intake/lifemaxing-health-endpoint.json` — a validated, low-risk task
  contract for the first real LifeMax end-to-end run. **Not executed.** Kick off
  with:
  `node scripts/factory-task.mjs init --contract factory/intake/lifemaxing-health-endpoint.json --repo ~/projects/lifemaxing`
  then `node scripts/openclaw-factory.mjs` (or `factory:openclaw` run).
- `docs/software-factory/REVIEW_MODEL_ROUTING.md` — product/release table + an
  "ACP / acpx root cause" section (the `acpx.config.agents` gap; `claude` has no
  ACP mode).
- `DC-2026-001` — added **Option A2** (review agents on the Claude subscription).

## Verification

- `npm run test:factory` — **215 / 215** (9 new: `factory-doctor.test.mjs` x7,
  `hq-store-live-agents.test.mjs` x2).
- `npm run factory:smoke:github` — hermetic pipeline still `merge-ready`.
- Live probes above (reviewer → gpt-4.1, product → starts).
- `npm run factory:doctor` — runs, exits 1 while OpenAI is in cooldown.

## Still not done (blocked / founder-only)

- **Review agents on the Claude subscription** — DC-2026-001 Option A2.
- **First real LifeMax factory run** — contract is ready (`factory/intake/…`);
  run it once the OpenAI cooldown clears (or rely on the Copilot fallback).
- **Engine phase-group / DAG parallelism** — deferred by decision.
- **Prune cron** — `openclaw cron add` with `node scripts/prune-factory-sessions.mjs --apply`; not automated here.
- **Real 7-agent `npm run factory:smoke`** — still blocked by the OpenAI cooldown
  at the time of writing; re-run when it clears.
