# Factory autonomy — earn the right to be left alone

Standing campaign. The factory improves itself, one wave per run, until the
founder can spend a week on another product and come back to merged work.

- Campaign id: `FACTORY_AUTONOMY_2026`
- Authorization: founder direction, 2026-09-17
- Target: `main`, one short-lived branch/worktree and PR per node (SFD-2026-008)
- Integration owner: Claude (architecture and independent review; Claude never
  reviews code it authored)
- Shared base: recorded at the start of each wave, per SFD-2026-010
- Expiry: the exit test below passes for seven consecutive nights, or a founder
  decision supersedes it
- Absorbs: `FACTORY_GATE_INTEGRITY_2026` as Wave 1

## Why this is a campaign and not one objective

`factory/lib/objective/decompose.mjs:135` caps decomposition at four build
nodes. This work is roughly twenty nodes. It is also *ordered* — measuring
comes before improving, and a verdict has to mean what it says before anything
downstream of a verdict can be trusted.

So this is a standing prompt, re-run per wave. Each run reads the campaign
state, picks the lowest unfinished wave, ships 2–4 nodes of it, and stops.

## The honest starting position

Measured from the run history on 2026-09-17, across 21 objectives and 286 agent
dispatches (both state roots):

| Measure | Today | Target |
| --- | ---: | ---: |
| Objectives reaching `complete` | 2 of 21 | ≥ 80% |
| Dispatches per task (median / max) | 7 / 21 | ≤ 9 max |
| Dispatches producing no verdict at all | 51 of 286 (18%) | < 2% |
| Reviewer dispatches producing no verdict | 33 of 70 (47%) | < 2% |
| Founder interruptions per merged task | ~3, mostly infrastructure | ≤ 1, product only |
| PRs originating from a `factory/*` branch | 33 of 251 (13%) | — |

Counted across **both** state roots. Factory state is keyed by repo basename, so
work run from `~/hq-runtime` lands under `data/factory/hq-runtime/` and work run
from the dev checkout lands under `data/factory/Openclaw-Agents-Headquarter/`.
The first pass at these numbers missed the `hq-runtime` root entirely and
undercounted by nine objectives. Any tool that reports on the factory must
enumerate state roots rather than assume one.

Two of those numbers are lies in the founder's favour and against the factory's:
`obj-c7b263bb` records both nodes as `failed` while its PRs **#35 and #36 are
merged**, and `obj-039f0f5a` reads `blocked` while **PR #48 is merged**. The
factory ships more than it admits, which means its own learning corpus is being
trained on false failures.

## Wave 0 — Measure, or none of this is checkable

Nothing else in this campaign can be verified without this. Ship it first.

1. `npm run factory:report` — computes, from canonical SQLite state only, every
   row in the table above plus cycle time per stage, and writes a dated JSON
   snapshot under `dashboard/backend/data/factory/_metrics/`. It **enumerates
   every project directory under every known state root**, including
   `hq-runtime`, and fails loudly on a root it cannot read rather than
   silently reporting on a subset.
2. The same numbers on the console, as a single "Is the factory getting better"
   panel. Trend over the last 14 days, not a point value.
3. A regression guard: the report fails loudly if a metric it cannot compute is
   silently reported as zero.

Acceptance: running the report twice on unchanged state produces identical
output; every number traces to a state row a human can open.

## Wave 1 — A verdict means what it says

Six nodes, already specified in `FACTORY_GATE_INTEGRITY_2026.md`. Build them
from that document; it carries the full failure analysis of `obj-d4e18cad`.

| Order | Node | What it changes | Depends on |
| --- | --- | --- | --- |
| 1 | `gate-1-worktree-isolation` | one dispatch, one worktree | — |
| 2 | `gate-2-verdict-attribution` | a stage's failure spends that stage's budget | — |
| 3 | `gate-3-evidence-at-source` | the producing stage writes evidence before it may pass | 1 |
| 4 | `gate-4-reverify-the-gates` | a moved tree re-dispatches the gates, not the builder | 2, 3 |
| 5 | `gate-5-recovery-budget-per-incident` | budget scoped to the incident | 2 |
| 6 | `gate-6-blocker-visibility` | the objective shows why it is blocked | — |

Add one node not in that document:

7. `gate-7-convergence-budget` — evidence freshness is currently all-or-nothing
   (`factory/lib/evidence-manifest.mjs:310`): any new commit invalidates every
   gate. Scope re-verification to the *diff*. Security re-runs when the delta
   touches security-relevant paths, not when any byte moves. And cap the cycle:
   after N full gate rounds on one task, the factory stops and presents the
   founder a choice — accept the verified work, raise the budget, or cut scope —
   instead of discovering a new secondary objection forever.

Acceptance for 7: a task where each gate passes once and a later commit touches
only test files reaches release without re-running security; a synthetic task
engineered to churn escalates after N rounds with a named decision, not a
silent block.

## Wave 2 — The loop closes

