import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DECISION_STATES, buildDecisionHistory } from "../lib/hq/decision-history.mjs";

const NOW = "2026-09-10T00:00:00.000Z";
const ago = (days) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

function root() {
  return mkdtempSync(join(tmpdir(), "hq-decisions-"));
}

function writeTask(stateRoot, taskId, state) {
  const dir = join(stateRoot, "proj", "tasks", taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    task: { id: taskId, project: "hq", risk: "high", outcome: "Ship it" },
    status: "active", createdAt: ago(2), updatedAt: ago(1), events: [], ...state,
  }));
}

const history = (stateRoot, over = {}) => buildDecisionHistory({ hqRoot: stateRoot, stateRoot, now: NOW, ...over });

// --- the property that makes this safe --------------------------------------

test("the module exposes no way to approve anything", async () => {
  const module = await import("../lib/hq/decision-history.mjs");
  const writers = Object.keys(module).filter((name) => /approve|grant|authorize|record|write|set/i.test(name));
  assert.deepEqual(writers, [], "a decision history that can decide is a second approval gate");
  assert.deepEqual(Object.keys(module).sort(), ["DECISION_STATES", "buildDecisionHistory"]);
});

test("the report names the real authority, so nobody mistakes this for it", () => {
  assert.equal(history(root()).authority, "founder-signed-assertion");
});

// --- the high-risk approval lifecycle ---------------------------------------

test("an unanswered request is 'requested' and counted as awaiting the founder", () => {
  const stateRoot = root();
  writeTask(stateRoot, "t1", { founderApprovalRequest: { challenge: "abc", requestedAt: ago(1) } });
  const view = history(stateRoot);
  assert.equal(view.decisions[0].state, "requested");
  assert.equal(view.summary.awaitingFounder, 1);
  assert.equal(view.decisions[0].evidence.challengePresent, true);
});

test("a recorded approval that has not moved the work is 'approved', not 'consumed'", () => {
  const stateRoot = root();
  writeTask(stateRoot, "t1", {
    founderApprovalRequest: { challenge: "abc", requestedAt: ago(2) },
    founderApproval: { verified: true, evidence: { path: "evidence/approval.md" } },
    events: [{ at: ago(1), type: "founder-approval-recorded" }],
  });
  const decision = history(stateRoot).decisions[0];
  assert.equal(decision.state, "approved");
  assert.equal(decision.evidence.signatureVerified, true);
  assert.equal(decision.evidence.evidencePath, "evidence/approval.md");
});

test("an approval the build actually resumed on is 'consumed'", () => {
  const stateRoot = root();
  writeTask(stateRoot, "t1", {
    founderApprovalRequest: { challenge: "abc", requestedAt: ago(3) },
    founderApproval: { verified: true },
    events: [{ at: ago(2), type: "founder-approval-recorded" }, { at: ago(1), type: "task-resumed" }],
  });
  assert.equal(history(stateRoot).decisions[0].state, "consumed");
});

test("a resume BEFORE the approval does not count as consuming it", () => {
  const stateRoot = root();
  writeTask(stateRoot, "t1", {
    founderApprovalRequest: { challenge: "abc", requestedAt: ago(4) },
    founderApproval: { verified: true },
    events: [{ at: ago(3), type: "task-resumed" }, { at: ago(1), type: "founder-approval-recorded" }],
  });
  assert.equal(history(stateRoot).decisions[0].state, "approved");
});

test("a rejection after an approval wins", () => {
  const stateRoot = root();
  writeTask(stateRoot, "t1", {
    founderApprovalRequest: { challenge: "abc", requestedAt: ago(3) },
    events: [{ at: ago(2), type: "founder-approval-recorded" }, { at: ago(1), type: "founder-approval-rejected" }],
  });
  assert.equal(history(stateRoot).decisions[0].state, "rejected");
});

test("a re-key before any decision revokes the request: that signature can no longer be produced", () => {
  const stateRoot = root();
  writeTask(stateRoot, "t1", {
    founderApprovalRequest: { challenge: "abc", requestedAt: ago(3) },
    events: [{ at: ago(1), type: "founder-approval-authority-rekeyed" }],
  });
  const decision = history(stateRoot).decisions[0];
  assert.equal(decision.state, "revoked");
  assert.equal(decision.evidence.rekeyed, true);
});

test("a stale request on a task nobody is waiting on reports as expired", () => {
  const stateRoot = root();
  writeTask(stateRoot, "t1", { status: "complete", founderApprovalRequest: { challenge: "abc", requestedAt: ago(60) } });
  assert.equal(history(stateRoot).decisions[0].state, "expired");
});

