import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildGoalsSnapshot, projectGoals, readGoalRegistry, validateGoalTree } from "../lib/hq/goals.mjs";

const GOALS = [
  { id: "company-growth", level: "company", title: "Build a reliable company" },
  { id: "project-hq", level: "project", parentId: "company-growth", projectId: "hq", title: "Operate HQ" },
  { id: "goal-obj-1", level: "objective", parentId: "project-hq", projectId: "hq", objectiveId: "obj-1", title: "Ship capability" },
];

// --- projection -------------------------------------------------------------

test("derives goal progress from canonical task state", () => {
  const view = projectGoals({
    goals: GOALS,
    objectives: [{ objectiveId: "obj-1", projectId: "hq", status: "active" }],
    tasks: [{ id: "a", objectiveId: "obj-1", status: "merged" }, { id: "b", objectiveId: "obj-1", status: "active" }],
  });
  assert.equal(view.summary.percent, 50);
  assert.equal(view.roots[0].children[0].progress.active, 1);
  assert.equal(view.goals[2].source, "canonical-projection");
});

test("a goal carries no status of its own — only what canonical work reports", () => {
  const claimed = GOALS.map((goal) => ({ ...goal, status: "completed", percent: 100 }));
  const view = projectGoals({
    goals: claimed,
    objectives: [{ objectiveId: "obj-1", projectId: "hq", status: "active" }],
    tasks: [{ objectiveId: "obj-1", status: "blocked" }],
  });
  assert.equal(view.summary.state, "blocked", "a self-declared 'completed' goal must not override canonical state");
  assert.equal(view.summary.percent, 0);
  assert.equal(view.goals[0].status, undefined, "no status field is projected");
});

test("blocked descendants surface through every rollup", () => {
  const view = projectGoals({ goals: GOALS, tasks: [{ objectiveId: "obj-1", status: "blocked" }] });
  assert.equal(view.summary.state, "blocked");
  assert.equal(view.roots[0].progress.blocked, 1);
});

test("blocked outranks active so the rollup shows what needs attention", () => {
  const view = projectGoals({
    goals: GOALS,
    tasks: [{ objectiveId: "obj-1", status: "running" }, { objectiveId: "obj-1", status: "failed" }],
  });
  assert.equal(view.summary.state, "blocked");
  assert.equal(view.summary.active, 1);
  assert.equal(view.summary.blocked, 1);
});

test("a project goal with no objective children rolls up every objective in its project", () => {
  const goals = GOALS.slice(0, 2);
  const view = projectGoals({
    goals,
    objectives: [
      { objectiveId: "obj-1", projectId: "hq", status: "active" },
      { objectiveId: "obj-2", projectId: "hq", status: "active" },
      { objectiveId: "obj-other", projectId: "elsewhere", status: "active" },
    ],
    tasks: [
      { objectiveId: "obj-1", status: "gate-satisfied" },
      { objectiveId: "obj-2", status: "pending" },
      { objectiveId: "obj-other", status: "blocked" },
    ],
  });
  assert.equal(view.summary.total, 2, "work in another project must not roll into this goal");
  assert.equal(view.summary.complete, 1);
  assert.equal(view.summary.percent, 50);
});

test("missing canonical objective is explicitly unavailable, not zero progress", () => {
  const view = projectGoals({ goals: GOALS });
  const leaf = view.goals.find((goal) => goal.id === "goal-obj-1");
  assert.equal(leaf.progress.state, "unavailable");
  assert.equal(leaf.progress.total, 0);
});

test("falls back to objective status when decomposition has not produced nodes", () => {
  const view = projectGoals({ goals: GOALS, objectives: [{ objectiveId: "obj-1", projectId: "hq", status6: "blocked" }] });
  assert.equal(view.summary.state, "blocked");
  assert.equal(view.summary.total, 1);
});

// ── vocabulary and rollup honesty ────────────────────────────────────────────
// A goal projection is only worth having if "done" means done and "blocked" is
// visible. Each case below reported a confident, wrong answer before the fix.

const TREE = [
  { id: "c", level: "company", title: "Co" },
  { id: "p", level: "project", title: "Pr", parentId: "c", projectId: "proj" },
  { id: "o", level: "objective", title: "Ob", parentId: "p", projectId: "proj", objectiveId: "ob1" },
];
const progressOf = (result, id = "o") => result.goals.find((goal) => goal.id === id).progress;

test("uppercase founder statuses project correctly", () => {
  // `status6` is preferred over `status` and its canonical values are uppercase
  // (presenter.mjs STATUS). Lowercase-only membership made every one of these
  // read as 0% pending — a finished objective and a blocked one alike.
  const complete = progressOf(projectGoals({ goals: TREE, objectives: [{ objectiveId: "ob1", status6: "COMPLETE" }], tasks: [] }));
  assert.equal(complete.state, "completed");
  assert.equal(complete.percent, 100);
  for (const status6 of ["BLOCKED", "WAITING_FOR_FOUNDER"]) {
    assert.equal(progressOf(projectGoals({ goals: TREE, objectives: [{ objectiveId: "ob1", status6 }], tasks: [] })).state, "blocked",
      `${status6} must stay visible as blocked, never laundered into pending`);
  }
  assert.equal(progressOf(projectGoals({ goals: TREE, objectives: [{ objectiveId: "ob1", status6: "RECOVERING" }], tasks: [] })).state, "active");
});

