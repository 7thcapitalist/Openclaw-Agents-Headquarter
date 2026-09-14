// A `decision-required` result must land its question on the task's `.blocker`.
//
// Regression: discovery for the founder queue walks `state.json`, so a decision
// that lives only in a result file is invisible. On 2026-09-14 the
// obj-c58897c0-integration recovery pass escalated with a two-option question
// and outcome `decision-required`; ingestion read `result.decision` only for
// `decision-deferred`, so the question never reached state and nothing
// founder-facing ever showed it. Ingestion is where a result becomes state, so
// the promotion belongs here.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { createState, readState, writeState } from "../lib/task-workflow.mjs";
import { ingestResult, prepareDispatch } from "../lib/openclaw-protocol.mjs";
import { findDecisions } from "../../scripts/founder-approve.mjs";

const hqRoot = resolve(".");

const task = {
  id: "task-decision-promotion",
  issue: "local:decision-promotion",
  outcome: "Integrate the sub-task branches and verify the combined tree.",
  acceptanceCriteria: ["Every sub-task branch merges without conflict"],
  project: "demo",
  workType: "ops",
  risk: "medium",
};

// A state tree shaped the way the founder queue's discovery walks it:
// <stateRoot>/<project>/tasks/<task-id>/state.json
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "decision-promotion-"));
  const worktree = join(root, "worktree");
  const statePath = join(root, "state", "demo", "tasks", task.id, "state.json");
  mkdirSync(worktree, { recursive: true });
  writeState(statePath, createState({ task, repo: join(root, "repo"), branch: "factory/x", worktree }));
  return { root, worktree, statePath, stateRoot: join(root, "state") };
}

function writeEvidence(worktree, stage) {
  mkdirSync(join(worktree, "evidence"), { recursive: true });
  const relative = `evidence/${stage}.md`;
  writeFileSync(join(worktree, relative), `${stage} verified\n`);
  return relative;
}

// The shape the 2026-09-14 escalation actually had.
const DECISION = {
  question:
    "The recovery-diagnose loop for the reviewer stage has run 6 consecutive times with identical"
    + " 'no code defect' conclusions, but the orchestrator never advances. How should this be unblocked?",
  why: "Six independent passes agree there is no code defect blocking the gate.",
  options: [
    "A. Fix the orchestrator's stage-advancement logic (durable fix)",
    "B. Manually trigger reviewer and security against the current verified HEAD (fastest unblock)",
    "Other",
  ],
  recommendation: "A, with B as an immediate unblock.",
};

test("a decision-required result promotes its question onto the blocker", () => {
  const fixture = makeFixture();
  const dispatch = prepareDispatch({ hqRoot, statePath: fixture.statePath });
  const evidence = [writeEvidence(fixture.worktree, dispatch.stage)];

  ingestResult({
    statePath: fixture.statePath,
    result: {
      version: 1,
      dispatchId: dispatch.dispatchId,
      stage: dispatch.stage,
      actor: dispatch.actor,
      outcome: "decision-required",
      summary: "Escalating rather than writing a 7th pass into a non-converging loop.",
      evidence,
      decision: DECISION,
    },
  });

  const state = readState(fixture.statePath);
  assert.equal(state.status, "blocked");
  assert.equal(state.blocker.outcome, "decision-required");

  // The question itself — not just the prose summary — must survive ingestion.
  assert.ok(state.blocker.decision, "the blocker must carry the agent's decision");
  assert.match(state.blocker.decision.question, /How should this be unblocked\?/);
  assert.equal(state.blocker.decision.options.length, 3);
  assert.match(state.blocker.decision.recommendation, /^A,/);

  // Provenance: which stage asked, which dispatch, and when.
  assert.equal(state.blocker.decision.stage, dispatch.stage);
  assert.equal(state.blocker.stage, dispatch.stage);
  assert.equal(state.blocker.dispatchId, dispatch.dispatchId);
  assert.ok(state.blocker.at, "the blocker must record when it was raised");
  assert.ok(state.blocker.decision.requestedAt, "the decision must record when it was asked");
});

test("the founder decision queue surfaces a promoted decision", () => {
  const fixture = makeFixture();
  const dispatch = prepareDispatch({ hqRoot, statePath: fixture.statePath });
  const evidence = [writeEvidence(fixture.worktree, dispatch.stage)];

  assert.deepEqual(findDecisions(fixture.stateRoot), [], "nothing is waiting before the escalation");

  ingestResult({
    statePath: fixture.statePath,
    result: {
      version: 1,
      dispatchId: dispatch.dispatchId,
      stage: dispatch.stage,
      actor: dispatch.actor,
      outcome: "decision-required",
      summary: "No safe progress is possible without a founder call.",
      evidence,
      decision: DECISION,
    },
  });

  const waiting = findDecisions(fixture.stateRoot);
  assert.deepEqual(waiting.map((p) => p.state.task.id), [task.id]);
  assert.match(waiting[0].state.blocker.decision.question, /How should this be unblocked\?/);
});

test("a malformed decision is kept, not dropped — losing the question is the bug", () => {
  const fixture = makeFixture();
  const dispatch = prepareDispatch({ hqRoot, statePath: fixture.statePath });
  const evidence = [writeEvidence(fixture.worktree, dispatch.stage)];

  // One option, no `why`: this would be rejected as a *deferred* decision.
  // A required decision is the task stopping dead, so it must still be recorded.
  ingestResult({
    statePath: fixture.statePath,
    result: {
      version: 1,
      dispatchId: dispatch.dispatchId,
      stage: dispatch.stage,
      actor: dispatch.actor,
      outcome: "decision-required",
      summary: "Blocked on an authority gate.",
      evidence,
      decision: { question: "Who owns the Vercel project?", options: ["Ask the founder"] },
    },
  });

  const state = readState(fixture.statePath);
  assert.equal(state.blocker.decision.question, "Who owns the Vercel project?");
  assert.deepEqual(state.blocker.decision.options, ["Ask the founder"]);
});

test("a plain fail carries no decision — a failure is not a question", () => {
  const fixture = makeFixture();
  const dispatch = prepareDispatch({ hqRoot, statePath: fixture.statePath });
  const evidence = [writeEvidence(fixture.worktree, dispatch.stage)];

  ingestResult({
    statePath: fixture.statePath,
    result: {
      version: 1,
      dispatchId: dispatch.dispatchId,
      stage: dispatch.stage,
      actor: dispatch.actor,
      outcome: "fail",
      summary: "product stage failed",
      evidence,
    },
  });

  // A `fail` at a routable stage is retried rather than blocked, so the status
  // is deliberately not asserted here. What matters is that nothing invents a
  // decision: a failure is not a question for the founder.
  const state = readState(fixture.statePath);
  assert.equal(state.blocker?.decision, undefined, "a fail is not a question");
});
