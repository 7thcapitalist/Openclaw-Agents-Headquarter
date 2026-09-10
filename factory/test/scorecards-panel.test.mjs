import test from "node:test";
import assert from "node:assert/strict";
import { scorecardsPanel } from "../../dashboard/backend/public/lib/scorecardsView.mjs";

const card = (over = {}) => ({
  agentId: "codex", sampleSize: 25, confidence: "high",
  outcomes: { accepted: 20, failed: 5, escalated: 0, acceptanceRate: 0.8 },
  quality: { findingsAgainst: 2, gateFailuresRaised: 0, gateRuns: 0, recoveries: 1, founderEscalations: 0, retryRate: 0.2 },
  latency: { medianMs: 205_000, samples: 25 },
  cost: { micros: 4_000_000, unpricedEvents: 0, microsPerAcceptedOutcome: 200_000, complete: true },
  dataQuality: { dispatches: 25, latencySamples: 25, missingCost: false, note: null },
  ...over,
});

const snapshot = (over = {}) => ({
  version: 1, available: true, usage: "advisory-only", warnings: [], pricingVersion: "2026-09-08",
  summary: { agents: 1, lowConfidence: 0, missingCostData: 0 }, scorecards: [card()], ...over,
});

test("renders an honest unavailable state", () => {
  assert.match(scorecardsPanel(null), /Unavailable/);
});

test("a factory with no decided outcomes says so", () => {
  assert.match(scorecardsPanel(snapshot({ scorecards: [], summary: { agents: 0 } })), /No agent has produced a decided outcome/);
});

test("a confident agent shows its rate, always with the sample size", () => {
  const html = scorecardsPanel(snapshot());
  assert.match(html, /80% accepted/);
  assert.match(html, /n=25/);
  assert.match(html, /high confidence/);
});

test("a low-confidence agent shows counts, never a percentage", () => {
  const html = scorecardsPanel(snapshot({
    scorecards: [card({ sampleSize: 1, confidence: "low", outcomes: { accepted: 1, failed: 0, escalated: 0, acceptanceRate: 1 } })],
  }));
  assert.match(html, /1 accepted of 1/);
  assert.doesNotMatch(html, /100% accepted/, "a rate over n=1 is the easiest way for this panel to lie");
  assert.match(html, /low confidence/);
});

test("cost is shown per accepted outcome, never as a total", () => {
  const html = scorecardsPanel(snapshot());
  assert.match(html, /cost \/ accepted/);
  assert.match(html, /\$0\.2000/);
  assert.doesNotMatch(html, /\$4\.00/, "the raw total would invite minimising it");
});

test("incomplete cost data is called incomparable rather than shown as a number", () => {
  const html = scorecardsPanel(snapshot({
    summary: { agents: 1, lowConfidence: 0, missingCostData: 1 },
    scorecards: [card({ cost: { micros: null, unpricedEvents: 3, microsPerAcceptedOutcome: null, complete: false } })],
  }));
  assert.match(html, /incomplete/);
  assert.match(html, /not comparable/);
});

test("findings against, recoveries, and a high retry rate are flagged", () => {
  const html = scorecardsPanel(snapshot());
  assert.match(html, /findings against/);
  assert.match(html, /recoveries/);
  const noisy = scorecardsPanel(snapshot({ scorecards: [card({ quality: { ...card().quality, retryRate: 0.9 } })] }));
  assert.match(noisy, /90%/);
  assert.match(noisy, /status-warn/);
});

test("gate credit only appears for agents that actually ran as a gate", () => {
  assert.doesNotMatch(scorecardsPanel(snapshot()), /caught as gate/);
  const gate = scorecardsPanel(snapshot({ scorecards: [card({ agentId: "claude", quality: { ...card().quality, gateRuns: 40, gateFailuresRaised: 12 } })] }));
  assert.match(gate, /caught as gate/);
});

test("the panel states it is advisory and names where routing lives", () => {
  const html = scorecardsPanel(snapshot());
  assert.match(html, /Advisory only/);
  assert.match(html, /factory\/factory\.config\.json/);
});

test("degraded input is labelled", () => {
  assert.match(scorecardsPanel(snapshot({ available: false })), /figures are incomplete/);
});

test("agent identifiers are escaped", () => {
  const html = scorecardsPanel(snapshot({ scorecards: [card({ agentId: "<script>alert(1)</script>" })] }));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("the panel carries an accessible section label", () => {
  assert.match(scorecardsPanel(snapshot()), /aria-labelledby="factory-scorecards-title"/);
});

test("a real cost that rounds to zero is never shown as free, and never emits raw markup", () => {
  const html = scorecardsPanel(snapshot({
    scorecards: [card({ cost: { micros: 39, unpricedEvents: 0, microsPerAcceptedOutcome: 39, complete: true } })],
  }));
  assert.match(html, /under \$0\.0001/);
  assert.doesNotMatch(html, /\$0\.0000/);
  assert.doesNotMatch(html, /<\$/, "a formatter that emits a raw < is one refactor from an injection");
});
