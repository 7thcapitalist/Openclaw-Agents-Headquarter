# Gate integrity — make a verdict mean what it says

Delivery campaign for the failure analysis of objective `obj-d4e18cad`
(project `lifemaxing`, 2026-09-15), which blocked after 17 dispatches with
every piece of its work green.

- Authorization: founder direction on 2026-09-15, following the watcher report
  on `obj-d4e18cad`
- Campaign id: `FACTORY_GATE_INTEGRITY_2026`
- Shared base: `51ab2ba` (`origin/main`, "fix(console): a panel with data is never rendered as absent (#256)")
- Integration owner: Claude (architecture and independent review; Codex builds,
  per the cross-review matrix — Claude does not review code it authored)
- Target: `main`, one short-lived branch/worktree and PR per node
- Expiry: all six nodes merged, cancelled, or superseded by a founder decision
- Scope: `factory/lib/` only. No change to agent prompts, routing, seats, or the
  founder-approval signature gate.

## Why a campaign

The six nodes are one mechanism seen from six sides. A stage cannot be held to
its own evidence until stages stop sharing a worktree; evidence cannot be
re-verified until something knows the tree moved; and none of it matters while a
stage can spend another stage's retry budget. SFD-2026-010 exists for this
shape: PRs prepared from one recorded base, merged in a declared order, each on
its own branch, each still independently reviewed.

## Where this started

`obj-d4e18cad` gave the LifeMax app a streak and a bounded arc. The domain node
ran for 70 minutes, produced four commits, and ended `blocked` with this in its
task state:

> Recovery attempt 1 was independently verified, but builder has returned 3
> verdict(s) of 3 allowed. Re-running it would exceed that budget. Founder
> direction is required: accept the verified work and advance, raise the budget,
> or change scope.

The work was not the problem. At the final commit `57b5b7f`, recovery recorded
*"full pnpm verify passed formatting, lint, typecheck, 43 unit/component tests,
63 integration tests, 5 architecture tests, and the production build."*

The gates were not the problem either. The verdict tally across all 17
dispatches:

| Stage | Runs | Verdicts |
| --- | --- | --- |
| reviewer | 2 | pass, pass |
| security | 1 | pass |
| qa | 2 | pass, fail |
| builder | 4 | fail, pass, pass, fail |
| release | 2 | fail, fail |

Reviewer and security never failed. QA failed once, correctly. Reviewer caught a
real blocker that security had waved through, and release caught a stale-evidence
condition on its own. **The gates did their job and the accounting around them
did not.** Two of the builder's three fatal verdicts were charged for other
stages' problems, and that budget is what stopped the objective.

## The chain, as it actually ran

1. **Stages shared one worktree.** Security's own note: *"the assigned worktree
   was found concurrently modified by other in-flight factory dispatches during
   review (multiple claude processes sharing the same worktree path), which
   produced one transient false test failure in-place."*
2. **Real work was mistaken for contamination.** Security stashed the
   concurrent changes and reviewed `7563a4f`. The stash held the actual fix for
   the `offerNextArc` reread bug plus two adjacent bugs.
3. **The tree moved after review.** The stash was committed as `766a649`.
4. **Release refused, correctly:** *"the worktree has moved to 766a649796 since
   the reviewed commit 7563a4f517. Review, QA and security evidence describes a
   tree that no longer exists; re-run them against the current commit."*
5. **The factory re-dispatched the builder** — which cannot refresh review
   evidence. A builder verdict was spent on a problem no builder can solve.
6. **A missing log killed another builder dispatch:** *"Evidence does not exist:
   evidence/qa-test-output.log"*. That file is QA's to write. The `evidence/`
   directory holds 13 files; four were written by builder-3 and not one is a
   `qa-*` artifact from either QA run.
7. **Budget exhausted, objective parked**, with node 2
   (`ui-design-language-and-arc-views`) `blocked-by-dep` and never started.

Two aggravating conditions, both previously known: the recovery budget is
cumulative, so an earlier recovery for an unrelated pre-existing Prettier defect
on `main` counted against this incident; and the first builder failure was that
same pre-existing defect — *"the exact pnpm verify acceptance gate remains red
solely because unchanged baseline file docs/DESIGN_LANGUAGE.md fails Prettier"* —
a condition that existed at `ec6345b` before the objective was launched.

## Ordered PR train

Issue numbers are assigned at filing; the node ids below are the durable
reference.

