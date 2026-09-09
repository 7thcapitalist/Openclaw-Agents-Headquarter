import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyBlocker, classifyObjectiveNodeBlocker, isInfraFailure, isFounderDecision,
  isFounderApprovalSetupFailure, founderApprovalSetupBlocker,
} from "../lib/hq/blocker-class.mjs";

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
    "reviewer agent could not run: [openclaw] Could not start the CLI.",
    "release agent could not run: failed to start",
    "dispatch orphaned by a host restart",
    "the agent process was killed",
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

test("classifyObjectiveNodeBlocker: infra:true tag on decision-required → infra", () => {
  assert.equal(classifyObjectiveNodeBlocker({
    outcome: "decision-required",
    infra: true,
    summary: "The builder for this task could not run (rate_limit). Retry the objective later, or adjust model routing for that role.",
  }), "infra");
});

test("classifyObjectiveNodeBlocker: backfill synthesized sentence without tag → infra", () => {
  assert.equal(classifyObjectiveNodeBlocker({
    outcome: "decision-required",
    summary: "The qa for this task could not run (ECONNRESET). Retry the objective later, or adjust model routing for that role.",
  }), "infra");
});

test("classifyObjectiveNodeBlocker: merge conflict stays decision", () => {
  assert.equal(classifyObjectiveNodeBlocker({
    outcome: "decision-required",
    summary: "merge conflict integrating factory/obj-x-a",
  }), "decision");
});

test("classifyObjectiveNodeBlocker: genuine stage decision stays decision", () => {
  assert.equal(classifyObjectiveNodeBlocker({
    outcome: "decision-required",
    summary: "Choose Postgres or SQLite",
  }), "decision");
});

test("classifyObjectiveNodeBlocker: fail summaries → infra|hard", () => {
  assert.equal(classifyObjectiveNodeBlocker({ outcome: "fail", summary: "ECONNRESET" }), "infra");
  assert.equal(classifyObjectiveNodeBlocker({ outcome: "fail", summary: "tests fail" }), "hard");
});

test("classifyObjectiveNodeBlocker: null → null", () => {
  assert.equal(classifyObjectiveNodeBlocker(null), null);
});

test("a missing founder approval key is a founder decision, never infra or hard", () => {
  // The exact string createState() throws.
  assert.equal(isFounderApprovalSetupFailure("High-risk task initialization requires the configured founder public key."), true);
  assert.equal(isFounderApprovalSetupFailure("Reviewer: acceptance criteria not met"), false);

  const b = founderApprovalSetupBlocker({ at: "2026-09-08T19:39:00.000Z" });
  assert.equal(b.outcome, "decision-required");
  assert.equal(b.founderAction, true);
  assert.equal(b.stage, "init");
  assert.equal(classifyBlocker(b), "decision");
  assert.equal(classifyObjectiveNodeBlocker(b), "decision");
  assert.equal(isFounderDecision(b), true);
  assert.equal(isInfraFailure(b), false);
});

test("a founderAction blocker with no outcome still classifies as a decision", () => {
  assert.equal(classifyBlocker({ founderAction: true, summary: "needs you" }), "decision");
  assert.equal(classifyObjectiveNodeBlocker({ founderAction: true, summary: "needs you" }), "decision");
});
