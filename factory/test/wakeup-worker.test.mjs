import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { enqueueWakeup, readWakeupQueue } from "../lib/wakeups/queue.mjs";
import { processNextWakeup } from "../lib/wakeups/worker.mjs";

function setup(maxAttempts = 3) {
  const root = mkdtempSync(join(tmpdir(), "wakeup-worker-"));
  const stateRoot = join(root, "state");
  const queuePath = join(stateRoot, "wakeups.json");
  const taskDir = join(stateRoot, "tasks", "task-1");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "state.json"), "{}\n");
  enqueueWakeup(queuePath, { source: "assignment", taskRef: "task-1", actorId: "builder", idempotencyKey: "assign:task-1", maxAttempts }, { id: () => "wake-1", now: () => "2026-09-09T10:00:00.000Z" });
  return { root, stateRoot, queuePath };
}

test("claims, leases, runs, completes, and releases", async () => {
  const f = setup();
  let sawLease = false;
  const result = await processNextWakeup({ hqRoot: f.root, stateRoot: f.stateRoot, queuePath: f.queuePath, now: () => "2026-09-09T10:01:00.000Z", run: async () => {
    sawLease = existsSync(join(f.stateRoot, "leases", "task-1.lease", "lease.json"));
    return { status: "active" };
  } });
  assert.equal(result.status, "processed", JSON.stringify(result));
  assert.equal(sawLease, true);
  assert.equal(existsSync(join(f.stateRoot, "leases", "task-1.lease")), false);
  assert.equal(readWakeupQueue(f.queuePath).items[0].status, "succeeded");
});

test("failure is retryable and becomes a dead letter at the bound", async () => {
  const f = setup(2);
  const run = async () => { throw new Error("gateway unavailable"); };
  let result = await processNextWakeup({ hqRoot: f.root, stateRoot: f.stateRoot, queuePath: f.queuePath, now: () => "2026-09-09T10:01:00.000Z", run });
  assert.equal(result.status, "retry");
  result = await processNextWakeup({ hqRoot: f.root, stateRoot: f.stateRoot, queuePath: f.queuePath, now: () => "2026-09-09T10:02:00.000Z", run });
  assert.equal(result.status, "dead-letter");
  assert.equal(readWakeupQueue(f.queuePath).items[0].attempt, 2);
});

test("missing task state fails without arbitrary command execution", async () => {
  const f = setup(1);
  const missing = join(f.stateRoot, "tasks", "task-1", "state.json");
  await import("fs").then(({ unlinkSync }) => unlinkSync(missing));
  let called = false;
  const result = await processNextWakeup({ hqRoot: f.root, stateRoot: f.stateRoot, queuePath: f.queuePath, now: () => "2026-09-09T10:01:00.000Z", run: async () => { called = true; } });
  assert.equal(result.status, "dead-letter");
  assert.equal(called, false);
});

test("empty queue is idle", async () => {
  const root = mkdtempSync(join(tmpdir(), "wakeup-empty-"));
  assert.deepEqual(await processNextWakeup({ hqRoot: root, stateRoot: root, queuePath: join(root, "queue.json") }), { status: "idle" });
});
