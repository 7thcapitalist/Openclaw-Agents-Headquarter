import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTasks, clusterFindings } from "../lib/learning/analyze.mjs";

const NOW = "2026-09-03T00:00:00Z";

function record(over = {}) {
  return {
    id: "t",
    project: "demo",
    repo: "/demo",
    risk: "low",
    workType: "backend",
    assignments: { builder: "codex", reviewer: "claude", qa: "codex" },
    terminalStatus: "blocked",
    blocker: null,
    createdAt: "2026-09-01T00:00:00Z",
    endedAt: "2026-09-01T01:00:00Z",
    cycleMs: 3600000,
    stageOutcomes: [],
    dispatches: [],
    failedDispatches: [],
    retryByStage: {},
    decisionEvents: [],
    founderDecisions: [],
    evidenceByStage: {},
    ...over,
  };
}

test("recurring ambiguous-criteria builder failures become a pattern and an agent-improvement", () => {
  const recs = [
    record({ id: "t1", failedDispatches: [{ stage: "builder", attempt: 1, outcome: "fail", summary: "acceptance criteria not testable", error: null }] }),
    record({ id: "t2", failedDispatches: [{ stage: "builder", attempt: 1, outcome: "fail", summary: "requirement unclear, non-observable criteria", error: null }] }),
  ];
  const out = analyzeTasks(recs, { now: NOW });
  assert.equal(out.failures.length, 2);
  assert.equal(out.patterns.length, 1);
  assert.equal(out.patterns[0].fingerprint, "builder-fail:backend:ambiguous-acceptance-criteria");
  assert.equal(out.patterns[0].occurrences, 2);
  assert.equal(out.agentImprovements.length, 1);
  assert.equal(out.agentImprovements[0].targetRole, "builder");
  assert.match(out.agentImprovements[0].recommendation, /acceptance test/i);
});

test("retry exhaustion is a high-confidence agent-scoped finding", () => {
  const recs = [record({ id: "t1", retryByStage: { builder: 2 } })];
  const out = analyzeTasks(recs, { now: NOW, maxAttemptsPerStage: 3 });
  const rx = out.failures.find((f) => f.fingerprint.startsWith("retry-exhaustion"));
  assert.ok(rx);
  assert.equal(rx.confidence, "high");
  assert.equal(rx.scope, "agent");
  assert.equal(rx.targetRole, "builder");
});

test("review rejection is classified from the failed stage and verdicts", () => {
  const recs = [record({
    id: "t1",
    stageOutcomes: [{ stage: "reviewer", status: "fail", attempts: 1, summary: "regression in the existing suite" }],
    evidenceByStage: { reviewer: [{ path: "review.md", verdicts: ["CHANGES REQUIRED"], excerpt: "broke existing behaviour" }] },
  })];
  const out = analyzeTasks(recs, { now: NOW });
  const rr = out.failures.find((f) => f.targetRole === "reviewer");
  assert.ok(rr);
  assert.match(rr.fingerprint, /^reviewer-reject:backend:/);
  assert.match(rr.observation, /CHANGES REQUIRED/);
});

test("decision friction records the wait time when resolved", () => {
  const recs = [record({
    id: "t1",
    blocker: { stage: "architect", outcome: "decision-required", at: "2026-09-01T00:00:00Z" },
    decisionEvents: [
      { at: "2026-09-01T00:00:00Z", type: "stage-decision-required", stage: "architect" },
      { at: "2026-09-01T05:00:00Z", type: "founder-decision-recorded", stage: "architect" },
    ],
  })];
  const out = analyzeTasks(recs, { now: NOW });
  const df = out.failures.find((f) => f.fingerprint.startsWith("decision-friction"));
  assert.ok(df);
  assert.match(df.observation, /~5h/);
});

test("clean merge-ready deliveries surface as successes", () => {
  const recs = [record({
    id: "t1",
    terminalStatus: "merge-ready",
    failedDispatches: [],
    dispatches: [{ stage: "builder" }, { stage: "reviewer" }, { stage: "qa" }],
    stageOutcomes: [{ stage: "builder", status: "pass", attempts: 1, summary: "implemented cleanly" }],
  })];
  const out = analyzeTasks(recs, { now: NOW });
  assert.equal(out.successes.length, 1);
  assert.equal(out.successes[0].kind, "success");
  assert.match(out.successes[0].fingerprint, /^clean-delivery:backend:codex:low/);
});

test("analysis is deterministic for fixed input and now", () => {
  const recs = [
    record({ id: "t1", failedDispatches: [{ stage: "builder", attempt: 1, outcome: "fail", summary: "compile error: cannot find module x" }] }),
    record({ id: "t2", terminalStatus: "merge-ready", failedDispatches: [], dispatches: [{ stage: "builder" }] }),
  ];
  const a = JSON.stringify(analyzeTasks(recs, { now: NOW }));
  const b = JSON.stringify(analyzeTasks(recs, { now: NOW }));
  assert.equal(a, b);
});

test("clusterFindings ignores singletons below the threshold", () => {
  const findings = [
    { kind: "failure", fingerprint: "x:y:z", targetRole: "builder", scope: "global", project: "p", title: "t", observation: "o", recommendation: "r", taskIds: ["a"], evidence: [] },
  ];
  const { patterns } = clusterFindings(findings, { patternThreshold: 2, now: NOW });
  assert.equal(patterns.length, 0);
});
