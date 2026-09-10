# Dependency diagnostics and wakeups

Inspired by Paperclip's `issue-dependency-wakeups` and issue-graph-liveness
services at pinned commit `6abeb67334348dcb6fde2d591a27ffc7efc7118d` (MIT). See
`factory/third-party/provenance.json`.

## The problem this solves

`runObjective` schedules ready nodes in-process and exits when nothing is
running and nothing is ready. When it exits with work still pending — a
delegate node left `running`, a subtree stranded behind a failed dependency —
**nothing re-enters the objective on its own**. The objective wrapper goes stale
while its individual nodes look fine, and dependent nodes never start. That
divergence is invisible until an operator goes looking.

## What was added

`factory/lib/objective/dependency-diagnostics.mjs` (the pure helpers, already
merged) is now connected to real runs by
`factory/lib/objective/graph-observer.mjs`, which `runObjective` calls once on
exit. It produces two things.

### 1. `graph-health.json`

Written next to `objective-state.json`. Findings:

| Code | Severity | Meaning |
| --- | --- | --- |
| `invalid-graph` | critical | A cycle or a dependency on a node that does not exist |
| `blocked-subtree` | high | A pending node behind a failed dependency, **plus every node transitively stranded behind it** |
| `stale-running` | high | A node marked `running` with no progress inside the staleness bound |
| `no-runnable-node` | medium | Nothing running, nothing runnable, and not complete |
| `objective-task-divergence` | high | A node's own task has moved on without it, **plus every node transitively stranded behind it** |

`objective-task-divergence` is the finding that pays for this file. The
objective wrapper and its nodes' task states are written by different paths:
`POST /api/founder/tasks/:id/retry` re-runs one task to terminal without
touching the objective. A node can therefore sit `blocked` while the task under
it is `merge-ready`, and its dependents stay `blocked-by-dep` permanently. Run
against live HQ state when this was written, the detector found **seven such
divergences across four objectives** — none of them visible anywhere before.

It reports, and deliberately does not repair. Rewriting objective state from
task state is a canonical mutation and belongs behind an explicit reviewed
action, not inside a projection that runs on every objective exit. A test
asserts that observation leaves `objective-state.json` byte-identical.

### 2. Durable dependency wakeups

One identifier-only request per node that became runnable during the run,
enqueued as a durable safety net.

In today's scheduler this set is usually empty, and that is correct rather than
dead: `runObjective` launches every ready node in-process, so a run normally
exits with nothing runnable left. The wakeup exists so that a run which *does*
exit with runnable work — a future out-of-process scheduler, a changed
concurrency bound, an unexpected early exit — cannot strand it silently. The
tests exercise the enqueue, the deduplication, and the retry identity directly.

Each request is
enqueued into the same durable queue `scripts/factory-wakeup.mjs` already
drains. The queue rejects anything carrying a `command` or `payload`, so a
wakeup can only ever say *which* work is ready — never what to do.

Identity is `dependency:<objectiveId>:<nodeId>:<attempt>:<hash of dependency
state>`. The hash keeps a fan-in node's key inside the queue's 200-character
bound, and the attempt counter means a genuine retry is wakeable again while a
repeat observation of the same run is deduplicated.

The node id is the wakeup's `taskRef`, which is exactly what
`defaultWakeupPaths()` resolves as `tasks/<taskRef>/state.json` — so a wakeup
enqueued here is directly actionable by the existing worker under an existing
task lease. No new execution path is introduced.

## Best-effort by construction

Observation runs **after** the objective's final status is computed and every
write is wrapped. An unwritable objective directory, a corrupt queue file, or an
invalid graph is reported in the returned `observation` and in `warnings`; none
of them can change a canonical outcome or fail a run. A read-only projection
must never be able to stop the factory.

## Operator surface

`GET /api/hq/operations` gains an `objectives` array and two summary counters,
`unhealthyObjectives` and `strandedNodes`. The Today panel lists only objectives
needing attention, with their finding codes and stranded-node count; a healthy
graph is not noise. Only codes and identifiers cross the boundary — never
prompts, paths, or agent output.

An objective that has not run since this landed has no `graph-health.json` and
is simply absent, which reads as unknown rather than as healthy.

## Operating it

- **Enable:** nothing to turn on. The next `runObjective` writes health and
  enqueues wakeups. Draining them is still the explicit, bounded
  `npm run factory:wakeup` — this change does not install a scheduler.
- **Health:** `unhealthyObjectives` and `deadLetters` on the Today panel;
  `warnings` in the operations snapshot name any unreadable source.
- **Recovery:** a dead-lettered dependency wakeup means the node's task state
  could not be run. The node is untouched and can still be resumed the normal
  way; the wakeup is a hint, never the authority.
- **Rollback:** revert this PR. `graph-health.json` files become stale data that
  nothing reads, queued dependency wakeups drain or expire harmlessly through
  the existing bounds, and `runObjective` returns to its previous behaviour.
  No canonical state written by this change needs undoing, because it writes
  none.

## Boundaries

A dependency event never creates a branch, starts a run, or merges anything. It
enqueues an identifier. Execution stays behind the wakeup worker, the task
lease, and `./run.sh`.
