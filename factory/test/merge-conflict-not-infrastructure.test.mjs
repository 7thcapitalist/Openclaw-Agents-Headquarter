import test from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, isDeterministicProjectFailure, repairTargetFor } from "../lib/failure-classification.mjs";
import { classifyBlocker, isRetriableInfraBlocker } from "../lib/hq/blocker-class.mjs";

// Regression pin for objective obj-c58897c0 (lifemaxing), which sat blocked for
// 1d20h. The integration builder hit a one-line .gitignore conflict between two
// sub-task branches. The runner rewrote that conflict as a missing-result
// dispatch failure, the generic wrapper classified it INFRASTRUCTURE_ERROR, and
// three recovery attempts logged inside ONE SECOND without an agent ever
// running before the founder was asked to decide.
const REAL_BLOCKER_SUMMARY =
  "builder dispatch wrote no result file (session agent:backend-builder:factory-obj-c58897c0-integration-builder-1); "
  + "redacted executor output captured at evidence/obj-c58897c0-integration-builder-1-missing-result.md. "
  + "Reason: merge conflict integrating factory/obj-c58897c0-game-backend";

test("a merge conflict wrapped in a missing-result failure is not infrastructure", () => {
  assert.equal(classifyFailure({ error: REAL_BLOCKER_SUMMARY, outcome: "fail", source: "execution" }), "PROJECT_ERROR");
});

test("recovery inspects the conflicting branches, not the factory", () => {
  // The branch name contains the literal word `factory`, which used to aim the
  // FACTORY vocabulary at the wrong repair target.
  assert.equal(repairTargetFor(classifyFailure({ error: REAL_BLOCKER_SUMMARY, outcome: "fail" })), "project");
});

test("a conflict is never swept for silent retry, even when stale state calls it infrastructure", () => {
  const blocker = {
    outcome: "decision-required",
    classification: "INFRASTRUCTURE_ERROR", // what the objective recorded before this fix
    summary: "Recovery could not continue after 3 bounded attempt(s): " + REAL_BLOCKER_SUMMARY,
    why: REAL_BLOCKER_SUMMARY,
  };
  assert.equal(isRetriableInfraBlocker(blocker), false,
    "a merge is a pure function of two commits; retrying it reproduces the conflict forever");
});

test("a conflict reaching the founder is a decision, not a transient hiccup", () => {
  assert.equal(classifyBlocker({ outcome: "fail", summary: REAL_BLOCKER_SUMMARY }), "hard");
});

// The override is deliberately narrow. A `Reason:` suffix is NOT always a clean
// cause — it can be a raw stderr tail from a genuinely environmental failure —
// so only a provably deterministic cause outranks the wrapper. Everything else
// keeps the infra verdict, and the sweep keeps absorbing seat failures without
// paging anyone.
test("a low-signal captured reason keeps the wrapper's infra verdict", () => {
  const error = "product dispatch wrote no result file (session agent:openclaw:factory-x); "
    + "redacted executor output captured at evidence/x.md. Reason: trace [redacted: gh-token]";
  assert.equal(classifyFailure({ error, outcome: "fail", source: "execution" }), "INFRASTRUCTURE_ERROR");
  assert.equal(isRetriableInfraBlocker({ outcome: "fail", summary: error }), true);
});

test("an environmental captured reason is still infrastructure", () => {
  for (const reason of ["[openclaw] Could not start the CLI.", "All models failed (rate_limit)", "rate_limit", "provider unavailable"]) {
    const error = `builder dispatch wrote no result file (session agent:x:y); redacted executor output captured at evidence/x.md. Reason: ${reason}`;
    assert.equal(classifyFailure({ error, outcome: "fail", source: "execution" }), "INFRASTRUCTURE_ERROR", reason);
    assert.equal(isRetriableInfraBlocker({ outcome: "fail", summary: error }), true, reason);
  }
});

test("a bare missing-result failure with no captured reason is still infrastructure", () => {
  const error = "builder dispatch wrote no result file (session agent:x:y); redacted executor output captured at evidence/x.md.";
  assert.equal(classifyFailure({ error, outcome: "fail", source: "execution" }), "INFRASTRUCTURE_ERROR");
  assert.equal(isRetriableInfraBlocker({ outcome: "fail", summary: error }), true);
});

test("raw git conflict output is recognised wherever it surfaces", () => {
  assert.equal(isDeterministicProjectFailure("CONFLICT (content): Merge conflict in .gitignore"), true);
  assert.equal(isDeterministicProjectFailure("Automatic merge failed; fix conflicts and then commit the result."), true);
  assert.equal(isDeterministicProjectFailure("QA: 3 tests fail"), false);
});
