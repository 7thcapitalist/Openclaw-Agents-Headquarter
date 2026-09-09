import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createState, readState, writeState } from "../lib/task-workflow.mjs";
import { runOneStage } from "../lib/openclaw-runner.mjs";
import { classifyFailure, FAILURE_CLASSES } from "../lib/failure-classification.mjs";

test("failure classification covers the required taxonomy", () => {
  assert.deepEqual(FAILURE_CLASSES, ["AGENT_ERROR", "FACTORY_ERROR", "PROJECT_ERROR", "INFRASTRUCTURE_ERROR", "FOUNDER_DECISION_REQUIRED", "UNKNOWN"]);
  assert.equal(classifyFailure({ error: "model timed out", source: "harness" }), "INFRASTRUCTURE_ERROR");
  assert.equal(classifyFailure({ error: "invalid result protocol", source: "factory" }), "FACTORY_ERROR");
  assert.equal(classifyFailure({ error: "test assertion failed", source: "project" }), "PROJECT_ERROR");
  assert.equal(classifyFailure({ outcome: "decision-required" }), "FOUNDER_DECISION_REQUIRED");
});

test("a project failure is diagnosed, repaired, independently verified, and resumed", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-recovery-"));
  const worktree = join(root, "worktree");
  const statePath = join(root, "state.json");
  mkdirSync(worktree);
  const task = { id: "issue-recovery", issue: "recovery", outcome: "Recover a failed task", acceptanceCriteria: ["The task resumes"], project: "sample", workType: "backend", risk: "low" };
  writeState(statePath, createState({ task, repo: root, branch: "factory/issue-recovery", worktree, maxRecoveryAttempts: 3 }));
  let failedOnce = false;
  const seen = [];
  const execute = async ({ dispatch, cwd }) => {
    seen.push({ kind: dispatch.kind, stage: dispatch.stage, actor: dispatch.actor });
    mkdirSync(join(cwd, "evidence"), { recursive: true });
    const evidence = `evidence/${dispatch.dispatchId}.md`;
    writeFileSync(join(cwd, evidence), "observed proof\n");
    const outcome = dispatch.kind === "stage" && dispatch.stage === "product" && !failedOnce ? "fail" : "pass";
    failedOnce ||= outcome === "fail";
    writeFileSync(dispatch.resultPath, JSON.stringify({ version: 1, dispatchId: dispatch.dispatchId, stage: dispatch.stage, actor: dispatch.actor, outcome, summary: outcome === "fail" ? "test assertion failed" : "verified", evidence: [evidence] }));
  };
  let result;
  for (let i = 0; i < 30; i += 1) {
    result = await runOneStage({ hqRoot: join(process.cwd()), statePath, execute, concurrentGroups: [] });
    if (result.status !== "active") break;
  }
  assert.equal(result.status, "merge-ready");
  const state = readState(statePath);
  assert.equal(state.failures[0].classification, "PROJECT_ERROR");
  assert.equal(state.recovery.attempts[0].status, "verified");
  assert.notEqual(seen.find((item) => item.kind === "recovery-diagnose").actor, seen.find((item) => item.kind === "recovery-verify").actor);
  assert.ok(state.events.some((event) => event.type === "recovery-diagnosing"));
  assert.ok(state.events.some((event) => event.type === "recovery-repair-attempted"));
  assert.ok(state.events.some((event) => event.type === "recovery-verified"));
});

