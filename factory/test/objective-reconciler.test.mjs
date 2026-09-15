// Objectives that nobody is running.
//
// The orchestrator is a function, not a daemon, and in production it runs
// inside the dashboard's express process. Restarting that process abandons
// every objective mid-flight: the nodes keep whatever status they held, and
// nothing looks at them again.
//
// The case that prompted this is obj-2fbb6bcd on 2026-09-15 — decomposed at
// 15:29Z into two nodes, both `pending`, no task state files, still sitting
// there four hours later. Nothing could see it: retryStuckTasks scans for task
// state files blocked on an infra-class blocker, and this objective had no task
// state files at all.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createState, writeState } from "../lib/task-workflow.mjs";
import { readObjState } from "../lib/objective/orchestrator.mjs";
import { readyNodes } from "../lib/objective/graph.mjs";
import { resumeStrandedObjectives, strandedNodes } from "../lib/hq/objective-reconciler.mjs";

function objectiveFixture(root, project, objectiveId, { status = "active", nodes = {}, integration = null } = {}) {
  const dir = join(root, project, "objectives", objectiveId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "objective-state.json");
  writeFileSync(path, `${JSON.stringify({
    version: 1, objectiveId, objective: "do the thing", project,
    repo: join(root, "repo"), status, nodes,
    integration: integration || { id: `${objectiveId}-integration`, status: "pending", dependsOn: [] },
    events: [], createdAt: "2026-09-15T15:29:16.934Z", updatedAt: "2026-09-15T15:29:16.934Z",
  }, null, 2)}\n`, "utf8");
  return path;
}

const node = (id, status, extra = {}) => ({ id, status, dependsOn: [], ...extra });

// A task state as a killed process leaves it: still `active`, with a dispatch
// that will never report. `updatedAt` decides whether anybody still owns it.
function abandonedTaskState(root, project, taskId, { updatedAt = "2026-09-15T10:00:00.000Z" } = {}) {
  const worktree = join(root, "wt", taskId);
  mkdirSync(worktree, { recursive: true });
  const state = createState({
    task: { id: taskId, issue: `local:${taskId}`, outcome: "Build the thing.", acceptanceCriteria: ["it works"], project, workType: "ops", risk: "low" },
    repo: join(root, "repo"), branch: `factory/${taskId}`, worktree,
  });
  state.status = "active";
  state.currentStage = "builder";
  state.stages.builder = { status: "in-progress" };
  state.currentDispatch = { stage: "builder", dispatchedAt: updatedAt };
  // Set before the write, never after: state.json is an export and SQLite is
  // the authority, so a hand-edit of the file readState() will not see.
  state.updatedAt = updatedAt;
  const statePath = join(root, project, "tasks", taskId, "state.json");
  writeState(statePath, state);
  return statePath;
}

function stateRoot() {
  return mkdtempSync(join(tmpdir(), "objective-reconcile-"));
}

// ── the decision, tested without a filesystem ────────────────────────────────

test("a decomposed objective whose nodes never ran is stranded", () => {
  const verdict = strandedNodes({
    status: "active",
    nodes: { a: node("a", "pending"), b: node("b", "pending") },
    integration: { id: "i", status: "pending", dependsOn: ["a", "b"] },
  });
  assert.equal(verdict.stranded, true);
  // The integration node is not ready — it waits on a and b — so it is not
  // listed. Scheduling the two build nodes is what restarts this objective.
  assert.deepEqual(verdict.nodeIds.sort(), ["a", "b"]);
});

test("a node left `running` by a killed process is stranded — nothing can be running at boot", () => {
  const verdict = strandedNodes({ status: "active", nodes: { a: node("a", "running") } });
  assert.equal(verdict.stranded, true);
  assert.deepEqual(verdict.nodeIds, ["a"]);
});

test("ready and abandoned are reported apart, because they need different handling", () => {
  // A ready node needs a scheduler. An abandoned one needs its dead dispatch
  // retired first — runObjective starts work only from `readyNodes`, which is
  // `pending` alone, so it cannot move a node that is sitting at `running`.
  const verdict = strandedNodes({
    status: "active",
    nodes: { a: node("a", "pending"), b: node("b", "running") },
    integration: { id: "i", status: "pending", dependsOn: ["a", "b"] },
  });
  assert.deepEqual(verdict.ready, ["a"]);
  assert.deepEqual(verdict.abandoned, ["b"]);
  assert.deepEqual(verdict.nodeIds.sort(), ["a", "b"]);
});

