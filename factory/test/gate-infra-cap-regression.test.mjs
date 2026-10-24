import test from "node:test";
import assert from "node:assert/strict";
import { countStageAttempts, stageBudgetExceeded } from "../lib/task-workflow.mjs";

// The cap is pinned as a literal on purpose: raising the constant must fail here too.
const CAP = 4;
const lost = (stage) => ({ stage, kind: "stage", status: "failed" });
const verdict = (stage) => ({ stage, kind: "stage", outcome: "fail" });

for (const stage of ["reviewer", "qa", "security"]) {
  test(`${stage}: consecutive infra failures stop at the 4th, even with a larger configured allowance`, () => {
    const state = { dispatches: [] };
    let stoppedAt = null;
    for (let n = 1; n <= 10 && stoppedAt === null; n += 1) {
      state.dispatches.push(lost(stage));
      if (stageBudgetExceeded(state, stage, { maxInfraAttemptsPerStage: 99 }).exceeded === "infra") stoppedAt = n;
    }
    assert.equal(stoppedAt, CAP);
  });

  test(`${stage}: real verdicts do not consume the infra cap`, () => {
    const state = { dispatches: [verdict(stage), verdict(stage), lost(stage), lost(stage), lost(stage)] };
    const before = stageBudgetExceeded(state, stage);
    assert.equal(before.exceeded, null);
    assert.equal(countStageAttempts(state, stage).infra, 3);
    state.dispatches.push(lost(stage));
    const after = stageBudgetExceeded(state, stage);
    assert.equal(after.exceeded, "infra");
    assert.equal(after.infra, CAP);
    assert.equal(after.verdicts, 2);
  });
}

test("a non-infra failure alone never trips the infra cap", () => {
  const state = { dispatches: [verdict("reviewer"), verdict("reviewer")] };
  const r = stageBudgetExceeded(state, "reviewer");
  assert.equal(r.exceeded, null);
  assert.equal(r.infra, 0);
});

test("non-gate stage is not capped at 4", () => {
  assert.equal(stageBudgetExceeded({ dispatches: Array(CAP).fill(lost("builder")) }, "builder").exceeded, null);
});
