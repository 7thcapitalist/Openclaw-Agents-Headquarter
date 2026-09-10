import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CIRCUIT_STATES, acceptInbound, connectorEvent, connectorHealth, dueEvents,
  enqueue, outboxPaths, readConnectorState, readOutbox, reconcile, recordAttempt, setCursor,
} from "../lib/integrations/connector-outbox.mjs";

const T0 = "2026-09-10T00:00:00.000Z";
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const paths = () => outboxPaths(mkdtempSync(join(tmpdir(), "hq-outbox-")));
const event = (over = {}) => connectorEvent({
  kind: "task.completed", subjectType: "task", subjectId: "task-1",
  occurredAt: T0, revision: 1, digest: "abc", ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// The property that makes this safe to merge: it cannot talk to anything.
// ─────────────────────────────────────────────────────────────────────────────

test("the module has no network capability at all", () => {
  const source = readFileSync(new URL("../lib/integrations/connector-outbox.mjs", import.meta.url), "utf8");
  const code = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  for (const forbidden of ["fetch(", "node:http", '"http"', '"https"', '"net"', '"tls"', "child_process", "XMLHttpRequest", "WebSocket"]) {
    assert.equal(code.includes(forbidden), false, `${forbidden} must not appear: this module is bookkeeping, not a client`);
  }
  // Imports are exactly the three it needs.
  const imports = [...code.matchAll(/from "([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual([...new Set(imports)], ["crypto", "fs", "path"]);
});

test("health states plainly that nothing is enabled or connected", () => {
  const health = connectorHealth(paths());
  assert.equal(health.enabled, false);
  assert.equal(health.transport, "none");
});

test("an outbox row holds a digest, never content", () => {
  const row = event({ digest: "sha256-of-the-thing" });
  assert.equal(row.digest, "sha256-of-the-thing");
  assert.equal(row.payload, undefined);
  assert.equal(row.body, undefined);
  assert.equal(row.content, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Identity and idempotency
// ─────────────────────────────────────────────────────────────────────────────

test("identity comes from what happened, not from when it was noticed", () => {
  assert.equal(event({ occurredAt: T0 }).eventId, event({ occurredAt: at(60) }).eventId);
});

test("the same fact enqueued twice is one row", () => {
  const p = paths();
  assert.equal(enqueue(p, event()).accepted, true);
  const second = enqueue(p, event());
  assert.equal(second.accepted, false);
  assert.equal(second.duplicate, true);
  assert.equal(readOutbox(p.events).length, 1);
});

test("a new revision of the same subject is a new row", () => {
  const p = paths();
  enqueue(p, event({ revision: 1 }));
  enqueue(p, event({ revision: 2 }));
  assert.equal(readOutbox(p.events).length, 2);
});

test("a changed digest at the same revision is recognised as a different fact", () => {
  assert.notEqual(event({ digest: "a" }).idempotencyKey, event({ digest: "b" }).idempotencyKey);
});

test("malformed identities are rejected rather than normalised", () => {
  assert.throws(() => event({ subjectId: "../escape" }), /subjectId is invalid/);
  assert.throws(() => event({ kind: "" }), /kind is invalid/);
  assert.throws(() => event({ occurredAt: "not-a-time" }), /occurredAt must be an ISO timestamp/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Delivery accounting — performed by a caller, recorded here
// ─────────────────────────────────────────────────────────────────────────────

test("a failure schedules an exponentially later retry, with a ceiling", () => {
  const p = paths();
  const row = event();
  enqueue(p, row);

  const first = recordAttempt(p, { eventId: row.eventId, outcome: "failed", error: "connection refused", now: T0 });
  assert.equal(first.status, "failed");
  assert.equal(first.attempts, 1);
  assert.equal(first.nextAttemptAt, at(0.5), "30s after the first failure");

  const second = recordAttempt(p, { eventId: row.eventId, outcome: "failed", now: T0 });
  assert.equal(second.nextAttemptAt, at(1), "60s after the second");

  // The ceiling holds even for an absurd attempt count.
  const capped = recordAttempt(p, { eventId: row.eventId, outcome: "failed", now: T0, maxAttempts: 100, baseBackoffMs: 1e9 });
  assert.ok(Date.parse(capped.nextAttemptAt) - Date.parse(T0) <= 6 * 60 * 60 * 1000);
});

test("retries are bounded and end in a dead letter, not an infinite loop", () => {
  const p = paths();
  const row = event();
  enqueue(p, row);
  let last;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    last = recordAttempt(p, { eventId: row.eventId, outcome: "failed", error: "nope", now: T0 });
  }
  assert.equal(last.status, "dead-letter");
  assert.equal(last.attempts, 5);
  assert.equal(last.nextAttemptAt, null);
  assert.equal(dueEvents(p, { now: at(1000) }).length, 0, "a dead letter is never retried");
});

test("a delivered row is never attempted again", () => {
  const p = paths();
  const row = event();
  enqueue(p, row);
  recordAttempt(p, { eventId: row.eventId, outcome: "delivered", now: T0 });
  assert.deepEqual(dueEvents(p, { now: at(1000) }), []);
});

test("a row is not due before its backoff elapses", () => {
  const p = paths();
  const row = event();
  enqueue(p, row);
  recordAttempt(p, { eventId: row.eventId, outcome: "failed", now: T0 });
  assert.equal(dueEvents(p, { now: at(0.4) }).length, 0);
  assert.equal(dueEvents(p, { now: at(1) }).length, 1);
});

test("recording an outcome for an unknown event is refused", () => {
  assert.throws(() => recordAttempt(paths(), { eventId: "nope", outcome: "delivered" }), /Unknown outbox event/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Circuit breaker
// ─────────────────────────────────────────────────────────────────────────────

test("repeated failures open the circuit and stop handing out work", () => {
  const p = paths();
  for (let index = 0; index < 5; index += 1) {
    const row = event({ subjectId: `task-${index}` });
    enqueue(p, row);
    recordAttempt(p, { eventId: row.eventId, outcome: "failed", now: T0 });
  }
  assert.equal(connectorHealth(p, { now: T0 }).circuit.state, "open");
  // Inside the cooldown: the rows are overdue by their own backoff, and the
  // circuit still hands out nothing. (Past the cooldown it half-opens — see the
  // next test — so the time here has to be inside it.)
  assert.deepEqual(dueEvents(p, { now: at(5) }), [], "an open circuit hands out nothing, however overdue the rows are");
});

test("after the cooldown the circuit half-opens for a probe", () => {
  const p = paths();
  for (let index = 0; index < 5; index += 1) {
    const row = event({ subjectId: `task-${index}` });
    enqueue(p, row);
    recordAttempt(p, { eventId: row.eventId, outcome: "failed", now: T0 });
  }
  assert.equal(connectorHealth(p, { now: at(16) }).circuit.state, "half-open");
  assert.ok(dueEvents(p, { now: at(16) }).length > 0, "a half-open circuit allows work through");
  assert.ok(CIRCUIT_STATES.includes("half-open"));
});

test("one success closes the circuit", () => {
  const p = paths();
  const rows = [];
  for (let index = 0; index < 5; index += 1) {
    const row = event({ subjectId: `task-${index}` });
    rows.push(row);
    enqueue(p, row);
    recordAttempt(p, { eventId: row.eventId, outcome: "failed", now: T0 });
  }
  recordAttempt(p, { eventId: rows[0].eventId, outcome: "delivered", now: at(16) });
  const health = connectorHealth(p, { now: at(16) });
  assert.equal(health.circuit.state, "closed");
  assert.equal(health.circuit.consecutiveFailures, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Inbound replay protection
// ─────────────────────────────────────────────────────────────────────────────

test("a nonce is single-use", () => {
  const p = paths();
  assert.equal(acceptInbound(p, { nonce: "n1", occurredAt: T0, now: T0 }).accepted, true);
  const replay = acceptInbound(p, { nonce: "n1", occurredAt: T0, now: T0 });
  assert.equal(replay.accepted, false);
  assert.equal(replay.reason, "replayed-nonce");
});

test("a message far outside the clock skew is refused in both directions", () => {
  const p = paths();
  assert.equal(acceptInbound(p, { nonce: "old", occurredAt: at(-60), now: T0 }).reason, "outside-clock-skew");
  assert.equal(acceptInbound(p, { nonce: "future", occurredAt: at(60), now: T0 }).reason, "outside-clock-skew");
  assert.equal(acceptInbound(p, { nonce: "bad-time", occurredAt: "nope", now: T0 }).reason, "invalid-timestamp");
});

test("a hostile nonce is rejected before it is stored", () => {
  assert.throws(() => acceptInbound(paths(), { nonce: "../../etc/passwd", occurredAt: T0, now: T0 }), /nonce is invalid/);
});

test("the nonce window is bounded", () => {
  const p = paths();
  for (let index = 0; index < 1100; index += 1) {
    acceptInbound(p, { nonce: `n${index}`, occurredAt: T0, now: T0 });
  }
  assert.equal(readConnectorState(p.state).seenNonces.length, 1000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Restart, cursors, drift
// ─────────────────────────────────────────────────────────────────────────────

test("state after a restart is rebuilt from the log, with no separate checkpoint to corrupt", () => {
  const p = paths();
  const row = event();
  enqueue(p, row);
  recordAttempt(p, { eventId: row.eventId, outcome: "failed", now: T0 });
  recordAttempt(p, { eventId: row.eventId, outcome: "delivered", now: at(1) });

  // A fresh read of the same files — as a restarted process would do.
  const rebuilt = readOutbox(p.events);
  assert.equal(rebuilt.length, 1, "the append-only log collapses to one row per event");
  assert.equal(rebuilt[0].status, "delivered");
  assert.equal(rebuilt[0].attempts, 2);
});

test("a corrupt state file loses the circuit, never the outbox", () => {
  const p = paths();
  enqueue(p, event());
  writeFileSync(p.state, "{ truncated");
  const health = connectorHealth(p, { now: T0 });
  assert.equal(health.total, 1, "the log is the record");
  assert.equal(health.available, false);
  assert.match(health.warnings.join(" "), /connector state file is unreadable/);
});

test("a corrupt outbox line is reported rather than silently skipped", () => {
  const p = paths();
  enqueue(p, event());
  writeFileSync(p.events, `${readFileSync(p.events, "utf8")}{ truncated\n`);
  assert.throws(() => readOutbox(p.events), /Invalid outbox line 2/);
  const health = connectorHealth(p, { now: T0 });
  assert.equal(health.available, false);
  assert.match(health.warnings.join(" "), /outbox unreadable/);
});

test("cursors persist and are namespaced", () => {
  const p = paths();
  setCursor(p, "tasks", "2026-09-10T00:00:00.000Z");
  setCursor(p, "costs", "42");
  assert.deepEqual(readConnectorState(p.state).cursors, { tasks: "2026-09-10T00:00:00.000Z", costs: "42" });
  assert.throws(() => setCursor(p, "../escape", "1"), /cursor name is invalid/);
});

test("reconciliation reports drift in both directions and repairs nothing", () => {
  const p = paths();
  const delivered = event({ subjectId: "task-1", revision: 1 });
  enqueue(p, delivered);
  recordAttempt(p, { eventId: delivered.eventId, outcome: "delivered", now: T0 });

  const before = readFileSync(p.events, "utf8");
  const report = reconcile({
    paths: p,
    local: [
      { subject: { type: "task", id: "task-1" }, revision: 2 },
      { subject: { type: "task", id: "task-2" }, revision: 1 },
    ],
  });

  assert.equal(report.readOnly, true);
  assert.deepEqual(report.drift.map((item) => item.kind).sort(), ["never-delivered", "revision-mismatch"]);
  assert.equal(readFileSync(p.events, "utf8"), before, "reconciliation writes nothing");
});

test("something delivered that HQ no longer knows about is drift too", () => {
  const p = paths();
  const row = event({ subjectId: "task-gone" });
  enqueue(p, row);
  recordAttempt(p, { eventId: row.eventId, outcome: "delivered", now: T0 });
  const report = reconcile({ paths: p, local: [] });
  assert.deepEqual(report.drift.map((item) => item.kind), ["delivered-but-unknown-locally"]);
});

test("health reports dead letters with identity and reason, and no payload", () => {
  const p = paths();
  const row = event();
  enqueue(p, row);
  for (let index = 0; index < 5; index += 1) recordAttempt(p, { eventId: row.eventId, outcome: "failed", error: "connection refused to example.invalid", now: T0 });

  const health = connectorHealth(p, { now: T0 });
  assert.equal(health.counts["dead-letter"], 1);
  assert.equal(health.deadLetters[0].attempts, 5);
  assert.match(health.deadLetters[0].lastError, /connection refused/);
  assert.equal(health.deadLetters[0].digest, undefined);
});