// The defect this caught, found by reading production rather than the code.
// Eight of the ten objectives on the machine on 2026-09-15 were week-old and
// `blocked`, with every build node blocked or failed and an integration node
// sitting `pending` behind them. `pending` alone would have called them
// stranded — and runObjective re-asserts `status = "active"` unconditionally,
// so all eight would have been relabelled as running work that does not exist.
test("an integration node waiting behind blocked dependencies is NOT stranded", () => {
  const verdict = strandedNodes({
    status: "blocked",
    nodes: {
      a: node("a", "blocked"),
      b: node("b", "blocked-by-dep", { dependsOn: ["a"] }),
    },
    integration: { id: "i", status: "pending", dependsOn: ["a", "b"] },
  });
  assert.equal(verdict.stranded, false, "nothing can run, so nothing is stranded");
  assert.match(verdict.reason, /no node is ready/);
});

test("an integration node whose dependencies all finished IS stranded", () => {
  const verdict = strandedNodes({
    status: "active",
    nodes: { a: node("a", "gate-satisfied"), b: node("b", "gate-satisfied") },
    integration: { id: "i", status: "pending", dependsOn: ["a", "b"] },
  });
  assert.equal(verdict.stranded, true);
  assert.deepEqual(verdict.nodeIds, ["i"]);
});

test("a pending node behind a failed dependency is not ready", () => {
  const verdict = strandedNodes({
    status: "active",
    nodes: { a: node("a", "failed"), b: node("b", "pending", { dependsOn: ["a"] }) },
    integration: { id: "i", status: "blocked" },
  });
  assert.equal(verdict.stranded, false);
});

test("a blocked node is a decision, not an interruption, and is left alone", () => {
  // This is the line that keeps the reconciler from becoming an auto-retry loop
  // by another name: re-running work that failed is the founder's call.
  const verdict = strandedNodes({
    status: "blocked",
    nodes: { a: node("a", "blocked", { blocker: { outcome: "decision-required" } }), b: node("b", "failed") },
    integration: { id: "i", status: "blocked" },
  });
  assert.equal(verdict.stranded, false);
  assert.match(verdict.reason, /no node is ready/);
});

test("a blocked objective with one released node IS resumed", () => {
  // Exactly obj-d4e18cad after its founder decision: the objective wrapper
  // still says `blocked` while the answered node has gone back to `pending`.
  const verdict = strandedNodes({
    status: "blocked",
    nodes: { a: node("a", "pending"), b: node("b", "blocked-by-dep", { dependsOn: ["a"] }) },
    integration: { id: "i", status: "pending", dependsOn: ["a", "b"] },
  });
  assert.equal(verdict.stranded, true);
  assert.deepEqual(verdict.nodeIds, ["a"], "only the released node — the integration still waits on b");
});

test("a finished objective is never restarted", () => {
  for (const status of ["complete", "completed", "cancelled", "superseded"]) {
    const verdict = strandedNodes({ status, nodes: { a: node("a", "pending") } });
    assert.equal(verdict.stranded, false, `${status} must not be resumed`);
    assert.match(verdict.reason, new RegExp(status));
  }
});

test("garbage is not stranded, it is skipped", () => {
  assert.equal(strandedNodes(null).stranded, false);
  assert.equal(strandedNodes("nonsense").stranded, false);
  assert.equal(strandedNodes({ status: "active" }).stranded, false, "no nodes at all");
});

// ── the sweep ────────────────────────────────────────────────────────────────

test("the sweep hands every stranded objective to the orchestrator, once", async () => {
  const root = stateRoot();
  objectiveFixture(root, "lifemaxing", "obj-2fbb6bcd", { nodes: { a: node("a", "pending") } });
  objectiveFixture(root, "lifemaxing", "obj-done", { status: "complete", nodes: { a: node("a", "pending") } });
  // The production shape: blocked build node, integration pending behind it.
  objectiveFixture(root, "hq", "obj-blocked", {
    status: "blocked", nodes: { a: node("a", "blocked") },
    integration: { id: "obj-blocked-integration", status: "pending", dependsOn: ["a"] },
  });

  const calls = [];
  const out = await resumeStrandedObjectives({
    hqRoot: root, stateRoot: root,
    runObjective: async (opts) => { calls.push(opts); return { status: "complete" }; },
    readConfig: () => ({ openclawIntegration: { agentIds: { builder: "codex" }, maxAttemptsPerStage: 4 } }),
  });

  assert.equal(out.scanned, 3);
  assert.equal(out.resumed.length, 1, "only the stranded one");
  assert.equal(out.resumed[0].objectiveId, "obj-2fbb6bcd");
  assert.equal(out.skipped.length, 2);

  // The detached runs are started but not awaited by the sweep.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxAttemptsPerStage, 4, "the factory's configured budgets are passed through");
  assert.deepEqual(calls[0].agentIds, { builder: "codex" });
  // <stateRoot>/<project> — the same root runObjective computes for itself when
  // none is passed (`dirname(objectivePath)/../..`), which is where that
  // project's tasks/ directory lives.
  assert.equal(calls[0].stateRoot, join(root, "lifemaxing"),
    "and a state root the orchestrator can find the project's tasks under");
});

