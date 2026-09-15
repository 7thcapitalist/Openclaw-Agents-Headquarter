// Cancelling an objective: the founder's terminal stop.
//
// Archiving only moves a card; this proves the stronger claim the Cancel button
// makes — the work itself is over. An objective the founder cancelled is never
// scheduled again, never resumed by recovery, no longer counts as active work,
// and cannot be argued back into "Running" by whatever its nodes happen to say.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildObjectiveStateFromNodes } from "../lib/objective/decompose.mjs";
import { cancelObjective, readObjState, runObjective } from "../lib/objective/orchestrator.mjs";
import { presentObjective, STATUS } from "../lib/hq/presenter.mjs";
import {
  buildFounderOverview,
  buildObjectivesView,
  finishFounderJob,
  handleObjectiveRetry,
  objectiveLifecycle,
  saveFounderJob,
} from "../../dashboard/backend/lib/founderControlPlane.mjs";
import {
  canCancelObjective,
  renderObjectiveCard,
  renderObjectiveHistoryRow,
} from "../../dashboard/backend/public/lib/objectiveView.mjs";

const HQ = process.cwd();
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

function tempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// A real repo, because runObjective works against one.
function makeRepo(root) {
  const repo = join(root, "app");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# app\n");
  const g = (args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  g(["init", "-b", "main"]);
  g(["config", "user.name", "T"]); g(["config", "user.email", "t@x.l"]);
  g(["add", "."]); g(["commit", "-m", "base"]);
  return repo;
}

// The JSON is seeded before anything reads it, so the transactional store
// imports this exact state as its first version — hand-editing the export after
// a read would silently do nothing.
function writeObjective(root, repo, nodes, { status = "active" } = {}) {
  const g = buildObjectiveStateFromNodes({ objective: "demo objective", project: "app", repo, nodes });
  const dir = join(root, "dashboard/backend/data/factory", "app", "objectives", g.objectiveId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "objective-state.json");
  writeFileSync(path, `${JSON.stringify({ ...g, status }, null, 2)}\n`);
  return { objectivePath: path, objectiveId: g.objectiveId };
}

const NODES = [
  { id: "a", role: "backend-builder", objective: "Build part A", acceptanceCriteria: ["A works"], workType: "backend", risk: "low", dependsOn: [] },
  { id: "b", role: "frontend-builder", objective: "Build part B", acceptanceCriteria: ["B works"], workType: "ui", risk: "low", dependsOn: [] },
];

test("cancelObjective writes a terminal status, records why, and is idempotent", () => {
  const root = tempRoot("obj-cancel-state-");
  const repo = makeRepo(root);
  const { objectivePath } = writeObjective(root, repo, NODES);

  const res = cancelObjective(objectivePath, { reason: "trial run, not needed" });
  assert.equal(res.status, "cancelled");
  assert.equal(res.previousStatus, "active");
  assert.equal(res.alreadyCancelled, false);
  assert.ok(res.cancelledAt);

  const state = readObjState(objectivePath);
  assert.equal(state.status, "cancelled");
  assert.equal(state.cancelReason, "trial run, not needed");
  assert.ok(state.events.some((e) => e.type === "objective-cancelled" && e.by === "founder"));
  // The record of what the parts actually reached is left alone.
  assert.deepEqual(new Set(Object.values(state.nodes).map((n) => n.status)), new Set(["pending"]));

  const again = cancelObjective(objectivePath, { reason: "second click" });
  assert.equal(again.alreadyCancelled, true);
  assert.equal(again.cancelledAt, res.cancelledAt);
  assert.equal(readObjState(objectivePath).cancelReason, "trial run, not needed");
});

test("cancelObjective refuses work that already finished", () => {
  const root = tempRoot("obj-cancel-complete-");
  const repo = makeRepo(root);
  const { objectivePath } = writeObjective(root, repo, NODES, { status: "complete" });
  assert.equal(readObjState(objectivePath).status, "complete");

  assert.throws(() => cancelObjective(objectivePath), (error) => {
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /already finished/);
    return true;
  });
});

