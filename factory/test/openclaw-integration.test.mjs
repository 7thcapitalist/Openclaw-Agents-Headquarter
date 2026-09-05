import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { createState, readState, writeState } from "../lib/task-workflow.mjs";
import { ingestResult, markDispatchRunning, prepareDispatch } from "../lib/openclaw-protocol.mjs";
import { runOneStage } from "../lib/openclaw-runner.mjs";

const hqRoot = resolve(".");
const task = {
  id: "issue-77",
  issue: "77",
  outcome: "OpenClaw drives every stage.",
  acceptanceCriteria: ["Every result is persisted"],
  project: "sample",
  workType: "backend",
  risk: "low",
};

test("dispatch packet is persistent and idempotent until claimed", () => {
  const fixture = makeFixture();
  const first = prepareDispatch({ hqRoot, statePath: fixture.statePath });
  const second = prepareDispatch({ hqRoot, statePath: fixture.statePath });
  assert.deepEqual(second, first);
  assert.equal(first.stage, "product");
  assert.equal(first.actor, "openclaw");
  assert.equal(first.cwd, fixture.worktree);
  assert.match(readFileSync(first.promptPath, "utf8"), new RegExp(first.dispatchId));
  markDispatchRunning({ statePath: fixture.statePath, dispatchId: first.dispatchId });
  assert.throws(() => markDispatchRunning({ statePath: fixture.statePath, dispatchId: first.dispatchId }), /already running/);
});

test("JSON stdin adapter exposes the dispatch packet to OpenClaw", () => {
  const fixture = makeFixture();
  const child = spawnSync(process.execPath, [resolve("scripts/openclaw-factory.mjs")], {
    input: JSON.stringify({ version: 1, action: "next", statePath: fixture.statePath }),
    encoding: "utf8",
  });
  if (child.error?.code === "EPERM") return;
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const response = JSON.parse(child.stdout);
  assert.equal(response.status, "dispatch");
  assert.equal(response.stage, "product");
  assert.equal(response.taskId, task.id);
});

test("rejects stale, mismatched, and evidence-free agent results", () => {
  const fixture = makeFixture();
  const dispatch = prepareDispatch({ hqRoot, statePath: fixture.statePath });
  assert.throws(() => ingestResult({ statePath: fixture.statePath, result: resultFor(dispatch, [], "pass") }), /evidence paths/);
  const evidence = writeEvidence(fixture.worktree, "product");
  assert.throws(() => ingestResult({ statePath: fixture.statePath, result: { ...resultFor(dispatch, [evidence]), dispatchId: "stale" } }), /stale or unknown/);
  assert.throws(() => ingestResult({ statePath: fixture.statePath, result: { ...resultFor(dispatch, [evidence]), actor: "codex" } }), /does not match/);
});

test("mocked OpenClaw execution drives a complete task to merge-ready", async () => {
  const fixture = makeFixture();
  const seen = [];
  const execute = async ({ dispatch, agentId, cwd }) => {
    seen.push({ stage: dispatch.stage, actor: dispatch.actor, agentId, cwd });
    const evidence = writeEvidence(cwd, dispatch.stage);
    writeFileSync(dispatch.resultPath, JSON.stringify(resultFor(dispatch, [evidence])));
  };
  const publishCalls = [];
  const publish = ({ state }) => {
    publishCalls.push(state.status);
    return { published: false, reason: "no github configured in this fixture" };
  };
  let response;
  do {
    response = await runOneStage({ hqRoot, statePath: fixture.statePath, agentIds: { openclaw: "main-agent" }, execute, publish });
  } while (response.status === "active");
  const state = readState(fixture.statePath);
  assert.equal(response.status, "merge-ready");
  assert.equal(state.dispatches.length, 7);
  assert.deepEqual(seen.map((item) => item.stage), ["product", "architect", "builder", "reviewer", "qa", "security", "release"]);
  assert.equal(seen[0].agentId, "main-agent");
  assert.notEqual(seen[2].actor, seen[3].actor);
  assert.notEqual(seen[2].actor, seen[4].actor);
  assert.equal(state.events.some((event) => event.type === "merged"), false);
  // The GitHub publish step ran exactly once, only after merge-ready.
  assert.deepEqual(publishCalls, ["merge-ready"]);
  assert.equal(response.githubPublish.published, false);
  assert.equal(state.githubPublish.reason, "no github configured in this fixture");
  assert.equal(state.events.at(-1).type, "github-publish");
  assert.equal(state.events.at(-1).outcome, "skipped");
});

