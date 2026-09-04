import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { collectTaskRecords, toTaskRecord } from "../lib/learning/evidence.mjs";

function stateRoot() {
  return mkdtempSync(join(tmpdir(), "learn-evidence-"));
}

function writeTask(root, id, state) {
  const dir = join(root, "tasks", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1, task: { id }, ...state }), "utf8");
  return dir;
}

const baseState = {
  repo: "/demo",
  worktree: "/nonexistent-worktree",
  branch: "factory/x",
  assignments: { product: "openclaw", architect: "claude", builder: "codex", reviewer: "claude", qa: "codex", security: "claude", release: "openclaw" },
  stages: {},
  dispatches: [],
  events: [],
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T02:00:00Z",
};

test("collectTaskRecords only returns terminal tasks and computes cycle time", () => {
  const root = stateRoot();
  writeTask(root, "issue-1", { ...baseState, status: "merge-ready" });
  writeTask(root, "issue-2", { ...baseState, status: "active" });
  writeTask(root, "issue-3", { ...baseState, status: "blocked", blocker: { stage: "builder", outcome: "fail", at: "x" } });
  const { records } = collectTaskRecords({ factoryStateRoot: root });
  assert.deepEqual(records.map((r) => r.id).sort(), ["issue-1", "issue-3"]);
  const one = records.find((r) => r.id === "issue-1");
  assert.equal(one.cycleMs, 2 * 3600 * 1000);
  assert.equal(one.terminalStatus, "merge-ready");
});

test("collectTaskRecords honours project and since filters and records skips", () => {
  const root = stateRoot();
  writeTask(root, "issue-1", { ...baseState, task: { id: "issue-1", project: "alpha" }, status: "merge-ready", updatedAt: "2026-09-01T00:00:00Z" });
  writeTask(root, "issue-2", { ...baseState, task: { id: "issue-2", project: "beta" }, status: "merge-ready", updatedAt: "2026-09-10T00:00:00Z" });
  const badDir = join(root, "tasks", "broken");
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, "state.json"), "{ not json", "utf8");

  const filtered = collectTaskRecords({ factoryStateRoot: root, project: "beta" });
  assert.deepEqual(filtered.records.map((r) => r.id), ["issue-2"]);

  const sinceFiltered = collectTaskRecords({ factoryStateRoot: root, since: "2026-09-05T00:00:00Z" });
  assert.deepEqual(sinceFiltered.records.map((r) => r.id), ["issue-2"]);
  assert.ok(sinceFiltered.skipped.some((s) => /unreadable/.test(s.reason)));
});

test("toTaskRecord normalizes dispatches, retries, decisions, and redacts summaries", () => {
  const record = toTaskRecord({
    version: 1,
    task: { id: "issue-9", project: "p", risk: "medium", workType: "backend" },
    repo: "/demo",
    worktree: "/nonexistent",
    status: "blocked",
    assignments: { builder: "codex", reviewer: "claude", qa: "codex" },
    stages: {
      builder: { status: "fail", actor: "codex", summary: "leaked sk-abcdefghijklmnopqrstuvwxyz012345 in logs" },
    },
    dispatches: [
      { id: "d1", stage: "builder", actor: "codex", attempt: 1, outcome: "fail", status: "completed", summary: "first try failed" },
      { id: "d2", stage: "builder", actor: "codex", attempt: 2, outcome: "fail", status: "completed", summary: "second try failed" },
    ],
    events: [
      { at: "2026-09-01T00:00:00Z", type: "task-created", stage: "product" },
      { at: "2026-09-01T01:00:00Z", type: "stage-decision-required", stage: "architect", actor: "system" },
      { at: "2026-09-01T05:00:00Z", type: "founder-decision-recorded", stage: "architect", actor: "founder" },
    ],
    blocker: { stage: "architect", outcome: "decision-required", at: "2026-09-01T01:00:00Z" },
    founderDecisions: [{ at: "2026-09-01T05:00:00Z", direction: "use local storage", blocker: { stage: "architect" } }],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T06:00:00Z",
  }, "/tmp/x/state.json");

  assert.equal(record.retryByStage.builder, 1);
  assert.equal(record.failedDispatches.length, 2);
  assert.equal(record.decisionEvents.length, 2);
  assert.ok(!JSON.stringify(record).includes("sk-abcdefghijklmnop"));
  assert.equal(record.founderDecisions[0].direction, "use local storage");
});
