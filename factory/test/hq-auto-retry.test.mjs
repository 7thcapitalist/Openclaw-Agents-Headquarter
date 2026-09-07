import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retryStuckTasks } from "../lib/hq/auto-retry.mjs";

function hqRoot() {
  const root = mkdtempSync(join(tmpdir(), "hq-auto-retry-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  writeFileSync(join(root, "factory", "factory.config.json"), JSON.stringify({ version: 1, openclawIntegration: { maxAttemptsPerStage: 3 } }));
  return root;
}

function writeTask(stateRoot, id, { status, blocker, autoRetries }) {
  const dir = join(stateRoot, "proj", "tasks", id);
  mkdirSync(dir, { recursive: true });
  const state = {
    version: 1, status,
    task: { id, project: "proj", risk: "low" },
    repo: "/tmp/proj", branch: `factory/${id}`, worktree: `/tmp/wt/${id}`,
    currentStage: blocker?.stage || "release",
    assignments: { product: "openclaw", architect: "claude", builder: "codex", reviewer: "claude", qa: "claude", security: "claude", release: "openclaw" },
    stages: { release: { status: status === "blocked" ? "pending" : "pass" } },
    dispatches: [], events: [],
    ...(blocker ? { blocker } : {}),
    ...(autoRetries != null ? { autoRetries } : {}),
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
  return join(dir, "state.json");
}

test("retryStuckTasks resumes infra-blocked tasks, bumps the counter, and stops at max", async () => {
  const root = hqRoot();
  const stateRoot = join(root, "state");

  const infraPath = writeTask(stateRoot, "task-infra", { status: "blocked", blocker: { outcome: "fail", stage: "release", summary: "Agent did not write its result file: x-release-3.json", at: "2026-09-07T00:00:00Z" } });
  writeTask(stateRoot, "task-hard", { status: "blocked", blocker: { outcome: "fail", stage: "qa", summary: "QA: acceptance criteria not met", at: "2026-09-07T00:00:00Z" } });
  writeTask(stateRoot, "task-decision", { status: "blocked", blocker: { outcome: "decision-required", stage: "architect", summary: "pick one", at: "2026-09-07T00:00:00Z" } });
  writeTask(stateRoot, "task-active", { status: "active" });
  writeTask(stateRoot, "task-exhausted", { status: "blocked", autoRetries: 3, blocker: { outcome: "fail", stage: "release", summary: "timed out", at: "2026-09-07T00:00:00Z" } });

  const driven = [];
  const runTask = async ({ statePath }) => { driven.push(statePath); return { status: "merge-ready" }; };

  const out = await retryStuckTasks({ hqRoot: root, stateRoot, max: 3, runTask, execute: async () => {} });

  // only the infra task was driven
  assert.deepEqual(driven, [infraPath]);
  assert.equal(out.retried.length, 1);
  assert.equal(out.retried[0].taskId, "task-infra");
  assert.equal(out.retried[0].status, "merge-ready");

  // the exhausted one is reported as skipped, not retried
  assert.ok(out.skipped.some((s) => s.taskId === "task-exhausted" && /budget/.test(s.reason)));

  // counter bumped + event recorded on the infra task
  const after = JSON.parse(readFileSync(infraPath, "utf8"));
  assert.equal(after.autoRetries, 1);
  assert.equal(after.status, "active");
  assert.ok(after.events.some((e) => e.type === "auto-retry" && e.attempt === 1));
});

test("a second sweep bumps to 2; a fourth is refused", async () => {
  const root = hqRoot();
  const stateRoot = join(root, "state");
  const p = writeTask(stateRoot, "task-x", { status: "blocked", autoRetries: 2, blocker: { outcome: "fail", stage: "release", summary: "no result file", at: "2026-09-07T00:00:00Z" } });
  // Simulate a run that fails again: re-block the task but keep the bumped counter.
  const runTask = async ({ statePath }) => {
    const s = JSON.parse(readFileSync(statePath, "utf8"));
    s.status = "blocked";
    s.blocker = { outcome: "fail", stage: "release", summary: "no result file", at: "2026-09-07T00:00:01Z" };
    writeFileSync(statePath, JSON.stringify(s, null, 2));
    return { status: "blocked" };
  };

  const first = await retryStuckTasks({ hqRoot: root, stateRoot, max: 3, runTask, execute: async () => {} });
  assert.equal(first.retried.length, 1);
  assert.equal(JSON.parse(readFileSync(p, "utf8")).autoRetries, 3);

  const second = await retryStuckTasks({ hqRoot: root, stateRoot, max: 3, runTask, execute: async () => {} });
  assert.equal(second.retried.length, 0);
  assert.ok(second.skipped.some((s) => s.taskId === "task-x"));
});
