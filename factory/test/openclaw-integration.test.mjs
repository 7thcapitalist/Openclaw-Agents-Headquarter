import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
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
  const publishEvent = state.events.find((event) => event.type === "github-publish");
  assert.equal(publishEvent.outcome, "skipped");
  // A founder-readable completion report is generated once the task settles,
  // recorded as the final event and a completion-report.md next to state.json.
  assert.equal(state.events.at(-1).type, "completion-report");
  assert.ok(state.completionReport?.path);
  assert.ok(existsSync(state.completionReport.path));
  assert.match(readFileSync(state.completionReport.path, "utf8"), /# Completion report/);
});

test("a restart with an owned running dispatch waits instead of double-claiming it", async () => {
  const fixture = makeFixture();
  const dispatch = prepareDispatch({ hqRoot, statePath: fixture.statePath });
  markDispatchRunning({ statePath: fixture.statePath, dispatchId: dispatch.dispatchId });

  const waiting = await runOneStage({
    hqRoot,
    statePath: fixture.statePath,
    execute: async () => { throw new Error("must not dispatch a second worker"); },
  });
  assert.equal(waiting.status, "dispatch");
  assert.equal(waiting.waiting, true);
  assert.equal((readState(fixture.statePath).dispatches || []).length, 0);

  const evidence = writeEvidence(fixture.worktree, "product");
  writeFileSync(dispatch.resultPath, JSON.stringify(resultFor(dispatch, [evidence])));
  const resumed = await runOneStage({ hqRoot, statePath: fixture.statePath, execute: async () => { throw new Error("must not re-dispatch"); } });
  assert.equal(resumed.status, "active");
  assert.equal(readState(fixture.statePath).dispatches[0].status, "completed");
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

// Every loop below is BOUNDED. These three tests previously spun on `for (;;)`
// waiting for a `failure-routed` event that #56 replaced with the recovery
// lifecycle, so the suite stopped terminating instead of failing — which is why
// nobody saw it for fifteen merged PRs. A contract change must produce a red
// test, never a hang.
const MAX_STEPS = 12;

async function runUntilTerminal({ statePath, execute, maxSteps = MAX_STEPS }) {
  const seen = [];
  for (let step = 0; step < maxSteps; step += 1) {
    const response = await runOneStage({ hqRoot, statePath, execute });
    seen.push(response.status);
    if (["blocked", "merge-ready"].includes(response.status)) return { response, steps: step + 1, seen };
  }
  throw new Error(`task never reached a terminal state in ${maxSteps} steps; saw: ${seen.join(" -> ")}`);
}

test("agent FAIL is retried safely and blocks at the attempt limit", async () => {
  const fixture = makeFixture();
  const execute = async ({ dispatch, cwd }) => {
    const evidence = writeEvidence(cwd, dispatch.stage);
    writeFileSync(dispatch.resultPath, JSON.stringify(resultFor(dispatch, [evidence], "fail")));
  };
  const { response } = await runUntilTerminal({ statePath: fixture.statePath, execute });
  assert.equal(response.status, "blocked");
  // A blocked task stops handing out work.
  assert.equal(prepareDispatch({ hqRoot, statePath: fixture.statePath }).status, "blocked");
  // It blocked because the bounded recovery budget was spent, not by looping.
  const state = readState(fixture.statePath);
  assert.equal(state.recovery.attempts.length, state.recovery.maxAttempts);
  assert.ok(state.events.some((e) => e.type === "recovery-escalated"));
});

test("missing result is persisted and safely retried as infrastructure", async () => {
  const fixture = makeFixture();
  const response = await runOneStage({ hqRoot, statePath: fixture.statePath, execute: async () => {} });
  assert.equal(response.status, "active");
  const state = readState(fixture.statePath);
  assert.equal(state.dispatches[0].status, "failed");
  assert.equal(state.currentStage, "product");
  // The stage failure is recorded and handed to recovery, not to the founder.
  assert.equal(state.events.at(-1).type, "recovery-diagnosing");
  // An agent that never wrote a result file is an environment problem. If this
  // is ever classified as a project failure it would page the founder for a
  // transient dispatch, which is the thing the factory must never do.
  assert.equal(state.failures.at(-1).classification, "INFRASTRUCTURE_ERROR");
});

// #56 put recovery in front of every `fail` outcome, so a reviewer FAIL is
// diagnosed and repaired rather than routed straight back to the builder —
// `routeStageFailure` only runs when recovery declines the failure. This test
// pins the behaviour that actually ships today: the task terminates, it
// terminates as blocked, and no downstream gate is credited on the way.
//
// NOTE for the founder: this means an ordinary "reviewer found a bug" spends
// the whole 3-attempt recovery budget before escalating, instead of going back
// to the builder to fix it. See the reliability handoff — it is a design
// question, not a test bug, so it is documented rather than changed here.
test("a persistently failing review terminates without crediting downstream gates", async () => {
  const fixture = makeFixture();
  const execute = async ({ dispatch, cwd }) => {
    const evidence = writeEvidence(cwd, dispatch.stage);
    writeFileSync(dispatch.resultPath, JSON.stringify(resultFor(dispatch, [evidence], dispatch.stage === "reviewer" ? "fail" : "pass")));
  };
  const { response } = await runUntilTerminal({ statePath: fixture.statePath, execute });
  assert.equal(response.status, "blocked");

  const state = readState(fixture.statePath);
  assert.equal(state.blocker.stage, "reviewer");
  assert.equal(state.stages.reviewer.status, "fail");
  // Work completed before the failure stands; nothing after it is credited.
  assert.equal(state.stages.builder.status, "pass");
  for (const stage of ["qa", "security", "release"]) {
    assert.equal(state.stages[stage].status, "pending", `${stage} must not be credited`);
  }
  assert.ok(state.events.some((e) => e.type === "recovery-escalated"));
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
