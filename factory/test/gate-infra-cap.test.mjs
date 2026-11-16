import test from "node:test";
import assert from "node:assert/strict";
import { GATE_MAX_INFRA_ATTEMPTS, stageBudgetExceeded } from "../lib/task-workflow.mjs";

const lost = (stage) => ({ stage, kind: "stage", status: "failed", error: "dispatch wrote no result file" });
const run = (stage, n) => ({ dispatches: Array(n).fill(null).map(() => lost(stage)) });

test("a gate stops retrying lost dispatches at the gate cap, below the global allowance", () => {
  for (const stage of ["reviewer", "qa", "security"]) {
    assert.equal(stageBudgetExceeded(run(stage, GATE_MAX_INFRA_ATTEMPTS - 1), stage).exceeded, null);
    const over = stageBudgetExceeded(run(stage, GATE_MAX_INFRA_ATTEMPTS), stage, { maxInfraAttemptsPerStage: 6 });
    assert.equal(over.exceeded, "infra");
    assert.equal(over.limit, GATE_MAX_INFRA_ATTEMPTS);
  }
});

test("non-gate stages keep the configured infra allowance", () => {
  assert.equal(stageBudgetExceeded(run("builder", 5), "builder").exceeded, null);
  assert.equal(stageBudgetExceeded(run("release", 5), "release").exceeded, null);
});

test("a stricter configured allowance is not raised", () => {
  assert.equal(stageBudgetExceeded(run("reviewer", 2), "reviewer", { maxInfraAttemptsPerStage: 2 }).exceeded, "infra");
});