test("orchestrator terminal statuses count as complete", () => {
  // orchestrator.mjs settles nodes at `published` / `skipped`; graph.mjs at
  // `gate-satisfied`. None were recognised.
  for (const status of ["published", "skipped", "gate-satisfied"]) {
    const p = progressOf(projectGoals({ goals: TREE, objectives: [{ objectiveId: "ob1", status6: "COMPLETE" }], tasks: [{ objectiveId: "ob1", status }] }));
    assert.equal(p.complete, 1, `${status} must count as complete`);
    assert.equal(p.state, "completed", `${status} is terminal success`);
  }
});

test("an objective blocked above its tasks is not reported complete", () => {
  // The objective's own status was discarded whenever tasks existed, so a
  // founder gate or a failed publication read as 100% done.
  const p = progressOf(projectGoals({ goals: TREE, objectives: [{ objectiveId: "ob1", status: "blocked" }], tasks: [{ objectiveId: "ob1", status: "merged" }] }));
  assert.equal(p.state, "blocked", "the objective's own blocker outranks its tasks' verdicts");
  assert.ok(p.blocked >= 1, "the blocker is counted, not just described");
  // The percentage stays task-derived and honest — every task really is done.
  // What must never happen is the STATE reading complete while the objective
  // itself cannot proceed.
  assert.equal(p.percent, 100);
});

test("an unrecognised status is counted, never silently dropped", () => {
  const p = progressOf(projectGoals({ goals: TREE, objectives: [{ objectiveId: "ob1", status: "some-new-state" }], tasks: [] }));
  assert.equal(p.unknown, 1);
  assert.equal(p.state, "unknown");
  assert.equal(p.total, 1, "an unknown status still counts toward the total");
});

test("a child with no canonical source cannot be rolled up as done", () => {
  // An unavailable leaf has total 0, so summing totals erased it and the parent
  // claimed 100% while half its scope had no source at all.
  const tree = [...TREE, { id: "o2", level: "objective", title: "B", parentId: "p", projectId: "proj", objectiveId: "missing" }];
  const result = projectGoals({ goals: tree, objectives: [{ objectiveId: "ob1", status: "merged" }], tasks: [] });
  assert.equal(result.summary.state, "partial", "half-unknown scope must not read as completed");
  assert.equal(result.summary.unavailable, 1);
  assert.equal(progressOf(result, "o2").state, "unavailable");
});

test("identifiers cannot carry path traversal", () => {
  assert.throws(() => projectGoals({ goals: [{ id: "c", level: "company", title: "Co", projectId: "a/../../etc/passwd" }], objectives: [], tasks: [] }),
    /projectId is invalid/);
});

// --- validation (negative cases) --------------------------------------------

test("rejects cycles, missing parents, invalid levels, and cross-project scope", () => {
  assert.throws(() => validateGoalTree([
    { id: "a", level: "project", title: "A", parentId: "b", projectId: "x" },
    { id: "b", level: "objective", title: "B", parentId: "a", projectId: "x", objectiveId: "o" },
  ]), /parent level is invalid|cycle/);
  assert.throws(() => validateGoalTree([{ id: "a", level: "project", title: "A", parentId: "missing", projectId: "x" }]), /unknown parent/);
  assert.throws(() => validateGoalTree([{ id: "a", level: "team", title: "A" }]), /invalid level/);
  assert.throws(() => validateGoalTree([...GOALS, { id: "cross", level: "objective", title: "Cross", parentId: "project-hq", projectId: "other", objectiveId: "o" }]), /crosses project scope/);
});

test("rejects duplicates, unusable identifiers, orphan levels, and oversized titles", () => {
  assert.throws(() => validateGoalTree([GOALS[0], GOALS[0]]), /duplicate goal/);
  assert.throws(() => validateGoalTree([{ id: "../escape", level: "company", title: "A" }]), /goal.id is invalid/);
  assert.throws(() => validateGoalTree([{ id: "a", level: "company", title: "A", parentId: "b" }]), /cannot have a parent/);
  assert.throws(() => validateGoalTree([{ id: "a", level: "project", title: "A", projectId: "x" }]), /requires a parent/);
  assert.throws(() => validateGoalTree([{ ...GOALS[0], title: "x".repeat(301) }]), /title is invalid/);
  assert.throws(() => validateGoalTree([{ ...GOALS[0], title: "   " }]), /title is invalid/);
  assert.throws(() => validateGoalTree("nope"), /must be an array/);
});

test("a self-parented goal is a cycle, not a stack overflow", () => {
  assert.throws(() => validateGoalTree([{ id: "a", level: "project", title: "A", parentId: "a", projectId: "x" }]), /parent level is invalid|cycle/);
});

