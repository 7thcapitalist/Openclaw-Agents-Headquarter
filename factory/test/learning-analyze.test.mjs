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

test("post-run inefficiency classifiers retain objective, task, and result-path evidence", () => {
  const repeated = record({
    id: "obj-deadbeef-a", objectiveId: "obj-deadbeef",
    dispatches: [
      { stage: "reviewer", attempt: 1, outcome: "pass", completedAt: "2026-09-01T00:00:00Z", resultPath: "/state/reviewer-1.json", summary: "approved" },
      { stage: "reviewer", attempt: 2, outcome: "pass", completedAt: "2026-09-01T02:00:00Z", resultPath: "/state/reviewer-2.json", summary: "approved again" },
    ],
    retryByStage: { reviewer: 1 },
    events: [{ at: "2026-09-01T01:00:00Z", type: "founder-approval-recorded", stages: [] }],
  });
  const noVerdict = record({
    id: "obj-deadbeef-b", objectiveId: "obj-deadbeef",
    dispatches: [{ stage: "builder", attempt: 1, outcome: "fail", resultPath: "/state/builder.json", summary: "could not start the CLI" }],
  });
  const upstream = record({
    id: "obj-deadbeef-c", objectiveId: "obj-deadbeef",
    dispatches: [
      { stage: "architect", attempt: 1, outcome: "fail", resultPath: "/state/architect.json", summary: "missing context in handoff" },
      { stage: "builder", attempt: 2, outcome: "pass", resultPath: "/state/builder-2.json", summary: "reworked" },
    ],
    retryByStage: { builder: 1 },
  });
  const infra = record({
    id: "obj-deadbeef-d", objectiveId: "obj-deadbeef",
    dispatches: [{ stage: "builder", attempt: 1, outcome: "fail", status: "failed", resultPath: "/state/infra.json", summary: "could not run" }],
    objectiveNodeBlocker: {
      objectiveId: "obj-deadbeef", objectivePath: "/state/objective-state.json",
      blocker: { stage: "builder", outcome: "decision-required", infra: true, summary: "could not run; retry the objective later" },
    },
  });
  const slowGroup = [1, 2, 3, 10].map((hours, index) => record({
    id: `obj-feedface-${index}`, objectiveId: "obj-feedface", cycleMs: hours * 3600000,
    dispatches: [{ stage: "release", attempt: 1, resultPath: `/state/slow-${index}.json`, summary: "done" }],
  }));

  const out = analyzeTasks([repeated, noVerdict, upstream, infra, ...slowGroup], { now: NOW });
  for (const prefix of ["no-verdict-dispatch", "repeated-stage-run", "unchanged-gate-rerun", "builder-rework-upstream-gap", "founder-interruption-infrastructure", "slow-cycle-outlier"]) {
    const finding = out.failures.find((item) => item.fingerprint.startsWith(prefix));
    assert.ok(finding, `missing ${prefix}`);
    assert.ok(finding.objectiveId);
    assert.equal(finding.taskIds.length, 1);
    assert.ok(finding.evidence.some((item) => item.path.endsWith(".json")), `${prefix} lacks result-file evidence`);
  }
});

test("recurring post-run inefficiency is marked as a pattern at the configured threshold", () => {
  const records = ["obj-aaaaaaaa-a", "obj-bbbbbbbb-b"].map((id, index) => record({
    id, objectiveId: id.slice(0, 12),
    dispatches: [{ stage: "qa", attempt: 1, resultPath: `/state/qa-${index}.json`, summary: "wrote no result file" }],
  }));
  const out = analyzeTasks(records, { now: NOW, patternThreshold: 2 });
  const pattern = out.patterns.find((item) => item.fingerprint === "no-verdict-dispatch:qa");
  assert.ok(pattern);
  assert.equal(pattern.occurrences, 2);
  assert.equal(pattern.objectiveId, null, "cross-objective patterns are systemic rather than attributed to one objective");
});