test("the sweep is bounded, so a boot after a long outage cannot start fifty runs", async () => {
  const root = stateRoot();
  for (let i = 0; i < 5; i += 1) {
    objectiveFixture(root, "lifemaxing", `obj-${i}`, { nodes: { a: node("a", "pending") } });
  }
  const out = await resumeStrandedObjectives({
    hqRoot: root, stateRoot: root, max: 2,
    runObjective: async () => ({ status: "complete" }),
    readConfig: () => ({}),
  });
  assert.equal(out.resumed.length, 2);
  assert.equal(out.skipped.filter((s) => /sweep limit/.test(s.reason)).length, 3);
});

test("one unreadable state file does not stop the objectives after it", async () => {
  const root = stateRoot();
  const broken = join(root, "lifemaxing", "objectives", "obj-broken");
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, "objective-state.json"), "{ not json", "utf8");
  objectiveFixture(root, "lifemaxing", "obj-zzz-good", { nodes: { a: node("a", "pending") } });

  const out = await resumeStrandedObjectives({
    hqRoot: root, stateRoot: root,
    runObjective: async () => ({ status: "complete" }),
    readConfig: () => ({}),
  });
  assert.equal(out.resumed.length, 1, "the good objective still started");
  assert.equal(out.resumed[0].objectiveId, "obj-zzz-good");
  assert.ok(out.skipped.some((s) => /unreadable/.test(s.reason)));
});

