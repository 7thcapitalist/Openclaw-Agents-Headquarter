# Builder brief — RUN_RELIABILITY_2026

A self-contained brief for the session that implements this campaign. Everything
needed to start is here; `RUN_RELIABILITY_2026.md` holds the evidence behind each
finding, and `DC-2026-007` holds the one open founder decision.

- Authorization: founder direction, 2026-09-16 — *"identify all the problems, the
  lack of efficiencies … a detailed plan on how to get better at every step, to
  spend less time and tokens, to fail less"*
- Target: `main`, one short-lived branch/worktree and PR per item
- Review: the findings were authored by Claude. Claude must not be the sole
  reviewer of fixes derived from them
- Baseline to beat: two objectives, ~5.5 hours wall clock, 11 wasted recovery
  attempts, 3 wasted integration review rounds, 2 false founder escalations, and
  roughly a dozen hand-run repair scripts — on work that was correct throughout

## The one sentence

**The factory cannot distinguish work that failed from work that was
interrupted, and it charges time, tokens and founder attention to both.**

Every item below is a consequence of that, or a consequence of nobody owning a
run once its process exits.

## Where the waste actually went

Measured from the 2026-09-15/16 run, not estimated:

| Waste | Amount | Cause |
|---|---|---|
| Recovery attempts on a dead gateway | 11 | Finding 1 — transport charged as verdict |
| Integration review rounds on an unchanged tree | 3 full agent runs | Finding 5d — FAIL routed to a merge |
| Agent turns whose verdict was never read | at least 1 (25 min idle) | Finding 5b — no owner, no reader |
| Wall clock lost to stalls needing a human | ~2.5 h of ~5.5 h | Findings 4, 5, 5b |
| Hand-written repair scripts | ~6 | Finding 4 — no supported objective resume |
| False founder escalations | 2 | Findings 1 and 2 |

The pattern: **almost none of the waste was the agents doing bad work.** The
builders, reviewers, QA and security stages did their jobs — one review caught a
real dark-mode contrast regression, another caught two real integration seams.
The waste was in the machinery around them.

## Work items, in the order that pays

Each is a separate PR. Estimated sizes are for the change plus its tests.

### 1. Stop charging infrastructure failures to the recovery ladder — DONE, in review

Already implemented on this branch. Transport and verdict failures now count
separately at both budget gates and against separate ceilings, transport stays on
plain `retry-recover` instead of climbing the review ladder, and the blocker says
it was the environment rather than the branch.

**Verify, do not rebuild.** If review rejects the approach, the requirement
stands: an `INFRASTRUCTURE_ERROR` must not spend the budget that exists to bound
an agent looping on work it cannot fix.

### 2. Reset recovery budget on progress — small

`maxAttempts: 3` is per incident and `maxTotalAttempts: 9` per task, and attempts
never age out. A task that has since passed stages is not the task that failed
three times.

- Reset the per-incident counter when a stage passes, or age attempts out after a
  bounded window
- Acceptance: a task that fails twice, passes a stage, then fails again gets a
  full ladder for the new failure; `maxTotalAttempts` still bounds the task
- Guard: `recovery-incident-budget.test.mjs` already pins incident scoping — do
  not weaken it

### 3. Give objectives a first-class resume — medium, highest leverage on human time

This is what forced every hand-written script. The founder-facing repair paths
operate on **tasks**; objectives have none.

- `POST /api/founder/objectives/:id/resume` that calls `runObjective` for an
  existing objective, plus a console control
- Extend the self-heal: a node recorded `blocked`/`failed` whose task reached
  `merge-ready` becomes `gate-satisfied` — currently only an `active` task
  matches, so a node whose task *finished* deadlocks with no supported path
- Acceptance: both 2026-09-15 scenarios recover from the console with no script:
  (a) task retried, objective wrapper stale while the task runs; (b) task reached
  `merge-ready` while the wrapper still says `blocked`
- Note `runObjective` cannot revive a `running` node — `resumeObjectiveNodes`
  must run first. The reconciler already knows this; the endpoint must too

### 4. Ownership and liveness on a run — medium

"Running" is currently a label nobody maintains. Two objectives displayed
*Running* for over an hour with no process alive, and one displayed it for a week.

- Record pid/host/lease with a heartbeat on a dispatch and on an objective run,
  the way task leases already work
- Present a node whose owner is gone as **interrupted**, not running
- Acceptance: kill an orchestrator mid-dispatch; within one heartbeat the console
  shows interrupted, and the boot reconciler picks it up

### 5. Nobody reads a verdict whose reader died — medium, prevents silent loss

`runToTerminal` returns the moment a dispatch is `running`, but the agent session
lives in the **gateway**, not the caller. So the agent finishes, writes its
result, and no one ingests it. One reviewer verdict — a real FAIL with a blocking
finding — sat unread for 25 minutes; re-driving it took 20ms and no new agent
call.

