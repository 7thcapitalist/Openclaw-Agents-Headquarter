import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { claimNextWakeup, enqueueWakeup, finishWakeup, readWakeupQueue, wakeupQueueHealth } from "../lib/wakeups/queue.mjs";
const path = () => join(mkdtempSync(join(tmpdir(), "hq-wakeup-")), "queue.json");
const clock = (value) => () => value;

test("enqueue is idempotent and stores no arbitrary command", () => {
  const file = path(); const input = { source: "assignment", taskRef: "task-1", actorId: "agent-1", idempotencyKey: "assign:1" };
  const one = enqueueWakeup(file, input, { now: clock("2026-09-09T20:00:00Z"), id: () => "wake-1" });
  const two = enqueueWakeup(file, input, { now: clock("2026-09-09T20:01:00Z"), id: () => "wake-2" });
  assert.equal(one.wakeupId, "wake-1"); assert.equal(two.wakeupId, "wake-1"); assert.equal(two.duplicate, true); assert.equal(readWakeupQueue(file).items.length, 1);
  assert.throws(() => enqueueWakeup(file, { ...input, idempotencyKey: "bad", command: "rm" }), /commands|payloads/);
});

test("claim respects notBefore and deterministic order", () => {
  const file = path(); const base = { source: "schedule", actorId: "agent", maxAttempts: 2 };
  enqueueWakeup(file, { ...base, taskRef: "later", idempotencyKey: "later", notBefore: "2026-09-10T00:00:00Z" }, { now: clock("2026-09-09T20:00:00Z"), id: () => "later" });
  enqueueWakeup(file, { ...base, taskRef: "ready", idempotencyKey: "ready" }, { now: clock("2026-09-09T20:00:00Z"), id: () => "ready" });
  assert.equal(claimNextWakeup(file, { actorId: "openclaw", now: clock("2026-09-09T21:00:00Z") }).taskRef, "ready");
});

test("failures retry within bounds then dead-letter; restart preserves state", () => {
  const file = path(); enqueueWakeup(file, { source: "recovery", taskRef: "task", actorId: "agent", idempotencyKey: "recovery:1", maxAttempts: 2 }, { now: clock("2026-09-09T20:00:00Z"), id: () => "wake" });
  claimNextWakeup(file, { actorId: "openclaw", now: clock("2026-09-09T20:01:00Z") });
  assert.equal(finishWakeup(file, { wakeupId: "wake", actorId: "openclaw", outcome: "failed", error: "temporary", now: clock("2026-09-09T20:02:00Z") }).status, "queued");
  claimNextWakeup(file, { actorId: "openclaw", now: clock("2026-09-09T20:03:00Z") });
  assert.equal(finishWakeup(file, { wakeupId: "wake", actorId: "openclaw", outcome: "failed", error: "again", now: clock("2026-09-09T20:04:00Z") }).status, "dead-letter");
  assert.equal(wakeupQueueHealth(file).counts["dead-letter"], 1); assert.equal(readWakeupQueue(file).items[0].attempt, 2);
});

test("only the claiming dispatcher can finish a wakeup", () => {
  const file = path(); enqueueWakeup(file, { source: "manual", taskRef: "task", actorId: "agent", idempotencyKey: "manual:1" }); claimNextWakeup(file, { actorId: "openclaw", now: clock("2026-09-09T20:00:00Z") });
  assert.throws(() => finishWakeup(file, { wakeupId: readWakeupQueue(file).items[0].wakeupId, actorId: "other", outcome: "succeeded" }), /not claimed/);
});
