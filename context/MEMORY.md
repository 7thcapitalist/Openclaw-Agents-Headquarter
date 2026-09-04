<!--
  Durable, non-obvious facts about operating this repo. Newest at the bottom.
  One fact per bullet. No secrets, no personal data.
-->

# Project memory

- `writeHandoff()` in `factory/lib/handoff.mjs` is the single chokepoint every
  agent invocation flows through (initial handoff, every stage dispatch, resume,
  approve, founder-decision resume). Enrich context there, nowhere else.
- Runtime task state is written under
  `dashboard/backend/data/factory/<basename(repo)>/` — keyed by the repo
  basename, not by the task contract's `project` field. The two need
  reconciling before the sensors land (Phase 3).
- `factory/lib/*` must import Node builtins only. No npm dependency in the engine
  or the intelligence layer. Schema validation is hand-rolled in
  `factory/lib/intel/schema.mjs`; the `*.schema.json` files are reference only.
- Root `.gitignore` ignores `/MEMORY.md` (root-anchored) and `memory/` (a dir).
  `context/MEMORY.md` is neither and is correctly tracked.
- `assembleContextPack` is deterministic given a fixed `now`; it only throws for
  a structurally broken `factory/projects.json`, and `writeHandoff()` catches
  even that and degrades to a one-line note so a dispatch is never blocked.
- The Headquarters Integration Layer lives in `factory/lib/hq/` (composition
  only, Node builtins only, never throws for missing data). It reads factory
  state, it never writes it. `factory/projects.json` is now the unified project
  registry (optional `github`, `mission`, `owner`, `responsibleAgents`);
  `factory/agents.json` is the agent registry. Entry points:
  `node scripts/hq.mjs <state|projects|agents|discover|github|chief-of-staff>`
  and `GET /api/hq/company`. See `docs/software-factory/HQ_INTEGRATION_LAYER.md`.
- Project discovery (`factory/lib/hq/discovery.mjs`) only ever *proposes*
  unregistered Git repos found under `factory/hq.config.json`
  `discovery.workspaceRoots`; the founder approves by editing the registry.
- The Integration Layer joins agents to live work by matching a task's actor to
  `factory/agents.json` `harnessAgentIds` (the OpenClaw agent ids from
  `factory.config.json` `openclawIntegration.agentIds`), so one Claude entry can
  cover `architect` + `reviewer` + `security`.