// --- registry and snapshot --------------------------------------------------

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hq-goals-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  return root;
}

function writeObjective(root, project, objectiveId, state) {
  const dir = join(root, "state", project, "objectives", objectiveId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "objective-state.json"), JSON.stringify(state));
}

test("readGoalRegistry validates the tracked file and reports a missing one as empty", () => {
  const root = fixture();
  assert.deepEqual(readGoalRegistry(root).goals, []);
  assert.equal(readGoalRegistry(root).present, false);

  writeFileSync(join(root, "factory", "goals.json"), JSON.stringify({ version: 1, goals: GOALS }));
  assert.equal(readGoalRegistry(root).goals.length, 3);

  writeFileSync(join(root, "factory", "goals.json"), "{ not json");
  assert.throws(() => readGoalRegistry(root), /not valid JSON/);

  writeFileSync(join(root, "factory", "goals.json"), JSON.stringify({ version: 1 }));
  assert.throws(() => readGoalRegistry(root), /'goals' array/);

  writeFileSync(join(root, "factory", "goals.json"), JSON.stringify({ version: 1, goals: [{ id: "a", level: "team", title: "A" }] }));
  assert.throws(() => readGoalRegistry(root), /invalid level/);
});

test("buildGoalsSnapshot rolls up real objective-state files", () => {
  const root = fixture();
  writeFileSync(join(root, "factory", "goals.json"), JSON.stringify({ version: 1, goals: GOALS.slice(0, 2) }));
  writeObjective(root, "Some-Repo", "obj-1", {
    objectiveId: "obj-1",
    project: "hq",
    status: "active",
    nodes: { a: { id: "a", status: "gate-satisfied" }, b: { id: "b", status: "blocked" } },
    integration: { id: "int", status: "pending" },
  });

  const snapshot = buildGoalsSnapshot({ hqRoot: root, stateRoot: join(root, "state") });
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.configured, true);
  assert.deepEqual(snapshot.warnings, []);
  assert.equal(snapshot.summary.total, 3, "nodes and the integration node are all canonical work");
  assert.equal(snapshot.summary.complete, 1);
  assert.equal(snapshot.summary.blocked, 1);
  assert.equal(snapshot.summary.state, "blocked");
});

test("buildGoalsSnapshot maps objectives by their canonical project key, not the directory name", () => {
  const root = fixture();
  writeFileSync(join(root, "factory", "goals.json"), JSON.stringify({ version: 1, goals: GOALS.slice(0, 2) }));
  // Directory is named after the repo; `project` is the canonical key.
  writeObjective(root, "Openclaw-Agents-Headquarter", "obj-1", {
    objectiveId: "obj-1", project: "hq", status: "active", nodes: { a: { id: "a", status: "running" } },
  });
  assert.equal(buildGoalsSnapshot({ hqRoot: root, stateRoot: join(root, "state") }).summary.active, 1);
});

test("buildGoalsSnapshot degrades honestly instead of throwing", () => {
  const root = fixture();
  writeFileSync(join(root, "factory", "goals.json"), JSON.stringify({ version: 1, goals: GOALS.slice(0, 2) }));
  writeObjective(root, "hq", "obj-broken", {});
  writeFileSync(join(root, "state", "hq", "objectives", "obj-broken", "objective-state.json"), "{ truncated");

  const snapshot = buildGoalsSnapshot({ hqRoot: root, stateRoot: join(root, "state") });
  assert.equal(snapshot.available, false);
  assert.match(snapshot.warnings.join(" "), /obj-broken state unavailable/);
  assert.equal(snapshot.goals.length, 2, "the readable part of the projection still renders");
});

test("buildGoalsSnapshot reports an unconfigured registry without failing", () => {
  const root = fixture();
  writeObjective(root, "hq", "obj-1", { objectiveId: "obj-1", project: "hq", status: "active", nodes: {} });
  const snapshot = buildGoalsSnapshot({ hqRoot: root, stateRoot: join(root, "state") });
  assert.equal(snapshot.configured, false);
  assert.equal(snapshot.available, true);
  assert.deepEqual(snapshot.roots, []);
});

test("buildGoalsSnapshot reports a missing state root as degraded, never as a crash", () => {
  const root = fixture();
  writeFileSync(join(root, "factory", "goals.json"), JSON.stringify({ version: 1, goals: GOALS.slice(0, 2) }));
  const snapshot = buildGoalsSnapshot({ hqRoot: root, stateRoot: join(root, "no-such-state") });
  assert.equal(snapshot.available, false);
  assert.match(snapshot.warnings.join(" "), /does not exist yet/);
});

test("the tracked HQ goal registry is valid", async () => {
  const { readGoalRegistry: read } = await import("../lib/hq/goals.mjs");
  const registry = read(new URL("../..", import.meta.url).pathname);
  assert.equal(registry.present, true, "factory/goals.json must exist and parse");
  assert.ok(registry.goals.length > 0);
});
