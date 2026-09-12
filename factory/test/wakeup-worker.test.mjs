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

// ── the re-wake throttle at the worker boundary (#157) ───────────────────────

import { readThrottleConfig } from "../lib/hq/rewake-throttle.mjs";

// One clock for the throttle tests: the queue only hands out a wakeup whose
// `notBefore` has passed, so the fixture's dispatch times, the enqueue time and
// the worker's clock all have to agree or the worker just reports `idle`.
const CLOCK = "2026-09-10T12:00:00.000Z";
const clockPlus = (minutes) => new Date(Date.parse(CLOCK) + minutes * 60_000).toISOString();

function stallingTask(root, taskId, runs, completedAt = CLOCK) {
  const dir = join(root, "tasks", taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    version: 1,
    task: { id: taskId, project: "hq", risk: "low", outcome: "x", acceptanceCriteria: ["a"], workType: "backend" },
    repo: "/tmp/repo", branch: `factory/${taskId}`, worktree: "/tmp/wt",
    status: "active", currentStage: "builder", assignments: { builder: "codex" },
    stages: {}, events: [],
    dispatches: Array.from({ length: runs }, (_, i) => ({
      id: `d${i}`, stage: "builder", actor: "codex", outcome: "pass",
      startedAt: completedAt, completedAt,
    })),
    createdAt: CLOCK, updatedAt: completedAt,
  }));
  return dir;
}

test("with no throttle config the worker behaves exactly as before", async () => {
  const root = mkdtempSync(join(tmpdir(), "wakeup-throttle-off-"));
  const stateRoot = join(root, "state");
  stallingTask(stateRoot, "t1", 9);
  const queuePath = join(stateRoot, "wakeups.json");
  enqueueWakeup(queuePath, { source: "schedule", taskRef: "t1", actorId: "codex", idempotencyKey: "k1", notBefore: CLOCK });

  const result = await processNextWakeup({ hqRoot: root, stateRoot, queuePath, run: async () => ({ ok: true }), now: () => clockPlus(1) });
  assert.equal(result.status, "processed", "an unconfigured throttle must never hold work back");
});

test("enforce mode defers a fruitless re-wake without spending a retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "wakeup-throttle-on-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  writeFileSync(join(root, "factory", "rewake-throttle.json"), JSON.stringify({ version: 1, mode: "enforce", threshold: 2, baseCooldownMs: 600_000 }));
  const stateRoot = join(root, "state");
  stallingTask(stateRoot, "t1", 5);
  const queuePath = join(stateRoot, "wakeups.json");
  enqueueWakeup(queuePath, { source: "schedule", taskRef: "t1", actorId: "codex", idempotencyKey: "k1", notBefore: CLOCK });

  let ran = 0;
  const result = await processNextWakeup({
    hqRoot: root, stateRoot, queuePath,
    run: async () => { ran += 1; return { ok: true }; },
    now: () => clockPlus(1),
  });

  assert.equal(result.status, "throttled");
  assert.equal(ran, 0, "no agent session is paid for");

  const [item] = readWakeupQueue(queuePath).items;
  assert.equal(item.status, "queued", "the wakeup is returned, not failed");
  assert.equal(item.attempt, 0, "a deferral is not a failure and must not consume a retry");
  assert.ok(item.notBefore > clockPlus(1), "it is reconsidered after the cooldown");
  assert.ok(item.deferredAt);
});

test("report mode records the verdict and still runs the work", async () => {
  const root = mkdtempSync(join(tmpdir(), "wakeup-throttle-report-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  writeFileSync(join(root, "factory", "rewake-throttle.json"), JSON.stringify({ version: 1, mode: "report", threshold: 2 }));
  const stateRoot = join(root, "state");
  stallingTask(stateRoot, "t1", 5);
  const queuePath = join(stateRoot, "wakeups.json");
  enqueueWakeup(queuePath, { source: "schedule", taskRef: "t1", actorId: "codex", idempotencyKey: "k1", notBefore: CLOCK });

  const result = await processNextWakeup({ hqRoot: root, stateRoot, queuePath, run: async () => ({ ok: true }), now: () => clockPlus(1) });
  assert.equal(result.status, "processed");
  assert.equal(result.throttle.wouldThrottle, true, "the verdict is recorded even though the work ran");
});

test("a founder's manual wake is never deferred", async () => {
  const root = mkdtempSync(join(tmpdir(), "wakeup-throttle-manual-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  writeFileSync(join(root, "factory", "rewake-throttle.json"), JSON.stringify({ version: 1, mode: "enforce", threshold: 2 }));
  const stateRoot = join(root, "state");
  stallingTask(stateRoot, "t1", 9);
  const queuePath = join(stateRoot, "wakeups.json");
  enqueueWakeup(queuePath, { source: "manual", taskRef: "t1", actorId: "codex", idempotencyKey: "k1", notBefore: CLOCK });

  assert.equal((await processNextWakeup({ hqRoot: root, stateRoot, queuePath, run: async () => ({ ok: true }), now: () => clockPlus(1) })).status, "processed");
});

test("a broken throttle config lets the work through rather than stalling the factory", async () => {
  const root = mkdtempSync(join(tmpdir(), "wakeup-throttle-broken-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  writeFileSync(join(root, "factory", "rewake-throttle.json"), "{ truncated");
  const stateRoot = join(root, "state");
  stallingTask(stateRoot, "t1", 9);
  const queuePath = join(stateRoot, "wakeups.json");
  enqueueWakeup(queuePath, { source: "schedule", taskRef: "t1", actorId: "codex", idempotencyKey: "k1", notBefore: CLOCK });

  const result = await processNextWakeup({ hqRoot: root, stateRoot, queuePath, run: async () => ({ ok: true }), now: () => clockPlus(1) });
  assert.equal(result.status, "processed", "a throttle that cannot be read must not become an outage");
  assert.match(result.throttle.reason, /throttle-unavailable/);
  assert.equal(readThrottleConfig(root, { path: join(root, "factory", "missing.json") }).mode, "off");
});
