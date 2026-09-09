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
