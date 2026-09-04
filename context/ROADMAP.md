<!--
  Ordered milestones. Maintainer: founder + the project intelligence layer.
  Keep exactly one milestone under "Current milestone".
-->

# Roadmap

## Current milestone

**Intelligence layer Phase 1 — project context + decision classifier.** Every
stage handoff carries factory + project context; any tool can classify a
judgement call against `factory/decision-protocol.json`. Blocker: none.

## Next

1. Phase 2 — decision queue: `open/answer/accept/reject/expire`, a `DECISIONS.md`
   appender, and folding `founderControlPlane.resolveFounderDecision` in as one
   writer.
2. Phase 3 — five deterministic sensors + `scripts/factory-sense.mjs` on a cron.
3. GitHub label/webhook -> OpenClaw invocation of the dispatcher.
4. PR creation/update and durable review-comment sync.

## Later

- Phase 4 — per-project digest artefact and optional read-only model-assisted
  sensing.
- Daily/weekly founder digest.
- A considered path to auto-merge for low-risk work (requires a new founder
  decision).

## Deferred / explicitly not doing

- UI for the intelligence layer — the dashboard consumes JSON later.
- Centralising per-project context under HQ — context lives in each project repo.
- Replacing or extending the workflow state machine.