| Order | Node | What it changes | Depends on | Risk |
| --- | --- | --- | --- | --- |
| 1 | `gate-1-worktree-isolation` | one dispatch, one worktree; a stage never shares a checkout | — | medium |
| 2 | `gate-2-verdict-attribution` | a stage's failure spends that stage's budget, never another's | — | high |
| 3 | `gate-3-evidence-at-source` | the producing stage writes its evidence before it may report pass | 1 | medium |
| 4 | `gate-4-reverify-the-gates` | a moved tree re-dispatches the gates, not the builder | 2, 3 | high |
| 5 | `gate-5-recovery-budget-per-incident` | recovery budget scoped to the incident, not the task lifetime | 2 | medium |
| 6 | `gate-6-blocker-visibility` | the objective shows why it is blocked | — | low |

Nodes 1, 2 and 6 are independent and can be built in parallel. Nodes 4 and 5
carry the behaviour changes and land last on purpose.

### Node 1 — `gate-1-worktree-isolation`

`factory/lib/leases/task-lease.mjs` (88 lines) already models a lease, but stage
dispatches for one task all resolve to the same worktree path, and nothing stops
two from running in it. Give each dispatch an isolated checkout of the commit it
was asked to judge, or hold an exclusive lease for the duration.

Security already works around this by hand — it re-verified in *"a fresh
isolated worktree (pnpm install + full affected test suites)"*. That workaround
should be the platform's job, not each agent's improvisation.

Acceptance: two concurrent dispatches on one task cannot observe each other's
uncommitted files; a test proves it with two simultaneous stages.

### Node 2 — `gate-2-verdict-attribution`

This is the node that would have saved `obj-d4e18cad`. In
`factory/lib/task-workflow.mjs` (1313 lines) and
`factory/lib/failure-classification.mjs` (140 lines), a dispatch failure
currently charges the dispatched stage regardless of whose condition failed.

Two of the builder's three verdicts were not builder failures: a pre-existing
formatting defect on `main`, and a missing QA log. Classify a failure by the
stage that owns the unmet condition, and charge that stage's budget.

Acceptance: a dispatch that fails on another stage's missing evidence does not
decrement the dispatched stage's verdict count; a failure caused by a defect
present at the task's `baseSha` is recorded as a baseline defect and charges
nobody.

### Node 3 — `gate-3-evidence-at-source`

`evidencePolicy: "strong"` makes missing evidence fatal, but nothing requires a
stage to write its evidence before reporting `pass`. QA passed once without
writing any artifact, and the omission surfaced one dispatch later as somebody
else's fatal error.

Enforce at the producing stage in `factory/lib/evidence-manifest.mjs` (414
lines): a stage that cannot produce its declared evidence fails then, in its own
result, with its own name on it.

Note for the builder: `/evidence/` is deliberately gitignored (`.gitignore:31`,
anchored so that `factory/lib/evidence/` is not caught). Evidence lives on disk
beside the task state, not in the product repo. Do not "fix" the ignore rule.

Acceptance: a stage reporting `pass` with a declared-but-absent artifact fails
in its own dispatch; the resulting error names the stage that owed the file.

### Node 4 — `gate-4-reverify-the-gates`

`factory/lib/task-workflow.mjs` records `verifiedCommit` and detects the
mismatch — the recorded reason is literally `source changed after verification`.
Its only recovery move is to re-run the builder, which cannot refresh review
evidence, so the condition is unresolvable by construction and loops until a
budget dies.

When the tree moves past `verifiedCommit`, re-dispatch the gates that judged the
old commit, against the new one.

Acceptance: a commit landing after review re-runs reviewer, QA and security
against the new head, charges no builder verdict, and reaches release with
evidence describing the tree that exists.

### Node 5 — `gate-5-recovery-budget-per-incident`

Recovery attempts never reset, so a later unrelated failure escalates instantly
and reports strategies it never ran. On this objective, a recovery spent on a
pre-existing formatting defect counted against a genuine QA gap 45 minutes
later.

Scope the budget to the incident being recovered, and record the incident id
alongside each attempt so an escalation can say which attempts were actually
spent on it.

Acceptance: two unrelated incidents on one task each get a full budget; an
escalation message lists only the attempts belonging to its own incident.

### Node 6 — `gate-6-blocker-visibility`

`objective-state.json` reported `status: "blocked"` with `blocker: null` on both
nodes. The real text sat in the task state under `founderDecisions[0].blocker`,
and the founder question from the architect stage sat in `deferredDecisions[0]`,
unread since 16:25Z. From the objective view — the view a founder actually
opens — a blocked objective looked like an idle one.

Surface the blocker summary and any pending founder question on the objective,
in `factory/lib/hq/task-detail.mjs` and the objective state projection.

