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
  // The review loop has already bounced this work back twice and the reviewer
  // is still rejecting it — so routing is spent and recovery is next in line.
  const fixture = makeFixture({ spentReviewerAttempts: 2 });
  // A real FAIL verdict means a project defect. Recovery repairs it and an
  // independent verifier confirms.
  const execute = async ({ dispatch, cwd }) => {
    const outcome = dispatch.stage === "reviewer" && dispatch.kind === "stage" ? "fail" : "pass";
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

// An infrastructure failure in a review stage never puts the builder's work at
// risk. With routing restored ahead of recovery, that guarantee is delivered by
// `routeStageFailure` retrying the stage in place — recovery only sees the
// stage once those attempts are spent, and by then re-entry is spent too, so
// the task escalates. What must hold throughout: nothing rebuilds, and the
// builder's pass is never invalidated by an environment problem.
test("an infrastructure failure never invalidates the builder's work", async () => {
  const fixture = makeFixture();
  // The reviewer's agent never writes a result. Nothing in the project changed,
  // so re-running the builder would be pure waste.
  const execute = async ({ dispatch, cwd }) => {
    if (dispatch.stage === "reviewer" && dispatch.kind === "stage") return;
    writeResult(dispatch, cwd, "pass");
  };
  const final = await driveUntilSettled(fixture, execute);

  assert.equal(final.status, "blocked", "an unfixable environment problem ends with the founder, not a loop");
  assert.equal(final.stages.builder.status, "pass", "the builder's verdict survived every retry");
  // Every reviewer retry stayed at the reviewer; the builder was never
  // re-dispatched to answer someone else's dropped model call.
  assert.equal(final.dispatches.filter((d) => d.stage === "builder" && (d.kind === "stage" || !d.kind)).length, 1,
    "no rebuild for an infrastructure failure");
  const routed = final.events.filter((e) => e.type === "failure-routed");
  assert.ok(routed.length > 0, "the failure was routed, not silently recovered");
  assert.ok(routed.every((e) => e.stage === "reviewer"), "each retry stayed in place at the reviewer");
  assert.ok(routed.every((e) => e.infra === true), "and each was marked infrastructure");
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

// Same bound, different terminal condition: drive until the task stops being
// active rather than until it resumes.
async function driveUntilSettled(fixture, execute, maxSteps = 25) {
  for (let i = 0; i < maxSteps; i += 1) {
    await runOneStage({
      hqRoot, statePath: fixture.statePath, execute,
      publish: () => ({ published: false, reason: "no github in fixture" }),
    });
    const state = readState(fixture.statePath);
    if (state.status !== "active") return state;
  }
  throw new Error(`task never settled in ${maxSteps} steps`);
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

function makeFixture({ spentReviewerAttempts = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "repair-target-"));
  const worktree = join(root, "worktree");
  const statePath = join(root, "state", "state.json");
  mkdirSync(worktree);
  const state = createState({ task, repo: join(root, "repo"), branch: "factory/repair", worktree });
  // A reviewer that has already used its per-stage attempts, while the builder
  // still has headroom — the ordinary shape once the review loop has bounced
  // work back a couple of times and the reviewer is still unhappy. This is what
  // puts recovery, rather than another route, next in line.
  if (spentReviewerAttempts) {
    state.dispatches = Array.from({ length: spentReviewerAttempts }, (_, i) => ({
      id: `${task.id}-reviewer-${i + 1}`, stage: "reviewer", actor: "claude", kind: "stage", status: "failed", attempt: i + 1,
    }));
  }
  writeState(statePath, state);
  return { root, worktree, statePath };
}
