# Ground truth — make HQ's account of itself match what is running

Three small, independent deliveries that close three places where Headquarters
reports something that is not so.

- Authorization: founder direction on 2026-09-15, after the control-plane
  recovery of the same day
- Campaign id: `FACTORY_GROUND_TRUTH_2026`
- Shared base: `722352f` (`origin/main`, "fix(dashboard): correct Today status presentation (#276)")
- Integration owner: Claude (architecture and independent review; Codex builds,
  per the cross-review matrix — Claude does not review code it authored)
- Target: `main`, one short-lived branch/worktree and PR per node
- Expiry: all three nodes merged, cancelled, or superseded by a founder decision
- Scope: `dashboard/backend/`, `factory/lib/`, and one new check. No change to
  agent prompts, routing, seats, or the founder-approval signature gate.

## Why a campaign, honestly

Unlike `FACTORY_GATE_INTEGRITY_2026`, these three are **not one mechanism seen
from three sides**. They are three unrelated defects that happen to share a
shape: in each one, HQ states something confidently and the statement is false.

- `main` says the work shipped; the machine is running something older.
- An objective says `active`; every node in it finished days ago.
- A worktree says it belongs to one agent; two are writing to it.

The campaign exists for sequencing and tracking, not because the nodes depend on
each other. All three are independent and can be built in parallel. If that
makes a campaign the wrong container, split it — nothing here needs the others.

## Where this started

On 2026-09-15 the control plane was recovered from a sequence of failures. Four
PRs were merged that afternoon. **None of them were running**, because the
runtime executes a checkout that nobody had pulled, and nothing anywhere said
so. The founder asked whether the issue was corrected; the honest answer was
"half of it", and the half that was missing was invisible from every screen.

That same day, two agent sessions sharing one working tree committed onto each
other's branches. One PR merged carrying two unrelated changes; another had to
be closed because its diff against `main` had become a revert of shipped code.

And `obj-c58897c0` has sat `active` since 2026-09-15T00:10Z with all of its
nodes `gate-satisfied` and its integration `skipped`. It is finished. The board
still counts it as live work.

## Ordered PR train

Issue numbers are assigned at filing; the node ids below are the durable
reference. Order is a preference, not a dependency.

| Order | Node | What it changes | Depends on | Risk |
| --- | --- | --- | --- | --- |
| 1 | `truth-1-runtime-drift` | HQ says when the running code is behind `main` | — | low |
| 2 | `truth-2-finished-is-not-active` | an objective whose work is done stops reporting `active` | — | low |
| 3 | `truth-3-worktree-isolation` | one dispatch, one worktree; a stage never shares a checkout | — | medium |

Node 3 is `gate-1-worktree-isolation` from `FACTORY_GATE_INTEGRITY_2026`,
carried here unchanged because it is the only node of that campaign that has
since reproduced in the HQ repo itself. **It is the same node, not a second
one** — whichever campaign builds it, the other drops it. It is listed here so
the founder has one list, not two.

### Node 1 — `truth-1-runtime-drift`

The runtime checkout (`/home/joao-vitor/hq-runtime`, see `DEPLOY.md`) is pinned
to `main` and updated by an explicit deploy. Nothing reports when it has fallen
behind, so "merged" and "running" drift apart silently. On 2026-09-15 they
drifted by six commits in four hours, across four merged PRs, and the only way
to find out was to read `git log` in two places by hand.

Report the drift where the founder already looks. The readiness panel is the
natural home: it already answers "is pm2 up, is openclaw healthy".

Notes for the builder:

- The runtime checkout and the agent checkout are different directories. The
  thing to measure is the revision the **running process** was started from,
  not the repo the dashboard's source happens to sit in. `AGENT_LAB_ROOT` is
  the honest anchor — it is what `server.mjs` already uses for `ROOT`.
- This must not perform a network fetch on every request. A comparison against
  the last-fetched `origin/main` is enough; say when the comparison was made.
  `buildReadinessReport` is cached for 30s and costs ~2.1s uncached — do not
  make it worse.
