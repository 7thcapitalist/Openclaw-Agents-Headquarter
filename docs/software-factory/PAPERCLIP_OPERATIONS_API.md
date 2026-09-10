# Factory operations API

Authenticated `GET /api/hq/operations` returns a bounded, read-only projection
of task liveness, current agent ownership, leases, wakeup health, recent audit
events, and normalized costs. It reads private runtime files but returns only
allow-listed identifiers, statuses, timestamps, short reasons, and aggregates.
It never returns prompts, handoffs, arbitrary wakeup context, credentials, or
raw OpenClaw responses.

Optional projection corruption is degraded explicitly through `available` and
`warnings`; canonical task discovery continues. The endpoint does not repair or
mutate runtime data.

## Rollback

Revert the PR. `GET /api/hq/operations` disappears; the dashboard panel that
reads it degrades to its unavailable state rather than erroring. The endpoint is
read-only and derives everything from files other capabilities write, so no
state has to be repaired.
