# No-progress re-wake throttle

Adapted from Paperclip's `issue-rewake-throttle` service (PAP-13775) at pinned
commit `6abeb67334348dcb6fde2d591a27ffc7efc7118d` under MIT. See
`factory/third-party/provenance.json`. Issue #157.

## The problem

`decideLivenessContinuation` already bounds continuations **within** one run, at
two attempts. It resets when a new run starts.

So any external driver — a dependency wakeup, an assignment sweep, a schedule —
can wake the same task again, get another two continuations, and repeat, for as
long as the task stays active. Every one of those wakes pays a full agent
session. If the run changes nothing, the factory has bought nothing.

Upstream measured **25 sessions and 2.4× cost for a single recovery** this way.
On this factory's live state when this was written, one task had **eight
dispatches since its last canonical stage pass**, and two tasks accounted for
**eleven runs that moved nothing**.

## What counts as progress

Deliberately narrow. Progress is a stage that **passed**, a stage that
**failed**, a stage that **asked for a decision**, a task reaching
**merge-ready**, a recorded **founder approval**, or a **verified recovery**.

An agent starting, running and finishing without moving canonical state is
exactly the case this exists to catch, so `dispatch-ready`, `dispatch-running`,
`handoff-ready` and `completion-report` are **not** progress. Neither is a
dispatch that has not finished — a run still in flight has not failed to produce
anything yet.

A settled task is never stalling, whatever its dispatch history looks like.

## Modes

| Mode | Trigger | Behaviour |
| --- | --- | --- |
| `off` | no `factory/rewake-throttle.json` | Every wake proceeds; the factory behaves exactly as before |
| `report` | the file exists (**default**) | Verdicts computed, recorded and surfaced — **no wake is ever held back** |
| `enforce` | `"mode": "enforce"` | A wake inside the cooldown is deferred |

A threshold tuned against no data is how a control ends up blocking legitimate
work on its first day, so `report` is the default and enforcement is a
deliberate second step.

## What is never throttled

`manual` — the founder asking directly. `recovery` — the factory's own crash
recovery, which must stay immediate or a process loss turns into a stall.

**`mention` is deliberately not exempt.** A wakeup carries identifiers and
nothing else by design, so HQ cannot tell a founder's mention from an
agent-authored one at the wakeup layer. Throttling a founder's mention merely
delays it; exempting an agent's would let a cross-task write borrow the
founder's wake privileges. Delay is the safe direction.

## The cooldown

At the threshold, the base cooldown (10 minutes by default). Each further
fruitless run **doubles** it, to a **four-hour ceiling** — so a task that keeps
producing nothing backs off quickly without ever going silent for a working day.

Fresh canonical progress clears the streak and ends the cooldown immediately.

## A deferral is not a failure

When `enforce` holds a wake back, the wakeup is **returned to the queue** with a
later `notBefore` and its attempt counter **given back**. Nothing is lost, no
retry is consumed, and the item never drifts toward a dead letter. `deferWakeup`
exists precisely so this is not expressed as `finishWakeup(..., "failed")`.

## Failure is always "let the work through"

Consulting the throttle can never stop a wake by breaking. An unreadable config,
an unparsable task state, a bug in the analysis — every one resolves to
**allowed**, with the reason recorded. The cost of a wrongly-held wake is a
stalled task; the cost of a wrongly-allowed one is a single agent session.

## Operator surface

`GET /api/hq/operations` gains a `rewake` section and two summary counters,
`stallingTasks` and `wastedRuns`. The Today panel lists only tasks at or over
the threshold, with the streak, what last moved them, and the governing mode —
and says plainly when `report` means nothing is being held back.

## Operating it

1. **Observe.** `cp factory/rewake-throttle.example.json factory/rewake-throttle.json`
   and merge. Mode is `report`; nothing is held back. Watch `wastedRuns`.
2. **Tune.** If the threshold would have caught work you wanted to run, raise it.
3. **Enforce.** Set `"mode": "enforce"`.
4. **Roll back.** Set `"mode": "report"`, or delete the file to return to `off`.
   Both are one-line reversals. Any wake already deferred simply becomes due.

## Rollback

Revert the PR. `deferWakeup` and the config disappear; the worker returns to
claiming and running every wakeup. No canonical state is written by any of this.
