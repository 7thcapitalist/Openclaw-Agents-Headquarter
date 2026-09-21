import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  countStageAttempts,
  createState,
  readState,
  recordVerifiedCommit,
  stageBudgetExceeded,
  writeState,
} from "../lib/task-workflow.mjs";
import { ingestResult, prepareDispatch } from "../lib/openclaw-protocol.mjs";
import { runConcurrentGroupIfReady } from "../lib/openclaw-runner.mjs";

const hqRoot = process.cwd();
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const task = {
  id: "issue-verdict-attribution",
  issue: "local:verdict-attribution",
  outcome: "Attribute gate verdicts to commits.",
  acceptanceCriteria: ["Repeated judgments do not spend verdict budget"],
  project: "sample",
  workType: "backend",
  risk: "low",
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "verdict-attribution-"));
  const worktree = join(root, "worktree");
  const statePath = join(root, "state", "state.json");
  mkdirSync(worktree);
  mkdirSync(join(worktree, "evidence"));
  for (const stage of ["reviewer", "qa", "security"]) {
    writeFileSync(join(worktree, "evidence", `${stage}.md`), `${stage} evidence\n`);
  }
  const state = createState({
    task,
    repo: join(root, "repo"),
    branch: "factory/verdict-attribution",
    worktree,
  });
  return { root, worktree, statePath, state };
}

function gateRecord(stage, outcome, judgedCommit) {
  return { stage, kind: "stage", status: "completed", outcome, judgedCommit };
}

function stageRecord(stage, outcome = "pass") {
  return {
    status: outcome,
    actor: "claude",
    summary: `${stage} ${outcome}`,
    evidence: [{ path: `evidence/${stage}.md`, recordedAt: "2026-09-18T00:00:00.000Z" }],
    evidenceStrength: "asserted",
    completedAt: "2026-09-18T00:00:00.000Z",
  };
}

test("evidence invalidation and a passing re-run do not spend gate verdict budget", () => {
  for (const stage of ["reviewer", "qa", "security"]) {
    const { state } = fixture();
    state.verifiedCommit = { sha: SHA_A };
    state.stages[stage] = stageRecord(stage, "pass");
    state.dispatches = [gateRecord(stage, "fail", SHA_A)];
    const before = countStageAttempts(state, stage);

    const invalidated = recordVerifiedCommit(state, { sha: SHA_B });
    invalidated.dispatches.push(gateRecord(stage, "pass", SHA_B));
    const after = countStageAttempts(invalidated, stage);

    assert.equal(invalidated.stages[stage].status, "pending");
    assert.equal(after.verdicts, before.verdicts, `${stage} invalidation/re-run is free`);
    assert.equal(stageBudgetExceeded(invalidated, stage).verdicts, 1);
  }
});

test("gate dispatches are stamped with their judged commit and snapshot their verdict", () => {
  const { state, statePath } = fixture();
  state.currentStage = "reviewer";
  state.verifiedCommit = { sha: SHA_A };
  writeState(statePath, state);

  const dispatch = prepareDispatch({ hqRoot, statePath });
  const result = {
    version: 1,
    dispatchId: dispatch.dispatchId,
    stage: "reviewer",
    actor: dispatch.actor,
    outcome: "pass",
    summary: "reviewer pass",
    evidence: ["evidence/reviewer.md"],
  };
  ingestResult({ statePath, result });

  const final = readState(statePath);
  assert.equal(final.dispatches.at(-1).judgedCommit, SHA_A);
  assert.equal(final.judgedVerdicts.reviewer[SHA_A].outcome, "pass");
  assert.equal(final.judgedVerdicts.reviewer[SHA_A].dispatchId, dispatch.dispatchId);
});

function ingestFail({ summary, infraFailure }) {
  const { state, statePath } = fixture();
  state.currentStage = "reviewer";
  state.verifiedCommit = { sha: SHA_A };
  writeState(statePath, state);

  const dispatch = prepareDispatch({ hqRoot, statePath });
  ingestResult({
    statePath,
    result: {
      version: 1,
      dispatchId: dispatch.dispatchId,
      stage: "reviewer",
      actor: dispatch.actor,
      outcome: "fail",
      summary,
      evidence: ["evidence/reviewer.md"],
      ...(infraFailure ? { infraFailure: true } : {}),
    },
  });
  return readState(statePath);
}

test("a result flagged infraFailure is not recorded as a judgment of the commit", () => {
  const final = ingestFail({ summary: "reviewer never ran", infraFailure: true });
  assert.equal(final.dispatches.at(-1).infraFailure, true);
  assert.equal(final.dispatches.at(-1).judgedCommit, undefined);
  assert.equal(final.judgedVerdicts, undefined);
});

test("a genuine rejection whose prose mentions timeout or provider is still a verdict", () => {
  const final = ingestFail({ summary: "Rejected: the provider client has no timeout and the quota check is missing" });
  assert.equal(final.dispatches.at(-1).infraFailure, undefined);
  assert.equal(final.dispatches.at(-1).judgedCommit, SHA_A);
  assert.equal(final.judgedVerdicts.reviewer[SHA_A].outcome, "fail");
  assert.equal(countStageAttempts(final, "reviewer").verdicts, 1);
});

