<!--
  One-screen orientation for every agent. Maintainer: founder + agents via PR.
  Deeper detail lives in docs/software-factory/*, which this file links to.
-->

# OpenClaw Agents Headquarter

An operator-controlled operating system for running a company with AI employees.
The software factory layer turns a founder-defined outcome into bounded GitHub
work, one primary implementation owner on an isolated worktree, independent
review, QA evidence, an independent security gate, and a merge-ready
recommendation. The larger goal is an autonomous company OS where multiple AI
employees collaborate to build companies.

## Current status

V1. The deterministic task lifecycle, OpenClaw dispatch protocol, founder
control plane, and (new) project intelligence layer are in place. Final merge is
human-only.

## Current phase

Building the intelligence layer on top of the proven workflow engine — Phase 1
(project context + decision classifier) is landing now. See
`ROADMAP.md` and `docs/software-factory/PROJECT_INTELLIGENCE_SYSTEM.md`.

## How work flows here

Standard factory pipeline: product -> architect -> builder -> reviewer -> qa ->
security -> release. One task, one branch (`factory/<task-id>`), one writable
worktree. A model cannot be the sole reviewer of its own work. The founder
authorizes every merge. High-risk work needs a signed founder approval before
build.

## Map

- `VISION.md` — why this exists, the long bet, non-goals
- `MISSION.md` — what we are doing now and how we measure it
- `ROADMAP.md` — milestones and what is deferred
- `DECISIONS.md` — pointer to the canonical factory decision log
- `MEMORY.md` — hard-won facts about operating this repo
- `TECH_CONTEXT.md` — stack, constraints, "do not do"
- `USERS.md` — who operates this and what they are sensitive about
- `COMPETITIVE_CONTEXT.md` — alternatives and our wedge
- `ownership.json` — the machine mirror
- `docs/software-factory/` — full operational detail