Acceptance: an objective blocked on a founder decision shows that decision's
summary and options without opening a task state file.

## Non-goals

- No change to agent prompts, model routing, or seat assignment. The gates
  reached correct conclusions; this is not a quality problem.
- No raising of any budget as a fix. Budgets that are charged correctly do not
  need to be larger. Node 2 lands before anyone argues about the number.
- No auto-merge, and no widening of what a stage may do without review.
- `HQ_AUTO_RETRY` stays at `0`. Nothing here flips it, and node 4 must not
  become a retry loop by another name — it re-dispatches gates once per commit
  move, bounded, with the move recorded.
- No new fixed-interval polling. Node 4 reacts to a recorded commit change; it
  does not watch the tree on a timer.

## Constraints on every node

- separate branch and worktree from `51ab2ba`; no shared branch, no integration
  branch, no stacked PR target
- PR body declares campaign id, dependencies, merge position, verification and
  rollback
- immediately before merge: refresh from latest `main`, resolve, rerun checks,
  preserve independent review and QA evidence; an earlier green result is stale
  once a predecessor merges — this campaign exists because of that exact failure
- Claude does not review code Claude authored; Codex builds, Claude reviews
- every node ships a test that fails against `51ab2ba`

## Rollback

Each node is independently revertible and none changes stored state format
except node 5, which adds an incident id to recovery attempts and must tolerate
attempts recorded without one.

1. `git revert` the node's commit — the factory returns to current behaviour
2. no data migration is required in either direction
3. running objectives are unaffected; the workflow is read fresh per dispatch

---

# Track B — make the factory's own state true

Added 2026-09-15, after `obj-d4e18cad` was resumed by the founder and did not
run. Track A explains why the objective stopped. Track B explains why it never
started again, which cost three hours against Track A's seventy minutes.

## What the log shows

At 17:27:52Z the node escalated and the runner exited. At 18:42:04Z the founder
resumed it from the console:

```
18:42:04.287Z  founder-decision-recorded   builder
18:42:04.287Z  recovery-incident-closed    builder   founder-resumed
18:42:04.287Z  task-resumed                builder
```

No `dispatch-ready` follows. No `dispatch-running`. Nothing ran, then or since.

Three independent facts make that inevitable:

1. **`task-resumed` is a state write, not an action.**
   `factory/lib/task-workflow.mjs:377` pushes an event and updates the record.
   Nothing dispatches.
2. **The runner is one-shot.** `scripts/factory-objective.mjs` ends with
   `process.exitCode = result.status === "complete" ? 0 : 2`. It runs an
   objective to a terminal state and exits. `blocked` is terminal, so the
   process that would act on a resume has already exited — normally, not by
   crashing.
3. **Nothing supervises a runner.** pm2 carries `hq-dashboard`, `hq-publisher`,
   `hq-intents` and `hq-tunnel`. There is no runner entry and no ecosystem file
   that would create one. The dashboard can mutate state; it cannot execute a
   dispatch.

The only mechanism that could revive a parked task is
`factory/lib/hq/auto-retry.mjs`, and `HQ_AUTO_RETRY: 0` in the running
dashboard's pm2 env. It is off deliberately until the 447 GB write loop is
understood, and **this campaign does not turn it on.**

Consequence, stated plainly: **every objective that blocks is permanently dead,
and the console's resume control writes a record that nothing reads.**

## What else the factory failed to notice

PR #10 merged at 18:43:52Z as `fd54c40`, 108 seconds after the resume. The
factory never learned. `objective-state.json` still reports node 1 `pending`
with `attempts: 17`, and node 2 `blocked-by-dep` — so the frontend node, the
entire visible half of the objective, never started because its dependency was
complete and mislabelled.

## Ordered PR train, Track B

| Order | Node | What it changes | Depends on | Risk |
| --- | --- | --- | --- | --- |
| 7 | `life-7-resume-actually-dispatches` | a resume either dispatches or refuses, and says which | — | high |
| 8 | `life-8-runner-presence` | the console knows whether a runner exists for an objective | — | medium |
| 9 | `life-9-merge-closes-the-node` | a merged PR marks its node done and releases dependents | — | medium |
| 10 | `life-10-terminal-states-are-honest` | `blocked` carries its reason to the objective and to the operator | 8 | low |

Node 7 is the one that ends the silent failure. Node 9 is the one that would
have let the frontend node start on its own.

### Node 7 — `life-7-resume-actually-dispatches`

A resume must be an action with an outcome. Either the resume path drives the
next dispatch itself, or it refuses with a reason the operator can read:
*"resumed, but no runner is attached to this objective — start one with
`npm run factory:objective start …`"*.

