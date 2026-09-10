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

function writeTask(stateRoot, id, { status, blocker, autoRetries, updatedAt, currentStage, currentDispatch }) {
  const dir = join(stateRoot, "proj", "tasks", id);
  mkdirSync(dir, { recursive: true });
  const stage = currentStage || blocker?.stage || "release";
  const state = {
    version: 1, status,
    task: { id, project: "proj", risk: "low" },
    repo: "/tmp/proj", branch: `factory/${id}`, worktree: `/tmp/wt/${id}`,
    currentStage: stage,
    assignments: { product: "openclaw", architect: "claude", builder: "codex", reviewer: "claude", qa: "claude", security: "claude", release: "openclaw" },
    stages: { [stage]: { status: status === "blocked" ? "pending" : "pass" } },
    dispatches: [], events: [],
    ...(updatedAt ? { updatedAt } : {}),
    ...(currentDispatch ? { currentDispatch } : {}),
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

test("an `active` task orphaned by a host restart is revived; a fresh `active` task is left alone", async () => {
  const root = hqRoot();
  const stateRoot = join(root, "state");
  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

  const staleWithDispatch = writeTask(stateRoot, "task-stale-dispatch", {
    status: "active", currentStage: "release", updatedAt: iso(120 * 60 * 1000),
    currentDispatch: { id: "task-stale-dispatch-release-4", stage: "release", status: "running", startedAt: iso(120 * 60 * 1000) },
  });
  const stalePlain = writeTask(stateRoot, "task-stale-plain", {
    status: "active", currentStage: "reviewer", updatedAt: iso(100 * 60 * 1000),
  });
  writeTask(stateRoot, "task-fresh", { status: "active", currentStage: "builder", updatedAt: iso(5 * 60 * 1000) });
  writeTask(stateRoot, "task-notime", { status: "active", currentStage: "builder" }); // no updatedAt -> untouched

  const driven = [];
  const runTask = async ({ statePath }) => { driven.push(statePath); return { status: "merge-ready" }; };

  const out = await retryStuckTasks({ hqRoot: root, stateRoot, max: 3, runTask, execute: async () => {} });

  assert.deepEqual(driven.sort(), [stalePlain, staleWithDispatch].sort());
  assert.equal(out.retried.length, 2);
  assert.ok(out.retried.every((r) => /orphaned/.test(r.reason)));

  // the stuck dispatch was cleared and the stage re-armed
  const revived = JSON.parse(readFileSync(staleWithDispatch, "utf8"));
  assert.equal(revived.currentDispatch, undefined);
  assert.equal(revived.stages.release.status, "pending");
  assert.equal(revived.autoRetries, 1);
  assert.ok(revived.events.some((e) => e.type === "auto-retry" && /orphaned/.test(e.reason)));

  // fresh + timestamp-less tasks were not touched
  assert.ok(!driven.includes(join(stateRoot, "proj", "tasks", "task-fresh", "state.json")));
  assert.equal(JSON.parse(readFileSync(join(stateRoot, "proj", "tasks", "task-notime", "state.json"), "utf8")).autoRetries, undefined);
});

test("auto-retry reconciles a stale owning objective node", async () => {
  const root = hqRoot();
  const stateRoot = join(root, "state");
  const taskPath = writeTask(stateRoot, "task-objective", {
    status: "blocked",
    blocker: { outcome: "fail", stage: "builder", summary: "agent did not write its result file" },
    currentStage: "builder",
  });
  const objectiveDir = join(stateRoot, "proj", "objectives", "obj-reconcile");
  mkdirSync(objectiveDir, { recursive: true });
  writeFileSync(join(objectiveDir, "objective-state.json"), JSON.stringify({
    objectiveId: "obj-reconcile", status: "blocked", nodes: {
      "task-objective": { id: "task-objective", status: "blocked", blocker: { outcome: "decision-required", summary: "stale" }, statePath: taskPath },
    }, events: [],
  }));

  await retryStuckTasks({ hqRoot: root, stateRoot, runTask: async () => ({ status: "active" }), execute: async () => {} });
  const objective = JSON.parse(readFileSync(join(objectiveDir, "objective-state.json"), "utf8"));
  assert.equal(objective.status, "active");
  assert.equal(objective.nodes["task-objective"].status, "running");
  assert.equal(objective.nodes["task-objective"].blocker, null);
  assert.equal(objective.events.at(-1).type, "node-reconciled");
});

// The auto-retry budget exists to stop a task looping on one stuck point, not
// to cap how long a task may live. It used to be counted once per task for the
// task's entire life and never reset, so a task that needed reviving three
// times during a flaky builder phase had no supervision left for the five
// stages after it — any later stall was permanent until a human noticed.
test("a passing stage restores the auto-retry allowance", async () => {
  const { completeStage } = await import("../lib/task-workflow.mjs");
  const base = {
    version: 1,
    status: "active",
    task: { id: "t", project: "p", risk: "low" },
    currentStage: "reviewer",
    assignments: { reviewer: "claude", qa: "claude" },
    stages: { reviewer: { status: "pending" }, qa: { status: "pending" } },
    dispatches: [],
    events: [],
    autoRetries: 3,
  };

  const passed = completeStage(base, {
    stage: "reviewer",
    actor: "claude",
    outcome: "pass",
    summary: "approved",
    evidence: [{ path: "evidence/r.md" }],
  });
  assert.equal(passed.autoRetries, undefined);
  assert.equal(passed.currentStage, "qa");

  // A stage that did not pass is not forward progress, so the spent budget
  // stands — otherwise a stage failing in a loop would mint supervision.
  const failed = completeStage(base, {
    stage: "reviewer",
    actor: "claude",
    outcome: "fail",
    summary: "rejected",
    evidence: [{ path: "evidence/r.md" }],
  });
  assert.equal(failed.autoRetries, 3);
});

test("a revived task that then makes progress can be revived again", async () => {
  const root = hqRoot();
  const stateRoot = join(root, "state");
  // Exhausted budget: the sweep must leave it alone.
  const path = writeTask(stateRoot, "task-spent", {
    status: "active",
    autoRetries: 3,
    updatedAt: "2026-09-07T00:00:00Z",
    currentStage: "qa",
  });
  const before = await retryStuckTasks({
    hqRoot: root,
    stateRoot,
    runTask: async () => ({ status: "active" }),
    now: () => "2026-09-07T05:00:00Z",
  });
  assert.equal(before.retried.length, 0);
  assert.equal(
    before.skipped.find((s) => s.taskId === "task-spent")?.reason,
    "auto-retry budget exhausted",
  );

  // Once a stage passes, completeStage clears the counter and the same task is
  // eligible again — which is the whole point of the fix.
  const state = JSON.parse(readFileSync(path, "utf8"));
  delete state.autoRetries;
  writeFileSync(path, JSON.stringify(state, null, 2));
  const after = await retryStuckTasks({
    hqRoot: root,
    stateRoot,
    runTask: async () => ({ status: "active" }),
    now: () => "2026-09-07T05:00:00Z",
  });
  assert.equal(after.retried.length, 1);
  assert.equal(after.retried[0].taskId, "task-spent");
});