test("runObjective refuses a cancelled objective instead of resuming it", async () => {
  const root = tempRoot("obj-cancel-run-");
  const repo = makeRepo(root);
  const { objectivePath } = writeObjective(root, repo, NODES);
  cancelObjective(objectivePath, { reason: "stop" });

  let dispatched = 0;
  const res = await runObjective({
    hqRoot: HQ,
    objectivePath,
    stateRoot: join(root, "factory-state"),
    execute: async () => { dispatched += 1; return {}; },
    publish: () => ({ published: false, reason: "not published in this test" }),
  });

  assert.equal(res.status, "cancelled");
  assert.equal(res.cancelled, true);
  assert.equal(dispatched, 0, "no node may be dispatched for a cancelled objective");
  // Crucially, the resume path did NOT flip the objective back to active.
  assert.equal(readObjState(objectivePath).status, "cancelled");
});

test("a cancelled objective is history, and its report/state survive", () => {
  const root = tempRoot("obj-cancel-view-");
  const repo = makeRepo(root);
  const { objectivePath, objectiveId } = writeObjective(root, repo, NODES);
  cancelObjective(objectivePath, { reason: "trial" });

  const view = buildObjectivesView(root);
  const shaped = view.objectives.find((o) => o.objectiveId === objectiveId);
  assert.equal(shaped.status, "cancelled");
  assert.equal(shaped.status6, STATUS.CANCELLED);
  assert.equal(shaped.statusLabel, "Cancelled");
  assert.equal(shaped.lifecycle, "history");
  assert.equal(view.summary.active, 0, "cancelled work stops counting as active");
});

test("objectiveLifecycle: cancelled is history however fresh, archived still wins", () => {
  const now = Date.parse("2026-09-15T12:00:00.000Z");
  const fresh = "2026-09-15T11:59:00.000Z";
  assert.equal(objectiveLifecycle({ status6: "CANCELLED", updatedAt: fresh }, { now }), "history");
  assert.equal(objectiveLifecycle({ status6: "CANCELLED", updatedAt: fresh }, { now, archived: true }), "archived");
});

test("presenter: a running node cannot argue a cancelled objective back into Running", () => {
  const p = presentObjective({
    objectiveId: "obj-deadbeef",
    objective: "Try something out",
    status: "cancelled",
    nodes: [{ id: "n1", role: "backend-builder", status: "running", contract: { outcome: "Build it" } }],
    integration: { id: "n-int", role: "integration", status: "pending" },
  });
  assert.equal(p.status, STATUS.CANCELLED);
  assert.equal(p.statusLabel, "Cancelled");
  assert.match(p.headline, /Cancelled by you/);
  assert.equal(p.nextAction.kind, "none", "nothing is owed on cancelled work");
});

test("recovery refuses to resume a cancelled objective", async () => {
  const root = tempRoot("obj-cancel-retry-");
  const repo = makeRepo(root);
  const { objectivePath, objectiveId } = writeObjective(root, repo, NODES);
  cancelObjective(objectivePath);

  await assert.rejects(
    () => handleObjectiveRetry({
      root,
      hqRoot: HQ,
      objectiveId,
      runObjective: async () => { throw new Error("recovery must not run a cancelled objective"); },
    }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /cancelled/i);
      return true;
    },
  );
});