The factory has no concept of "merged". Work lands and the state machine never
learns.

1. **Merge writeback.** A merged PR drives its node to `merged` and, when all
   nodes are terminal, the objective to `complete`. Source of truth is the
   GitHub merge event, not an agent's opinion.
2. **Reconciliation is authoritative and bidirectional.** Unblocking a task must
   update the objective wrapper, so dependent nodes actually start.
3. **Dead-start detection.** `obj-264e7ecf` was decomposed on 2026-09-14 and
   dispatched nothing, with one event, forever. A decomposed objective that has
   not dispatched within a bounded window surfaces as needing attention.
4. **Backfill the history.** Correct the objectives whose merged work is
   recorded as failed, so Wave 0's metrics and the learning corpus start honest.

Acceptance: no objective can hold a state contradicted by its PRs; a scripted
check proves it across all historical objectives and runs in CI.

## Wave 3 — Dispatch reliability

19% of all dispatches produced no verdict. The failures are not spread evenly:
builder and product, both dispatched sequentially, are at **0%**. Reviewer, QA
and security — the one `concurrentGroups` entry in `factory.config.json` — are
at 46%, 31% and 21%. 25 of the 45 failures are literally
`[openclaw] Could not start the CLI`.

1. Find out whether concurrent CLI startup is the cause. If it is, serialize
   startup or pool seats — do not remove the concurrency, it is worth keeping.
2. An infrastructure failure never charges a stage's verdict budget. (Wave 1
   node 2 covers the mechanism; this is its reliability half.)
3. Once the root cause is fixed, lower `maxInfraAttemptsPerStage` from 6. A
   retry budget of six is a monument to an unfixed bug, not a fix.

Note: the 2026-09-15 run had zero CLI failures. Confirm the fault is still live
before spending a wave on it, and if it is already gone, say so and move on.

Acceptance: no-verdict rate below 2% across 50 consecutive dispatches, measured
by Wave 0's report.

## Wave 4 — The founder stops being the bus

1. **Intake dedupe, and phantom objectives.** `obj-264e7ecf` and `obj-74ffa4cc`
   are the same objective 74 seconds apart; `obj-039f0f5a` and `obj-d9448721`
   are the same objective 70 minutes apart. Worse: of the nine objectives under
   the `hq-runtime` root, seven are `cancelled` and **six carry the objective
   text "Start an objective on the openclaw-factory project"** — the console's
   placeholder string. Those are launches where intake ran and the founder's
   actual text was never captured, the defect described in
   `objective-console-launcher.md`. An objective whose text is the placeholder
   must be refused at intake, not decomposed and then cancelled.
2. **Calibrate the risk classifier.** Five of twenty blocks were
   `High-risk work requires founder approval before build` on work approved
   within minutes. A gate that always says yes is a tax, not a control.
3. **Infrastructure never pages the founder.** `escalation-gate.mjs` is on
   `main`; verify it actually covers the no-verdict class and close the gaps.
4. **One action, from the console.** Approve, retry, redirect — including the
   approval intents still parked behind `DC-2026-006`. If that card is the
   blocker, escalate it as a decision card rather than working around it.

Acceptance: one week of runs in which every founder interruption was a genuine
product or spend decision, evidenced by the report.

## Wave 5 — It chooses its own work

Everything needed for this already exists and is switched off. `analyze.mjs`,
`synthesize.mjs`, `mastery.mjs`, `research.mjs` and the work proposer are all
built. `learning.autonomy.enabled` is `false`, the proposer is read-only in the
UI, and `_learning/runs/` holds two files, both from 2026-09-04.

1. **Proposer to intake.** The proposer may file an objective directly, bounded:
   at most N per day, drawn only from canonical state, never inventing work —
   the hard rule in `WORK_PROPOSER.md` stands unchanged.
2. **Bounded learning autonomy.** Turn on `knowledge-append` behind the existing
   size watchdog. Widen the whitelist only on evidence from Wave 0's report, one
   class at a time, each widening a founder decision.
3. **Mastery rotation actually runs**, on cadence, updating the agent dossiers
   under `factory/knowledge/agents/`.
4. **The factory reports on itself weekly**, unprompted: what it shipped, what
   it cost, which metric moved, and what it proposes next.

Acceptance: a week in which the factory executed work it proposed itself, and
the founder's only action was merging.

## The exit test — when the founder can leave

All five, simultaneously, for seven consecutive nights:

- Objectives reaching `complete` ≥ 80%
- Dispatches per merged task ≤ 9
- No-verdict rate < 2%
- Founder interruptions per merged task ≤ 1, none of them infrastructure
- Zero manual state repair — no hand-edited SQLite, no `resumeObjectiveNodes`
  run by a human, no branch rescued by hand

Until all five hold, the factory is not ready to be left alone, and the campaign
has not finished regardless of how many nodes have merged.

## Non-goals

- No new product surface. This campaign changes how the factory works, not what
  it can build.