test("prepareDispatch reuses a verdict on an unchanged commit without creating a dispatch", () => {
  const { state, statePath } = fixture();
  state.currentStage = "reviewer";
  state.verifiedCommit = { sha: SHA_A };
  state.judgedVerdicts = {
    reviewer: {
      [SHA_A]: { dispatchId: "reviewer-original", outcome: "pass", stageRecord: stageRecord("reviewer") },
    },
  };
  state.dispatches = [gateRecord("reviewer", "pass", SHA_A)];
  writeState(statePath, state);

  const response = prepareDispatch({ hqRoot, statePath });
  const final = readState(statePath);
  assert.equal(response.status, "active");
  assert.equal(final.currentStage, "qa");
  assert.equal(final.currentDispatch, undefined);
  assert.equal(final.dispatches.length, 1, "reuse creates no new dispatch");
  assert.equal(final.events.at(-2).type, "verdict-reused");
  assert.equal(final.events.at(-2).sourceDispatchId, "reviewer-original");
});

test("a reused failure follows normal routing without minting another verdict", () => {
  const { state, statePath } = fixture();
  state.currentStage = "reviewer";
  state.verifiedCommit = { sha: SHA_A };
  state.judgedVerdicts = {
    reviewer: {
      [SHA_A]: { dispatchId: "reviewer-failed", outcome: "fail", stageRecord: stageRecord("reviewer", "fail") },
    },
  };
  state.dispatches = [gateRecord("reviewer", "fail", SHA_A)];
  writeState(statePath, state);

  const response = prepareDispatch({ hqRoot, statePath });
  const final = readState(statePath);
  assert.equal(response.status, "active");
  assert.equal(final.currentStage, "builder", "the reused review failure routes back to builder");
  assert.equal(final.currentDispatch, undefined);
  assert.equal(final.dispatches.filter((item) => item.outcome).length, 1, "no second agent verdict is recorded");
  assert.deepEqual(countStageAttempts(final, "reviewer"), {
    verdicts: 1,
    infra: 1,
    passes: 0,
    repeats: 0,
    total: 2,
  });
});

test("the concurrent gate path reuses prior verdicts with zero agent dispatches", async () => {
  const { state, statePath } = fixture();
  state.currentStage = "reviewer";
  state.verifiedCommit = { sha: SHA_A };
  state.judgedVerdicts = {};
  for (const stage of ["reviewer", "qa", "security"]) {
    state.judgedVerdicts[stage] = {
      [SHA_A]: { dispatchId: `${stage}-original`, outcome: "pass", stageRecord: stageRecord(stage) },
    };
  }
  writeState(statePath, state);
  let dispatches = 0;

  const response = await runConcurrentGroupIfReady({
    hqRoot,
    statePath,
    execute: async () => { dispatches += 1; },
  });

  const final = readState(statePath);
  assert.equal(response, null);
  assert.equal(dispatches, 0);
  assert.equal(final.currentStage, "release");
  assert.equal(final.events.filter((event) => event.type === "verdict-reused").length, 3);
});

test("an already-yielded review group keeps ownership instead of reusing history", async () => {
  const { root, state, statePath } = fixture();
  state.currentStage = "reviewer";
  state.verifiedCommit = { sha: SHA_A };
  state.judgedVerdicts = {
    reviewer: {
      [SHA_A]: { dispatchId: "reviewer-original", outcome: "pass", stageRecord: stageRecord("reviewer") },
    },
  };
  state.yieldedGroup = [{ resultPath: join(root, "not-finished.json") }];
  writeState(statePath, state);

  const response = await runConcurrentGroupIfReady({ hqRoot, statePath, execute: async () => {} });
  const final = readState(statePath);
  assert.equal(response.waiting, true);
  assert.equal(final.currentStage, "reviewer");
  assert.equal(final.events.some((event) => event.type === "verdict-reused"), false);
});

test("only distinct rejected commits spend the three-verdict budget", () => {
  const { state } = fixture();
  state.dispatches = [
    gateRecord("reviewer", "fail", SHA_A),
    gateRecord("reviewer", "fail", SHA_A),
    gateRecord("reviewer", "fail", SHA_B),
  ];
  assert.deepEqual(countStageAttempts(state, "reviewer"), {
    verdicts: 2,
    infra: 0,
    passes: 0,
    repeats: 1,
    total: 3,
  });
  assert.equal(stageBudgetExceeded(state, "reviewer").exceeded, null);

  state.dispatches.push(gateRecord("reviewer", "fail", SHA_C));
  const budget = stageBudgetExceeded(state, "reviewer");
  assert.equal(budget.verdicts, 3);
  assert.equal(budget.exceeded, "verdicts");
});

test("legacy verdicts without a judged commit retain their existing counting", () => {
  const { state } = fixture();
  state.dispatches = [
    { stage: "reviewer", kind: "stage", outcome: "fail" },
    { stage: "reviewer", kind: "stage", outcome: "fail" },
  ];
  assert.equal(countStageAttempts(state, "reviewer").verdicts, 2);
});
