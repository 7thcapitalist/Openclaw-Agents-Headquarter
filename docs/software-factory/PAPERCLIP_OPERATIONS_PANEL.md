# Today factory operations panel

The Today view includes a compact read-only Factory control panel for active
runs, current leases, queued wakeups, dead letters, task liveness, attributed
events, and recorded tokens. It consumes `/api/hq/operations` and shows an
honest unavailable/degraded state when that endpoint or an optional projection
cannot be read. It does not offer merge, deploy, lease override, or queue
mutation controls.
