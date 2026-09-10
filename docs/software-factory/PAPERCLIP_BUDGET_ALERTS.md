# Budget alerts

Adapted from Paperclip's budget service (`server/src/services/budgets.ts`) at
pinned commit `6abeb67334348dcb6fde2d591a27ffc7efc7118d` under MIT. See
`factory/third-party/provenance.json`.

## Enforcement is alert-only

Evaluation cannot pause an agent, cancel work, or override a founder approval.
Crossing a limit is **information**. A hard stop changes what the factory is
allowed to do on its own and therefore needs a founder Decision Card plus
fault-injection proof before it exists. Every alert carries
`action: "alert-only"`, the snapshot carries `enforcement: "alert-only"`, the
panel says so in words, and tests assert all three.

## The gap this closes: the ledger had no prices

`telemetry/dispatch.mjs` records a cost event per dispatch, but only sets
`costMicros` when the agent itself reports one. No OpenClaw adapter does — every
event in the live ledger carried `costMicros: null` and
`costConfidence: "unavailable"`. Budget evaluation over that ledger could only
ever answer "unavailable": the feature reported nothing about real spend.

Meanwhile HQ already shipped a pricing table at `factory/pricing.json` and a
`priceUsage()` that reads it — used by the older cost view, never by the ledger.

`budget-snapshot.mjs` joins them. Events are priced **at read time**:

- The append-only ledger is never rewritten. It keeps saying exactly what the
  provider reported.
- A derived price is marked `costConfidence: "calculated"` — an existing value
  in the ledger's own vocabulary — so a derived number is always distinguishable
  from a billed one, in the API and on the panel.
- A provider-reported price always wins over a derived one.
- A model with no entry in `factory/pricing.json` stays **unpriced**. It is
  never counted as zero, the policy reports `unavailable`, and the snapshot
  raises a warning naming how many events are affected.

Against the live ledger when this was written, all 15 events went from
unpriceable to a total of 6,888 micros.

## Policies

Tracked in `factory/budgets.json` and changed by pull request, the same
reasoning as `factory/goals.json`: nothing at runtime can raise a limit without
review, and `GET /api/hq/budgets` is read-only by construction.

| Field | Meaning |
| --- | --- |
| `id` | Stable identifier |
| `scopeType` | `company`, `project`, or `agent` |
| `scopeId` | The project key / agent id the policy watches |
| `window` | `lifetime` or `calendar-month-utc` |
| `limitMicros` | USD micros; `1000000` = $1 |
| `warnPercent` | Warning threshold, default 80 |

A `company` policy deliberately observes the whole ledger: cost events carry
project, agent, objective, task, stage and run dimensions but no company one,
because an HQ ledger is a single company's. `scopeId` there is a label, not a
filter.

`calendar-month-utc` normalises each event's timestamp to UTC before comparing,
so an event written with an offset lands in the right month.

## Statuses

| Status | Meaning |
| --- | --- |
| `ok` | Priced spend is under the warning threshold |
| `warning` | At or above `warnPercent` of the limit |
| `exceeded` | At or above the limit — reported, nothing stopped |
| `unavailable` | There *was* usage in scope and none of it could be priced |

`unavailable` exists to prevent false reassurance: a scope whose spend is
entirely unpriceable must never read as a healthy `ok` at 0 micros.

## Degraded behaviour

`buildBudgetSnapshot` never throws. A missing registry reports
`configured: false`; a corrupt ledger, an invalid policy set, or unpriceable
usage lands in `warnings` with `available: false`, and policies still evaluate
against whatever could be read.

## Operating it

- **Enable:** edit `factory/budgets.json` and merge. The Today panel and
  `GET /api/hq/budgets` pick it up on the next load.
- **Health:** `available: false` plus `warnings` means a source could not be
  read or priced. `pricing.unpricedEvents > 0` means `factory/pricing.json` is
  missing a model the factory is actually using — add it there.
- **Rollback:** empty or delete `factory/budgets.json` — the panel returns to
  "Not configured". Nothing in the factory reads budgets, so no work changes.
  Reverting the PR also removes read-time pricing; the ledger is untouched
  either way, because this change never writes to it.

## Boundaries

Budgets inform the founder. No factory transition, routing decision, or gate
reads them.
