<!--
  The canonical factory decision log is docs/software-factory/DECISIONS.md
  (SFD-YYYY-NNN entries). This file is a pointer plus intelligence-layer-specific
  decisions that are not yet promoted there. Do not duplicate SFD entries here.
-->

# OpenClaw Factory — context decision log

Canonical log: `docs/software-factory/DECISIONS.md` (SFD-2026-001 … SFD-2026-005).

## PIS-2026-001 — Intelligence layer is inputs and reads, never a new state machine

- Date: 2026-09-03
- Status: Accepted
- Decision: The Project Intelligence System enriches handoffs and classifies
  decisions through pure functions over files and task state. It adds no
  pipeline stage and no second state machine. Its one integration point is
  `writeHandoff()`.
- Rationale: The workflow engine is proven; regressions there are expensive.
- Consequences: All intelligence code lives in `factory/lib/intel/*` and
  `scripts/project-intel.mjs`; engine files stay untouched except the single
  guarded context-pack insertion in `handoff.mjs`.

## PIS-2026-002 — Per-project context lives in each project's own repo

- Date: 2026-09-03
- Status: Accepted
- Decision: The canonical context files live under a `contextDir` (default
  `context/`) in the project's own repository, resolved through
  `factory/projects.json`. HQ holds only the registry, runtime queues, and
  digests.
- Rationale: Context should travel, version, and be reviewed with the code it
  describes (extends SFD-2026-001/004).
- Consequences: The factory is registered as its own project with
  `contextDir: "context"`; `docs/software-factory/*` stays canonical for detail
  and is linked from `context/*`.
