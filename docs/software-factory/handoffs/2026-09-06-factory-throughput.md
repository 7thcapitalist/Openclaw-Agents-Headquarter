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
