# Agent Contract — OpenClaw Startup HQ

This repository is an operations system for coordinating coding and non-coding agents. Changes must preserve operator control and auditability.

## Read first
1. `README.md`
2. `docs/software-factory/README.md`
3. `docs/software-factory/OPERATING_RULES.md`
4. `factory/factory.config.json`

## Engineering rules
- GitHub is the durable source of truth for software work: issues -> branches -> PRs -> reviews -> merge.
- Never have two agents edit the same branch concurrently.
- Prefer one task, one branch, one primary implementation agent.
- The implementation agent must not be the sole reviewer of its own work.
- Keep `main` releasable. Work through branches and PRs.
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