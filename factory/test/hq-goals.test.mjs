import test from "node:test";
import assert from "node:assert/strict";
import { projectGoals, validateGoalTree } from "../lib/hq/goals.mjs";
const goals = [{ id: "company-growth", level: "company", title: "Build a reliable company" }, { id: "project-hq", level: "project", parentId: "company-growth", projectId: "hq", title: "Operate HQ" }, { id: "goal-obj-1", level: "objective", parentId: "project-hq", projectId: "hq", objectiveId: "obj-1", title: "Ship capability" }];
test("derives goal progress from canonical task state", () => { const value = projectGoals({ goals, objectives: [{ objectiveId: "obj-1", status: "active" }], tasks: [{ id: "a", objectiveId: "obj-1", status: "merged" }, { id: "b", objectiveId: "obj-1", status: "active" }] }); assert.equal(value.summary.percent, 50); assert.equal(value.roots[0].children[0].progress.active, 1); assert.equal(value.goals[2].source, "canonical-projection"); });
test("blocked descendants surface through every rollup", () => { const value = projectGoals({ goals, tasks: [{ objectiveId: "obj-1", status: "blocked" }] }); assert.equal(value.summary.state, "blocked"); assert.equal(value.roots[0].progress.blocked, 1); });
test("missing canonical objective is explicitly unavailable", () => { const value = projectGoals({ goals }); assert.equal(value.goals.find((g) => g.id === "goal-obj-1").progress.state, "unavailable"); });
test("rejects cycles, missing parents, invalid levels, and cross-project scope", () => { assert.throws(() => validateGoalTree([{ id: "a", level: "project", title: "A", parentId: "b", projectId: "x" }, { id: "b", level: "objective", title: "B", parentId: "a", projectId: "x", objectiveId: "o" }]), /parent level|cycle/); assert.throws(() => validateGoalTree([{ id: "a", level: "project", title: "A", parentId: "missing", projectId: "x" }]), /unknown parent/); assert.throws(() => validateGoalTree([{ id: "a", level: "team", title: "A" }]), /invalid level/); assert.throws(() => validateGoalTree([...goals, { id: "cross", level: "objective", title: "Cross", parentId: "project-hq", projectId: "other", objectiveId: "o" }]), /crosses project/); });

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
