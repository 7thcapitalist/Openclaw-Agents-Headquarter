import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, readState, writeState, routeStageFailure } from "../lib/task-workflow.mjs";
import { runOneStage, waitForYieldedResult, isYieldedExecution } from "../lib/openclaw-runner.mjs";
import { retryStuckTasks } from "../lib/hq/auto-retry.mjs";
import { observeObjectivePrs } from "../lib/hq/pr-observation.mjs";
import { assessRound } from "../../scripts/factory-improve-loop.mjs";

const hqRoot = process.cwd();
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "overnight-followthrough-"));
  const worktree = join(root, "worktree"); mkdirSync(worktree);
  const statePath = join(root, "state.json");
  const state = createState({ task: { id: "night", issue: "38", outcome: "Finish work", acceptanceCriteria: ["verified"], project: "demo", workType: "backend", risk: "low" }, repo: root, branch: "factory/night", worktree });
  writeState(statePath, state);
  return { root, statePath, state, worktree };
}
const yielded = { stdout: JSON.stringify({ status: "ok", result: { yielded: true, livenessState: "paused" } }) };
function result(dispatch) {
  mkdirSync(join(dispatch.cwd, "evidence"), { recursive: true });
  writeFileSync(join(dispatch.cwd, "evidence", "pass.md"), "Verified the acceptance criterion.\n");
  writeFileSync(dispatch.resultPath, JSON.stringify({ version: 1, dispatchId: dispatch.dispatchId, stage: dispatch.stage, actor: dispatch.actor, outcome: "pass", summary: "Verified", evidence: ["evidence/pass.md"] }));
}

test("yielded execution waits for the exact result and does not dispatch twice", async () => {
  const f = fixture(); let dispatched, calls = 0;
  const execute = async ({ dispatch }) => { calls++; dispatched = dispatch; return yielded; };
  const response = await runOneStage({ hqRoot, statePath: f.statePath, execute,
    waitForResult: async ({ heartbeat }) => {
      heartbeat();
      assert.equal(readState(f.statePath).currentDispatch.status, "running");
      result(dispatched); return true;
    } });
  assert.equal(response.status, "active");
  assert.equal(calls, 1);
  assert.equal(readState(f.statePath).stages.product.status, "pass");
  assert.equal(readState(f.statePath).dispatches.length, 1);
});

test("expired yielded wait retains ownership, blocks auto-retry, and later ingests without execution", async () => {
  const f = fixture(); let dispatched, calls = 0;
  const opts = { hqRoot, statePath: f.statePath, execute: async ({ dispatch }) => { calls++; dispatched = dispatch; return yielded; }, waitForResult: async () => false };
  const response = await runOneStage(opts);
  assert.equal(response.waiting, true);
  assert.equal(readState(f.statePath).dispatches, undefined);
  assert.equal((await runOneStage(opts)).waiting, true);
  assert.equal(calls, 1);
  const sweep = await retryStuckTasks({ hqRoot, stateRoot: f.root, staleActiveMs: 1, now: () => "2099-01-01T00:00:00Z", runTask: async () => { throw new Error("must not run"); } });
  assert.equal(sweep.retried.length, 0);
  assert.match(sweep.skipped[0].reason, /delegated execution/);
  result(dispatched);
  assert.equal((await runOneStage(opts)).status, "active");
  assert.equal(calls, 1);
});

test("yield wait is bounded and only structured paused output activates it", async () => {
  const f = fixture(); let clock = 0;
  assert.equal(await waitForYieldedResult({ resultPath: join(f.root, "missing"), now: () => clock, timeoutMs: 10, pollMs: 4, wait: async (ms) => { clock += ms; } }), false);
  assert.equal(clock, 10);
  assert.equal(isYieldedExecution({ stdout: 'I have yielded work' }), false);
  assert.equal(isYieldedExecution({ stdout: '{"status":"error","yielded":true}' }), false);
  assert.equal(isYieldedExecution(yielded), true);
});