- A sweep that ingests a result whose dispatch has no live owner (depends on 4)
- Acceptance: kill the driver mid-dispatch, let the agent finish, and the verdict
  is ingested without a human noticing

### 6. An integration FAIL must not route to a merge — small, stops an unbounded loop

An integration node's `builder` stage only re-merges the sub-task branches. A
reviewer FAIL routed there produces a byte-identical tree and the same failure,
forever. `obj-d4e18cad` did three rounds; the third review said *"byte-identical
to attempt 2, no builder fixes have landed since."*

- Route an integration reviewer FAIL to the originating sub-task nodes, or
  escalate as a founder decision
- Interim guard, cheap and worth having regardless: if a rework round reproduces
  the tree just rejected, stop and escalate instead of re-reviewing
- Acceptance: a failing integration escalates after one round, not three

### 7. Inbox and intake hygiene — small, independent, do together

- A cancelled objective's **tasks** still page the founder; inbox items come from
  the task scan and cancellation is recorded on the objective. Filter by the
  owning objective's status
- Obsolete work is indistinguishable from stranded work: the boot reconciler
  resumed two objectives for a **closed** issue. Check the linked issue, or treat
  an objective still at stage 1 after N days as abandoned
- Duplicate objectives are accepted silently: two were created 74 seconds apart
  for an identical request and both ran. Warn at intake

### 8. Machine-wide concurrency bound — medium

`FACTORY_MAX_CONCURRENT` bounds one orchestrator; nothing bounds orchestrators.
Two detached runs, each honouring a limit of 1, drove the gateway to 4.6G.
Out-of-process runs are routine (`factory-objective.mjs`,
`factory-improve-loop.mjs`, `objective-smoke.mjs`), and *"no lock spans them"*.

- A lease or semaphore around dispatch, or the gateway refusing sessions above a
  memory watermark
- PR #287 reduces the common case per-process and must not be mistaken for a
  guarantee

### 9. One session per worktree — small, protects review integrity

A reviewer recorded that it could not trust its working tree because an unrelated
session was mutating it, and reviewed committed git blobs instead. A review that
cannot trust what it reads is not an independent review.

- A lease refusing a second session in a worktree that already has one

### 10. Retire the duplicate data directory — small

`~/Openclaw-Agents-Headquarter/dashboard/backend/data/factory` still holds a full
copy that nothing reads. It already caused one incident: a node's absolute
`statePath` pointed into it, so resuming would have run the work where the
dashboard could not see it. Retire it, and prefer paths relative to the state
root over absolute ones in recorded state.

## How to spend fewer tokens and less time

Lessons from operating the factory for one night, several of them mistakes made
by the operating session rather than by the factory.

**Diagnose from state files, not from the dashboard.** The console derives
liveness from node evidence and will report *Running* for work that has no
process. `objective-state.json` plus the node's task `state.json` answer in two
reads what the UI cannot answer at all. The objective file's `node.stage` is
always `null` — stage lives in the task state.

**Never measure staleness from `updatedAt`.** Tasks heartbeat it while parked, so
a hung task looks fresh. Measure progress as `(currentStage, count(dispatches))`.

**Never put a continuously-changing value in a watch's change comparison.** Three
separate versions of this mistake — raw memory bytes, then coarse bands, then
bands again — turned a monitor into a per-tick notifier and buried real events.
Compare state; report metrics; alarm only on a sustained threshold.

**`MemoryCurrent` is not memory pressure.** The systemd cgroup figure includes
page cache and overstated the real RSS by ~1.3G. One "shed load" reaction was
taken on a transient peak that was already falling. Measure RSS of the process
tree, and treat only a sustained climb or an actual `NRestarts` increment as
actionable.

**Never run two orchestrators.** It is the fastest way to recreate the OOM.

**Verify a PR still carries work before treating it as a deliverable.** `#283`
was described as shipped for hours; it was closed on review as superseded, 6 of 8
files already on `main` byte-identical, and the residual delta was a regression
that had been deliberately reverted. `git diff origin/main...branch` takes
seconds and would have caught it immediately.

**Re-drive before re-running.** When a dispatch looks stuck, check for an
existing result file first. Ingesting one costs milliseconds; re-running the
stage costs a full agent turn. A completed review sat unread for 25 minutes and
cost nothing to recover.

**Keep the loop's carried context short.** A self-paced loop that re-states its
full history every tick pays for that history on every tick. Carry the operational
facts a future tick must not rediscover — paths, the one-orchestrator rule, the
repair procedure — and leave the narrative in the PR.

## How to know it worked

Re-run two objectives concurrently with the gateway under load and confirm:

1. A gateway restart mid-run costs **zero** verdict-budget attempts
2. No objective requires a hand-written script to recover
3. No objective displays *Running* for more than one heartbeat after its process
   dies
4. A failing integration escalates after one round, not three
5. No completed verdict sits unread for longer than one sweep interval
6. Cancelling an objective silences its tasks in the inbox immediately
