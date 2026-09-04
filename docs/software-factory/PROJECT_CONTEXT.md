# Software Factory Project Context

This is the canonical narrative context for humans and agents working on the
OpenClaw software factory. Keep it aligned with `factory/factory.config.json`,
which is the machine-readable authority for mode, routing, roles, and gates.
Implementation detail belongs in the more focused documents linked below.

## Purpose

OpenClaw Startup HQ is an operator-controlled system for coordinating coding and
non-coding agents as a small, auditable team. The software factory layer turns a
founder-defined outcome into bounded GitHub work, implementation, independent
review, QA evidence, and a merge-ready recommendation. Its product goal is
attention compression: the founder should see outcomes, blockers, risks, and
real decisions without supervising agent logs all day.

The HQ dashboard is the operator view. OpenClaw is the orchestration and control
plane. GitHub is the durable source of truth for software tasks and delivery
history. The repository is the durable source of truth for shared project
context; local OpenClaw state is not.

## Intended workflow

1. The founder sets a goal and any settled product constraints.
2. The Chief of Staff turns it into a GitHub issue using
   `factory/templates/task.md`, including outcome, acceptance criteria, scope,
   risk, and prior human decisions.
3. OpenClaw routes exactly one primary implementation owner to an isolated
   branch/worktree. Two agents must never share a writable branch.
4. The assigned harness implements and verifies the smallest coherent change,
   then opens a PR. GitHub preserves the issue-to-branch-to-PR trail.
5. A different model reviews the work. The author cannot be the sole reviewer.
6. QA tests acceptance criteria and failure cases and records evidence. UI work
   includes visual/responsive evidence when possible.
7. Deterministic release gates evaluate merge readiness and OpenClaw surfaces
   blockers or required decisions.
8. The founder alone authorizes the merge in V1. Merging is not delegated to an
   agent, even for low-risk work.
9. After merge, durable decisions and relevant project context are updated.

The pipeline state is:

`idea -> issue -> ready -> building -> review -> QA -> merge-ready -> merged -> deployed`

"Merge-ready" is an evidence-based recommendation, not permission to merge or
deploy.

## Roles and model assignments

| Responsibility | Default system | Authority |
| --- | --- | --- |
| Orchestration / Chief of Staff | OpenClaw | Specify, classify, route, summarize, and escalate; coordinate lifecycle but do not bypass gates. |
| Task source and delivery record | GitHub Issues, branches, and PRs | Durable work state and audit trail. |
| Architecture, independent review, security | Claude | Read-mostly architecture challenge and default review of Codex work; writes only when explicitly assigned as builder. |
| Backend/general implementation and QA | Codex | Primary builder for backend, general, and bug-fix work; may perform QA or review work it did not author. |
| Frontend/UI implementation | Cursor | Primary UI/product builder and visual iteration harness. |
| Personal interactive development | Cursor | Founder's hands-on development environment; follows the same branch, review, QA, and human-merge rules. |
| Release readiness | Deterministic gates plus OpenClaw | Check acceptance criteria, verification, independent review, QA evidence, and unresolved decisions; cannot merge in V1. |
| Final merge authority | Human founder | Approves and performs/authorizes merges and all high-risk actions. |

Roles are responsibilities, not permanently running personas. Routing may change
for a task when the task contract says so, but reviewer independence and human
merge authority do not change. The detailed cross-review rules are in
`OPERATING_RULES.md`; executable defaults are in `factory/factory.config.json`.

## Cursor in the system

Cursor has two deliberate uses. As an agent harness it owns frontend/UI
implementation and visual QA when routed by OpenClaw. As the founder's personal
interactive IDE it is the operator's direct workspace for exploration and
hands-on development. Interactive work is not an exception to the factory: use
an issue and isolated branch for deliverable work, preserve the `./run.sh`
boundary, collect suitable verification, obtain independent review, and leave
the final merge to the founder. Repository-wide Cursor instructions live in
`.cursor/rules/factory.mdc`.

