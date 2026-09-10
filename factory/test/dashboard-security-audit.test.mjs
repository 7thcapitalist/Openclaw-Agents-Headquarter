// Durable audit records for privileged Headquarters actions (FCT-P0-04 req 12/13).
//
// Two obligations pull against each other: a privileged action must be
// attributable, and the record must never become a copy of the credential that
// authorized it. These tests hold both.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  auditLogPath,
  readSecurityEvents,
  recordSecurityEvent,
  redact,
  sessionHandle,
} from "../../dashboard/backend/lib/securityAudit.mjs";

function newRoot() {
  return mkdtempSync(join(tmpdir(), "hq-audit-"));
}

test("a privileged action produces an attributable record", () => {
  const root = newRoot();
  recordSecurityEvent(root, {
    action: "approval.granted",
    actor: "founder",
    taskId: "issue-42",
    sessionHandle: sessionHandle("session-abc"),
    ip: "127.0.0.1",
  });

  const events = readSecurityEvents(root);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "approval.granted");
  assert.equal(events[0].taskId, "issue-42");
  assert.equal(events[0].ip, "127.0.0.1");
  assert.ok(events[0].id, "every record needs an id");
  assert.ok(Date.parse(events[0].at), "every record needs a parseable timestamp");
});

test("the audit log is append-only across writes and readable newest-first", () => {
  const root = newRoot();
  for (let i = 0; i < 5; i += 1) {
    recordSecurityEvent(root, { action: "login.failed", details: { attempt: i } });
  }
  const events = readSecurityEvents(root);
  assert.equal(events.length, 5);
  assert.equal(events[0].details.attempt, 4, "newest record comes first");
  assert.equal(events[4].details.attempt, 0);

  // Nothing was rewritten: the raw file still holds every line.
  const raw = readFileSync(auditLogPath(root), "utf8").trim().split("\n");
  assert.equal(raw.length, 5);
});

test("signatures, keys and secrets are never written to the audit log", () => {
  const root = newRoot();
  recordSecurityEvent(root, {
    action: "approval.granted",
    details: {
      assertion: { signature: "SIGNATURE-BYTES-THAT-MUST-NOT-APPEAR", challenge: "c-1" },
      privateKey: "-----BEGIN PRIVATE KEY-----MUST-NOT-APPEAR-----END PRIVATE KEY-----",
      password: "hunter2-must-not-appear",
      csrfToken: "csrf-must-not-appear",
      nested: { deep: { secret: "deep-secret-must-not-appear" } },
      taskId: "issue-42",
    },
  });

  const text = readFileSync(auditLogPath(root), "utf8");
  for (const forbidden of [
    "SIGNATURE-BYTES-THAT-MUST-NOT-APPEAR",
    "MUST-NOT-APPEAR-----END",
    "hunter2-must-not-appear",
    "csrf-must-not-appear",
    "deep-secret-must-not-appear",
  ]) {
    assert.ok(!text.includes(forbidden), `audit log leaked ${forbidden}`);
  }
  // The non-sensitive context around it survives, or the record is useless.
  assert.ok(text.includes("issue-42"));
  assert.ok(text.includes("[redacted"), "a redaction must be visible, not silently dropped");
});

test("redact marks that a credential was present without revealing it", () => {
  const out = redact({ signature: "abc123", note: "fine" });
  assert.match(out.signature, /^\[redacted:[0-9a-f]{12}\]$/);
  assert.equal(out.note, "fine");

  // The same credential digests identically, so two events can be correlated.
  const again = redact({ signature: "abc123" });
  assert.equal(out.signature, again.signature);
  const different = redact({ signature: "different" });
  assert.notEqual(out.signature, different.signature);
});

test("redaction survives arrays, depth limits, and oversized values", () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: "too-deep" } } } } } } };
  assert.doesNotThrow(() => redact(deep));

  const arr = redact({ items: Array.from({ length: 100 }, (_, i) => ({ password: `p${i}` })) });
  assert.ok(arr.items.length <= 20, "arrays are bounded");
  assert.ok(String(arr.items[0].password).startsWith("[redacted"));

  const long = redact({ blob: "x".repeat(5000) });
  assert.ok(long.blob.length < 600, "long values are truncated");
});

test("the audit file is created with owner-only permissions", () => {
  const root = newRoot();
  recordSecurityEvent(root, { action: "login.succeeded" });
  const mode = statSync(auditLogPath(root)).mode & 0o777;
  assert.equal(mode & 0o077, 0, `audit log must not be group/world readable, got ${mode.toString(8)}`);
});

test("a corrupt audit line is surfaced rather than silently skipped", () => {
  const root = newRoot();
  recordSecurityEvent(root, { action: "login.succeeded" });
  writeFileSync(auditLogPath(root), `${readFileSync(auditLogPath(root), "utf8")}{not valid json\n`);

  const events = readSecurityEvents(root);
  assert.equal(events.length, 2);
  assert.ok(events.some((e) => e.corrupt), "a corrupt record must be visible to the founder");
});

test("session handles are stable but not the session id itself", () => {
  const a = sessionHandle("session-abc");
  assert.equal(a, sessionHandle("session-abc"), "same session → same handle");
  assert.notEqual(a, sessionHandle("session-xyz"));
  assert.ok(!a.includes("session-abc"), "the raw session id must not be recoverable");
  assert.equal(sessionHandle(null), null);
});

test("reading an audit log that does not exist yet returns nothing", () => {
  assert.deepEqual(readSecurityEvents(newRoot()), []);
});

test("events can be filtered by action", () => {
  const root = newRoot();
  recordSecurityEvent(root, { action: "login.failed" });
  recordSecurityEvent(root, { action: "approval.granted" });
  recordSecurityEvent(root, { action: "login.failed" });

  const failures = readSecurityEvents(root, { action: "login.failed" });
  assert.equal(failures.length, 2);
  assert.ok(failures.every((e) => e.action === "login.failed"));
});

test("an unwritable audit destination never breaks the calling request", () => {
  // Losing the request because the audit file cannot be written would be a worse
  // outcome than the gap; the failure goes to stderr instead.
  //
  // Make the destination genuinely unwritable by putting a FILE where the code
  // needs a directory — mkdirSync then fails ENOTDIR immediately, on any
  // platform and regardless of the running user.
  const root = newRoot();
  writeFileSync(join(root, "dashboard"), "not a directory\n");

  assert.doesNotThrow(() => {
    recordSecurityEvent(root, { action: "login.succeeded" });
  });
  // And the caller still gets a well-formed record object back.
  const record = recordSecurityEvent(root, { action: "approval.granted", taskId: "issue-42" });
  assert.equal(record.action, "approval.granted");
  assert.equal(record.taskId, "issue-42");
});
