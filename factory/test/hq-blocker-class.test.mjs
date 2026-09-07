import test from "node:test";
import assert from "node:assert/strict";
import { classifyBlocker, isInfraFailure, isFounderDecision } from "../lib/hq/blocker-class.mjs";

test("a decision-required blocker is a founder decision, nothing else", () => {
  const b = { outcome: "decision-required", stage: "architect", summary: "Pick a database." };
  assert.equal(classifyBlocker(b), "decision");
  assert.equal(isFounderDecision(b), true);
  assert.equal(isInfraFailure(b), false);
});

test("transient agent/process failures classify as infra (never paged to the founder)", () => {
  for (const summary of [
    "Agent did not write its result file: /x/results/task-release-3.json",
    "the qa agent (qa) produced no result file",
    "openclaw agent timed out after 3600s",
    "request failed: 429 Too Many Requests",
    "upstream error 503",
    "socket hang up",
    "ECONNRESET",
    "model gpt-5 unavailable, provider capacity",
  ]) {
    assert.equal(classifyBlocker({ outcome: "fail", summary }), "infra", summary);
    assert.equal(isInfraFailure({ outcome: "fail", summary }), true, summary);
  }
});

test("a real FAIL reason classifies as hard (worth a founder look)", () => {
  for (const summary of [
    "Reviewer: acceptance criteria not met — greet() returns the wrong string",
    "QA: 3 tests fail in factory/test/foo.test.mjs",
    "Security: hard-coded credential in src/config.mjs",
  ]) {
    assert.equal(classifyBlocker({ outcome: "fail", summary }), "hard", summary);
  }
});

test("no blocker -> null", () => {
  assert.equal(classifyBlocker(null), null);
  assert.equal(classifyBlocker(undefined), null);
});
