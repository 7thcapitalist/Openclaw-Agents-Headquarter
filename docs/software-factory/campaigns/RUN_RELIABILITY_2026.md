# Run Reliability: what one night of failures cost, and what to fix

Findings campaign from the evening of 2026-09-15, when two objectives spent
roughly four hours failing at work that was never broken.

- Authorization: founder direction on 2026-09-15 — "if we see any inefficiency in
  the process we should note, and by noting all the problems create solutions"
- Campaign id: `RUN_RELIABILITY_2026`
- Shared base: `e05371d` (`main`, "chore(hq): register AI4Logistics project")
- Integration owner: founder (every item below is a separate PR by its builder;
  Claude authored the findings and must not be the sole reviewer of its own fixes)
- Target: `main`, one short-lived branch/worktree and PR per item
- Expiry: items 1–6 merged, or superseded by a founder decision

## Why a campaign

The nine findings below look like nine bugs. They are closer to one shape seen
nine times: **the factory cannot tell the difference between work that failed and
work that was interrupted**, and it charges the founder's budget either way.

Everything that went wrong on 2026-09-15 followed from that. An OOM-killed
gateway read as an agent failure. A restarted dashboard read as an objective that
ended. A cancelled objective read as running work. The fixes are individually
small; treating them as one campaign is what keeps them from being re-derived
one incident at a time, which is what has already happened twice (`release` moved
off the shared OpenAI seat on 2026-09-07 for the identical reason `product` moved
on 2026-09-15).

## What happened

Two objectives — `obj-47cf7355` (HQ Today panel) and `obj-d4e18cad` (LifeMaxing
streak/arc domain) — were running. Between 21:28 and 21:50 the OpenClaw Gateway
was OOM-killed twice:

```
17:31:20 EDT  openclaw-gateway.service: Main process exited, code=killed, status=9/KILL
              Consumed 1h 3min CPU, 5.5G memory peak
17:49:56 EDT  openclaw-gateway.service: Main process exited, code=killed, status=9/KILL
              Consumed 12min 52s CPU, 4.3G memory peak
```

against `MemoryHigh=5G` / `MemoryMax=6G`. Every dispatch in flight died with it.
The factory recorded each as `wrote no result file` and charged it to recovery
budget. Both objectives escalated to the founder as failures.

Neither had a code problem. Once the gateway was stable, both ran every one of
the seven stages and published PRs — `#283` and `lifemax#11` — without a single
further recovery attempt.

**Cost: eleven recovery attempts, four hours, and two false escalations, on work
that was correct the whole time.** One objective reached 8 of its 9 lifetime
attempts; a ninth failure would have exhausted it permanently.

## Findings

### 1. The recovery ladder spends founder budget on dead sockets

The single most expensive item — and not, as it first appears, a classification
gap. The classifier is thorough and explicitly gateway-aware:

```js
"agent call connection closed",
"gateway[^.;]{0,60}(?:connection closed|not reachable|unreachable|is down)",
"(?:not reachable|unreachable) at wss?://",
```

It correctly called every one of tonight's failures `INFRASTRUCTURE_ERROR`. The
**stage** budget already acts on that distinction, allowing
`DEFAULT_MAX_INFRA_ATTEMPTS = 6` against `maxAttemptsPerStage = 3`.

The recovery ladder does not. `isRecoverableFailure` includes
`INFRASTRUCTURE_ERROR`, and each attempt is recorded *with* its classification
and then counted exactly like an agent failure — 3 per incident, 9 per lifetime,
advancing `retry-recover → deeper-diagnosis → independent-review →
founder-escalation` on attempt count alone. So the factory ran a "deeper
diagnosis" and an "independent review" against a closed socket, three times,
and escalated to the founder as though the branch were at fault.

The knowledge is already in the system. Nothing acts on it at the point where
the budget is spent.

**Fix:** give recovery its own infrastructure path, mirroring what the stage
budget already does — an `INFRASTRUCTURE_ERROR` should retry with backoff
against a separate allowance, and must not advance the escalation ladder while
the cause is transport. Better still, a circuit breaker: when the gateway is
unreachable, park dispatch and wait for it to return rather than spending
attempts discovering it is still down.

**Status:** not started. Highest value item in this campaign.

### 2. Recovery budget is cumulative and never resets

`maxAttempts: 3` is per incident, `maxTotalAttempts: 9` per task, and attempts
never age out. `obj-d4e18cad` entered the evening having spent 2 attempts days
earlier on unrelated problems, so the gateway outage took it from 2 to 8 in
minutes and it escalated with one attempt left for the rest of its life.

**Fix:** reset the per-incident counter when a stage passes, or age attempts out
after a bounded window. A task that has since made progress is not the task that
failed three times.

**Status:** not started.

### 3. The concurrency bound is per-process, not per machine

`FACTORY_MAX_CONCURRENT` limits nodes inside one orchestrator. Nothing limits
orchestrators. Running two detached `runObjective` processes, each honouring a
limit of 1, drove the gateway from 2.1G to 4.6G — within reach of the levels it
had just been killed at. Out-of-process runs are routine here:
`scripts/factory-objective.mjs`, `scripts/factory-improve-loop.mjs` and
`scripts/objective-smoke.mjs` all call `runObjective` directly, and
`objective-reconciler.mjs` says so itself — *"no lock spans them"*.

