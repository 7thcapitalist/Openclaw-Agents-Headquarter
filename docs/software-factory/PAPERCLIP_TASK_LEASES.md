# Paperclip-Derived Task Leases

`factory/lib/leases/task-lease.mjs` adapts Paperclip's issue checkout ownership,
same-run idempotency, and conflict behavior from:

- https://github.com/paperclipai/paperclip/blob/6abeb67334348dcb6fde2d591a27ffc7efc7118d/server/src/services/issues.ts
- https://github.com/paperclipai/paperclip/blob/6abeb67334348dcb6fde2d591a27ffc7efc7118d/docs/guides/agent-developer/heartbeat-protocol.md

Paperclip is MIT licensed, Copyright (c) 2025 Paperclip AI. HQ implements the
behavior with atomic filesystem directories rather than Paperclip's PostgreSQL
transactions. A conflict is final for the claimant and must not be blindly
retried. The primitive is for generic/non-factory work; it does not replace
factory dispatch reservation or branch/worktree ownership.

Issue #80's audit envelope is accepted through an injected callback so this
campaign PR does not duplicate its unmerged implementation. Central provenance
registration is required during the pre-merge refresh after #79 lands.

## Rollback

Revert the PR. Lease files under `<stateRoot>/leases/` become inert data.
Ownership stops being enforced, which returns HQ to its previous behaviour —
worth knowing before reverting, because the failure mode that motivated leases
(two runners driving one task) becomes possible again. No canonical state is
touched either way.
