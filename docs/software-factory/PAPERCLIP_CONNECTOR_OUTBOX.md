# Connector outbox and reconciliation

Adapted from Paperclip's `paperclip-cloud-connector`,
`execution-control-reconciliation` and `managed-resource-drift` services at
pinned commit `6abeb67334348dcb6fde2d591a27ffc7efc7118d` under MIT. See
`factory/third-party/provenance.json`. Issue #125.

## This module cannot talk to anything

It imports `fs`, `path` and `crypto` — and nothing else. No `fetch`, no `http`,
no `https`, no `net`, no `tls`, no child process. There is no host, no URL, and
no credential anywhere in it.

That is not a claim in a comment; a test reads the source and asserts both the
absence of every network primitive and that the import list is exactly those
three. **Nothing is enabled, and `connectorHealth()` says so in the payload:
`enabled: false, transport: "none"`.**

Delivery is performed by a *caller* that supplies its own transport. This module
records what happened. Nothing here decides to send anything.

## Why build it before there is a connector

Delivery semantics — identity, idempotency, backoff, retry bounds, dead letters,
replay protection, circuit state, drift — are the part that is hard to get right
and the part nobody gets right under time pressure. Building and proving them
first means that enabling a connector later is a reviewed decision about a
**network boundary**, not a rewrite of delivery semantics while something is
already failing in production.

**A live connector still requires a founder Decision Card** covering host,
network exposure, credentials, data scope, retention, resource limits, backup
and rollback. This file existing changes none of that.

## What is stored

An outbox row holds a **digest, never content**. The whole point of an outbox
that has never been connected to anything is that it holds no payload to leak.

| Field | Meaning |
| --- | --- |
| `eventId` | Derived from kind + subject + revision — *what* happened, never when it was noticed |
| `idempotencyKey` | The above plus digest, so a changed body at the same revision is a different fact |
| `status` | `pending` → `in-flight` → `delivered` / `failed` → `dead-letter` |
| `attempts`, `nextAttemptAt`, `lastError` | Delivery accounting |

The same fact enqueued twice — by a retry, a replayed run, or two code paths
that both noticed it — is **one row**.

## Delivery accounting

- **Exponential backoff with a ceiling** (30s base, 6h max). A long outage must
  not schedule a retry years out and quietly strand the row.
- **Bounded retries ending in a dead letter**, never an infinite loop. A dead
  letter is never handed out again.
- **A circuit breaker with a real `half-open`**: five consecutive failures open
  it and `dueEvents()` returns nothing however overdue the rows are; after the
  cooldown exactly one probe is allowed through, and its outcome closes or
  re-opens the circuit.

## Inbound replay protection

A nonce is **single-use**; a repeat is refused. A message outside a five-minute
clock skew is refused in *both* directions, and an unparsable timestamp is
refused — an unbounded window is no window at all. The nonce window itself is
bounded to 1000 entries so it cannot grow without limit.

## Restart

The outbox is an append-only log; the last write per `eventId` wins. Replaying
the file rebuilds exact state with **no separate checkpoint to corrupt**. The
state file holds only circuit position and cursors, so a corrupt state file
loses the circuit — never the outbox. Both degraded conditions are reported.

## Reconciliation

`reconcile()` compares what HQ believes against what the outbox says was
delivered and reports drift in **both** directions: `never-delivered`,
`revision-mismatch`, and `delivered-but-unknown-locally`. It **repairs
nothing** — a reconciliation that writes is a second authority over canonical
state. A test asserts the log is byte-identical afterwards.

## Observability without leakage

`connectorHealth()` returns counts by status, the oldest pending event, circuit
state and consecutive failures, cursors, and dead letters with identity, attempt
count and last error. No payload appears, because none is stored.

## Rollback

Revert the PR. The outbox and state files become inert data that nothing reads.
Nothing was ever sent, because nothing here can send.
