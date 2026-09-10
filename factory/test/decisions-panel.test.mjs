import test from "node:test";
import assert from "node:assert/strict";
import { decisionsPanel } from "../../dashboard/backend/public/lib/decisionsView.mjs";

const decision = (over = {}) => ({
  kind: "high-risk-build", taskId: "obj-abc-node", objectiveId: "obj-abc", projectId: "lifemaxing", risk: "high",
  state: "requested", requestedAt: "2026-09-09T10:00:00Z", decidedAt: null, updatedAt: "2026-09-09T10:00:00Z",
  actor: "system", summary: "High-risk build in lifemaxing requires founder approval before build.",
  evidence: { challengePresent: true, keyFingerprint: "abc", signatureVerified: false, evidencePath: null, rekeyed: false },
  ...over,
});

const snapshot = (over = {}) => ({
  version: 1, available: true, authority: "founder-signed-assertion", warnings: [],
  summary: { total: 1, requested: 1, approved: 0, rejected: 0, consumed: 0, revoked: 0, expired: 0, awaitingFounder: 1, unsigned: 0 },
  decisions: [decision()], ...over,
});

test("renders an honest unavailable state", () => {
  assert.match(decisionsPanel(null), /Unavailable/);
});

test("a factory that has never asked anything says so", () => {
  const html = decisionsPanel(snapshot({ decisions: [], summary: { total: 0, awaitingFounder: 0 } }));
  assert.match(html, /Nothing recorded/);
  assert.match(html, /has not asked you to decide anything/);
});

test("the header leads with what is waiting on the founder", () => {
  assert.match(decisionsPanel(snapshot()), /1 waiting on you/);
  assert.match(decisionsPanel(snapshot({ summary: { total: 1, awaitingFounder: 0 } })), /All answered/);
});

test("each lifecycle state renders as itself", () => {
  for (const [state, label] of [
    ["requested", "Waiting on you"], ["approved", "Approved"], ["consumed", "Approved and used"],
    ["rejected", "Rejected"], ["revoked", "Revoked by re-key"], ["expired", "Expired"],
  ]) {
    assert.match(decisionsPanel(snapshot({ decisions: [decision({ state })] })), new RegExp(label));
  }
});

test("the panel states where authority actually lives", () => {
  assert.match(decisionsPanel(snapshot()), /never a way to grant it/);
});

test("an approval without a verified signature is called out, loudly", () => {
  const html = decisionsPanel(snapshot({ summary: { total: 1, awaitingFounder: 0, unsigned: 2 } }));
  assert.match(html, /2 approval\(s\) recorded without a verified signature/);
  assert.match(html, /Investigate before trusting them/);
});

test("a verified signature is shown on the row", () => {
  assert.match(decisionsPanel(snapshot({ decisions: [decision({ evidence: { signatureVerified: true } })] })), /· signed/);
});

test("degraded history is labelled, not presented as complete", () => {
  assert.match(decisionsPanel(snapshot({ available: false })), /history is incomplete/);
});

test("summaries, task ids, and project ids are escaped", () => {
  const html = decisionsPanel(snapshot({ decisions: [decision({ summary: "<script>alert(1)</script>", taskId: "<img src=x>", projectId: "\"><b>" })] }));
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /&lt;script&gt;/);
});

test("the panel carries an accessible section label", () => {
  assert.match(decisionsPanel(snapshot()), /aria-labelledby="factory-decisions-title"/);
});
