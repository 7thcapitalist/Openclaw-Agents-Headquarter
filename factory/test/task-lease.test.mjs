import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { acquireTaskLease, forceReleaseTaskLease, LeaseConflictError, readLease, releaseTaskLease, renewTaskLease } from "../lib/leases/task-lease.mjs";

const root = () => mkdtempSync(join(tmpdir(), "hq-leases-"));

test("100 contenders produce exactly one owner and conflicts are terminal", () => {
  const dir = root(); const winners = []; const conflicts = [];
  for (let i = 0; i < 100; i++) try { winners.push(acquireTaskLease({ root: dir, taskId: "task-1", actorId: `agent-${i}`, runId: `run-${i}`, id: () => `lease-${i}` })); } catch (error) { assert.ok(error instanceof LeaseConflictError); conflicts.push(error); }
  assert.equal(winners.length, 1); assert.equal(conflicts.length, 99); assert.equal(readLease(dir, "task-1").runId, "run-0");
});

test("same run acquisition is idempotent and renewal extends expiry", () => {
  const dir = root(); let time = Date.parse("2026-09-09T20:00:00Z"); const now = () => time;
  const one = acquireTaskLease({ root: dir, taskId: "task-2", actorId: "agent", runId: "run", ttlMs: 1000, now, id: () => "lease" });
  assert.deepEqual(acquireTaskLease({ root: dir, taskId: "task-2", actorId: "agent", runId: "run", ttlMs: 1000, now }), one);
  time += 500; const renewed = renewTaskLease({ root: dir, taskId: "task-2", actorId: "agent", runId: "run", ttlMs: 2000, now });
  assert.equal(Date.parse(renewed.expiresAt), time + 2000);
});

test("expired owner can be atomically replaced and every transition is audited", () => {
  const dir = root(); const events = []; let time = 100_000; const now = () => time;
  acquireTaskLease({ root: dir, taskId: "task-3", actorId: "old", runId: "old-run", ttlMs: 1000, now, id: () => "old-lease", audit: (e) => events.push(e) });
  time += 1001;
  const lease = acquireTaskLease({ root: dir, taskId: "task-3", actorId: "new", runId: "new-run", ttlMs: 1000, now, id: () => "new-lease", audit: (e) => events.push(e) });
  assert.equal(lease.actorId, "new"); assert.deepEqual(events.map((e) => e.action), ["lease.acquired", "lease.recovered"]);
});

test("only the owner releases; operator force release requires a reason", () => {
  const dir = root(); acquireTaskLease({ root: dir, taskId: "task-4", actorId: "owner", runId: "owner-run" });
  assert.throws(() => releaseTaskLease({ root: dir, taskId: "task-4", actorId: "other", runId: "other-run" }), LeaseConflictError);
  assert.throws(() => forceReleaseTaskLease({ root: dir, taskId: "task-4", operatorId: "founder", reason: "" }), /reason/);
  const events = []; forceReleaseTaskLease({ root: dir, taskId: "task-4", operatorId: "founder", reason: "manual recovery", audit: (e) => events.push(e) });
  assert.equal(readLease(dir, "task-4"), null); assert.equal(events[0].action, "lease.force-released");
});

test("malformed identifiers cannot escape the lease root", () => {
  assert.throws(() => acquireTaskLease({ root: root(), taskId: "../escape", actorId: "a", runId: "r" }), /taskId is invalid/);
});
