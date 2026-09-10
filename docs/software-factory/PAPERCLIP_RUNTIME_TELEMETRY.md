# Paperclip-derived runtime telemetry

The factory now projects real OpenClaw dispatch transitions into three
operator-facing, rebuildable telemetry artifacts:

- `audit.ndjson` beside each task `state.json`, with actor, subject, action,
  and task/dispatch/stage correlation;
- `liveness.json` beside each task state, recording whether its latest run is
  active, yielded, advanced, blocked, failed, or completed;
- `.openclaw-factory/telemetry/cost-events.ndjson`, containing idempotent,
  normalized provider usage and optional provider-reported cost.

These files are private runtime data and are ignored by Git. Canonical workflow
state remains the task state file and GitHub remains the delivery authority.
Projection failures are deliberately contained: observability must never turn a
successful stage into a failed stage or bypass recovery and approval gates.

The shapes reuse the audit, liveness, and cost concepts adapted from Paperclip
at pinned commit `6abeb67334348dcb6fde2d591a27ffc7efc7118d` under MIT. The HQ
adapter adds deterministic dispatch identifiers, local-only storage, redaction,
idempotent cost ingestion, and the existing `./run.sh`/OpenClaw boundaries.

## Operations

No toggle or external service is required. Telemetry starts when the factory
runner processes a dispatch. Delete only the projection files to rebuild or
reset visibility; never delete canonical `state.json`. A missing or malformed
projection is reported as unavailable by consumers and must not mutate task
state.
