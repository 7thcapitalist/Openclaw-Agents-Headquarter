// Local, disabled-by-default connector reliability primitives.
//
// Adapted from Paperclip's `paperclip-cloud-connector`,
// `execution-control-reconciliation` and `managed-resource-drift` services at
// pinned commit 6abeb67334348dcb6fde2d591a27ffc7efc7118d (MIT). Issue #125.
//
// THIS MODULE CANNOT TALK TO ANYTHING. It imports `fs`, `path` and `crypto` and
// nothing else — no `fetch`, no `http`, no `https`, no `net`, no child process.
// There is no host, no URL, and no credential anywhere in it, and a test
// asserts that by reading the source. It is the bookkeeping a connector would
// need, built and proven before any connection exists, so that enabling one
// later is a reviewed decision about a network boundary rather than a rewrite
// of delivery semantics under time pressure.
//
// Delivery is performed by a CALLER that passes in a `deliver` function. The
// state machine records what happened. Nothing here decides to send anything.
//
// A live connector still requires a founder Decision Card covering host,
// network exposure, credentials, data scope, retention, resource limits, backup
// and rollback. That requirement is unaffected by this file existing.

import { createHash } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";

export const OUTBOX_STATUSES = Object.freeze(["pending", "in-flight", "delivered", "failed", "dead-letter"]);
export const CIRCUIT_STATES = Object.freeze(["closed", "open", "half-open"]);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const DEFAULT_CIRCUIT_THRESHOLD = 5;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 15 * 60 * 1000;
const NONCE_WINDOW = 1000;

export function outboxPaths(root) {
  const base = resolve(root);
  return { events: join(base, "outbox.ndjson"), state: join(base, "connector-state.json") };
}

// ------------------------------------------------------------------- outbound

// A deterministic identity for one fact. The same fact enqueued twice — by a
// retry, a replayed run, or two code paths that both noticed it — is one row.
export function connectorEvent({ kind, subjectType, subjectId, occurredAt, revision = null, digest = null }) {
  assertSafe(kind, "kind");
  assertSafe(subjectType, "subjectType");
  assertSafe(subjectId, "subjectId");
  if (!Number.isFinite(Date.parse(occurredAt || ""))) throw new Error("occurredAt must be an ISO timestamp");

  return {
    version: 1,
    // Identity is derived from WHAT happened, never from when it was noticed.
    eventId: fingerprint(kind, subjectType, subjectId, String(revision ?? "")),
    idempotencyKey: fingerprint(kind, subjectType, subjectId, String(revision ?? ""), String(digest ?? "")),
    kind,
    subject: { type: subjectType, id: subjectId },
    revision: revision == null ? null : String(revision),
    // A digest, never the content. The whole point of an outbox that has never
    // been connected to anything is that it holds no payload to leak.
    digest: digest == null ? null : String(digest).slice(0, 64),
    occurredAt,
    status: "pending",
    attempts: 0,
    lastError: null,
    nextAttemptAt: occurredAt,
    updatedAt: occurredAt,
  };
}