- Behind is not an error. A founder mid-deploy is not a broken system: report
  the number and the age, and let the reader decide.

Acceptance: a runtime whose HEAD is behind the last-known `origin/main` reports
how many commits and how old the oldest unshipped one is; a runtime level with
`main` says so; a checkout with no upstream, no git, or a detached HEAD degrades
to "unknown" rather than throwing or claiming green. A test covers all four.

### Node 2 — `truth-2-finished-is-not-active`

`obj-c58897c0` has every node `gate-satisfied` and its integration `skipped`,
and its status is `active`. `runObjective` re-asserts `status = "active"` on
entry and only writes `complete` when the integration node reaches
`GATE_SATISFIED` (orchestrator.mjs) — so an objective whose integration was
skipped or superseded never reaches a terminal state, and the founder's board
counts finished work as live forever.

This is the objective-level half of the known open loop: nothing writes
`merged`, so finished work shows as pending. Fix the objective wrapper only.

Notes for the builder:

- `skipped` and `superseded` are real integration outcomes, not errors.
  `obj-c58897c0`'s integration was superseded because the work landed on the
  product repo's `main` through PR #6 — that is a success, recorded as such in
  its event log.
- Do not make this a sweep that mutates on a timer. The transition belongs where
  the objective's state is already being written.
- A cancelled objective stays cancelled. Never resurrect one to complete it.

Acceptance: an objective whose build nodes are all `gate-satisfied` and whose
integration is `gate-satisfied`, `skipped` or `superseded` reports a terminal
status and stops appearing as live work; an objective with any node not yet
finished is untouched; a cancelled objective is untouched; `obj-c58897c0`
specifically is the regression fixture.

### Node 3 — `truth-3-worktree-isolation`

Carried from `FACTORY_GATE_INTEGRITY_2026` node 1, unchanged in substance.

`factory/lib/leases/task-lease.mjs` models a lease, but stage dispatches for one
task all resolve to the same worktree path and nothing stops two from running in
it. Give each dispatch an isolated checkout of the commit it was asked to judge,
or hold an exclusive lease for the duration.

What is new since that campaign was written is that this stopped being a
product-repo problem. On 2026-09-15 it happened in the HQ repo, between two
agent sessions, and cost a mixed PR and a closed one. Security had already been
working around it by hand — it re-verified in *"a fresh isolated worktree (pnpm
install + full affected test suites)"*. That workaround should be the platform's
job.

Acceptance: two concurrent dispatches on one task cannot observe each other's
uncommitted files; a test proves it with two simultaneous stages.

## Non-goals

- No new dashboard panels. Node 1 adds a line to a panel that exists.
- No automated deploy, and no process that pulls or restarts anything on its
  own. Node 1 **reports** drift; closing it stays a human act, per `DEPLOY.md`.
- No change to `HQ_AUTO_RETRY`, which stays at `0`. Nothing here flips it.
- No auto-merge, and no widening of what a stage may do without review.
- Node 2 does not touch task state, only the objective wrapper. The task-level
  open loop (nothing writes `merged`) is a separate problem with its own
  reconciler already running.

## Constraints on every node

- separate branch and worktree from `722352f`; no shared branch, no integration
  branch, no stacked PR target
- PR body declares campaign id, dependencies, merge position, verification and
  rollback
- immediately before merge: refresh from latest `main`, resolve, rerun checks,
  preserve independent review and QA evidence. **An earlier green result is
  stale once a predecessor merges** — on 2026-09-15 a PR whose check predated
  the previous merge had become a revert of shipped code by the time anyone
  looked
- Claude does not review code Claude authored; Codex builds, Claude reviews
- every node ships a test that fails against `722352f`

## Rollback

Each node is independently revertible and none changes a stored state format.

1. `git revert` the node's commit — HQ returns to current behaviour
2. no data migration is required in either direction
3. running objectives are unaffected by nodes 1 and 2; node 3 changes where a
   dispatch checks out, which is read fresh per dispatch
