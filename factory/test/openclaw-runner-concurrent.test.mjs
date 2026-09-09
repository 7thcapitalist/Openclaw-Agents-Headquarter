import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createState, readState, writeState } from "../lib/task-workflow.mjs";
import { computeDispatchPaths } from "../lib/openclaw-protocol.mjs";
import { runOneStage, runToTerminal, runConcurrentGroupIfReady } from "../lib/openclaw-runner.mjs";

const hqRoot = process.cwd();
const task = {
  id: "issue-900",
  issue: "900",
  outcome: "Concurrent review phase.",
  acceptanceCriteria: ["Every result is persisted"],
  project: "sample",
  workType: "backend",
  risk: "low",
};

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "runner-concurrent-"));
  const worktree = join(root, "worktree");
  const statePath = join(root, "state", "state.json");
  mkdirSync(worktree);
  writeState(statePath, createState({ task, repo: join(root, "repo"), branch: "factory/issue-900", worktree }));
  return { root, worktree, statePath };
}

function writeEvidence(worktree, stage) {
  const dir = join(worktree, "evidence");
  mkdirSync(dir, { recursive: true });
  const relative = `evidence/${stage}.md`;
  writeFileSync(join(worktree, relative), `${stage} verified\n`);
  return relative;
}

// A mock agent: writes a valid result file for its dispatch, and records the
// wall-clock window it was "running" so the test can prove overlap.
function makeExecute({ failStage = null, delayMs = 40, windows = [] } = {}) {
  return async ({ dispatch }) => {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, delayMs));
    const end = Date.now();
    windows.push({ stage: dispatch.stage, start, end });
    const worktree = dispatch.cwd;
    const evidence = writeEvidence(worktree, dispatch.stage);
    const outcome = dispatch.stage === failStage ? "fail" : "pass";
    writeFileSync(dispatch.resultPath, JSON.stringify({
      version: 1,
      dispatchId: dispatch.dispatchId,
      stage: dispatch.stage,
      actor: dispatch.actor,
      outcome,
      summary: `${dispatch.stage} ${outcome}`,
      evidence: [evidence],
    }));
    return {
      stdout: JSON.stringify({
        meta: {
          agentMeta: {
            provider: "openai",
            model: "gpt-5.6-sol",
            usage: { tokensIn: 10, tokensOut: 20 },
            durationMs: end - start,
          },
        },
      }),
      stderr: "",
    };
  };
}

test("computeDispatchPaths matches prepareDispatch's ids and bumps attempt after a recorded dispatch", () => {
  const { statePath } = makeFixture();
  const state = readState(statePath);
  const first = computeDispatchPaths({ state, stage: "reviewer", statePath });
  assert.equal(first.dispatchId, "issue-900-reviewer-1");
  assert.equal(first.attempt, 1);
  state.dispatches = [{ stage: "reviewer", status: "completed", outcome: "fail" }];
  const second = computeDispatchPaths({ state, stage: "reviewer", statePath });
  assert.equal(second.dispatchId, "issue-900-reviewer-2");
  assert.equal(second.attempt, 2);
});

test("reviewer + qa + security run concurrently, then the engine reaches merge-ready", async () => {
  const { statePath } = makeFixture();
  const windows = [];
  const execute = makeExecute({ windows, delayMs: 60 });

  const response = await runToTerminal({ hqRoot, statePath, execute });
  assert.equal(response.status, "merge-ready", JSON.stringify(response.blocker || response));

  const state = readState(statePath);
  for (const stage of ["product", "architect", "builder", "reviewer", "qa", "security", "release"]) {
    assert.equal(state.stages[stage].status, "pass", `${stage} should have passed`);
  }
  assert.ok(state.dispatches.every((d) => d.usage?.provider === "openai"), "every recorded dispatch keeps usage metadata");

  // The three review stages overlapped in wall-clock time.
  const review = ["reviewer", "qa", "security"].map((s) => windows.find((w) => w.stage === s));
  assert.ok(review.every(Boolean), "all three review stages ran");
  const latestStart = Math.max(...review.map((w) => w.start));
  const earliestEnd = Math.min(...review.map((w) => w.end));
  assert.ok(earliestEnd >= latestStart, "review windows overlap (ran concurrently, not sequentially)");

  // product/architect/builder still ran before the review phase, in order.
  const seq = ["product", "architect", "builder"].map((s) => windows.find((w) => w.stage === s));
  assert.ok(seq[0].end <= seq[1].start && seq[1].end <= seq[2].start, "pre-review stages stayed sequential");
  assert.ok(seq[2].end <= latestStart, "builder finished before the review phase started");
});

async function advanceToStage(statePath, execute, target) {
  for (let i = 0; i < 20; i += 1) {
    if (readState(statePath).currentStage === target) return;
    await runOneStage({ hqRoot, statePath, execute });
  }
  throw new Error(`never reached ${target}`);
}