export function enqueue(paths, event) {
  const rows = readOutbox(paths.events);
  const duplicate = rows.find((row) => row.idempotencyKey === event.idempotencyKey);
  if (duplicate) return { accepted: false, duplicate: true, event: duplicate };
  mkdirSync(dirname(resolve(paths.events)), { recursive: true, mode: 0o700 });
  appendFileSync(paths.events, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  return { accepted: true, duplicate: false, event };
}

export function readOutbox(path) {
  if (!existsSync(path)) return [];
  // Append-only log, last write per eventId wins. Replaying the file rebuilds
  // exact state after a restart with no separate checkpoint to corrupt.
  const byId = new Map();
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  for (const [index, line] of lines.entries()) {
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid outbox line ${index + 1}: ${error.message}`);
    }
    if (!OUTBOX_STATUSES.includes(row.status)) throw new Error(`Invalid outbox line ${index + 1}: unknown status`);
    byId.set(row.eventId, row);
  }
  return [...byId.values()];
}

// Which rows a caller may attempt right now. Respects per-row backoff and the
// circuit breaker, so a caller cannot accidentally hammer a failing endpoint by
// looping over the whole outbox.
export function dueEvents(paths, { now = new Date().toISOString(), limit = 10 } = {}) {
  const state = readConnectorState(paths.state);
  if (circuitAt(state, now) === "open") return [];
  return readOutbox(paths.events)
    .filter((row) => (row.status === "pending" || row.status === "failed") && row.nextAttemptAt <= now)
    .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt) || a.eventId.localeCompare(b.eventId))
    .slice(0, Math.max(1, Math.min(100, limit)));
}

// Record the outcome of one delivery a CALLER performed. Never performs one.
export function recordAttempt(paths, { eventId, outcome, error = null, now = new Date().toISOString(), maxAttempts = DEFAULT_MAX_ATTEMPTS, baseBackoffMs = DEFAULT_BASE_BACKOFF_MS }) {
  if (!["delivered", "failed"].includes(outcome)) throw new Error("outcome must be delivered or failed");
  const row = readOutbox(paths.events).find((item) => item.eventId === eventId);
  if (!row) throw new Error(`Unknown outbox event '${eventId}'`);

  const attempts = row.attempts + 1;
  const next = outcome === "delivered"
    ? { ...row, status: "delivered", attempts, lastError: null, nextAttemptAt: null, deliveredAt: now, updatedAt: now }
    : attempts >= maxAttempts
      ? { ...row, status: "dead-letter", attempts, lastError: trim(error), nextAttemptAt: null, updatedAt: now }
      : { ...row, status: "failed", attempts, lastError: trim(error), nextAttemptAt: backoffFrom(now, attempts, baseBackoffMs), updatedAt: now };

  appendFileSync(paths.events, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  writeConnectorState(paths.state, applyCircuit(readConnectorState(paths.state), outcome, now));
  return next;
}

// --------------------------------------------------------------------- inbound

// Inbound replay protection. A nonce is single-use; a repeat is refused rather
// than processed twice. Bounded so the window cannot grow without limit.
export function acceptInbound(paths, { nonce, occurredAt, now = new Date().toISOString(), maxSkewMs = 5 * 60_000 }) {
  assertSafe(nonce, "nonce");
  const state = readConnectorState(paths.state);

  if (state.seenNonces.includes(nonce)) return { accepted: false, reason: "replayed-nonce" };
  const at = Date.parse(occurredAt || "");
  if (!Number.isFinite(at)) return { accepted: false, reason: "invalid-timestamp" };
  // A message from far in the past or future is refused: an unbounded window is
  // no window at all.
  if (Math.abs(Date.parse(now) - at) > maxSkewMs) return { accepted: false, reason: "outside-clock-skew" };

  writeConnectorState(paths.state, {
    ...state,
    seenNonces: [...state.seenNonces, nonce].slice(-NONCE_WINDOW),
    inboundAcceptedAt: now,
  });
  return { accepted: true, reason: "accepted" };
}

// ------------------------------------------------------------- cursors, state

export function readConnectorState(path) {
  if (!existsSync(path)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      ...emptyState(),
      ...parsed,
      seenNonces: Array.isArray(parsed.seenNonces) ? parsed.seenNonces.slice(-NONCE_WINDOW) : [],
      cursors: parsed.cursors && typeof parsed.cursors === "object" ? parsed.cursors : {},
    };
  } catch {
    // A corrupt state file must not lose the outbox. State is a cache of
    // circuit and cursor position; the log is the record.
    return { ...emptyState(), degraded: true };
  }
}

export function setCursor(paths, name, position) {
  assertSafe(name, "cursor name");
  const state = readConnectorState(paths.state);
  writeConnectorState(paths.state, { ...state, cursors: { ...state.cursors, [name]: String(position) } });
  return readConnectorState(paths.state).cursors;
}

// --------------------------------------------------------------- observability

// What an operator needs to see, with no payload in it — because there is none
// to show. Counts, identities, statuses, and the circuit.
export function connectorHealth(paths, { now = new Date().toISOString() } = {}) {
  const warnings = [];
  let rows = [];
  try {
    rows = readOutbox(paths.events);
  } catch (error) {
    warnings.push(`outbox unreadable: ${error.message}`);
  }
  const state = readConnectorState(paths.state);
  if (state.degraded) warnings.push("connector state file is unreadable; circuit and cursors were reset");

  const counts = Object.fromEntries(OUTBOX_STATUSES.map((status) => [status, rows.filter((row) => row.status === status).length]));
  const oldestPending = rows
    .filter((row) => row.status === "pending" || row.status === "failed")
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))[0] || null;

  return {
    version: 1,
    // Restated at the top: nothing here has ever been connected to anything.
    enabled: false,
    transport: "none",
    available: warnings.length === 0,
    warnings,
    counts,
    total: rows.length,
    oldestPendingAt: oldestPending?.occurredAt || null,
    circuit: { state: circuitAt(state, now), consecutiveFailures: state.consecutiveFailures, openedAt: state.circuitOpenedAt },
    cursors: state.cursors,
    inboundAcceptedAt: state.inboundAcceptedAt,
    deadLetters: rows.filter((row) => row.status === "dead-letter").map((row) => ({
      eventId: row.eventId, kind: row.kind, subject: row.subject, attempts: row.attempts, lastError: row.lastError,
    })),
  };
}

// Read-only drift: what HQ believes, versus what the outbox says was delivered.
// Reports; repairs nothing, because a reconciliation that writes is a second
// authority over canonical state.
export function reconcile({ paths, local }) {
  const delivered = new Map();
  let rows = [];
  try {
    rows = readOutbox(paths.events);
  } catch (error) {
    return { version: 1, readOnly: true, available: false, reason: String(error?.message || error), drift: [] };
  }
  for (const row of rows.filter((item) => item.status === "delivered")) delivered.set(subjectKey(row.subject), row);

  const drift = [];
  for (const item of local || []) {
    const key = subjectKey(item.subject);
    const row = delivered.get(key);
    if (!row) {
      drift.push({ subject: item.subject, kind: "never-delivered", localRevision: item.revision ?? null, deliveredRevision: null });
      continue;
    }
    if (String(item.revision ?? "") !== String(row.revision ?? "")) {
      drift.push({ subject: item.subject, kind: "revision-mismatch", localRevision: item.revision ?? null, deliveredRevision: row.revision });
    }
  }

  const localKeys = new Set((local || []).map((item) => subjectKey(item.subject)));
  for (const [key, row] of delivered) {
    if (!localKeys.has(key)) drift.push({ subject: row.subject, kind: "delivered-but-unknown-locally", localRevision: null, deliveredRevision: row.revision });
  }

  return { version: 1, readOnly: true, available: true, checked: (local || []).length, drift };
}

// ------------------------------------------------------------------ internals

function emptyState() {
  return {
    version: 1,
    consecutiveFailures: 0,
    circuitOpenedAt: null,
    cursors: {},
    seenNonces: [],
    inboundAcceptedAt: null,
    degraded: false,
  };
}

function writeConnectorState(path, state) {
  mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function applyCircuit(state, outcome, now, { threshold = DEFAULT_CIRCUIT_THRESHOLD } = {}) {
  if (outcome === "delivered") return { ...state, consecutiveFailures: 0, circuitOpenedAt: null };
  const consecutiveFailures = state.consecutiveFailures + 1;
  const opened = consecutiveFailures >= threshold ? (state.circuitOpenedAt || now) : state.circuitOpenedAt;
  return { ...state, consecutiveFailures, circuitOpenedAt: opened };
}

// `half-open` is a real state, not decoration: after the cooldown a caller is
// allowed exactly one probe, and its outcome either closes the circuit or
// re-opens it.
function circuitAt(state, now, { cooldownMs = DEFAULT_CIRCUIT_COOLDOWN_MS } = {}) {
  if (!state.circuitOpenedAt) return "closed";
  const openedAt = Date.parse(state.circuitOpenedAt);
  const at = Date.parse(now);
  if (!Number.isFinite(openedAt) || !Number.isFinite(at)) return "open";
  return at - openedAt >= cooldownMs ? "half-open" : "open";
}

// Exponential with a ceiling, so a long outage does not schedule a retry years
// out and quietly strand the row.
function backoffFrom(now, attempts, baseMs) {
  const delay = Math.min(MAX_BACKOFF_MS, baseMs * (2 ** (attempts - 1)));
  return new Date(Date.parse(now) + delay).toISOString();
}

function subjectKey(subject) {
  return `${subject?.type || "?"}:${subject?.id || "?"}`;
}

function fingerprint(...parts) {
  return createHash("sha256").update(parts.join(String.fromCharCode(31))).digest("hex").slice(0, 32);
}

function trim(value) {
  return value == null ? null : String(value).replace(/\s+/g, " ").trim().slice(0, 300);
}

function assertSafe(value, label) {
  const text = String(value ?? "");
  if (!SAFE_ID.test(text)) throw new Error(`${label} is invalid`);
  if (text.split("/").some((segment) => segment === "." || segment === "..")) throw new Error(`${label} is invalid`);
}