test("release conflicts go to builder, preserving earlier gates and invalidating later evidence", () => {
  const f = fixture();
  f.state.currentStage = "release"; f.state.status = "blocked";
  for (const stage of Object.keys(f.state.stages)) f.state.stages[stage] = { status: "pass", evidence: ["old"] };
  f.state.dispatches = [{ stage: "release" }];
  f.state.blocker = { outcome: "fail", summary: "Provider routing tests pass but PR is CONFLICTING/DIRTY; builder must merge main" };
  const next = routeStageFailure(f.state, { failedStage: "release" });
  assert.equal(next.currentStage, "builder");
  assert.equal(next.stages.architect.status, "pass");
  for (const stage of ["builder", "reviewer", "qa", "security", "release"]) assert.deepEqual(next.stages[stage], { status: "pending" });
  f.state.blocker = { outcome: "decision-required", summary: "Approve scope" };
  assert.equal(routeStageFailure(f.state, { failedStage: "release" }), f.state);
  f.state.blocker = { outcome: "fail", summary: "provider temporarily unavailable" };
  assert.equal(routeStageFailure(f.state, { failedStage: "release" }).currentStage, "release");
  f.state.dispatches = [{ stage: "release" }, { stage: "release" }, { stage: "release" }];
  assert.equal(routeStageFailure(f.state, { failedStage: "release" }).status, "blocked");
});

test("PR observation counts blocked work without granting a release gate", async () => {
  const f = fixture();
  const node = { id: "night", statePath: f.statePath, branch: "factory/night", status: "failed" };
  const objective = { nodes: { night: node }, integration: { status: "pending" } };
  const url = "https://github.com/o/r/pull/35";
  const observation = await observeObjectivePrs({ hqRoot, objective, resolveTarget: () => ({ ownerRepo: "o/r" }), run: async () => ({ stdout: JSON.stringify([{ url, headRefName: "factory/night", isCrossRepository: false }, { url: "https://github.com/o/r/pull/99", headRefName: "factory/night", isCrossRepository: true }]) }) });
  assert.equal(observation.prs.length, 1);
  const round = assessRound({ status: "blocked", objective }, observation.prs);
  assert.equal(round.prs[0].url, url); assert.equal(round.status, "blocked");
  assert.equal(node.githubPublish, undefined);
  assert.equal(readState(f.statePath).status, "active");
  const unavailable = await observeObjectivePrs({ hqRoot, objective, resolveTarget: () => ({ ownerRepo: "o/r" }), run: async () => { throw new Error("offline"); } });
  assert.equal(unavailable.errors.length, 1);
});


test("yield polling tolerates a partially written result instead of retrying a live worker", async () => {
  const f = fixture(); const path = join(f.root, "partial.json"); let clock = 0;
  writeFileSync(path, '{"version":');
  assert.equal(await waitForYieldedResult({ resultPath: path, now: () => clock, timeoutMs: 10, pollMs: 1,
    wait: async (ms) => { clock += ms; writeFileSync(path, '{"version":1}'); } }), true);
  assert.equal(clock, 1);
});

test("release conflict runs builder and all downstream gates again before publication", async () => {
  const { runToTerminal } = await import("../lib/openclaw-runner.mjs");
  const { readFileSync } = await import("node:fs");
  const f = fixture(); const calls = []; let failedRelease = false;
  const response = await runToTerminal({ hqRoot, statePath: f.statePath, concurrentGroups: [],
    publish: () => ({ published: true, prUrl: "https://github.com/o/r/pull/1" }),
    execute: async ({ dispatch }) => {
      calls.push(dispatch.stage);
      if (failedRelease && dispatch.stage === "builder") assert.match(readFileSync(dispatch.promptPath, "utf8"), /CONFLICTING/);
      result(dispatch);
      if (dispatch.stage === "release" && !failedRelease) {
        failedRelease = true;
        const artifact = JSON.parse(readFileSync(dispatch.resultPath));
        artifact.outcome = "fail"; artifact.summary = "PR is CONFLICTING; merge current main and resolve conflicts";
        writeFileSync(dispatch.resultPath, JSON.stringify(artifact));
      }
    },
  });
  assert.equal(response.status, "merge-ready");
  assert.deepEqual(calls, ["product", "architect", "builder", "reviewer", "qa", "security", "release", "builder", "reviewer", "qa", "security", "release"]);
});
