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

## Rollback

Revert the PR. `.openclaw-factory/telemetry/cost-events.ndjson` becomes inert
data that nothing reads. The ledger is append-only and derived from dispatch
records, so no canonical state depends on it and nothing has to be rebuilt.
Cost views that read it degrade to unavailable rather than to zero.

## Gate telemetry format (SOF-79)

Every paid gate dispatch (`reviewer`, `qa`, `security`) that completes or fails
writes exactly one line to `<HQ_ROOT>/.openclaw-factory/telemetry/cost-events.ndjson`
(eventId `cost:<dispatchId>`, idempotent). Each line is one JSON `cost-event`
v1 object (see `factory/lib/hq/cost-ledger.mjs`): `provider`, `model`,
`inputTokens`, `cachedInputTokens`, `outputTokens`, `costMicros` (1e-6 USD, `null`
when unpriced), `costConfidence`, and the correlation keys `taskId`, `stage`,
`runId`, `dispatchId`, `agentId`.

When the harness reports no usage, the event is still written with zero tokens,
`provider`/`model` `unknown`, `usageConfidence`/`costConfidence` `unavailable`
and `costMicros: null`, so calls stay countable and are never summed as free.
`HQ_ROOT` must be writable; a write failure is returned as `recorded: false`
and never fails the dispatch.

Per-run table (read-only; `--split` gives before/after totals, e.g. SOF-12):

    node scripts/hq-cost-by-run.mjs --hq-root <HQ_ROOT> --split 2026-10-22T23:03:06Z