## Safety and approval boundaries

Agents may inspect repositories, make ordinary reversible engineering choices,
work in their assigned isolated workspace, run normal development checks, and
create or update their task branch and PR. They must not:

- push directly to `main` or merge their own work;
- weaken the dashboard's registered-agent `./run.sh` execution boundary;
- let multiple writers modify the same branch/worktree;
- deploy to production, delete production data, rotate secrets, spend money,
  change billing, or publish externally without explicit human approval;
- copy secrets, credentials, private runtime data, or generated personal data
  into Git history;
- claim review, QA, or verification that did not occur.

Low- and medium-risk work can begin without founder approval when the task is
already bounded. High-risk work requires a founder decision before the risky
action. Every risk level requires founder merge approval in V1. Strategic,
costly, privacy-sensitive, destructive, public, production-data, or
hard-to-reverse choices use `factory/templates/decision-card.md`. Ordinary
reversible implementation details should be decided and documented by the
assigned agent. See `OPERATING_RULES.md` for examples and gate requirements.

## Project memory and decisions

Use durable artifacts according to their purpose:

- GitHub issue: requested outcome, acceptance criteria, scope, risk, and task
  discussion.
- Branch and PR: implementation history, review findings, QA evidence, and merge
  discussion.
- `factory/factory.config.json`: machine-readable operating mode, routing,
  prohibited actions, and required gates.
- `AGENTS.md` and harness-specific instruction files: stable execution rules.
- This file: stable cross-harness project context and workflow intent.
- `docs/software-factory/DECISIONS.md`: accepted durable decisions, rationale,
  consequences, and supersession links.
- Focused docs: setup, operating procedures, and architecture details.

Update shared context in the same PR when a change alters how future work should
be understood. Record only decisions that were actually accepted; a proposal or
open question belongs in an issue or Decision Card. When replacing a decision,
mark the old entry superseded and link both entries rather than erasing history.
Do not use generated runtime memory as a substitute for repository evidence.

## Repository versus private OpenClaw state

Commit information needed by every contributor to safely reproduce, understand,
review, and operate the publishable factory: code, sanitized examples, shared
instructions, accepted project decisions, schemas, templates, and non-sensitive
verification artifacts.

Keep local or private:

- `~/.openclaw` and its configuration, runtime databases, sessions, caches,
  device state, cron state, logs, and generated memory;
- credentials, tokens, OAuth material, cookies, auth profiles, private network
  details, and `.env` files;
- personal user profiles, communication preferences, private agent identities,
  conversation history, and generated personal data;
- root `IDENTITY.md`, `SOUL.md`, `USER.md`, and `MEMORY.md` files created for an
  OpenClaw workspace.

Those generic root files describe a particular local agent/operator relationship,
not the shared software factory. They remain in the local OpenClaw workspace and
are ignored here. If a fact from local memory becomes necessary for collaborators,
rewrite only the non-sensitive project fact into the appropriate repository
document or decision record; never copy the private workspace wholesale.

## Context map

- `README.md` — public product overview and runnable-agent model.
- `AGENTS.md` — mandatory shared contributor contract and reading order.
- `factory/factory.config.json` — machine-readable factory policy.
- `docs/software-factory/OPERATING_RULES.md` — autonomy, risk, review, and done criteria.
- `docs/software-factory/DECISIONS.md` — durable accepted decisions.
- `docs/software-factory/SETUP.md` — host and harness setup.
- `docs/software-factory/FIRST_WEEK.md` — staged adoption plan.
- `factory/prompts/` — role-specific behavior.
- `factory/templates/` — task and founder-decision contracts.
- `CLAUDE.md` and `.cursor/rules/factory.mdc` — harness-specific entry points.

When these artifacts conflict, preserve safety, stop the affected work, and
surface the discrepancy. Do not silently relax a prohibition or approval gate.
