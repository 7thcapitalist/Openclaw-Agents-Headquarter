// SOF-87: synthetic events in cost-events.ndjson -> gate -> quota alert.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { observeDispatchState, telemetryPaths } from "../lib/telemetry/dispatch.mjs";
import { readAuditEvents } from "../lib/audit/envelope.mjs";
import { appendCostEvent, createCostEvent } from "../lib/hq/cost-ledger.mjs";

const QUOTA = { quotaTokens: 10000, runWarnPct: 25 }; // limit = 2500 tokens

function setup() {
  const root = mkdtempSync(join(tmpdir(), "hq-quota-gate-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  writeFileSync(join(root, "factory", "factory.config.json"), JSON.stringify({ quotaAlert: QUOTA }));
  const taskDir = join(root, ".openclaw-factory", "tasks", "task-1");
  mkdirSync(taskDir, { recursive: true });
  const statePath = join(taskDir, "state.json");
  const dispatch = { id: "task-1-builder-1", stage: "builder", actor: "codex", agentId: "b", status: "completed", createdAt: "2026-09-09T10:00:00.000Z", startedAt: "2026-09-09T10:01:00.000Z", completedAt: "2026-09-09T10:02:00.000Z", outcome: "pass", summary: "ok" };
  writeFileSync(statePath, JSON.stringify({ task: { id: "task-1", project: "hq" }, status: "active", currentStage: "reviewer", events: [], dispatches: [dispatch] }));
  return { root, statePath, dispatch, paths: telemetryPaths({ hqRoot: root, statePath }) };
}

// Writes synthetic usage events straight into cost-events.ndjson.
function seed(f, rows) {
  rows.forEach(([taskId, tokens], i) => appendCostEvent(f.paths.costs, createCostEvent({
    eventId: `synthetic-${i}`, source: "synthetic", sourceEventId: `s-${i}`, provider: "anthropic", model: "claude-x",
    inputTokens: tokens, taskId, occurredAt: "2026-09-09T10:00:00.000Z",
  })));
}

function runGate(f) {
  const r = observeDispatchState({ hqRoot: f.root, statePath: f.statePath, phase: "completed", dispatchId: f.dispatch.id });
  assert.equal(r.recorded, true);
  return readAuditEvents(f.paths.audit).filter((e) => e.action === "cost.quota-warning");
}

test("alert fires above the configured percentage, summing the run's events", () => {
  const f = setup();
  seed(f, [["task-1", 1500], ["task-1", 1500]]); // 30% > 25%
  const warnings = runGate(f);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].data.pct, 30);
  assert.equal(warnings[0].data.limitPct, 25);
  assert.equal(runGate(f).length, 1, "re-running the gate does not duplicate the alert");
});

test("no alert below or exactly at the percentage, nor from other tasks' usage", () => {
  const below = setup(); seed(below, [["task-1", 1000], ["task-1", 1000]]); // 20%
  assert.equal(runGate(below).length, 0);
  const edge = setup(); seed(edge, [["task-1", 2500]]); // exactly 25%
  assert.equal(runGate(edge).length, 0);
  const other = setup(); seed(other, [["task-1", 100], ["task-2", 9000]]);
  assert.equal(runGate(other).length, 0);
});