**Fix:** a machine-wide bound — a lease or semaphore around dispatch, or the
gateway refusing new sessions above a memory watermark. The per-process setting
(PR #287) reduces the common case but is not a guarantee, and should not be
mistaken for one.

**Status:** #287 open (per-process only). The machine-wide bound is not started.

### 4. Recovering a task leaves its objective stranded

The founder-facing repair paths operate on **tasks**; objectives have no
equivalent. `POST /api/founder/tasks/:id/retry` resumes a blocked task but never
touches the objective wrapper, so the wrapper keeps whatever node status it had.
`runObjective` heals that — but only while the task is `active`. Once the task
reaches `merge-ready` the heal cannot match, the node stays `blocked`, and the
objective deadlocks with **no supported path back**.

Both objectives ended there on 2026-09-15 and had to be repaired by hand-writing
`gate-satisfied` into their node records through the transactional store. That is
not a procedure anyone should need.

**Fix:** extend the resume rule — a node recorded `blocked`/`failed` whose task
reached `merge-ready` becomes `gate-satisfied`, exactly as it would have if the
orchestrator had been watching. And give objectives a first-class resume: an
endpoint and console control that calls `runObjective` for an existing objective,
so recovering one does not require a hand-written script.

**Status:** not started. PR #282 fixes the adjacent reconciler blind spot.

### 5. "Running" is a label, not a fact

Nothing records who owns an objective run. A restarted dashboard leaves nodes
reading `running` with no runner; `obj-039f0f5a` showed *Running* on Today for a
week while nothing ran, and `obj-47cf7355`'s integration node still reads
`running` after its process was killed. The dashboard compounds it by deriving
liveness from node evidence, so a stale node makes a dead objective look alive.

**Fix:** record ownership on a run (pid/host/lease with a heartbeat, the way task
leases already work) and present a node whose owner is gone as interrupted rather
than running. The founder should never have to ask whether "Running" means
running — that question was asked twice tonight.

**Status:** not started.

### 6. A cancelled objective's tasks still page the founder

Cancelling `obj-264e7ecf` left two decision items in the Founder Inbox, because
inbox items are built from the **task** scan and cancellation is recorded on the
objective. They had to be dismissed by hand.

**Fix:** filter inbox items by the owning objective's status, the way the
objective-level loop already does.

**Status:** not started.

### 7. Obsolete work is indistinguishable from stranded work

The boot reconciler resumed two objectives for issue **#186 — closed**, whose
deliverable had already shipped. By its own test they were stranded: ready nodes,
no runner. Nothing recorded that their purpose was gone.

**Fix:** check the linked issue's state before resuming, or treat an objective
still at stage 1 after N days as abandoned rather than stranded. The reconciler
is right to be structural; it needs one fact about intent.

**Status:** not started.

### 8. Duplicate objectives are accepted silently

`obj-74ffa4cc` and `obj-264e7ecf` were created 74 seconds apart for an identical
request, and both ran. Nothing at intake noticed.

**Fix:** warn at intake when an open objective already targets the same
issue/outcome, and let the founder confirm.

**Status:** not started.

### 9. Two copies of the factory data exist

`~/hq-runtime` is production; `~/Openclaw-Agents-Headquarter/dashboard/backend/data/factory`
still holds a full duplicate that nothing reads. It has already caused one
incident: `obj-d4e18cad`'s node recorded an absolute `statePath` into the old
checkout, so resuming it would have run the work where the dashboard could not
see it.

**Fix:** retire the old copy deliberately, and prefer paths relative to the state
root over absolute ones in recorded state.

**Status:** not started.

## Order of work

1. **Finding 1** — infrastructure must stop costing recovery budget. Everything
   else tonight was survivable; this is what turned an outage into escalations.
2. **Finding 2** — the budget must reflect the current incident.
3. **Finding 4** — objectives need a supported resume, so recovery never again
   requires hand-writing state.
4. **Finding 5** — ownership, so "running" can be trusted.
5. **Findings 6, 7, 8** — inbox and intake hygiene; cheap, independent.
6. **Finding 3 (machine-wide)** and **Finding 9** — infrastructure shape; larger,
   and neither is urgent once 1 and 2 land.

## Already shipped from this incident

| PR | What |
|---|---|
| #275 | A retry leaves the route that just failed to deliver (merged) |
| #278 | A cancelled objective cannot come back as Running (merged) |
| #282 | The boot sweep sees work whose wrapper drifted (open) |
| #287 | Hold the settings that stopped the gateway dying (open) |

## What this campaign deliberately does not propose

- **Turning on `HQ_AUTO_RETRY`.** With finding 1 unfixed, automatic retry would
  spend budget faster against the same infrastructure failures. It stays off
  until infrastructure failures stop being charged as agent failures.
- **Raising the gateway's memory ceilings.** The host has ~14G; the gateway
  already peaked at 5.5G. More headroom postpones the kill rather than removing
  the cause, and trades a gateway OOM for host pressure. Bound the work instead.
- **Any change to the seven gates.** Nothing failed tonight because the gates
  were wrong. Every stage passed once the infrastructure held.
