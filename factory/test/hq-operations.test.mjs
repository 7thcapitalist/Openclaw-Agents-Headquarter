import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildOperationsSnapshot } from "../lib/hq/operations.mjs";
import { enqueueWakeup } from "../lib/wakeups/queue.mjs";
import { acquireTaskLease } from "../lib/leases/task-lease.mjs";
import { appendCostEvent, createCostEvent } from "../lib/hq/cost-ledger.mjs";

function fixture() { const hqRoot = mkdtempSync(join(tmpdir(), "hq-ops-")); const stateRoot = join(hqRoot, "state"); const taskDir = join(stateRoot, "tasks", "task-1"); mkdirSync(taskDir, { recursive: true }); writeFileSync(join(taskDir, "state.json"), JSON.stringify({ task: { id: "task-1" }, status: "active", currentStage: "builder", currentDispatch: { actor: "codex" }, updatedAt: "2026-09-09T10:00:00.000Z" })); return { hqRoot, stateRoot, taskDir }; }

test("returns explicit empty operational state", () => { const hqRoot = mkdtempSync(join(tmpdir(), "hq-ops-empty-")); const value = buildOperationsSnapshot({ hqRoot, stateRoot: join(hqRoot, "missing") }); assert.equal(value.summary.tasks, 0); assert.equal(value.summary.queuedWakeups, 0); assert.deepEqual(value.audit, []); });

test("aggregates bounded sanitized runtime operations", () => { const f = fixture(); writeFileSync(join(f.taskDir, "liveness.json"), JSON.stringify({ runId: "run-1", state: "needs-followup", reason: "working", nextAction: "continue", recordedAt: "2026-09-09T10:00:00.000Z" })); appendFileSync(join(f.taskDir, "audit.ndjson"), `${JSON.stringify({ version: 1, eventId: "event-1", occurredAt: "2026-09-09T10:00:00.000Z", actor: { type: "agent", id: "codex" }, action: "dispatch.running", subject: { type: "task", id: "task-1" }, correlation: { taskId: "task-1" }, data: {} })}\n`); enqueueWakeup(join(f.stateRoot, "wakeups.json"), { source: "manual", taskRef: "task-1", actorId: "codex", idempotencyKey: "manual:1" }); mkdirSync(join(f.stateRoot, "leases"), { recursive: true }); acquireTaskLease({ root: join(f.stateRoot, "leases"), taskId: "task-1", actorId: "worker", runId: "run-1" }); const costPath = join(f.hqRoot, ".openclaw-factory", "telemetry", "cost-events.ndjson"); appendCostEvent(costPath, createCostEvent({ source: "openclaw-factory", sourceEventId: "run-1", provider: "openai", model: "gpt-5", inputTokens: 10, outputTokens: 5, taskId: "task-1" })); const value = buildOperationsSnapshot({ hqRoot: f.hqRoot, stateRoot: f.stateRoot }); assert.equal(value.summary.activeRuns, 1); assert.equal(value.summary.leasedTasks, 1); assert.equal(value.summary.queuedWakeups, 1); assert.equal(value.summary.inputTokens, 10); assert.equal(value.audit[0].data.secret, undefined); });

test("malformed optional projections degrade without hiding canonical tasks", () => { const f = fixture(); writeFileSync(join(f.taskDir, "liveness.json"), "not-json"); writeFileSync(join(f.stateRoot, "wakeups.json"), "not-json"); const value = buildOperationsSnapshot({ hqRoot: f.hqRoot, stateRoot: f.stateRoot }); assert.equal(value.available, false); assert.equal(value.summary.tasks, 1); assert.ok(value.warnings.length >= 2); });

// A cancelled objective's last recorded graph health describes work that is
// over. Leaving it in the snapshot is how cancelled work keeps asking for the
// founder's attention from the Operations panel.
test("objective graph health is dropped once the founder cancels the objective", () => {
  const hqRoot = mkdtempSync(join(tmpdir(), "hq-ops-cancel-"));
  const stateRoot = join(hqRoot, "state");
  const objDir = join(stateRoot, "objectives", "obj-aa11bb22");
  mkdirSync(objDir, { recursive: true });
  const writeObjective = (status) => writeFileSync(join(objDir, "objective-state.json"),
    JSON.stringify({ objectiveId: "obj-aa11bb22", objective: "Try something out", status }));
  writeFileSync(join(objDir, "graph-health.json"), JSON.stringify({
    objectiveId: "obj-aa11bb22", healthy: false, recordedAt: "2026-09-15T10:00:00.000Z",
    findings: [{ severity: "high", code: "stranded-node", message: "a node is stranded", nodeIds: ["n1"], strandedNodeIds: ["n1"] }],
  }));

  writeObjective("active");
  let value = buildOperationsSnapshot({ hqRoot, stateRoot });
  assert.equal(value.objectives.length, 1);
  assert.equal(value.summary.unhealthyObjectives, 1);

  writeObjective("cancelled");
  value = buildOperationsSnapshot({ hqRoot, stateRoot });
  assert.deepEqual(value.objectives, []);
  assert.equal(value.summary.unhealthyObjectives, 0);
  assert.equal(value.summary.strandedNodes, 0);
});

// Cancelling writes the objective only; its nodes keep the status they stopped
// with. The Board is built from this task list, so on 2026-09-18 it showed
// twenty nodes of cancelled objectives as active, blocked and ready to merge,
// days after the founder had ended them.
test("the task list drops work whose objective the founder cancelled, and keeps its history", () => {
  const hqRoot = mkdtempSync(join(tmpdir(), "hq-ops-board-"));
  const stateRoot = join(hqRoot, "state");
  const project = join(stateRoot, "hq");
  const node = (id, status) => {
    const dir = join(project, "tasks", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ task: { id, project: "hq" }, status, currentStage: "builder", updatedAt: "2026-09-15T10:00:00.000Z" }));
    appendFileSync(join(dir, "audit.ndjson"), `${JSON.stringify({ version: 1, eventId: `e-${id}`, occurredAt: "2026-09-15T10:00:00.000Z", actor: { type: "agent", id: "codex" }, action: "dispatch.running", subject: { type: "task", id }, correlation: { taskId: id }, data: {} })}\n`);
  };
  const objective = (id, status, nodeIds) => {
    const dir = join(project, "objectives", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "objective-state.json"), JSON.stringify({
      objectiveId: id, status,
      nodes: Object.fromEntries(nodeIds.map((n) => [n, { id: n, status: "running" }])),
      integration: { id: `${id}-integration`, status: "pending" },
    }));
  };
  objective("obj-dead0001", "cancelled", ["obj-dead0001-a"]);
  objective("obj-live0001", "active", ["obj-live0001-a"]);
  node("obj-dead0001-a", "active");
  node("obj-dead0001-integration", "blocked");
  node("obj-live0001-a", "active");
  node("task-standalone", "blocked");

  const value = buildOperationsSnapshot({ hqRoot, stateRoot });

  assert.deepEqual(value.tasks.map((t) => t.taskId).sort(), ["obj-live0001-a", "task-standalone"]);
  assert.equal(value.summary.tasks, 2);
  assert.equal(value.summary.cancelledTasks, 2);
  // The audit feed is a record, not a to-do list: cancelled work stays in it.
  assert.ok(value.audit.some((e) => e.subject?.id === "obj-dead0001-a" || e.correlation?.taskId === "obj-dead0001-a"));
});
