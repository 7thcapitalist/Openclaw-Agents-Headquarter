// A stage's attempt budget bounds REJECTIONS. It was counting successes too.
//
// lifemaxing obj-d4e18cad, 2026-09-15. The builder's four stage dispatches were
// `fail`, `pass`, `pass`, and one with no outcome. `countStageAttempts` counted
// any dispatch carrying an outcome as a verdict, so the two passes were charged
// to the rejection budget alongside the single real failure. At three of three
// the task escalated:
//
//   "Recovery attempt 1 was independently verified, but builder has returned
//    3 verdict(s) of 3 allowed. Re-running it would exceed that budget."
//
// It escalated at the moment the work became correct: recovery had just
// committed the missing arc-completion unit test as 57b5b7f and passed the full
// gate. The objective parked on a founder decision, its second node never
// started, and the product half of the objective was never built.
//
// The budget's own contract — "this stage keeps rejecting the work" — is the
// fix. A pass is not a rejection.
import test from "node:test";
import assert from "node:assert/strict";

import { countStageAttempts, stageBudgetExceeded, routeStageFailure } from "../lib/task-workflow.mjs";

// The builder dispatch sequence exactly as recorded in
// dashboard/backend/data/factory/lifemaxing/tasks/
//   obj-d4e18cad-domain-streak-and-arc/state.json
// Recovery dispatches are present because the real state had them and
// countStageAttempts must keep ignoring them by `kind`.
const OBJ_D4E18CAD_BUILDER_DISPATCHES = [
  { stage: "builder", kind: "stage", outcome: "fail" },
  { stage: "builder", kind: "recovery-diagnose", outcome: "pass" },
  { stage: "builder", kind: "recovery-verify", outcome: "pass" },
  { stage: "builder", kind: "stage", outcome: "pass" },
  { stage: "builder", kind: "stage", outcome: "pass" },
  { stage: "builder", kind: "stage", error: "Evidence does not exist: evidence/qa-test-output.log" },
];

function stateWith(dispatches) {
  return {
    status: "blocked",
    currentStage: "builder",
    assignments: { builder: "codex", reviewer: "claude" },
    stages: {},
    events: [],
    dispatches,
  };
}

test("a passing dispatch is not charged to the rejection budget", () => {
  const counts = countStageAttempts(stateWith(OBJ_D4E18CAD_BUILDER_DISPATCHES), "builder");

  // One genuine rejection. Before the fix this was 3.
  assert.equal(counts.verdicts, 1, "only the `fail` dispatch is a rejection");
  // The two passes are counted, not discarded — a livelock guard needs them.
  assert.equal(counts.passes, 2);
  // The dispatch that produced no outcome stays in the infrastructure allowance.
  assert.equal(counts.infra, 1);
  // Recovery dispatches are still excluded by `kind`.
  assert.equal(counts.total, 4);
});

test("obj-d4e18cad would not have escalated", () => {
  const budget = stageBudgetExceeded(stateWith(OBJ_D4E18CAD_BUILDER_DISPATCHES), "builder", {
    maxAttemptsPerStage: 3,
  });
  assert.equal(budget.exceeded, null, "one rejection is inside a budget of three");
  assert.equal(budget.verdicts, 1);
});

test("three real rejections still exhaust the budget", () => {
  const rejected = stateWith([
    { stage: "builder", kind: "stage", outcome: "fail" },
    { stage: "builder", kind: "stage", outcome: "pass" },
    { stage: "builder", kind: "stage", outcome: "fail" },
    { stage: "builder", kind: "stage", outcome: "pass" },
    { stage: "builder", kind: "stage", outcome: "fail" },
  ]);
  const budget = stageBudgetExceeded(rejected, "builder", { maxAttemptsPerStage: 3 });
  assert.equal(budget.exceeded, "verdicts", "passes interleaved do not buy extra rejections");
  assert.equal(budget.verdicts, 3);
  assert.equal(budget.passes, 2);
});

test("a decision-required outcome is still a verdict, not a pass", () => {
  const counts = countStageAttempts(
    stateWith([
      { stage: "builder", kind: "stage", outcome: "decision-required" },
      { stage: "builder", kind: "stage", outcome: "decision-request" },
    ]),
    "builder",
  );
  assert.equal(counts.verdicts, 2);
  assert.equal(counts.passes, 0);
});

test("the infrastructure allowance is unchanged", () => {
  // `infraFailure` marks a synthesized fail from the review fan-out: a real
  // `fail` outcome that judged nothing. It must stay in the infra bucket and
  // must not be mistaken for a pass by the new success check.
  const counts = countStageAttempts(
    stateWith([
      { stage: "reviewer", kind: "stage", outcome: "fail", infraFailure: true },
      { stage: "reviewer", kind: "stage", outcome: "pass", infraFailure: true },
      { stage: "reviewer", kind: "stage" },
    ]),
    "reviewer",
  );
  assert.equal(counts.infra, 3);
  assert.equal(counts.verdicts, 0);
  assert.equal(counts.passes, 0, "an infraFailure is never counted as a success");
});

test("routing still proceeds when only passes precede the failure", () => {
  // The end-to-end consequence: with two passes on record, a fresh FAIL must
  // still route back to the builder instead of being swallowed by an exhausted
  // budget. `routeStageFailure` returns `state` unchanged when the budget is
  // spent, which is what stranded obj-d4e18cad.
  const state = stateWith([
    { stage: "reviewer", kind: "stage", outcome: "pass" },
    { stage: "reviewer", kind: "stage", outcome: "pass" },
    { stage: "reviewer", kind: "stage", outcome: "fail" },
  ]);
  state.blocker = { stage: "reviewer", outcome: "fail", summary: "missing regression coverage" };
  state.stages = { builder: { status: "pass" }, reviewer: { status: "fail" } };

  const next = routeStageFailure(state, { failedStage: "reviewer", now: "2026-09-15T20:00:00.000Z" });
  assert.notEqual(next, state, "the failure must be routed, not dropped");
  assert.equal(next.currentStage, "builder");
  assert.equal(next.status, "active");
});
