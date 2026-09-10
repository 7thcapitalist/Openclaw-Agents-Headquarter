import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { createState, readState, writeState } from "../lib/task-workflow.mjs";
import { repairTargetFor } from "../lib/failure-classification.mjs";
import { runOneStage } from "../lib/openclaw-runner.mjs";

// Recovery has to answer one question before it repairs anything: is the
// PROJECT at fault, or the factory? The answer decides both what the recovery
// agent inspects and — once the repair verifies — which earlier gate verdicts
// are still worth anything.

const hqRoot = resolve(".");
const task = {
  id: "issue-repair",
  issue: "repair",
  outcome: "Recovery repairs the right thing and invalidates the right gates.",
  acceptanceCriteria: ["A verified project repair invalidates stale verdicts"],
  project: "sample",
  workType: "backend",
  risk: "low",
};

test("only a project defect puts the project's code in scope", () => {
  assert.equal(repairTargetFor("PROJECT_ERROR"), "project");
  // An unclassified failure is inspected rather than retried blindly.
  assert.equal(repairTargetFor("UNKNOWN"), "project");
  // None of these changed a line of the deliverable.
  assert.equal(repairTargetFor("INFRASTRUCTURE_ERROR"), "factory");
  assert.equal(repairTargetFor("FACTORY_ERROR"), "factory");
  assert.equal(repairTargetFor("AGENT_ERROR"), "factory");
});

test("a verified project repair resumes at the builder and invalidates downstream verdicts", async () => {
  const fixture = makeFixture();
  // The reviewer rejects the work once — a real FAIL verdict, so a project
  // defect. Recovery repairs it and an independent verifier confirms.
  let reviewerFails = 1;
  const execute = async ({ dispatch, cwd }) => {
    const outcome = dispatch.stage === "reviewer" && dispatch.kind === "stage" && reviewerFails-- > 0 ? "fail" : "pass";
    writeResult(dispatch, cwd, outcome);
  };
  const resumed = await driveUntilResumed(fixture, execute);
  assert.equal(resumed.recovery.attempts.at(-1).repairTarget, "project");
  assert.equal(resumed.currentStage, "builder");
  // The repair rewrote the code the builder was credited for.
  assert.equal(resumed.stages.builder.status, "pending");
  assert.equal(resumed.stages.reviewer.status, "pending");
  assert.equal(resumed.events.at(-1).fromStage, "reviewer");
  assert.equal(resumed.events.at(-1).invalidatedDownstream, true);
});

test("a factory-side repair retries in place and keeps the builder's work", async () => {
  const fixture = makeFixture();
  // The reviewer's agent never writes a result — an infrastructure failure.
  // Nothing in the project changed, so re-running the builder would be pure
  // waste; the builder's pass must survive.
  let reviewerDrops = 1;
  const execute = async ({ dispatch, cwd }) => {
    if (dispatch.stage === "reviewer" && dispatch.kind === "stage" && reviewerDrops-- > 0) return;
    writeResult(dispatch, cwd, "pass");
  };
  const resumed = await driveUntilResumed(fixture, execute);
  assert.equal(resumed.recovery.attempts.at(-1).repairTarget, "factory");
  assert.equal(resumed.currentStage, "reviewer");
  assert.equal(resumed.stages.builder.status, "pass");
  assert.equal(resumed.events.at(-1).invalidatedDownstream, undefined);
});

// Bounded on purpose: a contract change must make these tests red, never hang.
async function driveUntilResumed(fixture, execute, maxSteps = 25) {
  const seen = [];
  for (let i = 0; i < maxSteps; i += 1) {
    await runOneStage({
      hqRoot, statePath: fixture.statePath, execute,
      publish: () => ({ published: false, reason: "no github in fixture" }),
    });
    const state = readState(fixture.statePath);
    const last = state.events.at(-1);
    seen.push(last?.type);
    if (last?.type === "task-resumed" && last.reason === "recovery-verified") return state;
    if (state.status !== "active") break;
  }
  throw new Error(`recovery never resumed the task in ${maxSteps} steps; saw: ${seen.join(" -> ")}`);
}

function writeResult(dispatch, cwd, outcome) {
  mkdirSync(join(cwd, "evidence"), { recursive: true });
  const relative = `evidence/${dispatch.stage}.md`;
  writeFileSync(join(cwd, relative), `${dispatch.stage} ${outcome}\n`);
  writeFileSync(dispatch.resultPath, JSON.stringify({
    version: 1, dispatchId: dispatch.dispatchId, stage: dispatch.stage, actor: dispatch.actor,
    outcome, summary: `${dispatch.stage} ${outcome}`, evidence: [relative],
  }));
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "repair-target-"));
  const worktree = join(root, "worktree");
  const statePath = join(root, "state", "state.json");
  mkdirSync(worktree);
  writeState(statePath, createState({ task, repo: join(root, "repo"), branch: "factory/repair", worktree }));
  return { root, worktree, statePath };
}
