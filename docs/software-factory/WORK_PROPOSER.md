# Work proposer

Ranks what the factory should do next, from state it already has.

## Why this exists

Every objective this factory has ever run started with the founder typing it.
`goals.mjs`, `agent-scorecards.mjs`, `cost-ledger.mjs` and `learning/analyze.mjs`
all exist and all four only ever *informed* — nothing read them together and had
an opinion. The overnight queue has exactly one way in: a human POST.

So the factory got very good at executing work and proving it, and never got any
better at choosing it.

## The hard rule

**A proposal must point at something already in canonical state.**

It ranks real blocked work, real untouched goals and real recurring findings. It
never invents an objective.

This is the whole design constraint, and it is not caution for its own sake: a
proposer that invents adds noise to the one surface the founder reads every day,
and noise there is worse than silence. A founder who learns to skim this panel
has lost more than they would have lost without it.

## What it proposes

| Kind | Meaning | Drawn from |
| --- | --- | --- |
| `unblock` | Work that is started and stuck | goal projection, `blocked > 0` |
| `systemic` | A failure seen often enough to be a pattern | learning findings at/above `learning.patternThreshold` |
| `neglected` | Work nobody picked up — nothing active, nothing stuck, not done | goal projection |

### Ranking

`unblock` > `systemic` > `neglected`, then by size, then by id.

Blocked work ranks first because it is **already paid for and stopped** —
clearing it converts spend the factory has *already made* into delivered work.
Neglected work costs nothing until it is picked up, so it ranks last. Systemic
findings sit between: cheap to act on, and they compound.

The final tiebreak on id is not cosmetic. Without it, two equal candidates could
order differently between reads and the panel would reshuffle for no reason the
reader can see.

### Blocked work is attributed to the leaf

A company goal reads `blocked` precisely because something beneath it is. So a
goal with children yields no `unblock` candidate: its blockage is already
represented by whichever leaf actually carries it. Counting both would report the
same tasks twice and rank the useless parent — "unblock the company goal" — above
the specific, actionable one.

### What is deliberately not proposed

- A goal with `total: 0` — no canonical work exists to judge. That is silence,
  not neglect, and proposing it would be inventing a referent from an empty
  projection.
- A goal with active work — something is already moving it.
- A finished goal.
- A finding below the founder's threshold — not yet a pattern.
- A finding with no title, rather than rendering a blank row.

## Report-only

It produces a ranked list and nothing else. There is deliberately **no write
route**: promoting a proposal into the overnight queue stays a deliberate human
action, through the queue that already exists.

Same enablement shape as budgets (#139), permissions (#141), the re-wake
throttle (#157) and blast radius (#160). A control that acts on its first day,
against thresholds tuned on no data, is an outage rather than a control.

## Failure behaviour

Fails **open and quiet**. Every input is optional; every failure degrades to a
warning plus fewer proposals. `buildWorkProposals()` does not throw, whatever it
is handed.

The reasoning is the same as the re-wake throttle's: a proposer that breaks the
Today view is a proposer that gets switched off, and then none of this matters.
The cost of a missing proposal is one thing the founder had to notice themselves.
The cost of a broken Today view is the founder's whole morning.

One distinction the panel must preserve: **"nothing to propose" and "nothing to
propose from" are different facts.** The first is good news and renders as
*Clear*. The second means the inputs are missing and the panel is blind, and
renders as *Not configured*. Collapsing them would let a broken goal registry
read as a healthy factory.

## Surfaces

- `GET /api/hq/proposals` — read-only snapshot
- **Proposed work** panel on Today, above Goals: what to do next, then what it serves
- `factory/lib/hq/proposer.mjs` — `buildWorkProposals()` (I/O) and `rankProposals()` (pure)

`rankProposals()` is separated from all I/O so the ordering is tested against
fixtures rather than against whatever the live factory happens to contain today.

## Tuning

- `limit` — default 3. Three, not ten: this is read at a glance beside everything
  else on Today, and a longer list is a backlog, which is the thing the founder
  already has too much of.
- `learning.patternThreshold` in `factory.config.json` — the founder's existing
  threshold, read rather than duplicated.

## How you would know it is wrong

If you reject all three proposals for two weeks running, the ranking is wrong —
not the idea. The most likely cause is that `blocked` is dominated by one stalled
project, in which case weight by goal level, or scope the rank per project.
