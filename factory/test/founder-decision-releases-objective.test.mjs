import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createState, readState, writeState } from "../lib/task-workflow.mjs";
import { readObjState } from "../lib/objective/orchestrator.mjs";
import { clearObjectiveNodeAfterDecision, resolveFounderDecision } from "../../dashboard/backend/lib/founderControlPlane.mjs";

// hqRoot is the repo, not the fixture: writeHandoff reads factory/prompts/<stage>.md
// from it. Only the DATA root is temporary.
const HQ_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const OBJECTIVE_ID = "obj-c58897c0";
const NODE_ID = `${OBJECTIVE_ID}-integration`;
const PROJECT = "lifemaxing";

// The blocker that actually stalled obj-c58897c0: a merge conflict, escalated
// to the founder as a decision.
const CONFLICT_BLOCKER = {
  stage: "builder",
  outcome: "decision-required",
  founderAction: true,
  summary: "merge conflict integrating factory/obj-c58897c0-game-backend: .gitignore",
  at: "2026-09-12T06:29:05.131Z",
};

function fixture({ nodeStatus = "blocked", nodeBlocker = CONFLICT_BLOCKER } = {}) {
  const root = mkdtempSync(join(tmpdir(), "founder-decision-"));
  const worktree = join(root, "wt", NODE_ID);
  mkdirSync(worktree, { recursive: true });

  const state = createState({
    task: { id: NODE_ID, issue: `local:${NODE_ID}`, outcome: "Integrate the parallel build tasks.", acceptanceCriteria: ["merges cleanly"], project: PROJECT, workType: "ops", risk: "medium" },
    repo: join(root, "repo"),
    branch: `factory/integration-${OBJECTIVE_ID}`,
    worktree,
  });
  state.status = "blocked";
  state.currentStage = "builder";
  state.blocker = CONFLICT_BLOCKER;
  state.stages.builder = { status: "decision-required" };
  const statePath = join(root, "dashboard/backend/data/factory", PROJECT, "tasks", NODE_ID, "state.json");
  writeState(statePath, state);

  const dir = join(root, "dashboard/backend/data/factory", PROJECT, "objectives", OBJECTIVE_ID);
  mkdirSync(dir, { recursive: true });
  const objectivePath = join(dir, "objective-state.json");
  writeFileSync(objectivePath, `${JSON.stringify({
    version: 1,
    objectiveId: OBJECTIVE_ID,
    objective: "Turn lifemaxing into a real-life game",
    project: PROJECT,
    repo: join(root, "repo"),
    status: "integration-blocked",
    nodes: {},
    integration: { id: NODE_ID, role: "integration", status: nodeStatus, blocker: nodeBlocker, statePath, finishedAt: "2026-09-12T06:29:05.172Z" },
    events: [],
    createdAt: "2026-09-12T06:00:00.000Z",
    updatedAt: "2026-09-12T06:29:05.175Z",
  }, null, 2)}\n`, "utf8");

  return { root, statePath, objectivePath };
}

// The production failure. The founder answered the merge-conflict decision; the
// task resumed; the objective node kept the answered blocker. runObjective only
// runs READY nodes, so the objective never picked the work back up and the run
// sat for 1d20h after the conflict was already resolved.
test("answering a decision releases the objective node, not just the task", () => {
  const { root, statePath, objectivePath } = fixture();

  const view = resolveFounderDecision({ root, hqRoot: HQ_ROOT, statePath, direction: "Resolved the conflict on the integration branch; continue." });

  const task = readState(statePath);
  assert.equal(task.status, "active", "precondition: the task resumed");

  const node = readObjState(objectivePath).integration;
  assert.equal(node.blocker, null, "the answered blocker must not survive on the objective");
  assert.equal(node.status, "pending", "a released node must be runnable again");
  assert.equal(node.finishedAt, null);
  assert.equal(view.objectiveResume?.objectiveId, OBJECTIVE_ID, "the caller is told which objective to resume");
  assert.equal(view.objectiveResume?.objectivePath, objectivePath);
  assert.equal(typeof view.objective, "string", "taskView's own `objective` (the outcome text) must not be clobbered");
});

test("the release is recorded on the objective's own timeline", () => {
  const { root, statePath, objectivePath } = fixture();
  resolveFounderDecision({ root, hqRoot: HQ_ROOT, statePath, direction: "continue" });
  const events = readObjState(objectivePath).events;
  assert.ok(events.some((e) => e.type === "objective-node-retry" && e.node === NODE_ID && e.reason === "founder-decision-resolved"),
    "an audit reader must be able to see why the node became runnable again");
});

// A node someone else is already driving must not be yanked out from under them.
test("a node that is not blocked is left alone", () => {
  const { root, statePath, objectivePath } = fixture({ nodeStatus: "running", nodeBlocker: null });
  resolveFounderDecision({ root, hqRoot: HQ_ROOT, statePath, direction: "continue" });
  const node = readObjState(objectivePath).integration;
  assert.equal(node.status, "running", "a live runner owns this node");
  assert.equal(readObjState(objectivePath).events.length, 0, "nothing to record");
});

test("a standalone task with no objective wrapper resolves normally", () => {
  const root = mkdtempSync(join(tmpdir(), "founder-decision-solo-"));
  const worktree = join(root, "wt", "issue-77");
  mkdirSync(worktree, { recursive: true });
  const state = createState({
    task: { id: "issue-77", issue: "77", outcome: "Standalone work", acceptanceCriteria: ["ok"], project: PROJECT, workType: "backend", risk: "low" },
    repo: join(root, "repo"), branch: "factory/issue-77", worktree,
  });
  state.status = "blocked";
  state.blocker = { stage: "builder", outcome: "decision-required", summary: "which database?", at: "2026-09-12T06:00:00.000Z" };
  state.stages.builder = { status: "decision-required" };
  const statePath = join(root, "dashboard/backend/data/factory", PROJECT, "tasks", "issue-77", "state.json");
  writeState(statePath, state);

  const view = resolveFounderDecision({ root, hqRoot: HQ_ROOT, statePath, direction: "postgres" });
  assert.equal(readState(statePath).status, "active");
  assert.equal(view.objectiveResume, undefined, "there is no wrapper to report");
});

test("the helper ignores a task id that names no objective", () => {
  const { root } = fixture();
  assert.equal(clearObjectiveNodeAfterDecision(root, "issue-77"), null);
  assert.equal(clearObjectiveNodeAfterDecision(root, "obj-deadbeef-missing"), null, "an unknown objective is not an error");
});
