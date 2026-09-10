import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { observeDispatchState, telemetryPaths } from "../lib/telemetry/dispatch.mjs";
import { readAuditEvents } from "../lib/audit/envelope.mjs";
import { readCostEvents } from "../lib/hq/cost-ledger.mjs";

function fixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "hq-telemetry-"));
  const taskDir = join(root, ".openclaw-factory", "tasks", "task-1");
  mkdirSync(taskDir, { recursive: true });
  const statePath = join(taskDir, "state.json");
  const dispatch = { id: "task-1-builder-1", stage: "builder", actor: "codex", agentId: "backend-builder", status: "completed", createdAt: "2026-09-09T10:00:00.000Z", startedAt: "2026-09-09T10:01:00.000Z", completedAt: "2026-09-09T10:02:00.000Z", outcome: "pass", summary: "Implemented and tested." };
  writeFileSync(statePath, JSON.stringify({ task: { id: "task-1", project: "hq" }, status: "active", currentStage: "reviewer", events: [], dispatches: [{ ...dispatch, ...overrides }] }));
  return { root, statePath, dispatch: { ...dispatch, ...overrides } };
}

test("records sanitized audit and liveness projections", () => {
  const f = fixture();
  const result = observeDispatchState({ hqRoot: f.root, statePath: f.statePath, phase: "completed", dispatchId: f.dispatch.id, now: () => "2026-09-09T10:02:00.000Z" });
  assert.equal(result.recorded, true);
  const paths = telemetryPaths({ hqRoot: f.root, statePath: f.statePath });
  assert.equal(readAuditEvents(paths.audit)[0].action, "dispatch.completed");
  assert.equal(JSON.parse(readFileSync(paths.liveness)).state, "advanced");
});

test("usage creates one idempotent normalized cost event", () => {
  const f = fixture();
  const agentMeta = { provider: "openai", model: "gpt-5", tokensIn: 120, tokensOut: 30, costMicros: 42 };
  observeDispatchState({ hqRoot: f.root, statePath: f.statePath, phase: "completed", dispatchId: f.dispatch.id, agentMeta });
  observeDispatchState({ hqRoot: f.root, statePath: f.statePath, phase: "completed", dispatchId: f.dispatch.id, agentMeta });
  const events = readCostEvents(telemetryPaths({ hqRoot: f.root, statePath: f.statePath }).costs);
  assert.equal(events.length, 1);
  assert.equal(events[0].costMicros, 42);
  assert.equal(readAuditEvents(telemetryPaths({ hqRoot: f.root, statePath: f.statePath }).audit).length, 1);
});

test("telemetry failures are contained", () => {
  const root = mkdtempSync(join(tmpdir(), "hq-telemetry-bad-"));
  const result = observeDispatchState({ hqRoot: root, statePath: join(root, "missing.json"), phase: "failed" });
  assert.equal(result.recorded, false);
  assert.match(result.reason, /ENOENT/);
});

test("failed and yielded runs retain distinct liveness", () => {
  const failed = fixture({ status: "failed", error: "gateway timeout" });
  let result = observeDispatchState({ hqRoot: failed.root, statePath: failed.statePath, phase: "failed", dispatchId: failed.dispatch.id });
  assert.equal(result.liveness.state, "failed");
  assert.match(result.liveness.reason, /timeout/);
  const yielded = fixture({ status: "running", yieldedAt: "2026-09-09T10:01:30.000Z" });
  result = observeDispatchState({ hqRoot: yielded.root, statePath: yielded.statePath, phase: "yielded", dispatchId: yielded.dispatch.id });
  assert.equal(result.liveness.state, "needs-followup");
  assert.match(result.liveness.nextAction, /Resume/);
});
