import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { enqueueWakeup, readWakeupQueue } from "../lib/wakeups/queue.mjs";
import { processNextWakeup } from "../lib/wakeups/worker.mjs";
import { observeDispatchState } from "../lib/telemetry/dispatch.mjs";
import { buildOperationsSnapshot } from "../lib/hq/operations.mjs";

function scenario(maxAttempts = 2) {
  const hqRoot = mkdtempSync(join(tmpdir(), "paperclip-e2e-"));
  const stateRoot = join(hqRoot, "dashboard", "backend", "data", "factory");
  const taskDir = join(stateRoot, "tasks", "task-e2e");
  const statePath = join(taskDir, "state.json");
  const queuePath = join(stateRoot, "wakeups.json");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify({ task: { id: "task-e2e", project: "hq" }, status: "active", currentStage: "reviewer", events: [], dispatches: [], currentDispatch: { id: "task-e2e-builder-1", stage: "builder", actor: "codex", agentId: "backend-builder", kind: "stage", status: "running", createdAt: "2026-09-09T10:00:00.000Z", startedAt: "2026-09-09T10:01:00.000Z" } }));
  enqueueWakeup(queuePath, { source: "assignment", taskRef: "task-e2e", actorId: "backend-builder", idempotencyKey: "e2e:task", maxAttempts }, { id: () => "wake-e2e", now: () => "2026-09-09T10:00:00.000Z" });
  return { hqRoot, stateRoot, statePath, queuePath };
}

test("wakeup -> lease -> dispatch telemetry -> dashboard projection", async () => {
  const f = scenario(); let leaseObserved = false;
  const result = await processNextWakeup({ hqRoot: f.hqRoot, stateRoot: f.stateRoot, queuePath: f.queuePath, now: () => "2026-09-09T10:03:00.000Z", run: async ({ statePath }) => {
    leaseObserved = true;
    const state = JSON.parse(readFileSync(statePath));
    const finished = { ...state.currentDispatch, status: "completed", outcome: "pass", summary: "done", completedAt: "2026-09-09T10:02:00.000Z", usage: { provider: "openai", model: "gpt-5", tokensIn: 100, tokensOut: 20 } };
    state.dispatches.push(finished); delete state.currentDispatch; writeFileSync(statePath, JSON.stringify(state));
    assert.equal(observeDispatchState({ hqRoot: f.hqRoot, statePath, phase: "completed", dispatchId: finished.id }).recorded, true);
    return { status: "active" };
  } });
  assert.equal(result.status, "processed"); assert.equal(leaseObserved, true);
  const snapshot = buildOperationsSnapshot({ hqRoot: f.hqRoot, stateRoot: f.stateRoot });
  assert.equal(snapshot.summary.inputTokens, 100); assert.equal(snapshot.audit[0].action, "dispatch.completed");
  assert.equal(snapshot.tasks[0].liveness.state, "advanced"); assert.equal(snapshot.queue.counts.succeeded, 1); assert.equal(snapshot.summary.leasedTasks, 0);
});

test("recoverable execution failure is retained for retry without false telemetry", async () => {
  const f = scenario();
  const result = await processNextWakeup({ hqRoot: f.hqRoot, stateRoot: f.stateRoot, queuePath: f.queuePath, now: () => "2026-09-09T10:03:00.000Z", run: async () => { throw new Error("synthetic gateway outage"); } });
  assert.equal(result.status, "retry");
  const queue = readWakeupQueue(f.queuePath); assert.equal(queue.items[0].status, "queued"); assert.equal(queue.items[0].attempt, 1);
  const snapshot = buildOperationsSnapshot({ hqRoot: f.hqRoot, stateRoot: f.stateRoot });
  assert.equal(snapshot.audit.length, 0); assert.equal(snapshot.summary.leasedTasks, 0);
});
