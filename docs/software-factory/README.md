# Software Factory V1

The goal of this layer is to make OpenClaw Startup HQ behave like a small software company where the founder sets direction and agents execute, review, test, and report.

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

V1 is the protocol and operational foundation. The next implementation milestones are:

1. GitHub issue -> OpenClaw dispatcher.
2. Isolated worktree creation per task.
3. Harness routing: Codex / Claude / Cursor.
4. Automatic cross-model PR review.
5. CI and QA gates.
6. Founder dashboard view for active work + decisions.
7. Daily/weekly founder digest.

See `docs/software-factory/FIRST_WEEK.md` for how to learn the system by using it.