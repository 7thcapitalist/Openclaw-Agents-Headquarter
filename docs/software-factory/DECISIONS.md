# Software Factory Decision Log

This log records accepted decisions that future agents must preserve. It is not
a backlog or a place for unresolved options. Proposed decisions belong in a
GitHub issue or a `factory/templates/decision-card.md` response until the founder
accepts them.

For each new entry, use a stable ID (`SFD-YYYY-NNN`), date, status, decision,
rationale, consequences, and links to relevant issues or PRs. Do not delete old
entries. When a decision changes, add a new entry and mark the old one
`Superseded by SFD-...`.

## SFD-2026-001 — GitHub is the durable software-work record

- Date: 2026-09-03
- Status: Accepted
- Decision: GitHub Issues are the task source, and branches, PRs, reviews, and
  merge history are the durable software delivery record.
- Rationale: A shared, inspectable history keeps agent work auditable and
  recoverable across tools and sessions.
- Consequences: Deliverable work follows `issue -> branch -> PR -> review ->
  merge`. Dashboard or local runtime state may summarize that work but does not
  replace GitHub as its source of truth.

## SFD-2026-002 — OpenClaw orchestrates specialized harnesses

- Date: 2026-09-03
- Status: Accepted
- Decision: OpenClaw is the orchestration/control plane. Claude defaults to
  planning, architecture, independent review, and security; Codex defaults to
  backend and frontend/UI implementation. Cursor remains the founder's
  interactive development environment and a planned visual harness, but is not
  an autonomous route until its capability probe proves ACP support.
- Rationale: Explicit responsibilities make routing predictable while retaining
  cross-model checks.
- Consequences: One primary builder owns each writable task workspace. A model
  cannot be the sole reviewer of its own implementation. Task contracts may
  override preferred routing without weakening independence or safety gates.

## SFD-2026-003 — V1 uses human-merge mode

- Date: 2026-09-03
- Status: Accepted
- Decision: Deterministic release gates and OpenClaw may declare a change
  merge-ready, but the founder retains final merge authority for every risk level.
- Rationale: V1 prioritizes operator control while the factory workflow and gates
  are proven through real use.
- Consequences: Agents do not push directly to `main`, merge PRs, or treat a green
  gate as merge authorization. Future auto-merge requires a new founder-approved
  decision and corresponding configuration change.

## SFD-2026-004 — Shared context is separate from private OpenClaw memory

- Date: 2026-09-03
- Status: Accepted
- Decision: Shared project context and accepted decisions live in versioned,
  sanitized repository documents. Private OpenClaw workspace identity, user,
  memory, session, credential, and runtime files remain local.
- Rationale: Future agents need durable context without publishing personal data
  or coupling the project to one runtime instance.
- Consequences: Generic root `IDENTITY.md`, `SOUL.md`, `USER.md`, and `MEMORY.md`
  are ignored and are not project context. Only non-sensitive facts required for
  collaboration are rewritten into the appropriate repository document.

## SFD-2026-005 — Agent execution remains behind `./run.sh`

- Date: 2026-09-03
- Status: Accepted
- Decision: The dashboard runs registered worker agents only through the local
  `./run.sh` entrypoint inside the resolved agent folder.
- Rationale: A narrow, inspectable command surface limits accidental or malicious
  expansion of dashboard execution authority.
- Consequences: Factory changes must not weaken or bypass this boundary. Any
  proposal to broaden it requires explicit security review and founder approval.

## SFD-2026-006 — Company Learning System is read-only and proposal-driven

- Date: 2026-09-03
- Status: Accepted
- Decision: A company-level Learning / R&D Agent analyzes completed-task evidence
  and external knowledge and feeds improvements back through
  `factory/knowledge/` (global), each project's own `context/` (project), and
  `factory/knowledge/agents/<role>.md` (agent). It is implemented as the
  `scripts/factory-learn.mjs` adapter and `factory/lib/learning/*` — no pipeline
  stage, no state-machine change. See
  `docs/software-factory/COMPANY_LEARNING_SYSTEM_PROPOSAL.md`.
- Rationale: The factory produced evidence it never learned from. Closing that
  loop is what makes agents more capable month over month.
- Consequences: The Learning Agent is read-only over project repos and never
  starts, resumes, or routes a task. Its only repo writes are `learning/*`
  proposal branches opened as PRs (opt-in, `--publish`); prompt, routing, and
  gate changes are scaffolded as normal low-risk factory tasks with independent
  review. Secrets, bulk private data, model chain-of-thought, and raw
  transcripts never enter its outputs (`factory/lib/common/redact.mjs`). Runtime
  learning state lives under the gitignored `dashboard/backend/data/factory/_learning/`.
  Handoff injection of accepted knowledge is opt-in
  (`FACTORY_LEARNING_IN_HANDOFF=1` or `factory.config.json` →
  `learning.injectIntoHandoff`).