test("a failing review member routes back to builder and discards the siblings' results", async () => {
  const { statePath } = makeFixture();
  await advanceToStage(statePath, makeExecute(), "reviewer");

  // One concurrent review pass where qa fails.
  const response = await runConcurrentGroupIfReady({ hqRoot, statePath, execute: makeExecute({ failStage: "qa" }) });
  assert.equal(response.status, "active");
  const state = readState(statePath);
  assert.equal(state.currentStage, "builder", "qa failure routed the task back to builder");

  // security's speculative result file was cleaned up (it never got applied).
  const sec = computeDispatchPaths({ state, stage: "security", statePath });
  assert.equal(existsSync(sec.resultPath), false, "unapplied sibling result discarded");

  // Re-run to completion with everything passing: the group re-runs, qa is
  // retried, and the task finishes.
  const done = await runToTerminal({ hqRoot, statePath, execute: makeExecute() });
  assert.equal(done.status, "merge-ready", JSON.stringify(done.blocker || done));
  assert.ok(readState(statePath).dispatches.filter((d) => d.stage === "qa").length >= 2, "qa retried after its failure");
});

test("runConcurrentGroupIfReady returns null when not parked at a group head", async () => {
  const { statePath } = makeFixture();
  // Fresh task sits at `product`, not a group head.
  const out = await runConcurrentGroupIfReady({ hqRoot, statePath, execute: makeExecute() });
  assert.equal(out, null);
});

test("a review member whose agent fails on infra retries in place with a legible reason, no rebuild", async () => {
  const { statePath } = makeFixture();
  await advanceToStage(statePath, makeExecute(), "reviewer");

  const flaky = async ({ dispatch }) => {
    if (dispatch.stage === "qa") throw new Error("[openclaw] Could not start the CLI. Reason: All models failed");
    return makeExecute()({ dispatch });
  };
  const response = await runConcurrentGroupIfReady({ hqRoot, statePath, execute: flaky });
  assert.equal(response.status, "active");
  const state = readState(statePath);
  // Infra failure ("Could not start the CLI") retries the review stage in
  // place — there is nothing for the builder to fix, so no rebuild.
  assert.equal(state.currentStage, "qa", "an infra failure retries qa in place, not a full rebuild");
  const routed = state.events.filter((e) => e.type === "failure-routed").at(-1);
  assert.equal(routed.infra, true, "the routing is marked infra");
  const qaDispatch = state.dispatches.filter((d) => d.stage === "qa").at(-1);
  assert.match(qaDispatch.summary || "", /could not run|Could not start the CLI/i, "the failure reason is carried, not swallowed");
});

test("yielded review group resumes its exact artifacts without duplicate workers", async () => {
  const { retryStuckTasks } = await import("../lib/hq/auto-retry.mjs");
  const { root, statePath } = makeFixture();
  const normal = makeExecute({ delayMs: 0 });
  for (let i = 0; i < 3; i++) await runOneStage({ hqRoot, statePath, execute: normal });
  let calls = 0; let delegated;
  const execute = async (input) => {
    calls++;
    if (input.dispatch.stage === "security") {
      delegated = input;
      return { stdout: JSON.stringify({ status: "ok", result: { yielded: true } }) };
    }
    return normal(input);
  };
  const opts = { hqRoot, statePath, execute, waitForResult: async () => false };
  assert.equal((await runConcurrentGroupIfReady(opts)).waiting, true);
  assert.equal(calls, 3);
  assert.equal(readState(statePath).yieldedGroup.length, 3);
  const sweep = await retryStuckTasks({ hqRoot, stateRoot: root, staleActiveMs: 1, now: () => "2099-01-01T00:00:00Z" });
  assert.equal(sweep.retried.length, 0);
  await normal(delegated); // the original delegate finishes
  assert.equal((await runConcurrentGroupIfReady({ ...opts, groups: [] })).waiting, true);
  assert.ok(readState(statePath).yieldedGroup, "configuration drift cannot discard ownership");
  assert.equal((await runConcurrentGroupIfReady(opts)).status, "active");
  assert.equal(readState(statePath).currentStage, "release");
  assert.equal(readState(statePath).yieldedGroup, undefined);
  assert.equal(calls, 3);
});

test("review artifacts surviving a crash are consumed without re-dispatch", async () => {
  const { statePath, worktree } = makeFixture();
  const normal = makeExecute({ delayMs: 0 });
  for (let i = 0; i < 3; i++) await runOneStage({ hqRoot, statePath, execute: normal });
  const state = readState(statePath);
  for (const stage of ["reviewer", "qa", "security"]) {
    const paths = computeDispatchPaths({ state, stage, statePath });
    await normal({ dispatch: { ...paths, stage, actor: state.assignments[stage], cwd: worktree } });
  }
  const result = await runConcurrentGroupIfReady({ hqRoot, statePath, execute: async () => { throw new Error("must not redispatch completed work"); } });
  assert.equal(result.status, "active");
  assert.equal(readState(statePath).currentStage, "release");
});
