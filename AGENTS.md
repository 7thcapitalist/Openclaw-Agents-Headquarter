# Agent Contract — OpenClaw Startup HQ

This repository is an operations system for coordinating coding and non-coding agents. Changes must preserve operator control and auditability.

## Read first
1. `README.md`
2. `docs/software-factory/PROJECT_CONTEXT.md`
3. `docs/software-factory/README.md`
4. `docs/software-factory/OPERATING_RULES.md`
5. `factory/factory.config.json`

`PROJECT_CONTEXT.md` is the canonical narrative context. The JSON config is the
machine-readable authority for factory mode, routing, roles, and gates. If they
disagree, stop and resolve the discrepancy rather than silently choosing one.

## Repository and Git workflow — NON-NEGOTIABLE

`main` is the single canonical and permanent branch. Every repository change —
by the founder, Claude Code, Codex, Cursor, OpenClaw factory agents, automated
recovery, QA, or infrastructure jobs — MUST land through a new Pull Request
targeting `main`. **Never push directly to `main`.**

Ephemeral PR branches/worktrees are allowed but must stay short-lived: one
coherent change, then PR, review, merge, delete branch, delete worktree. Do not
keep feature, development, integration, or per-agent branches, or long-lived
worktrees. Independent changes are separate PRs, never accumulated on a shared
branch. Start every task from the latest `main`.

Full policy: `docs/software-factory/GIT_WORKFLOW.md` (SFD-2026-008).

## Engineering rules
- GitHub is the durable source of truth for software work: issues -> branches -> PRs -> reviews -> merge.
- Never have two agents edit the same branch concurrently.
- Prefer one task, one branch, one primary implementation agent.
- The implementation agent must not be the sole reviewer of its own work.
- `main` is the only permanent branch. Keep it releasable. All work lands via a PR targeting `main`; never push to `main` directly. Delete the branch and worktree after merge. See `docs/software-factory/GIT_WORKFLOW.md`.
- Do not weaken the existing `./run.sh` execution boundary.
- Do not put secrets, tokens, private OpenClaw state, or generated personal data in the repository.
- Reversible implementation details should be decided autonomously. Escalate only strategic, costly, privacy-sensitive, destructive, or hard-to-reverse decisions.
- Every completed task should leave evidence: tests, logs, screenshots, or another verification artifact appropriate to the change.

## Human escalation
Ask the founder only when a decision changes product direction, scope, privacy posture, meaningful spend, external/public behavior, production data, or another hard-to-reverse choice. Use the Decision Card format in `factory/templates/decision-card.md`.

## Handoff
Before finishing a task, record:
- what changed
- verification performed
- unresolved risks
- recommended next action

Do not mark work complete merely because code was written.

## Memory and decisions
- Keep durable project facts and accepted architectural/product decisions in the repository.
- Record durable decisions in `docs/software-factory/DECISIONS.md`; use a Decision Card before making any choice that requires founder approval.
- Company-wide lessons and improvements distilled from completed work live in `factory/knowledge/` (`LESSONS_LEARNED.md`, `ENGINEERING_IMPROVEMENTS.md`, `PROCESS_IMPROVEMENTS.md`), maintained by the Learning / R&D Agent and promoted by the founder. Per-role notes are in `factory/knowledge/agents/`.
- Keep personal preferences, agent personality, credentials, sessions, and runtime memory in the private OpenClaw workspace, not this repository.
