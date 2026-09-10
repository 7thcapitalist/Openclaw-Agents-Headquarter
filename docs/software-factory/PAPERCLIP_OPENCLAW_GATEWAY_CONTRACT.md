# Paperclip OpenClaw Gateway Interoperability Contract

The synthetic contract harness adapts Paperclip's first-party OpenClaw Gateway
adapter at commit `6abeb67334348dcb6fde2d591a27ffc7efc7118d`
(MIT, Copyright 2025 Paperclip AI):

https://github.com/paperclipai/paperclip/blob/6abeb67334348dcb6fde2d591a27ffc7efc7118d/packages/adapters/openclaw-gateway/src/server/execute.ts

It exercises WebSocket URL policy, challenge/device signing, pairing retry,
issue/run/fixed session routing, stable idempotency keys, structured events,
bounded waits, new sessions, duplicate runs, and revoked credentials through an
injected synthetic transport. It never contains or contacts production
credentials. Factory work remains behind `scripts/openclaw-factory.mjs` and
registered workers remain behind `./run.sh`.

Central provenance registration is required during pre-merge refresh after #79.

## Rollback

Revert the PR. This is a synthetic contract harness with no credentials, no
network calls and no runtime wiring — reverting removes tests and a
specification document and changes no behaviour. Connecting a real Gateway was
never enabled by this change and still requires a founder Decision Card.