test("expiry is a reading of the record, never an action on it", () => {
  const stateRoot = root();
  writeTask(stateRoot, "t1", { status: "complete", founderApprovalRequest: { challenge: "abc", requestedAt: ago(60) } });
  const before = JSON.parse(JSON.stringify(history(stateRoot)));
  history(stateRoot);
  // Reading twice must be identical: nothing was consumed, invalidated, or aged.
  assert.deepEqual(history(stateRoot).decisions, before.decisions);
});

test("a live task still awaiting the founder is never expired away", () => {
  const stateRoot = root();
  writeTask(stateRoot, "t1", { founderApprovalRequest: { challenge: "abc", requestedAt: ago(90) } });
  assert.equal(history(stateRoot).decisions[0].state, "requested", "an old ask the founder still owes an answer to stays visible");
});

// --- founder decisions that are not approvals -------------------------------

test("a decision-required blocker is part of the same history", () => {
  const stateRoot = root();
  writeTask(stateRoot, "t1", {
    task: { id: "t1", project: "hq", risk: "low", outcome: "x" },
    blocker: { outcome: "decision-required", summary: "Pick a provider", stage: "architect", classification: "FOUNDER_DECISION_REQUIRED" },
    events: [{ at: ago(1), type: "stage-decision-required" }],
  });
  const decision = history(stateRoot).decisions[0];
  assert.equal(decision.kind, "founder-decision");
  assert.equal(decision.state, "requested");
  assert.equal(decision.evidence.stage, "architect");
  assert.equal(decision.summary, "Pick a provider");
});

test("an approval row never borrows an unrelated blocker's text", () => {
  const stateRoot = root();
  writeTask(stateRoot, "t1", {
    founderApprovalRequest: { challenge: "abc", requestedAt: ago(1) },
    blocker: { outcome: "decision-required", summary: "Recovery could not continue after 3 attempts", stage: "release" },
    events: [{ at: ago(1), type: "recovery-escalated" }],
  });
  const approval = history(stateRoot).decisions.find((d) => d.kind === "high-risk-build");
  assert.doesNotMatch(approval.summary, /Recovery could not continue/);
  assert.match(approval.summary, /requires founder approval/);
});

// --- correlation, sanitisation, degradation ---------------------------------

test("decisions carry task, objective, and project correlation", () => {
  const stateRoot = root();
  writeTask(stateRoot, "obj-abc123-node-one", {
    task: { id: "obj-abc123-node-one", project: "lifemaxing", risk: "high", outcome: "x" },
    founderApprovalRequest: { challenge: "abc", requestedAt: ago(1) },
  });
  const decision = history(stateRoot).decisions[0];
  assert.equal(decision.taskId, "obj-abc123-node-one");
  assert.equal(decision.objectiveId, "obj-abc123");
  assert.equal(decision.projectId, "lifemaxing");
  assert.equal(decision.risk, "high");
});

test("the signed assertion, challenge, and evidence body are never published", () => {
  const stateRoot = root();
  writeTask(stateRoot, "t1", {
    founderApprovalRequest: { challenge: "SECRET-CHALLENGE-VALUE", requestedAt: ago(1) },
    founderApproval: { verified: true, assertion: { signature: "SECRET-SIGNATURE" } },
    founderApprovalAuthority: { fingerprint: "a".repeat(64) },
  });
  const json = JSON.stringify(history(stateRoot));
  assert.doesNotMatch(json, /SECRET-CHALLENGE-VALUE/);
  assert.doesNotMatch(json, /SECRET-SIGNATURE/);
  assert.equal(history(stateRoot).decisions[0].evidence.keyFingerprint.length, 32, "the fingerprint is truncated, not echoed whole");
});

test("an unparsable task state degrades the view rather than hiding every decision", () => {
  const stateRoot = root();
  writeTask(stateRoot, "good", { founderApprovalRequest: { challenge: "abc", requestedAt: ago(1) } });
  const dir = join(stateRoot, "proj", "tasks", "bad");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), "{ truncated");

  const view = history(stateRoot);
  assert.equal(view.available, false);
  assert.match(view.warnings.join(" "), /task bad decision history unavailable/);
  assert.equal(view.decisions.length, 1, "the readable decisions still render");
});

test("an empty factory reports an empty history, not a failure", () => {
  const view = history(root());
  assert.equal(view.available, true);
  assert.equal(view.summary.total, 0);
  for (const state of DECISION_STATES) assert.equal(view.summary[state], 0);
});
