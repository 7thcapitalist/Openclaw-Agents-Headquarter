# Refusing a durable file we do not understand

Adapted from the discipline underneath Paperclip's migration-safety tooling
(`packages/db/src/check-migration-safety.ts`, `migration-snapshot-drift.test.ts`)
at pinned commit `6abeb67334348dcb6fde2d591a27ffc7efc7118d` under MIT. See
`factory/third-party/provenance.json`. Issue #159.

## What was taken, and what was not

Upstream runs static safety rules over 270 SQL migrations — loop mutation on a
large table, unbatched full-table mutation, non-concurrent index creation — and
asserts that the declared schema and the applied migrations agree.

HQ has no SQL migrations, so the scanner is not the transferable part. The rule
underneath it is: **never operate on a durable file whose format you do not
understand.**

## What was actually true here

Every HQ durable artifact carries `version: 1`. Five readers checked it — the
wakeup queue, leases, cost events, audit events, interactions — in five
different ways, none of which named the file, the version found, or the version
supported. `"Invalid wakeup queue"` is what an operator got.

The rest did not check at all. The goal, budget and permission registries read
past `parsed.version` and returned their own `version: 1`. Canonical task and
objective state never looked. So a `version: 2` file written by a newer HQ would
be parsed by an older one and **silently misread** — the worst of the three
possible outcomes, because a confidently wrong projection looks exactly like a
correct one.

#145 added a SQLite state authority whose format will change, which makes that a
matter of time rather than taste.

## The rule

`factory/lib/store/durable-version.mjs` holds one registry of every durable
format and the highest version this code can read, and one function that
enforces it:

| Version found | Result |
| --- | --- |
| absent | **the floor (1)** — exactly today's behaviour |
| 1 … max | accepted, read exactly as today |
| above max | `UnsupportedVersionError`, naming the file, the version found and the version supported |
| anything else | a malformed file, reported as corruption — not as the future |

**A missing version is not an error.** Operator-authored registry files omit it
today and are accepted today; refusing them would turn a hardening change into
an outage on config the operator already wrote.

**Corruption and the future are different failures.** `isUnsupportedVersion`
tells them apart, so a panel can say "this file is newer than this HQ" rather
than "this file is broken" — different words, different fix.

## Coverage

Twelve formats, all at version 1: task state, objective state, the wakeup queue,
task leases, the goal / budget / permission registries, connector state, and the
audit, cost, interaction and connector-outbox ledgers.

Task and objective state both flow through `readTransactionalState`, so the
check sits at the SQLite authority itself and covers both — and covers every
future format change to that store.

## The one deliberate exception

`readConnectorState` **degrades** instead of throwing. Connector state is a
cache of cursor and circuit position and the outbox log is the record, so losing
the cache is recoverable while throwing would strand deliverable events. It
returns `degraded: true` with the reason — and, critically, does **not** merge
fields it does not understand over the defaults, because that is how a cursor
silently moves.

## Degradation, not an outage

A refusal reaches the operator as a panel that reports itself unavailable with
the reason. Verified for the goals, budget and permissions snapshots: each
reports `available: false` and names both versions. The factory keeps running.

## The guard that keeps this from decaying

`factory/test/durable-versions.test.mjs` walks `DURABLE_FORMATS`, writes each
file **with HQ's own writers**, version-bumps it, and asserts the reader refuses
with a typed error naming the file. Its last test asserts the reader table
covers the format registry exactly — so **a durable format cannot be added
without a reader that performs the check**.

That last test is the point. Everything else proves the rule holds today; that
one keeps it from decaying one new file at a time.

## Rollback

Revert the PR. Every reader returns to its previous behaviour; no durable file
is written, migrated or touched by any of this.