## SFD-2026-007 — QA, Learning, and Research are real Claude-backed OpenClaw agents

- Date: 2026-09-05
- Status: Accepted
- Decision: The `qa`, `learning`, and `research` organizational roles each map to
  a real, isolated OpenClaw agent that executes on Claude through the acpx ACP
  backend (`runtime.acp.agent: "claude"`), the same mechanism already used by
  `architect`, `reviewer`, and `security`. `learning` and `research` were created
  on this date (they previously existed only as role entries in
  `factory/agents.json` with a `runtimeAgentId` that resolved to nothing).
  `qa` already existed but was codex-backed; it is now Claude-backed.
  `factory.config.json` maps both `qa:claude` and `qa:codex` to the single `qa`
  agent, and adds `research`.
- Rationale: A role that names a non-existent runtime agent cannot run and is
  invisible to `factory/lib/hq/runtime.mjs`'s resolution check. Putting
  verification, learning, and research on Claude gives them an auth path
  independent of the shared OpenAI seat used by the other agents, and matches the
  factory's intent that review/verification/security run on a different model
  family from the Codex-backed builders.
- Consequences: SFD-2026-006 is unchanged — the Learning Agent stays read-only
  and proposal-driven. Each acpx-Claude agent still resolves a base OpenClaw
  gateway model to start its turn, so all agents remain dependent on that base
  model's auth being healthy; a true Claude *model* provider
  (`anthropic` / `github-copilot`) is not configured on the current machine and
  would need founder-supplied credentials. Reverting is
  `openclaw agents delete learning research` plus restoring
  `~/.openclaw/openclaw.json.before-learning-research-agents`.

## SFD-2026-008 — Repository is main-only; every change lands via a PR

- Date: 2026-09-08
- Status: Accepted
- Decision: `main` is the single canonical and permanent branch. Every
  repository change, from any actor (founder/manual, Claude Code, Codex, Cursor,
  OpenClaw factory agents, automated recovery, QA agents, infrastructure/
  maintenance jobs), MUST be delivered through a new Pull Request targeting
  `main`. Direct pushes to `main` are prohibited. Ephemeral PR branches and
  worktrees are permitted but must stay short-lived — one coherent change, then
  PR, review/gates, merge, delete branch, delete worktree, and the next task
  starts from the new `main`. No feature, development, integration, per-agent, or
  otherwise long-lived branches or worktrees are kept as part of normal
  operation. Independent changes are separate PRs, not accumulated on a shared
  branch; unrelated work is never added to an existing PR. The full policy is
  `docs/software-factory/GIT_WORKFLOW.md`.
- Rationale: A single permanent branch with mandatory PRs keeps every change
  reviewable, auditable, and recoverable across tools, agents, and sessions, and
  removes the stale-branch and divergent-worktree failures the factory has hit
  during recovery runs.
- Consequences: Strengthens SFD-2026-001 (GitHub is the durable record) and is
  bounded by SFD-2026-003 (V1 human-merge mode) — agents still only declare work
  merge-ready and the founder merges. `factory.config.json` keeps `push-to-main`
  in `prohibitedAutonomousActions` and adds a machine-readable `gitWorkflow`
  block. The factory must track, per change, the base `main` commit, the owning
  PR and its state, whether the worktree still exists, and whether cleanup
  completed. After merge, the branch and worktree are disposable and no work
  continues from them. Agents synchronize with the latest `main` before starting
  new work.
## SFD-2026-009 — Deploy orchestrator is dry-run by default; real production deploy is founder-triggered

- Date: 2026-09-08
- Status: Proposed (architect; objective `obj-039f0f5a-deployment-capability-core`)
- Decision: The deployment capability (`factory/lib/deploy/`) runs build → test →
  deploy → smoke only when explicitly invoked by the founder (CLI / dashboard
  action). Its orchestrator takes an `allowRealDeploy` flag that defaults to
  `false`; a dry run validates the manifest, builds, and tests, then lands
  `needs_founder_action` without calling the provider's `deploy()`. The
  orchestrator is never added to `factory.config.json` `pipeline` or
  `concurrentGroups` and is never called from the 7-stage engine or the
  objective orchestrator.
- Rationale: `production-deploy` is already listed in
  `factory.config.json` `prohibitedAutonomousActions`. Keeping real deploys
  behind an explicit founder action keeps the new capability inside that policy
  with no change to the engine or its gates.
- Consequences: Automated tests exercise the state machine with a mocked
  provider and `allowRealDeploy: true`. Any future move to auto-deploy (even to a
  non-production environment) requires a new founder-approved decision. Adapter
  credentials (`VERCEL_TOKEN`, project/org ids, DB URLs) are read from
  `process.env` / the secret store only and are redacted from all persisted
  deployment state.
