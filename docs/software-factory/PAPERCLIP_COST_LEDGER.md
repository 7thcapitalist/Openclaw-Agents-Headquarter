# Paperclip-Derived Cost Ledger

The append-only HQ cost ledger adapts Paperclip's `cost_events` schema from
commit `6abeb67334348dcb6fde2d591a27ffc7efc7118d`:

https://github.com/paperclipai/paperclip/blob/6abeb67334348dcb6fde2d591a27ffc7efc7118d/packages/db/src/schema/cost_events.ts

Paperclip is MIT licensed, Copyright (c) 2025 Paperclip AI. HQ adds stable source
event identities, micro-dollar precision, pricing/confidence metadata, factory
correlation dimensions, corrections, and reversals. History is never rewritten;
effective totals ignore superseded or reversed records. This PR adds the ledger
without replacing the existing dashboard cost API. Compatibility wiring happens
after its campaign dependencies merge.

Central provenance registration is required during pre-merge refresh after #79.
