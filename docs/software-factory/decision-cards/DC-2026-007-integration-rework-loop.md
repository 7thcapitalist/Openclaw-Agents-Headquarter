# Decision Required

Raised 2026-09-16 from `obj-d4e18cad` (LifeMaxing streak/arc + design language),
whose integration node reviewed the combined tree three times, failed it three
times on the same findings, and could not have done anything else.

## Decision

The integration reviewer found four real gaps that only exist when both branches
are merged. Nothing in the factory can act on them. Do we open a follow-up
objective to fix them, or accept the two branches as they are and close this out?

## Why this needs the founder

Not because the findings are ambiguous — they are concrete and verified three
times — but because **fixing them is new work that no existing node owns**, and
only the founder decides whether it is worth doing now.

There is also a factory bug underneath, and it is the reason this reached you as
a loop rather than as a question:

> An integration node's `builder` stage is not a builder. Its own result reads
> `summary: merged 2 sub-task branch(es) into factory/integration-obj-d4e18cad`.

So when the integration reviewer fails, the engine routes the failure to
`builder` exactly as it would for an ordinary node — and that "builder" re-runs
the merge, producing a byte-identical tree. The reviewer then fails the same
findings again. The third review said so directly:

```
commit c3776c1 — byte-identical to attempt 2, no builder fixes have landed since
```

Three review rounds, three merges, one unchanged commit. The loop can only end
when recovery budget runs out, and it would have escalated then with a blocker
describing strategies that could never have worked. The run was stopped by hand
at the founder's direction rather than left to burn the remaining attempts.

## What the reviewer found

Cross-cutting gaps that neither sub-task could see alone — which is exactly what
integration exists to catch:

1. **`offerNextArc` has zero frontend consumers.** No UI calls `POST
   /api/v1/chapters` outside onboarding, so completing an arc offers no
   in-product way to start the next one. The backend transition works; nothing
   reaches it.
2. **Momentum's "tap a day" link misses.** It routes to `/chronicle?date=X`
   driven by `mission.status='completed'` (dayEvidence/arcDays), while
   Chronicle's date filter returns rows joined through a different table, so the
   link silently lands on nothing for days that qualify by one rule and not the
   other.

Two further findings are recorded in the integration task's evidence.

Both sub-task branches passed all seven gates on their own and are open as
`lifemax#11` (streak/arc domain) and `lifemax#12` (design language + arc views).
Node 2's own reviewer separately caught a blocking dark-mode contrast regression,
which the builder fixed before passing. The individual work is sound; the seam
between the two is not.

## Option A — open a follow-up objective for the four findings

- Benefit: the gaps get fixed by agents that can actually change the sub-task
  code, and the arc feature works end to end rather than only in the backend.
- Cost/risk: another full objective's worth of agent time, on a milestone that
  has already consumed a great deal tonight.

## Option B — accept the two branches, close the objective, file the findings

- Benefit: `lifemax#11` and `lifemax#12` are reviewable and mergeable now; the
  findings become issues to schedule rather than work in flight.
- Cost/risk: the arc-completion flow ships with no way to start the next arc,
  and the Momentum→Chronicle link stays broken for the exact daily use this
  milestone was meant to validate. Both are user-visible.

## Other

The founder may scope a smaller fix — for example, wiring `offerNextArc` only,
and filing the Chronicle join mismatch separately.

## Recommendation

**B, then A as a scoped follow-up.** The two branches are independently sound and
should not be held hostage to a seam problem. But finding 1 is not cosmetic: an
arc that cannot be followed by the next arc defeats the feature this milestone
exists to deliver, so the follow-up should be scheduled rather than merely filed.

## Default if no decision

`lifemax#11` and `lifemax#12` stay open and reviewable. `obj-d4e18cad` stays
active with its integration stopped — no agent time is being spent on it. Nothing
else is blocked.

## The factory bug, separately

Regardless of A or B, the rework loop needs fixing, and it is recorded as a
finding in `RUN_RELIABILITY_2026`. An integration reviewer's FAIL should route to
the originating sub-task nodes, or escalate as a founder decision — never to a
`builder` whose only action is to repeat a merge.

## Reply format

`A`, `B`, or `Other: ...`.