test("the card offers Cancel on live work and withdraws it once cancelled", () => {
  const live = {
    objectiveId: "obj-deadbeef", title: "Trial Objective", project: "app",
    status: "active", status6: "RUNNING", statusLabel: "Running", statusTone: "info",
    progress: { label: "0 of 2 parts done" }, nextAction: { label: null }, nodeBriefs: [], lifecycle: "active",
  };
  assert.equal(canCancelObjective(live), true);
  assert.match(renderObjectiveCard(live, { esc }), /data-cancel-objective="obj-deadbeef"/);
  // A stale card the founder pushed into History still needs a terminal state.
  assert.match(renderObjectiveHistoryRow({ ...live, lifecycle: "history" }, { esc }), /data-cancel-objective="obj-deadbeef"/);

  const cancelled = { ...live, status: "cancelled", status6: "CANCELLED", statusLabel: "Cancelled", lifecycle: "history" };
  assert.equal(canCancelObjective(cancelled), false);
  assert.doesNotMatch(renderObjectiveHistoryRow(cancelled, { esc }), /data-cancel-objective/);

  const complete = { ...live, status: "complete", status6: "COMPLETE", statusLabel: "Complete" };
  assert.equal(canCancelObjective(complete), false);
  assert.doesNotMatch(renderObjectiveCard(complete, { esc }), /data-cancel-objective/);
});

test("cancelling mid-run stops the orchestrator from starting anything else", async () => {
  const root = tempRoot("obj-cancel-midrun-");
  const repo = makeRepo(root);
  const { objectivePath } = writeObjective(root, repo, NODES);

  const started = new Set();
  const res = await runObjective({
    hqRoot: HQ,
    objectivePath,
    maxConcurrent: 1,
    stateRoot: join(root, "factory-state"),
    // The founder hits Cancel while the first part is out with an agent.
    execute: async ({ dispatch }) => {
      started.add(dispatch.taskId);
      cancelObjective(objectivePath, { reason: "changed my mind" });
      throw new Error("agent stopped");
    },
    publish: () => ({ published: false, reason: "not published in this test" }),
  });

  assert.equal(res.status, "cancelled");
  assert.equal(started.size, 1, "the second part is never launched after the cancel");
  const state = readObjState(objectivePath);
  assert.equal(state.status, "cancelled", "the run must not overwrite the cancel with its own outcome");
  assert.equal(state.integration.status, "pending", "integration never runs on cancelled work");
});

test("a cancelled objective stops asking for the founder in the inbox", () => {
  const repo = makeRepo(tempRoot("obj-cancel-inbox-repo-"));
  const graph = buildObjectiveStateFromNodes({ objective: "Try something out", project: "app", repo, nodes: NODES });
  // The first part stopped on a decision the founder would normally have to answer.
  const firstNodeId = Object.keys(graph.nodes)[0];
  graph.nodes[firstNodeId].status = "blocked";
  graph.nodes[firstNodeId].blocker = {
    stage: "product", outcome: "decision-required", founderAction: false,
    summary: "Which of the two shapes should this take?", at: "2026-09-15T10:00:00.000Z",
  };

  // One HQ per status, because the state is seeded before it is ever read.
  const hqWith = (status) => {
    const hq = tempRoot(`obj-cancel-inbox-${status}-`);
    const dir = join(hq, "dashboard/backend/data/factory/app/objectives", graph.objectiveId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "objective-state.json"), `${JSON.stringify({ ...graph, status }, null, 2)}\n`);
    return hq;
  };
  const inboxItem = (hq) => buildFounderOverview(hq, []).inbox.find((x) => x.objectiveId === graph.objectiveId);

  assert.ok(inboxItem(hqWith("active")), "a blocked objective node reaches the founder inbox");
  assert.equal(inboxItem(hqWith("cancelled")), undefined, "nobody owes an answer to work the founder cancelled");
});

test("a cancelled run is recorded as a decision, never as a hard failure", () => {
  const root = tempRoot("obj-cancel-job-");
  const job = { id: "job-1", kind: "objective", objectiveId: "obj-aa11bb22", status: "running", createdAt: "2026-09-15T10:00:00.000Z" };
  saveFounderJob(root, job);

  const saved = finishFounderJob(root, { ...job }, { result: { status: "cancelled" } });
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.error, undefined);
  assert.equal(saved.outcome, undefined, "a cancel is not classified as a failure outcome");
});
