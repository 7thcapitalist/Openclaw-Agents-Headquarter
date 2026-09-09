# Claude Code Instructions

Read `AGENTS.md` first. It is the shared contract for every coding agent in this repository.

The repository is **main-only**: `main` is the single permanent branch and every change — including yours — lands through a PR targeting `main` from a short-lived branch/worktree that is deleted after merge. Never push to `main` directly. Full policy: `docs/software-factory/GIT_WORKFLOW.md` (SFD-2026-008).

For software-factory work, also read:
- `docs/software-factory/README.md`
- `docs/software-factory/OPERATING_RULES.md`
- `factory/factory.config.json`

Claude's default responsibilities in this factory are architecture and independent review. If you are assigned as the primary builder, follow `factory/prompts/builder.md`; otherwise do not silently turn a review/design task into an implementation task.

Never be the sole reviewer of code you authored. Escalate founder-level questions using `factory/templates/decision-card.md`.