Silent success is the defect. A resume that writes `task-resumed` and returns OK
while nothing runs is worse than an error, because the operator stops watching.

Acceptance: resuming a blocked task with no attached runner returns an explicit
refusal naming the missing runner, and never records `task-resumed` alone; with
a runner attached, a `dispatch-ready` event follows the resume in the same task
state.

### Node 8 — `life-8-runner-presence`

Record the runner's identity and liveness on the objective when it starts, and
surface it. An objective whose runner has exited is `unattended`, and the
console says so rather than showing a status that implies motion.

This is not a supervisor and does not restart anything. It only makes the
difference between "working" and "abandoned" visible, which is the difference
nobody could see for three hours.

Acceptance: an objective whose runner process is gone reports `unattended` in
the objective view within one poll; an objective with a live runner does not.

### Node 9 — `life-9-merge-closes-the-node`

Nothing ever writes "merged". A node whose PR is merged stays `pending`
forever, and every node depending on it stays `blocked-by-dep` forever. This is
a long-standing open loop; `obj-d4e18cad` is the first time it cost a whole
half of an objective.

Reconcile a node against its PR: merged PR, node done, dependents released.

Acceptance: merging a node's PR transitions that node to a terminal success
state and starts any node whose only unmet dependency was that one, without a
founder touching anything.

### Node 10 — `life-10-terminal-states-are-honest`

Extends Track A node 6. Beyond surfacing `blocker.summary`, a terminal state
must distinguish *waiting on a human*, *waiting on a runner that does not
exist*, and *finished*. `obj-d4e18cad` presented all three as the same thing:
an objective that looked busy and was not.

Acceptance: the objective view separates `blocked-on-founder`,
`unattended` and `complete`, and never renders a terminal objective in a way
that suggests work is in progress.

## Track B non-goals

- No auto-merge. A merge stays a human act; node 9 only *observes* one.
- No fixed-interval poll of the git remote. Node 9 reconciles on a merge signal
  or an explicit reconcile, never on a timer.
- Node 7 makes a resume honest. Making work *continue without a human* is
  Track C, and depends on node 0.

---

# Track C — a factory that keeps working

Added 2026-09-15 on founder direction: *"the factory should be able to actively
do tasks, and always be writing and doing things. Not stale."*

Tracks A and B make the factory tell the truth. They do not make it keep going;
a human still starts every runner. Track C closes that, and it has one hard
prerequisite.

## Node 0 is not optional

`HQ_AUTO_RETRY` is `0` because of the 447 GB write loop of 2026-09-14. The gate
is aimed at the wrong component. From
`docs/incidents/2026-09-14-lifemax-factory-forensics.md`:

> Meanwhile **the dashboard backend** went into a write loop against the
> integration task's state DB — 447 GB written in 5h37m, still growing at
> 3.9 MB/s.

and, under *determinations I could not make*:

> **Why `dashboard/backend/server.mjs` entered the write loop.** I confirmed
> *that* it is the writer (`/proc/2183424/io`) and the rate, but did not trace
> the code path.

The writer was never auto-retry. `state.sqlite` reached 402.2 GiB of
materialised pages — on the order of **two million full-state rewrites** of one
195 KiB record, for a task with 15 dispatches. That is write amplification in
the state store, reachable by anything that writes state in a loop. An
always-running factory is exactly such a thing.

Status as of 2026-09-15 16:10: not currently active. Disk recovered (411 GiB
free), no `state.sqlite` above 10 MB, `hq-dashboard` writing 30 KB/s against the
incident's 3.9 MB/s. The bloated file was deleted. **The cause is still
unknown**, which is the point.

### Node 0 — `run-0-write-amplification` — **cause already fixed, backstop outstanding**

Revised 2026-09-15 16:15, after tracing the mechanism to a fix that is already
on `main`.

