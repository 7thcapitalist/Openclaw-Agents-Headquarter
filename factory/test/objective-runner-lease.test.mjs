// Knowing whether an objective's runner is still alive.
//
// obj-154e9b39, 2026-09-16: builder passed 19:28:04Z, dashboard restarted
// 19:31:29Z. The reconciler found the task written three minutes earlier and,
// with no way to know its runner had died, presumed it live — the 90-minute age
// guard — and it only ran at boot, so it never looked again. "Running" for
// eleven hours with nothing running.
//
// obj-c58897c0, 2026-09-15: both build nodes merged, integration reconciled by
// hand to `skipped` because its work landed another way. Nothing writes
// `complete` except the end of a run, so it read "active" indefinitely — and a
// run would have redone the integration whose store grew to 403 GiB.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";

import { createState, writeState } from "../lib/task-workflow.mjs";
import { readObjState, runObjective } from "../lib/objective/orchestrator.mjs";
import { beginRun, endRun, processStartTicks, runnerIdentity, runnerStatus } from "../lib/objective/runner-lease.mjs";
import { resumeStrandedObjectives } from "../lib/hq/objective-reconciler.mjs";

const root = () => mkdtempSync(join(tmpdir(), "runner-lease-"));

function objective(dir, id, { status = "active", nodes = {}, integration, runner } = {}) {
  const path = join(dir, "hq", "objectives", id, "objective-state.json");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    version: 1, objectiveId: id, objective: "x", project: "hq", repo: join(dir, "repo"), status, nodes,
    integration: integration || { id: `${id}-integration`, status: "pending", dependsOn: Object.keys(nodes) },
    events: [], createdAt: "2026-09-16T16:54:35.700Z", updatedAt: "2026-09-16T19:28:04.446Z",
    ...(runner ? { runner } : {}),
  }, null, 2)}\n`);
  return path;
}

// The task exactly as the restart left it: active at the reviewer, written
// three minutes before the process died.
function taskWrittenMinutesAgo(dir, taskId, minutes) {
  const worktree = join(dir, "wt", taskId);
  mkdirSync(worktree, { recursive: true });
  const state = createState({
    task: { id: taskId, issue: `local:${taskId}`, outcome: "Build.", acceptanceCriteria: ["works"], project: "hq", workType: "ops", risk: "low" },
    repo: join(dir, "repo"), branch: `factory/${taskId}`, worktree,
  });
  state.status = "active";
  state.currentStage = "reviewer";
  state.stages.reviewer = { status: "pending" };
  state.updatedAt = new Date(Date.now() - minutes * 60_000).toISOString();
  const statePath = join(dir, "hq", "tasks", taskId, "state.json");
  writeState(statePath, state);
  return statePath;
}

const DEAD_PID = 2 ** 22 - 7; // above Linux's default pid_max ceiling in practice; never alive in a test

// ── the decision ─────────────────────────────────────────────────────────────

test("runner status: no record, our live run, our finished run", () => {
  assert.equal(runnerStatus(null, "/o"), "none");
  const me = runnerIdentity();
  beginRun("/o");
  assert.equal(runnerStatus(me, "/o"), "live");
  endRun("/o");
  assert.equal(runnerStatus(me, "/o"), "gone", "our own record with no run in progress is a dead run");
});

test("runner status: another process — dead, alive, or its pid reused", () => {
  const other = { pid: 4242, processStart: "100", instance: "someone-else", host: hostname() };
  assert.equal(runnerStatus(other, "/o", { isAlive: () => false }), "gone");
  assert.equal(runnerStatus(other, "/o", { isAlive: () => true, startOf: () => "100" }), "live");
  assert.equal(runnerStatus(other, "/o", { isAlive: () => true, startOf: () => "999" }), "gone",
    "a live pid that started at a different time is a different process");
  assert.equal(runnerStatus({ ...other, host: "another-machine" }, "/o"), "unknown");
});

test("the real process start time is readable, so reuse detection works on this machine", { skip: process.platform !== "linux" }, () => {
  assert.match(String(processStartTicks(process.pid)), /^\d+$/);
  assert.equal(runnerIdentity().processStart, processStartTicks(process.pid));
});

// ── obj-154e9b39 ─────────────────────────────────────────────────────────────

test("a run killed three minutes into a stage is resumed at once when its runner is dead", async () => {
  const dir = root();
  const statePath = taskWrittenMinutesAgo(dir, "obj-t-card", 3);
  const path = objective(dir, "obj-t", {
    nodes: { "obj-t-card": { id: "obj-t-card", status: "running", dependsOn: [], statePath } },
    runner: { pid: DEAD_PID, processStart: "1", instance: "the-dashboard-that-restarted", host: hostname() },
  });
  const started = [];
  const out = await resumeStrandedObjectives({ hqRoot: null, stateRoot: dir, runObjective: async (a) => { started.push(a.objectivePath); } });
  await new Promise((r) => setImmediate(r));

  assert.equal(out.resumed.length, 1, `expected a resume, got: ${JSON.stringify(out.skipped)}`);
  assert.deepEqual(started, [path]);
  assert.equal(readObjState(path).nodes["obj-t-card"].status, "pending");
});

test("without an ownership record, the old age guard still protects a fresh task", async () => {
  // Objectives stamped before this change carry no record. For them nothing is
  // known, so the conservative behaviour is kept rather than guessed past.
  const dir = root();
  const statePath = taskWrittenMinutesAgo(dir, "obj-u-card", 3);
  objective(dir, "obj-u", { nodes: { "obj-u-card": { id: "obj-u-card", status: "running", dependsOn: [], statePath } } });
  const started = [];
  const out = await resumeStrandedObjectives({ hqRoot: null, stateRoot: dir, runObjective: async (a) => { started.push(a); } });
  assert.equal(started.length, 0);
  assert.match(out.skipped[0].reason, /still owned by a live runner/);
});

test("a run another live process is driving is never adopted — the timer is safe", async () => {
  const dir = root();
  const statePath = taskWrittenMinutesAgo(dir, "obj-v-card", 240); // old enough that age alone would adopt it
  const path = objective(dir, "obj-v", {
    nodes: {
      "obj-v-card": { id: "obj-v-card", status: "running", dependsOn: [], statePath },
      "obj-v-next": { id: "obj-v-next", status: "pending", dependsOn: [] },
    },
    runner: { pid: process.pid, processStart: processStartTicks(process.pid), instance: "a-terminal-script", host: hostname() },
  });
  const started = [];
  const out = await resumeStrandedObjectives({ hqRoot: null, stateRoot: dir, runObjective: async (a) => { started.push(a); } });
  assert.equal(started.length, 0, "a second scheduler on a live graph is the thing this must never do");
  assert.match(out.skipped[0].reason, /run in progress/);
  assert.equal(readObjState(path).nodes["obj-v-card"].status, "running");
});

test("a run leaves no ownership record behind, even when it throws", async () => {
  const dir = root();
  const cyclic = objective(dir, "obj-w", {
    nodes: {
      a: { id: "a", status: "pending", dependsOn: ["b"] },
      b: { id: "b", status: "pending", dependsOn: ["a"] },
    },
  });
  await assert.rejects(runObjective({ objectivePath: cyclic }));
  assert.equal(readObjState(cyclic).runner, undefined);
});

// ── obj-c58897c0 ─────────────────────────────────────────────────────────────

const superseded = (dir, id) => objective(dir, id, {
  nodes: {
    backend: { id: "backend", status: "gate-satisfied", dependsOn: [] },
    frontend: { id: "frontend", status: "gate-satisfied", dependsOn: ["backend"] },
  },
  integration: { id: `${id}-integration`, status: "skipped", dependsOn: ["backend", "frontend"], reason: "Superseded: landed via PR #6" },
});

test("finished work whose integration was superseded is settled complete, not left active", async () => {
  const dir = root();
  const path = superseded(dir, "obj-x");
  const started = [];
  const out = await resumeStrandedObjectives({ hqRoot: null, stateRoot: dir, runObjective: async (a) => { started.push(a); } });
  assert.equal(started.length, 0);
  assert.equal(out.skipped[0].reason, "settled as complete");
  const after = readObjState(path);
  assert.equal(after.status, "complete");
  assert.equal(after.events.at(-1).type, "objective-finished");
});

test("running such an objective never redoes the superseded integration", async () => {
  const dir = root();
  const path = superseded(dir, "obj-y");
  let dispatched = 0;
  const result = await runObjective({ objectivePath: path, execute: async () => { dispatched += 1; throw new Error("must not dispatch"); } });
  assert.equal(dispatched, 0);
  assert.equal(result.status, "complete");
  assert.equal(readObjState(path).integration.status, "skipped");
});
