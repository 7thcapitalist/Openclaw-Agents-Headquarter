# Blast radius: how much one run may touch

Adapted from Paperclip's `cross-issue-influence-limit` service at pinned commit
`6abeb67334348dcb6fde2d591a27ffc7efc7118d` under MIT. See
`factory/third-party/provenance.json`. Issue #160.

## The gap

#141 scopes capabilities by company / project / task. That bounds **which** work
an agent may touch. Nothing bounded **how much**.

An agent granted `company:*` — which the shipped example grant table does for
`task.initialize` and `task.dispatch` — may act on an unlimited number of tasks
inside that scope. **Scope and blast radius are different properties**, and HQ
had only the first.

Upstream ships a hard cap of 20 with an explicit enforcement date. HQ gets the
counter and the alert first.

## Alert-only, deliberately

Nothing here refuses anything, and there is no code path that throws. The same
enablement shape as budgets (#139), permissions (#141) and the re-wake throttle
(#157): a threshold tuned against no data stops legitimate work on its first
day. Enforcement is a separate change with its own evidence — which is the
issue's own acceptance criterion, not a shortcut taken here.

## What is counted

**Distinct subjects one run was allowed to act on.** Acting on the same task
twenty times is one subject: the blast radius is how far the run reached, not
how busy it was. A denial touched nothing, so it does not count.

| Case | Counted? |
| --- | --- |
| Agent allowed on a new subject | yes |
| Agent allowed again on the same subject | no — already counted |
| Agent denied | no — it touched nothing |
| **Founder acting** (`human`, or `founder-authority`) | **never** |
| Agent acting under `founder-approved-task` | **yes** |
| `report`-mode allowance that would have been denied | yes, and flagged |
| Subject that cannot be named safely | no |

The last two rows are the ones worth arguing about.

**`founder-approved-task` counts.** The founder approved *one task*. An agent
carrying that approval into twenty other subjects is exactly the thing this
measures, so treating the approval as a blanket exemption would blind the
counter to its own worst case.

**A `report`-mode allowance counts, and is flagged.** Excluding it would make
the observation useless in precisely the mode it exists to be observed in;
flagging it lets the operator separate "allowed" from "would have been denied".

## Per run, not per agent lifetime

The tracker lives as long as the run and is discarded with it. An agent that
touches three subjects in each of ten runs has a blast radius of **three**, not
thirty. There is a test that would fail if a tracker ever accumulated across
runs.

## Crossing is audited once

One alert per run, not one per subject after the threshold — a 60-subject run
produces one `blast-radius.exceeded` event, not 58. It carries the same
attribution as a permission decision (actor, run, project correlation) into the
same append-only log, and states `enforcement: "alert-only"` **in the record**,
so an operator reading raw NDJSON is never left wondering whether something was
stopped.

Recording is best-effort in the same sense as the permission decision itself:
failing to write an alert must not turn an allowed action into an outage.

## The report is read back from the ledger

The live tracker dies with its run. The durable record is the permission ledger,
which already names every allowed decision, its actor and its subject, so
`GET /api/hq/blast-radius` derives the count from there. That is deliberate:
a report computed from a second source could drift from what actually happened,
and the operator would have no way to tell which was right. The live counter and
the ledger use the same `subjectKey` for exactly that reason.

## What the live factory says today

`{"runs":0,"overThreshold":0,"widestRun":0}` — and that is the honest answer,
not a failure. There is no `factory/permissions.json`, so permission enforcement
is `off` and no `permission.allowed` events have ever been written. **The report
reads empty because the control it measures is not yet turned on**, which is
itself the finding: today the blast radius is unbounded and unrecorded.

Turning on permissions in `report` mode is what starts populating it.

## Operating it

1. Enable permissions (`factory/permissions.json`, mode `report`).
2. Pass a tracker where a run drives multiple permission checks:
   `enforce({ ..., blastRadius: createRunBlastRadius({ runId, actorId }) })`.
   Without one, `enforce` behaves exactly as it did before — there is a test
   for that.
3. Watch `GET /api/hq/blast-radius` across real objective runs.
4. Tune the threshold against what those runs actually reach.
5. Only then propose enforcement, as its own change with its own evidence.

## Deliberately not in this change

No dashboard panel. The report has nothing to show until permissions are on and
real runs have populated the ledger, and a panel that renders zeroes teaches an
operator that the number is zero rather than that the control is off. It belongs
with the enforcement change, which is where the threshold stops being a guess.

## Rollback

Revert the PR. `enforce` loses one optional parameter it defaults to `null`; no
caller passes it today, so no behaviour changes. Nothing durable is written by
any of this except the alert event itself.
