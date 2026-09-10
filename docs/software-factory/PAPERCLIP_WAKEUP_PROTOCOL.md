# Paperclip-Derived Wakeup Protocol

HQ's durable wakeup queue adapts Paperclip's `agent_wakeup_requests` fields and
idempotent delivery behavior from commit
`6abeb67334348dcb6fde2d591a27ffc7efc7118d` (MIT, Copyright 2025 Paperclip AI):

https://github.com/paperclipai/paperclip/blob/6abeb67334348dcb6fde2d591a27ffc7efc7118d/packages/db/src/schema/agent_wakeup_requests.ts

HQ stores a narrow request—source, task reference, intended agent, idempotency
key, not-before time, context reference, attempt bound, and lifecycle metadata.
It deliberately has no command or arbitrary payload field. OpenClaw claims and
dispatches requests; workers do not poll Paperclip and the queue cannot expand
execution authority. State is private, atomic, restart-safe JSON with bounded
dead-letter behavior.

Central provenance registration is required during the pre-merge refresh after
issue #79 lands.

## Rollback

Revert the PR. `wakeups.json` becomes inert data. Queued wakeups are
identifier-only records that nothing acts on without the worker, so removing the
queue strands no work — the tasks they referenced are resumable through the
ordinary paths.
