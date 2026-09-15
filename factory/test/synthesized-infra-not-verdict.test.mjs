import test from "node:test";
import assert from "node:assert/strict";
import { countStageAttempts, stageBudgetExceeded } from "../lib/task-workflow.mjs";

// `passes` joined the returned shape when the rejection budget stopped charging
// successes (see stage-budget-counts-rejections.test.mjs). Both scenarios below
// are all-`fail`, so it is 0 in each and every other count is unchanged.

// The concurrent review fan-out must write a real `fail` result for a member
// whose agent could not start, because the engine routes on an outcome. That
// makes an infrastructure failure look identical to a review rejection in the
// durable record — which defeats the verdict/infra split entirely.
//
// Observed live on lifemaxing obj-c58897c0-game-frontend: three reviewer
// dispatches failed with "[openclaw] Could not start the CLI", were correctly
// classified INFRASTRUCTURE_ERROR in `failures`, and still counted as 3 of 3
// rejections because their dispatch records carried outcome "fail".
const cliFailed = () => ({
  stage: "reviewer", kind: "stage", status: "completed", outcome: "fail", infraFailure: true,
  summary: "reviewer agent could not run: [openclaw] Could not start the CLI.",
});
const rejected = () => ({
  stage: "reviewer", kind: "stage", status: "completed", outcome: "fail",
  summary: "CHANGES REQUIRED: the mission card never reads the guardrail.",
});

test("a synthesized could-not-run result is not counted as a rejection", () => {
  const state = { dispatches: [cliFailed(), cliFailed(), cliFailed()] };
  assert.deepEqual(countStageAttempts(state, "reviewer"), { verdicts: 0, infra: 3, passes: 0, total: 3 });
  assert.equal(stageBudgetExceeded(state, "reviewer", { maxAttemptsPerStage: 3 }).exceeded, null);
});

test("real rejections still spend the rejection budget alongside them", () => {
  const state = { dispatches: [cliFailed(), rejected(), cliFailed(), rejected(), rejected()] };
  const counted = countStageAttempts(state, "reviewer");
  assert.deepEqual(counted, { verdicts: 3, infra: 2, passes: 0, total: 5 });
  assert.equal(stageBudgetExceeded(state, "reviewer", { maxAttemptsPerStage: 3 }).exceeded, "verdicts");
});

test("the infrastructure allowance still bounds repeated could-not-run failures", () => {
  const state = { dispatches: Array.from({ length: 6 }, cliFailed) };
  const budget = stageBudgetExceeded(state, "reviewer", { maxAttemptsPerStage: 3, maxInfraAttemptsPerStage: 6 });
  assert.equal(budget.exceeded, "infra");
  assert.equal(budget.verdicts, 0);
});

test("an ordinary fail without the marker is still a verdict", () => {
  // Guards against the marker being applied too broadly: only the fan-out sets it.
  const state = { dispatches: [rejected(), rejected(), rejected()] };
  assert.equal(countStageAttempts(state, "reviewer").verdicts, 3);
  assert.equal(stageBudgetExceeded(state, "reviewer", { maxAttemptsPerStage: 3 }).exceeded, "verdicts");
});