test("a non-terminal stage completion never invokes the GitHub publish step", async () => {
  const fixture = makeFixture();
  const execute = async ({ dispatch, cwd }) => {
    const evidence = writeEvidence(cwd, dispatch.stage);
    writeFileSync(dispatch.resultPath, JSON.stringify(resultFor(dispatch, [evidence])));
  };
  let publishCalled = false;
  const publish = () => { publishCalled = true; return { published: false }; };
  const response = await runOneStage({ hqRoot, statePath: fixture.statePath, execute, publish });
  assert.equal(response.status, "active");
  assert.equal(publishCalled, false);
  assert.equal(response.githubPublish, undefined);
});

test("a GitHub publish failure is recorded on the task, never thrown", async () => {
  const fixture = makeFixture();
  const execute = async ({ dispatch, cwd }) => {
    const evidence = writeEvidence(cwd, dispatch.stage);
    writeFileSync(dispatch.resultPath, JSON.stringify(resultFor(dispatch, [evidence])));
  };
  const publish = () => { throw new Error("network unreachable"); };
  let response;
  do {
    response = await runOneStage({ hqRoot, statePath: fixture.statePath, execute, publish });
  } while (response.status === "active");
  assert.equal(response.status, "merge-ready");
  assert.equal(response.githubPublish.published, false);
  assert.match(response.githubPublish.reason, /network unreachable/);
});

test("agent FAIL is retried safely and blocks at the attempt limit", async () => {
  const fixture = makeFixture();
  const execute = async ({ dispatch, cwd }) => {
    const evidence = writeEvidence(cwd, dispatch.stage);
    writeFileSync(dispatch.resultPath, JSON.stringify(resultFor(dispatch, [evidence], "fail")));
  };
  assert.equal((await runOneStage({ hqRoot, statePath: fixture.statePath, execute })).status, "active");
  assert.equal((await runOneStage({ hqRoot, statePath: fixture.statePath, execute })).status, "active");
  const response = await runOneStage({ hqRoot, statePath: fixture.statePath, execute });
  assert.equal(response.status, "blocked");
  assert.equal(prepareDispatch({ hqRoot, statePath: fixture.statePath }).status, "blocked");
});

test("missing result is persisted and safely retried", async () => {
  const fixture = makeFixture();
  const response = await runOneStage({ hqRoot, statePath: fixture.statePath, execute: async () => {} });
  assert.equal(response.status, "active");
  const state = readState(fixture.statePath);
  assert.equal(state.dispatches[0].status, "failed");
  assert.equal(state.events.at(-1).type, "failure-routed");
  assert.equal(state.currentStage, "product");
});

test("review failure routes back to builder and invalidates downstream evidence", async () => {
  const fixture = makeFixture();
  const execute = async ({ dispatch, cwd }) => {
    const evidence = writeEvidence(cwd, dispatch.stage);
    writeFileSync(dispatch.resultPath, JSON.stringify(resultFor(dispatch, [evidence], dispatch.stage === "reviewer" ? "fail" : "pass")));
  };
  for (;;) {
    await runOneStage({ hqRoot, statePath: fixture.statePath, execute });
    const state = readState(fixture.statePath);
    if (state.events.at(-1)?.type === "failure-routed") {
      assert.equal(state.currentStage, "builder");
      assert.equal(state.stages.builder.status, "pending");
      assert.equal(state.stages.reviewer.status, "pending");
      assert.equal(state.events.at(-1).fromStage, "reviewer");
      break;
    }
  }
});

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "openclaw-integration-"));
  const worktree = join(root, "worktree");
  const statePath = join(root, "state", "state.json");
  mkdirSync(worktree);
  writeState(statePath, createState({ task, repo: join(root, "repo"), branch: "factory/issue-77", worktree }));
  return { root, worktree, statePath };
}

function writeEvidence(worktree, stage) {
  const dir = join(worktree, "evidence");
  mkdirSync(dir, { recursive: true });
  const relative = `evidence/${stage}.md`;
  writeFileSync(join(worktree, relative), `${stage} verified\n`);
  return relative;
}

function resultFor(dispatch, evidence, outcome = "pass") {
  return {
    version: 1,
    dispatchId: dispatch.dispatchId,
    stage: dispatch.stage,
    actor: dispatch.actor,
    outcome,
    summary: `${dispatch.stage} ${outcome}`,
    evidence,
  };
}
