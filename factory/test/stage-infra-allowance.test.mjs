import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_INFRA_ATTEMPTS,
  countStageAttempts,
  routeStageFailure,
  stageBudgetExceeded,
} from "../lib/task-workflow.mjs";

const verdict = (stage, outcome = "fail") => ({ stage, kind: "stage", status: "completed", outcome });
const lost = (stage) => ({ stage, kind: "stage", status: "failed", error: "dispatch wrote no result file" });

function state(dispatches, stage = "builder") {
  return {
    status: "blocked",
    currentStage: stage,
    assignments: { builder: "codex", reviewer: "claude", qa: "claude", security: "claude", release: "openclaw" },
    stages: { builder: { status: "pending" } },
    blocker: { stage, outcome: "fail", summary: "a real rejection" },
    dispatches,
    events: [],
  };
}

test("attempts are split by whether the stage actually returned a verdict", () => {
  const s = state([verdict("builder"), lost("builder"), lost("builder"), verdict("reviewer")]);
  // `passes` joined the shape when successes stopped being charged to the
  // rejection budget; `verdict()` defaults to `fail`, so it is 0 here.
  assert.deepEqual(countStageAttempts(s, "builder"), { verdicts: 1, infra: 2, passes: 0, total: 3 });
  // Recovery dispatches carry the stage name but are a different job.
  const withRecovery = state([verdict("builder"), { stage: "builder", kind: "recovery-diagnose", outcome: "pass" }]);
  assert.equal(countStageAttempts(withRecovery, "builder").total, 1);
});

// The exact escalation from lifemaxing obj-c58897c0: six dispatches that never
// produced a verdict (actor/agent-id mismatch, orphaned runner, quota failure)
// plus one genuine rejection, reported as "7 of 3 stage attempts" and sent to
// the founder. Infrastructure had spent the budget meant for rejection.
test("dispatches that never returned a verdict no longer spend the rejection budget", () => {
  const s = state([...Array(6).fill(null).map(() => lost("builder")), verdict("builder")]);
  const budget = stageBudgetExceeded(s, "builder", { maxAttemptsPerStage: 3, maxInfraAttemptsPerStage: 10 });
  assert.equal(budget.exceeded, null);
  assert.equal(budget.verdicts, 1);
  assert.equal(budget.infra, 6);
  // It routes instead of stalling.
  assert.equal(routeStageFailure(s, { failedStage: "builder", maxInfraAttemptsPerStage: 10 }).status, "active");
});

test("a stage that keeps genuinely rejecting still stops at its budget", () => {
  const s = state([verdict("builder"), verdict("builder"), verdict("builder")]);
  assert.equal(stageBudgetExceeded(s, "builder").exceeded, "verdicts");
  // routeStageFailure returns the state untouched, i.e. it does not re-route.
  assert.equal(routeStageFailure(s, { failedStage: "builder" }), s);
});

// The allowance is longer, not infinite — an unreachable route must not retry
// forever just because it never produces a verdict.
test("infrastructure is still bounded, on its own allowance", () => {
  const s = state(Array(DEFAULT_MAX_INFRA_ATTEMPTS).fill(null).map(() => lost("builder")));
  const budget = stageBudgetExceeded(s, "builder");
  assert.equal(budget.exceeded, "infra");
  assert.equal(budget.limit, DEFAULT_MAX_INFRA_ATTEMPTS);
  assert.equal(routeStageFailure(s, { failedStage: "builder" }), s);

  // One below the line still routes.
  const under = state(Array(DEFAULT_MAX_INFRA_ATTEMPTS - 1).fill(null).map(() => lost("builder")));
  assert.equal(routeStageFailure(under, { failedStage: "builder" }).status, "active");
});

test("the infra allowance is longer than the rejection budget by default", () => {
  assert.ok(DEFAULT_MAX_INFRA_ATTEMPTS > 3);
});