test("an orchestrator that throws is reported, not propagated", async () => {
  const root = stateRoot();
  objectiveFixture(root, "lifemaxing", "obj-explodes", { nodes: { a: node("a", "pending") } });
  const logged = [];

  // Must not reject: one objective that cannot start is not a reason to leave
  // the others unstarted, and boot must not fall over.
  const out = await resumeStrandedObjectives({
    hqRoot: root, stateRoot: root,
    runObjective: async () => { throw new Error("orchestrator exploded"); },
    readConfig: () => ({}),
    log: (m) => logged.push(m),
  });
  assert.equal(out.resumed.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(logged.some((m) => /did not resume.*orchestrator exploded/.test(m)), logged.join("\n"));
});

test("an empty or missing state root is silence, not an error", async () => {
  const out = await resumeStrandedObjectives({
    hqRoot: "/nope", stateRoot: join(tmpdir(), "does-not-exist-objective-reconcile"),
    runObjective: async () => { throw new Error("must not be called"); },
    readConfig: () => ({}),
  });
  assert.deepEqual(out, { scanned: 0, resumed: [], skipped: [] });
});

test("the sweep refuses to run without an orchestrator", async () => {
  await assert.rejects(
    () => resumeStrandedObjectives({ hqRoot: "/x", stateRoot: "/x" }),
    /runObjective is required/,
  );
});

// ── the abandoned-node path ──────────────────────────────────────────────────
//
// The defect that 1828 passing tests did not catch: every sweep test injected a
// spy for runObjective, so nothing ever put the real orchestrator behind a node
// left at `running`. Handing it one does NOT restart the node — the resume path
// in runObjective moves only `blocked` and `failed` nodes, and the loop starts
// only `readyNodes`, which is `pending`. The objective was relabelled
// `incomplete`, the node stayed `running`, and the next boot found it stranded
// all over again.

test("an abandoned node is made schedulable before the orchestrator is handed the objective", async () => {
  const root = stateRoot();
  const statePath = abandonedTaskState(root, "lifemaxing", "obj-killed-build");
  const objectivePath = objectiveFixture(root, "lifemaxing", "obj-killed", {
    nodes: { "obj-killed-build": node("obj-killed-build", "running", { statePath }) },
    integration: { id: "obj-killed-integration", status: "blocked-by-dep", dependsOn: ["obj-killed-build"] },
  });

  // The real reviver, deliberately: the bug was that the reconciler's decision
  // was right and the action it took on that decision did nothing.
  const out = await resumeStrandedObjectives({
    hqRoot: null, stateRoot: root,
    runObjective: async () => ({ status: "complete" }),
    readConfig: () => ({}),
  });

  assert.equal(out.resumed.length, 1);
  assert.deepEqual(out.resumed[0].revived, ["obj-killed-build"]);

  const after = readObjState(objectivePath);
  assert.equal(after.nodes["obj-killed-build"].status, "pending",
    "the node must leave `running`, or the orchestrator cannot see it");
  assert.deepEqual(readyNodes(after), ["obj-killed-build"],
    "and it must be READY — that is the whole point of reviving it");
  // The machine did this, not the founder. The audit log the founder reads must
  // not attribute a boot sweep to a decision they made.
  assert.equal(after.recovery.by, "system");
  // It is still stranded — the orchestrator here is a spy, so nothing ran. What
  // matters is that it is no longer ABANDONED: a boot that repeats this work
  // schedules a ready node instead of reviving a dead dispatch a second time.
  assert.deepEqual(strandedNodes(after).abandoned, []);
  assert.deepEqual(strandedNodes(after).ready, ["obj-killed-build"]);
});

test("an objective whose work is still live in another process is left alone", async () => {
  // The header comment says nothing can be running in a process that has just
  // started. That is true of THIS process, not of the machine: runObjective is
  // also called by scripts/factory-objective.mjs, scripts/factory-improve-loop.mjs
  // and scripts/objective-smoke.mjs, and no lock spans them. A task state still
  // being written belongs to whoever is writing it.
  const root = stateRoot();
  const statePath = abandonedTaskState(root, "hq", "obj-live-build", { updatedAt: new Date().toISOString() });
  const objectivePath = objectiveFixture(root, "hq", "obj-live", {
    nodes: { "obj-live-build": node("obj-live-build", "running", { statePath }) },
    integration: { id: "obj-live-integration", status: "blocked-by-dep", dependsOn: ["obj-live-build"] },
  });

  const calls = [];
  const out = await resumeStrandedObjectives({
    hqRoot: null, stateRoot: root,
    runObjective: async (opts) => { calls.push(opts); return { status: "complete" }; },
    readConfig: () => ({}),
  });

  assert.equal(out.resumed.length, 0);
  assert.match(out.skipped[0].reason, /still owned by a live runner/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0,
    "starting a run here is what wrote `incomplete` over an objective that was merely interrupted");
  assert.equal(readObjState(objectivePath).nodes["obj-live-build"].status, "running", "and its node is untouched");
});

test("a reviver that throws costs that objective, not the sweep", async () => {
  const root = stateRoot();
  objectiveFixture(root, "lifemaxing", "obj-unrevivable", {
    nodes: { a: node("a", "running", { statePath: join(root, "nope", "state.json") }) },
  });
  objectiveFixture(root, "lifemaxing", "obj-zzz-fine", { nodes: { a: node("a", "pending") } });

  const out = await resumeStrandedObjectives({
    hqRoot: null, stateRoot: root,
    runObjective: async () => ({ status: "complete" }),
    resumeNodes: () => { throw new Error("permission registry is unreadable"); },
    readConfig: () => ({}),
  });

  assert.equal(out.resumed.length, 1);
  assert.equal(out.resumed[0].objectiveId, "obj-zzz-fine");
  assert.ok(out.skipped.some((entry) => /cannot revive.*permission registry/.test(entry.reason)), JSON.stringify(out.skipped));
});

test("an objective that could not be started does not spend a slot", async () => {
  // `max` bounds runs, not scans. Six task states were already sitting `active`
  // with nothing behind them on 2026-09-15, against a budget of ten: counting
  // those as resumed would crowd out the objectives that can actually move.
  const root = stateRoot();
  const live = abandonedTaskState(root, "hq", "obj-aaa-live-build", { updatedAt: new Date().toISOString() });
  objectiveFixture(root, "hq", "obj-aaa-live", {
    nodes: { "obj-aaa-live-build": node("obj-aaa-live-build", "running", { statePath: live }) },
    integration: { id: "obj-aaa-live-integration", status: "blocked-by-dep", dependsOn: ["obj-aaa-live-build"] },
  });
  objectiveFixture(root, "hq", "obj-bbb-real", { nodes: { a: node("a", "pending") } });

  const out = await resumeStrandedObjectives({
    hqRoot: null, stateRoot: root, max: 1,
    runObjective: async () => ({ status: "complete" }),
    readConfig: () => ({}),
  });

  assert.deepEqual(out.resumed.map((entry) => entry.objectiveId), ["obj-bbb-real"],
    "the inert one is scanned first and must not consume the only slot");
});

// The wiring: boot must actually call this, or the module is decoration.
test("the dashboard resumes stranded objectives when it starts", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const server = readFileSync(join(repo, "dashboard", "backend", "server.mjs"), "utf8");

  assert.match(server, /resumeStrandedObjectives/, "server.mjs must import the reconciler");
  assert.match(server, /app\.listen\([\s\S]{0,320}?resumeStrandedObjectivesOnBoot\(\)/,
    "and call it from the listen callback, where nothing can be running yet");
});
