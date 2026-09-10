# Agent reliability scorecards

Adapted from Paperclip's `tool-runtime-metrics` and `agent-task-run-telemetry`
services at pinned commit `6abeb67334348dcb6fde2d591a27ffc7efc7118d` under MIT.
See `factory/third-party/provenance.json`. Issue #123.

## What this deliberately does not measure

Message count. Dispatch count. Raw activity. Wall-clock speed. Cheapness.

Every one of those is trivially gamed by an agent doing more work, faster,
worse — and rewarding them is how a factory ends up optimising for looking busy.
A test asserts that twenty failed dispatches score worse than one accepted one.

## The unit is the accepted outcome

An outcome counts as **accepted** when the stage it produced ended up passing in
canonical state — not when the agent said it was done. An agent's own `"pass"`
is a claim; the stage passing is the fact. A test pins the difference.

| Measure | Meaning |
| --- | --- |
| `outcomes.accepted` / `sampleSize` | Accepted outcomes out of decided ones |
| `outcomes.acceptanceRate` | `null` when nothing has been decided — never `0%` |
| `quality.findingsAgainst` | Gate failures on this agent's builds |
| `quality.gateFailuresRaised` | Failures this agent caught **while acting as a gate** |
| `quality.recoveries` | Recovery cycles its work triggered |
| `quality.founderEscalations` | Times its work reached the founder |
| `quality.retryRate` | Retry events per dispatch |
| `latency.medianMs` | Median stage duration, with its sample count |
| `cost.microsPerAcceptedOutcome` | The only cost figure worth comparing |

## A gate failure cuts both ways

When `reviewer`, `qa` or `security` fails a build, that is a **finding against
the builder** and **evidence for the gate that caught it**. Both facts are
recorded, on different scorecards. A reviewer that catches a lot is doing its
job, not generating noise.

## Cost is only ever per accepted outcome

Total cost rewards the agent that gives up first. `cost.micros` is reported for
completeness but the comparable figure — and the only one the panel shows — is
cost per accepted outcome. An agent with no accepted outcomes gets `null`, not a
flattering zero.

Costs use the same read-time pricing as the budget snapshot: the append-only
ledger is never rewritten, and a model absent from `factory/pricing.json` stays
**unpriced** rather than counting as free. Any agent with unpriced usage is
marked `complete: false` and the panel calls its cost "incomplete", because an
incomparable number presented as comparable is worse than no number.

## Confidence

`sampleSize` is decided outcomes. Below 5 the card is `low` confidence, and the
panel shows **counts rather than a percentage** — printing "100%" over `n=1` is
the single easiest way for this panel to lie. Confidence rises with the sample,
never with the score.

## The boundary

Scorecards **inform** routing. They never set it. Factory routing lives in
`factory/factory.config.json`, nothing in this module writes to it, and the
module's entire export surface is `buildAgentScorecards` — a test asserts that,
because a scorecard module that can route is a router. The payload carries
`usage: "advisory-only"` so no consumer can mistake it, and the panel names
where routing actually lives.

## Privacy

Prompts, result paths and agent prose never reach a scorecard. Only counts,
rates, durations and identifiers cross the boundary; a test asserts that
dispatch summaries and absolute paths do not appear in the output.

## Degraded behaviour

An unparsable task state or missing cost ledger lands in `warnings` with
`available: false`, and every readable agent still gets a card. A missing ledger
produces `cost.micros: null` and `missingCost: true`, never zero.

## Rollback

Revert the PR. This module writes nothing — no factory state, no routing, no
config — so there is nothing to repair or migrate.
