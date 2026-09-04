# Software Factory V1

The goal of this layer is to make OpenClaw Startup HQ behave like a small software company where the founder sets direction and agents execute, review, test, and report.

Start with [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) for the durable context
shared by every harness. Accepted decisions and their rationale live in
[`DECISIONS.md`](DECISIONS.md). This document remains the operational overview.

## Founder loop

1. Founder discusses a goal with a strategy agent.
2. A GitHub issue is created with a clear outcome and acceptance criteria.
3. The issue is classified by risk and routed to one primary implementation harness.
4. The implementation agent works on an isolated branch/worktree and opens a PR.
5. A different model reviews the PR.
6. QA verifies behavior with tests and, for UI work, screenshots/browser checks.
7. Low-risk work can eventually auto-merge when all gates pass. V1 keeps merge approval human-controlled.
8. The HQ records what shipped, what is blocked, and what requires a strategic decision.

## Roles

| Role | Default harness | Purpose |
| --- | --- | --- |
| Chief of Staff | OpenClaw | turn goals into bounded work; route/escalate |
| Architect | Claude Code | design and challenge non-trivial architecture |
| Builder | Codex | primary autonomous implementation |
| Product/UI Builder | Cursor | interface work and visual iteration |
| Reviewer | different from builder | find correctness, maintainability, security, and product issues |
| QA | Cursor/Codex/Claude | attempt to break the result and verify acceptance criteria |
| Release Manager | deterministic gates + OpenClaw | decide whether work is merge-ready; no production autonomy in V1 |

Roles are responsibilities, not seven permanently-running processes.

## Control plane

GitHub is the durable control plane:

`idea -> issue -> ready -> building -> review -> QA -> merge-ready -> merged -> deployed`

OpenClaw is the orchestrator. Codex, Claude Code, and Cursor are execution harnesses. The HQ dashboard is the operator view.

## V1 safety model

- Agents may read project repos and create branches/PRs.
- Agents may run normal development commands inside isolated workspaces.
- Agents do not push directly to `main`.
- Agents do not deploy production, delete production data, spend money, publish externally, or change secrets without human approval.
- A model cannot be the sole reviewer of its own implementation.

## Task contract

Every autonomous coding task should have the fields in `factory/templates/task.md`. The most important fields are **Outcome**, **Acceptance criteria**, **Risk**, and **Human decisions already made**.

## Decision contract

When an agent really needs the founder, it should not send a vague question. It should return a short Decision Card using `factory/templates/decision-card.md` with options, tradeoffs, and a recommendation.

## What to build next

V1 now includes a local deterministic task lifecycle that creates an isolated
worktree, writes persistent handoffs, and enforces evidence and independence
through merge readiness. It deliberately leaves harness invocation to OpenClaw
and final merge to the founder.

The normal founder-facing entrypoint accepts a natural-language objective and
drives the complete pipeline:

```bash
printf '%s' '{"version":1,"action":"start","repo":"/srv/projects/app","objective":"Add a dependency-free health endpoint with tests."}' \
  | npm run --silent factory:openclaw
```

The Chief of Staff creates and validates the task contract, initializes an
isolated worktree, and runs until `merge-ready` or a bounded blocker. You can
still initialize from an explicit JSON contract (copy
`factory/templates/task.json`):

```bash
node scripts/factory-task.mjs init \
  --contract /path/to/task.json \
  --repo /path/to/project
```

The command prints the state and worktree paths. OpenClaw reads the generated
`handoff-<stage>.md`, invokes the assigned harness in that worktree, and records
the result:

```bash
node scripts/factory-task.mjs complete \
  --task issue-42 --repo /path/to/project \
  --stage product --actor openclaw --outcome pass \
  --summary "Acceptance criteria normalized" \
  --evidence evidence/product.md
```

Evidence paths must exist inside the task worktree. `fail` and
`decision-required` block the task and return a non-zero exit status. Use
`resume` only after the blocker is resolved. The terminal state is
`merge-ready`; this tool has no merge or deploy command.

High-risk tasks require `FACTORY_FOUNDER_PUBLIC_KEY` during initialization and
stop before the builder until a signed founder approval assertion is recorded.
Task-contract approval fields are discarded and cannot satisfy this gate. The
founder signs the task-specific challenge with `factory-sign-approval.mjs`
using a private key that is not accessible to OpenClaw, then records it with
`factory-task.mjs approve --assertion ...`. Only the public key and verified
decision are persisted in factory state.

## OpenClaw integration

`scripts/openclaw-factory.mjs` is the machine interface. It accepts one JSON
request on stdin (or `--request <file>`) and emits one JSON response. Request and
agent-result contracts are versioned in `factory/schemas/`.

Initialize through the adapter:

```bash
printf '%s' '{"version":1,"action":"init","contractPath":"/tmp/task.json","repo":"/srv/projects/app"}' \
  | npm run --silent factory:openclaw
```

Use the returned `state` path for later requests. `next` reserves and returns a
persistent dispatch packet without invoking an agent. `run-one` reserves one
stage, calls the installed stage-specific OpenClaw role agent, and ingests its
result. `run` drives all remaining stages:

```json
{"version":1,"action":"run-one","statePath":"/absolute/path/to/state.json"}
```

For an OpenClaw automation that owns invocation itself, call `next`, dispatch
the returned `actor` with `promptPath` and `cwd`, then call `ingest`. Repeated
`next` calls return the same outstanding dispatch, while a running dispatch
cannot be claimed twice. Invocation failures retry the same stage up to the
configured limit. Substantive review, QA, and security failures invalidate
downstream evidence and route their findings back to the builder. A
decision-required result or exhausted retry budget blocks advancement.

The default OpenClaw agent IDs are configured under
`openclawIntegration.agentIds` in `factory/factory.config.json`; requests may
override that mapping for a host. These are local agent IDs, not provider model
names or credentials.

Run `npm run factory:smoke` for a real live-harness test against a disposable
local project with no remote.

The founder dashboard is documented in
[`FOUNDER_CONTROL_PLANE.md`](FOUNDER_CONTROL_PLANE.md). It projects existing
factory state, accepts natural-language outcomes, surfaces agent activity and
Decision Cards, and preserves the signed high-risk approval boundary.

Remaining implementation milestones are:

1. GitHub label/webhook -> OpenClaw invocation of this dispatcher.
2. GitHub PR creation/update and durable review-comment synchronization.
3. Daily/weekly founder digest.

See `docs/software-factory/FIRST_WEEK.md` for how to learn the system by using it.