**The cause is known and shipped.** `d7e5c95` — *"perf(state): bound
state.events[] in the document, keep the history in the table (#254)"* — is an
ancestor of `origin/main`. From its test:

> `state.events[]` was append-only inside the state document, and the whole
> document is rewritten on every mutation — so a long task paid for its entire
> event history on every write. **Quadratic in write traffic, not in file size,
> which is why no disk alarm caught it.** Measured before this change: 5,000
> mutations produced a 521.6 KiB entity row, rewritten in place 5,000 times.

`factory/lib/store/sqlite-state.mjs` now windows the document to
`DEFAULT_EVENTS_WINDOW = 200` and rehydrates full history from the `events`
table, so readers see what they always saw. Quadratic write traffic becomes
linear. Two million rewrites of a monotonically growing record is precisely the
402.2 GiB the incident measured.

This also means **the `HQ_AUTO_RETRY` gate has been guarding the wrong
component and is now guarding a fixed defect.** The writer was the dashboard
backend, not auto-retry; and the amplification it exploited is closed.

**What remains is the backstop.** A known cause is not a bound. Before anything
runs unattended, the store should refuse to become a runaway regardless of which
component loops next.

Acceptance: a test drives a task to N state mutations and asserts a hard ceiling
on bytes written; exceeding a per-task write budget settles the task with a
named blocker instead of continuing; the ceiling holds with a reader attached
concurrently; a regression test asserts the events window stays bounded under
sustained mutation.

Risk drops from high to medium — this is now additive defence over a fix that
already landed, not an open investigation.

## Ordered PR train, Track C

| Order | Node | What it changes | Depends on | Risk |
| --- | --- | --- | --- | --- |
| 0 | `run-0-write-amplification` | bound state writes; explain the 447 GB | — | high |
| 11 | `run-11-supervised-runner` | a runner is a pm2 service, not a foreground CLI | 0, 7 | high |
| 12 | `run-12-work-queue` | the runner picks up queued and resumed work by itself | 11 | high |
| 13 | `run-13-heartbeat-and-progress` | the factory reports what it is doing, continuously | 11 | medium |

### Node 11 — `run-11-supervised-runner`

`scripts/factory-objective.mjs` ends with
`process.exitCode = result.status === "complete" ? 0 : 2` — one objective, then
exit. Nothing supervises it; pm2 carries the dashboard, publisher, intents and
tunnel, and no runner. That is why a resume at 18:42:04Z reached a machine with
nobody home.

Make the runner a supervised long-lived service that owns a dispatch loop and
survives an objective reaching a terminal state. The CLI stays, for one-shot
runs and for debugging.

Acceptance: killing the runner process results in pm2 restarting it and work
resuming without a human; an objective blocking does not end the service; the
service starts clean on host reboot.

### Node 12 — `run-12-work-queue`

With node 11 alive, a resume becomes real: the runner watches for tasks that are
resumable and picks them up. `task-resumed` stops being a note in a file and
becomes an event something acts on.

This is where `HQ_AUTO_RETRY` gets revisited — **after** node 0, with the write
budget enforced, and as an explicit founder decision recorded in the campaign,
not as a side effect of this node merging.

Acceptance: a task resumed through the console dispatches within one queue
interval with no human action; a task blocked on a founder decision is *not*
picked up until the decision is recorded; the queue respects the per-task write
budget from node 0.

### Node 13 — `run-13-heartbeat-and-progress`

"Always writing and doing things" has to be observable, or the next stall looks
exactly like this one. The runner emits a heartbeat and a current-activity line;
the console shows time-since-last-progress per objective and flags anything that
has not moved.

Acceptance: an objective that has not progressed in N minutes is visibly flagged
without opening a state file; the heartbeat is bounded by the node 0 write
budget and does not itself become a write loop.

## Track C non-goals

- **No enabling anything by default before node 0 merges.** The write loop is
  undiagnosed; an always-on factory is the worst possible way to rediscover it.
- `HQ_AUTO_RETRY` is not flipped by any node here. Node 12 surfaces the decision
  with the budget in place; the founder still makes it.
- No auto-merge, and no autonomous authority the factory does not already have.
  A faster factory is not a more privileged one.
- The heartbeat is not a fixed-interval publish to an external store. The
  publisher stays publish-on-change.

## Where `obj-d4e18cad` actually stands

- Node 1 `domain-streak-and-arc`: **merged** as `fd54c40` on `origin/main`
  (streak, arc, migration `0004`, unit and integration coverage). Factory state
  still says `pending`.
- Node 2 `ui-design-language-and-arc-views`: **never started.** No task
  directory, no branch, no worktree, no dispatch.
- Integration: **never ran.** No combined PR.
- One commit merged without a security pass: security reviewed `7563a4f`, while
  `766a649` and `57b5b7f` reached `main` inside the squash.
- `src/app/globals.css:14` on `main` still reads `--gold: #a67632;`. No token
  from the design language shipped.
- The architect's deferred question is still unanswered and node 2 may need it:
  whether arc-completion chronicle entries join the Chronicle feed or stay a
  domain-only record.

Relaunching the frontend node against current `main` is cleaner than resuming a
state record that is wrong in two directions — and per Track B, a relaunch needs
a runner actually attached, or it will do nothing at all.
