# Scoped agent permissions

Adapted from Paperclip's `agent-permissions` and `authorization` services at
pinned commit `6abeb67334348dcb6fde2d591a27ffc7efc7118d` under MIT. See
`factory/third-party/provenance.json`. Issue #119.

## What this is, and what it deliberately is not

It is a **deny-only** gate in front of factory mutation entrypoints. It answers
one question — *is this agent allowed to do this, here?* — and the only answer
it can add to the system is "no".

It is **not** an authority system. Three properties enforce that.

### 1. Strictly subtractive

The capability vocabulary is a closed list in `factory/lib/hq/permissions.mjs`:

| Capability | What it gates |
| --- | --- |
| `task.initialize` | Creating a task branch and worktree |
| `task.dispatch` | Running a pipeline stage |
| `objective.run` | Scheduling an objective's nodes |
| `objective.recover` | Resuming blocked or failed nodes |
| `github.open-pr` | Publishing a branch and opening a pull request |
| `interaction.post` | Attaching a comment or mention to task context |
| `wakeup.enqueue` | Placing an identifier-only wakeup on the durable queue |

Note what is **absent and must stay absent**: merging, deploying, deleting data,
reading or rotating secrets, changing billing, purchasing, publishing publicly.
Those are governed by `factory.config.json` `prohibitedAutonomousActions` and
the founder approval signature. A registry that names one is **rejected
outright** with a message pointing at where the real authority lives — so a
permissions file can never become a back door around policy.

### 2. Founder authority is superior

A `human` actor is always allowed. A task carrying a **verified** founder
approval is always allowed. This gate cannot be used to lock the founder out of
their own factory. Both bypasses are audited, so "the founder did it" is a
recorded fact rather than a silent hole. An *unverified* approval claim grants
nothing, and there is a test for each falsy shape.

### 3. Deny-by-default, inside an opt-in envelope, with an observe step

| Mode | Trigger | Behaviour |
| --- | --- | --- |
| `off` | no `factory/permissions.json` | Every check allows, `reason: "enforcement-disabled"` |
| `report` | the file exists (**default**) | Every decision is computed and audited exactly as under `enforce`, then allowed anyway |
| `enforce` | `"mode": "enforce"` | Denials are real |

Inside `report` and `enforce` the rule is identical and there is **no implicit
grant**: an actor with no matching grant is denied. The only difference is
whether the denial stops the work — a `report`-mode verdict carries
`wouldDeny: true` and is recorded in the audit log as the denial it would have
been, so the log answers "what would enforcement have stopped" rather than
"everything was allowed".

`off` exists because a factory with no permissions file must keep working
exactly as before, or this is an outage rather than a control. `report` being
the default when the file appears means **adding the file can never take the
factory down by itself**.

## Scopes

A grant is `{ actorId, capability, scopeType, scopeId }`.

- `company` with `scopeId: "*"` covers everything below it.
- `project` covers tasks in that project.
- `task` covers exactly that task.

A request that does not say what it is acting on **fails closed** — it cannot
match a narrower grant than `company`, so an under-specified call is denied
rather than matching everything.

## Where it is enforced

`initializeTask()` — creating a branch and a worktree is the first irreversible
thing a task does, so it is where the check belongs. An **unreadable registry is
a refusal, not a bypass**: a broken permissions file must not silently disable
the control it configures. That is also why the panel shows a broken registry as
`Broken`, never as `Not enforcing`.

## Auditing

Every decision — allow and deny — goes to the append-only audit log via
`recordPermissionDecision()`. Pre-task decisions land in
`.openclaw-factory/telemetry/permissions.ndjson`; per-task decisions land in the
task's own `audit.ndjson`. `GET /api/hq/permissions` reads both.

Recording is best-effort in the same sense as dispatch telemetry: failing to
write an audit line must not turn an allowed action into an outage.

## Operating it

1. **Observe.** `cp factory/permissions.example.json factory/permissions.json`
   and merge. Mode is `report`: nothing is blocked. Watch the Today panel's
   "would be denied" count and the listed denials.
2. **Adjust.** Every denial is either a missing grant or a real finding. Add
   grants by pull request until the count is zero and you agree with it.
3. **Enforce.** Set `"mode": "enforce"` and merge.
4. **Roll back.** Set `"mode": "report"`, or delete `factory/permissions.json`
   entirely to return to `off`. Both are single-line reversals; no factory
   state has to be repaired, because this gate writes none.

## Health

- Panel reads `Broken` and `/api/hq/permissions` reports `available: false` when
  the registry cannot be parsed — task initialization is refusing in that state.
- `summary.denials` with `enforcement: "enforce"` is work that was actually
  stopped. Investigate before adding a grant.
- `summary.wouldDeny` under `report` is what enforcement would stop today.

## Boundaries

This gate cannot grant merge, deployment, billing, secret, or production
authority, cannot override human-merge mode, and cannot weaken the `./run.sh`
execution boundary. It can only refuse an agent an action policy already
permitted.