- No raising of any budget as a fix. Budgets charged correctly do not need
  raising.
- No self-modification shortcut. Every node goes through all seven stages and
  all five gates like any other work, on its own branch, ending in a PR the
  founder merges.
- No new design documents. This repository has 61 of them and 10,777 lines of
  them. Ship code with tests.

## Sequencing warning

Waves 0–2 repair the mechanism this campaign runs on. Until Wave 1 node 4 and
Wave 2 node 1 have landed, a self-improvement objective executes on the same
broken loop it is trying to fix — which is exactly how `obj-c7b263bb`, an
earlier run of this same mission, ended with both nodes recorded `failed` while
its PRs merged.

Run Waves 0–2 attended: founder present, merges by hand, short objectives.
From Wave 3 on, run them unattended overnight.
## The standing prompt

Paste this into "Start work" against the `openclaw-factory` project, Decompose
**on**. It is written to be re-run: each run advances the campaign by one wave,
or by the 2–4 nodes of a wave that fit under the decomposer's cap.

> **Mission — make this factory good enough to be left alone.**
>
> Its job is to turn a founder objective into shipped, reviewed work with the
> least founder attention, across many projects, getting faster and more
> reliable over time. Today it does not do that well enough to leave: 1 of 14
> objectives ever reached `complete`, a merged task costs 11 to 22 dispatches
> against a 7-stage pipeline, and 19% of all dispatches produce no verdict at
> all. Judge every change in this campaign against closing that gap — not
> against being interesting.
>
> **The campaign is `docs/software-factory/campaigns/FACTORY_AUTONOMY_2026.md`.
> Read it first. It is the specification; this prompt is only the entry point.**
> Wave 1 additionally depends on
> `docs/software-factory/campaigns/FACTORY_GATE_INTEGRITY_2026.md`, which
> carries the full failure analysis those six nodes are built from.
>
> **This run, in order:**
>
> 1. Read the campaign document and determine the **lowest-numbered wave that
>    is not finished**. A wave is finished only when every one of its acceptance
>    criteria is met in merged code — not when its nodes have been attempted.
> 2. Verify that before building. The campaign quotes measurements taken on
>    2026-09-17; confirm each claim you are about to act on still holds against
>    current state, and if one has already been fixed, say so in the objective
>    report and move to the next node rather than rebuilding it. Wave 3 in
>    particular may already be resolved.
> 3. Ship **2 to 4 nodes of that wave**, fully. Concrete file changes with
>    tests. Do not start a node from a later wave because it looks easier, and
>    do not spread one node's worth of work across two waves.
> 4. If a wave's remaining nodes exceed the cap, take the ones with no
>    unsatisfied dependency and leave the rest for the next run. Record in the
>    objective report exactly which nodes remain and why.
>
> **Order is not advice.** Wave 0 makes the campaign measurable and every later
> wave's acceptance criteria depend on it. Wave 1 makes a verdict mean what it
> says. Nothing downstream of a verdict can be trusted until it lands. Do not
> reorder waves to reach a more satisfying result sooner.
>
> **Constraints (do not violate):**
> - Every node is a real change on its own `factory/<id>` branch, through all
>   seven stages and all five gates, ending in a PR the founder merges. Never
>   push `main`, never merge, never deploy, never touch billing.
> - No self-modification shortcut. This campaign changes the pipeline; it does
>   not get to skip the pipeline. If a node changes the very mechanism judging
>   it, say so in its plan and have it judged by the mechanism as it exists on
>   the shared base, not as the node would have it.
> - Keep changes reversible and small per node. Do not break the task, dispatch
>   or result JSON schemas, or `writeHandoff()`'s signature, without an explicit
>   migration path in the node's plan.
> - Preserve independent review, evidence at every stage, and worktree
>   isolation.
> - Keep the full factory suite green via `npm run test:factory`, and add tests
>   for what you change. A wave that cannot be tested is not finished.
> - **Ship no new design documents.** This repository holds 61 of them and
>   10,777 lines of them. If a node's output is prose, it is the wrong node.
>
> **Report honestly, and prefer the unflattering number.** The single most
> damaging property of this factory today is that its state lies in its own
> favour — `obj-c7b263bb` records both nodes `failed` while PRs #35 and #36 are
> merged. If a node half-lands, say it half-landed. If a metric got worse, lead
> with that. A run that reports one honest failure is worth more to this
> campaign than a run that reports four unverifiable successes.
>
> **If you run low on model credits mid-run:** finish or cleanly abandon the
> current node — never leave a half-committed branch or a task stuck `active` —
> record where you stopped in the objective report, and end. A later run
> continues from the new state.
>
> **Deliverable:** one PR per node plus the integration PR. Each PR explains
> what got better, which campaign acceptance criterion it satisfies, and how the
> founder can tell without reading logs. Finish the objective report with the
> current value of every metric in the campaign's table and which wave is next.
