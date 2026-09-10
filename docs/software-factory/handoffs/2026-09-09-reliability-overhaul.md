# Reliability overhaul — 2026-09-09 overnight

Founder brief: *"Regular prompts are failing silently and I never get what happens."*
Preferences taken as decided: keep both seats working together; the founder merges
every PR by hand; credit exhaustion should pause and resume rather than fail.

## The short version

The founder's report was correct, and the cause turned out to run one layer
deeper than the symptom. Three independent silences were stacked on top of each
other:

1. **A failed request left no trace in any founder-facing view.** The detached
   job paths recorded a raw error string, and the Founder Inbox never read
   `control.jobs` at all.
2. **`npm run test:factory` had not terminated since #56.** A `for (;;)` loop
   waited for an event that a merged PR had renamed. Because it *hung* instead of
   *failing*, the suite produced no result — so every "tests pass" claim since
   then, including the release gate's `279/279` on obj-c7b263bb, reported
   something no one could have observed.
3. **Infrastructure failures were being reported to the founder as decisions,
   and could not be resumed by the system.** Both because recovery (#56) changed
   the blocker shape and no caller was updated.

Fixing (2) is what made (3) visible. The suite is now green for the first time
since #56: **483 tests, 480 pass, 0 fail, 3 skipped, 47s.**

One thing the founder believed to be broken is in fact working — see
"Both seats are already working together" below.

## What shipped

Merge in this order. Each is a standalone PR.

| PR | What | Status |
| --- | --- | --- |
| #75 | The typed terminal failure-outcome contract | merged |
| #76 | Surface detached founder jobs that fail before producing state | merged |
| #109 | Repair stale founder-UI assertions that merged red | open |
| #111 | Make the suite terminate; restore infra classification | open |
| (this) | Doctor reports real seat spread; this handoff | open |

### #75 + #76 — the founder's actual complaint

`POST /api/founder/tasks` and `/api/founder/objectives` answer `202` and finish
the work in a detached promise. A rejection was stored as
`{ status: "error", error: "<raw string>" }`, and `buildFounderInbox()` projects
tasks, objectives, decisions and questions — never `control.jobs`. A run that
died before a state file existed (an intake throw, a decomposition throw on an
exhausted seat) was therefore invisible everywhere.

Now every settlement produces one typed record — `outcomeClass`, a plain-language
`headline`, `whatFailed`, `whatTheFactoryTried`, `resumeAfter`, `evidencePaths` —
derived from the existing taxonomies, never a raw string. Founder-facing outcomes
become Inbox rows; `paused-credits` and `infra-retrying` go to `autoRecovering`
with their resume time instead, so infrastructure never pages the founder. The
dispatched prompt is stripped from the detail (it used to be ~2KB of prompt with
the cause at the end).

`factory/test/failure-visibility.test.mjs` drives the real intake and
decomposition entry points with a stub executor forced into a rate limit,
invalid JSON, and a git failure, and asserts each reaches the right destination.

### #111 — the suite, and what it hid

Every loop in the integration tests is now bounded and throws with the observed
status sequence. **A contract change must make a test red, never make it hang.**

With the suite terminating, 11 further failures appeared. Two were real defects:

- **Infrastructure reached the founder as a decision.** `orchestrator.mjs` only
  tagged a blocker `infra: true` when `outcome === "fail"`; recovery escalates
  with `outcome: "decision-required"`, so the tag was never applied and
  `classifyObjectiveNodeBlocker()` fell through to `"decision"`.
- **Infra-blocked work could not be resumed.** The resume gate asked
  `classifyBlocker(...) !== "infra"` — that answers *who owns this now*, not *is
  this safe to retry*. A recovery-escalated blocker answers `"decision"`, so the
  sweep skipped exactly the work it exists to revive. A rate-limited seat could
  never come back on its own. New `isRetriableInfraBlocker()` answers the second
  question, judging the original error recovery preserves in `why` rather than
  its `"Recovery could not continue after N attempts"` wrapper.

Supporting fix: the three infra vocabularies disagreed.
`failure-classification.mjs` did not recognise `could not start the CLI`,
`all models failed`, `usage limit` or `cooldown`, which `blocker-class.mjs` and
the orchestrator both do — so the same failure was infrastructure to one layer
and the project's fault to another. Verified not to over-match: *"builder could
not implement A"* and *"QA: 3 tests fail"* still classify `PROJECT_ERROR`.

## Both seats are already working together

`factory-doctor` has been reporting, for months:

> acpx has no command mapping for: claude, codex — `runtime.acp.agent:"claude"`
> has nothing to spawn and silently falls back to OpenAI.

**This is a false alarm.** Probed directly:

```
openclaw agent --agent reviewer         -> provider claude-cli, model claude-sonnet-5
openclaw agent --agent backend-builder  -> provider openai,     model gpt-5.6-sol
```

Claude is served by the `claude-cli` runtime, not by acpx, so its absence from
the acpx map means nothing. The seats are split today: **anthropic 6 roles,
openai 4, github-copilot 2.** The doctor now reports that spread instead, and
warns only when everything collapses onto one seat.

Two consequences worth knowing: the ACP section of `REVIEW_MODEL_ROUTING.md`
states a root cause that is no longer true, and **DC-2026-001 partly rests on
this false premise** — the "no independence / one-seat ceiling" argument is
weaker than it appears. The decision card is still worth answering on throughput
grounds, but not on the grounds that Claude is unreachable.

`openclaw models` does still report `anthropic/claude-sonnet-5` auth readiness as
`[indeterminate]` because it is a synthetic `claude-cli` profile rather than an
OpenClaw OAuth profile. Readiness is unconfirmable by inspection but confirmed by
probe. **No interactive login is required.**

## Regressions — RESOLVED 2026-09-10

> **Update.** All three regressions below shared one root cause: since #56
> recovery sat in front of every `fail` outcome, so `routeStageFailure()` was
> unreachable. Restoring routing ahead of recovery for the stages that have
> somewhere to route *to* fixed all three at once, and all three tests are
> un-skipped and passing. The suite is **549 tests, 549 pass, 0 skipped**.
>
> The escalation ladder is now: the review loop routes a FAIL back to the
> builder (up to the per-stage budget) → recovery diagnoses and repairs → the
> founder is asked. Recovery is the second line, not the first.
>
> The original analysis is kept below as the record of how each was found.

## Regressions found and deliberately NOT fixed (original analysis)

Three tests assert behaviour the factory was designed around and no longer has.
Rewriting them to match today would bless the defect, so each is **skipped with a
reason** naming this document. They are visible in every test run as skips.

### 1. A review/QA verdict no longer returns work to the builder — *highest impact* — **FIXED**

Since #56 recovery sits in front of **every** `fail` outcome, so
`routeStageFailure()` is never reached. An ordinary *"reviewer found a bug"* —
the most routine event in a code factory — is handed to a recovery agent that
diagnoses it as an environment problem, burns the full three-attempt budget, and
then escalates to **the founder**.

This is very likely a large share of the "factory fails too much" experience.

**Recommended fix.** The distinction already exists in the data. An agent that
*returned* a `fail` verdict has judged the code; an agent that produced no
verdict at all (missing result, crash, infra) is an environment problem. In
`openclaw-protocol.mjs` `ingestResult()`, route an explicit stage FAIL through
`routeStageFailure()` and reserve `startRecovery()` for the no-verdict path. The
two skipped tests in `openclaw-runner-concurrent.test.mjs` become the acceptance
criteria.

### 2. A release conflict dead-ends instead of rebasing — **FIXED**

*Resolved by the same routing change: `routeStageFailure` already detected a
release conflict and targeted the builder; it was simply never reached.*

`overnight-followthrough.test.mjs` asserts that a release conflict re-runs the
builder and every downstream gate before publication. Today `release` is simply
re-dispatched three times and the node dies.

**This is exactly what stranded obj-c7b263bb**: two nodes passed all six gates
with independent evidence, PR #36 fell behind `main`, release returned NOT MERGE
READY three times, and nothing was assigned to rebase. Finished, reviewed work
sat unmergeable.

**Recommended fix.** On a release-reported conflict, dispatch rebase onto
`origin/main` → re-run `npm run test:factory` → re-request reviewer/QA approval of
the merged tree → release re-evaluates. Bounded attempts, no gate bypass. A clean
rebase must not require the founder; only a real semantic conflict should.

### 3. `maxAttemptsPerStage` no longer means what it says — **FIXED**

*The config key is honoured again: a routable stage gets its configured
attempts before recovery engages. The value is also now forwarded to
`recordRecoveryResult`, which previously ignored it.*

Recovery intercepts on the **first** stage failure, so a stage gets one attempt,
not the configured three; the recovery budget then applies. Documented in
`openclaw-runner-missing-result.test.mjs`. Not changed — decide whether the
config key should be honoured or retired.

## What was NOT done

Phases 3–6 of the brief were not built. Ranked by value:

1. **Pause/resume on credit exhaustion (Phase 3).** Partly unblocked —
   `isRetriableInfraBlocker()` means the sweep will now pick this work up, and
   the outcome contract already carries `resumeAfter`. Still missing: the
   `paused` state itself, a headroom pre-check before dispatch and decomposition
   so an exhausted seat consumes no attempt, and `scripts/factory-resume.mjs`
   plus a timer. **This is the founder's explicit ask and the top remaining
   build.**
2. **Release-conflict rebase recovery (regression 2 above).**
3. **Builder routing for review verdicts (regression 1 above).**
4. **CI (Phase 4c).** Now finally worth adding — the suite terminates in 47s and
   is green, so `.github/workflows` running `npm ci && npm run test:factory` on
   PRs would give the release gate something real to cite instead of a
   hand-rolled claim. Until then nothing prevents another red merge.
5. **Learning loop (Phase 5)** — `learning.injectIntoHandoff` is still `false`
   and `LESSONS_LEARNED.md` is still empty.
6. **Skills extraction (Phase 8)** — not started.

## Founder actions

- **Merge #109 and #111 together.** Either alone leaves the suite red.
- **Answer DC-2026-001**, on throughput grounds — its independence premise was
  false (see above). Both seats work; the question is only whether one OpenAI
  seat is enough headroom.
- **Decide regression 1**: should a reviewer/QA FAIL go back to the builder
  (recommended) or continue to escalate to you?
- **Run `npm run factory:prune-sessions -- --apply`** — 384 sessions, 278 stale.
- No interactive login is needed. Nothing is blocked on credentials.

## Environment notes

- Three concurrent `claude --resume` sessions share this checkout. During this
  work another session's in-flight edits to `handoff.mjs`,
  `openclaw-protocol.mjs`, `openclaw-runner.mjs` and a new
  `dispatch-identity.test.mjs` appeared in the working tree. They were preserved,
  left untouched, and excluded from every commit here. Their change fixes an
  agent self-reporting `backend-builder` instead of `codex` and having a green
  result rejected — worth landing.
- ~40 stale worktrees and branches remain from earlier runs, against the
  main-only policy in `GIT_WORKFLOW.md`. Cleanup is safe but was left alone.
- All work here was done in an isolated worktree to avoid colliding with those
  sessions.
