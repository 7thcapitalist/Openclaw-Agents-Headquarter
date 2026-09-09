# Paperclip Audit Model Attribution

The HQ audit envelope in `factory/lib/audit/envelope.mjs` adapts the field model
from Paperclip's `activity_log` schema at commit
`6abeb67334348dcb6fde2d591a27ffc7efc7118d`:

- Source: https://github.com/paperclipai/paperclip/blob/6abeb67334348dcb6fde2d591a27ffc7efc7118d/packages/db/src/schema/activity_log.ts
- License: MIT
- Copyright: 2025 Paperclip AI

The HQ implementation is dependency-free and filesystem-native. It maps
Paperclip's actor/action/entity/run attribution into a versioned NDJSON envelope,
adds structured redaction and deterministic projection of legacy factory events,
and does not use Paperclip's PostgreSQL or Drizzle implementation.

This file is the campaign compatibility attribution until issue #79's central
provenance manifest is merged. Before this PR becomes merge-ready, its local
artifacts must also be registered in that manifest.
