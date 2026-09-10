import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { appendAuditEvent, createAuditEvent, projectAuditEvents, projectTaskEvents, readAuditEvents, validateAuditEvent } from "../lib/audit/envelope.mjs";

const fixed = { now: () => "2026-09-09T20:00:00.000Z", id: () => "event-1" };

test("creates an attributed event and redacts nested secret-like values", () => {
  const event = createAuditEvent({ actor: { type: "agent", id: "backend-builder" }, action: "task.stage-completed", subject: { type: "task", id: "issue-80" }, correlation: { dispatchId: "dispatch-1" }, data: { nested: { token: "ghp_abcdefghijklmnopqrstuvwxyz123456" } } }, fixed);
  assert.equal(event.actor.id, "backend-builder");
  assert.match(event.data.nested.token, /\[redacted: gh-token\]/);
  assert.doesNotMatch(JSON.stringify(event), /ghp_abcdefghijklmnopqrstuvwxyz/);
});

test("append-only NDJSON ledger round-trips and uses private permissions", () => {
  const path = join(mkdtempSync(join(tmpdir(), "hq-audit-")), "audit.ndjson");
  const first = createAuditEvent({ actor: { type: "human", id: "founder" }, action: "decision.recorded", subject: { type: "decision", id: "d-1" } }, fixed);
  const second = createAuditEvent({ eventId: "event-2", occurredAt: "2026-09-09T20:01:00Z", actor: { type: "system", id: "factory" }, action: "task.resumed", subject: { type: "task", id: "t-1" } });
  appendAuditEvent(path, first); appendAuditEvent(path, second);
  assert.deepEqual(readAuditEvents(path), [first, second]);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 2);
});

test("validation fails closed for malformed attribution and unknown fields", () => {
  assert.throws(() => validateAuditEvent({ ...createAuditEvent({ actor: { type: "system", id: "factory" }, action: "task.created", subject: { type: "task", id: "t-1" } }, fixed), surprise: true }), /surprise is not allowed/);
  assert.throws(() => createAuditEvent({ actor: { type: "plugin", id: "x" }, action: "BAD ACTION", subject: { type: "secret", id: "x" } }, fixed), /actor.type is invalid/);
});

test("legacy task events project deterministically without mutating state", () => {
  const state = { task: { id: "issue-80" }, events: [{ at: "2026-09-09T10:00:00Z", type: "stage-pass", stage: "qa", actor: "qa", outcome: "pass" }] };
  const before = JSON.stringify(state);
  const one = projectTaskEvents(state, fixed);
  const two = projectTaskEvents(state, fixed);
  assert.deepEqual(one, two);
  assert.equal(JSON.stringify(state), before);
  assert.equal(one[0].action, "stage.pass");
  assert.equal(one[0].correlation.stage, "qa");
});

test("projection order is deterministic for equal timestamps", () => {
  const base = { version: 1, occurredAt: "2026-09-09T20:00:00Z", actor: { type: "system", id: "factory" }, action: "task.created", subject: { type: "task", id: "t" }, correlation: {}, data: {} };
  assert.deepEqual(projectAuditEvents([{ ...base, eventId: "b" }, { ...base, eventId: "a" }]).map((x) => x.eventId), ["a", "b"]);
});
