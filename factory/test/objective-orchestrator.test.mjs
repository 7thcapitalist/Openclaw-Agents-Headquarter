import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildObjectiveStateFromNodes } from "../lib/objective/decompose.mjs";
import { runObjective, readObjState } from "../lib/objective/orchestrator.mjs";

const HQ = process.cwd();

function makeRepo(root, withRemote = false) {
  const repo = join(root, "app");
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# app\n");
  const g = (args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  g(["init", "-b", "main"]);
  g(["config", "user.name", "T"]); g(["config", "user.email", "t@x.l"]);
  g(["add", "."]); g(["commit", "-m", "base"]);
  if (withRemote) {
    const bare = join(root, "remote.git");
    mkdirSync(bare, { recursive: true });
    execFileSync("git", ["-C", bare, "init", "--bare", "-b", "main"], { stdio: "pipe" });
    g(["remote", "add", "origin", "https://github.com/objective-smoke/app.git"]);
    g(["config", `url.${bare}.insteadOf`, "https://github.com/objective-smoke/app.git"]);
    g(["push", "-u", "origin", "main"]);
    return { repo, bare };
  }
  return { repo };
}

function makeExecute({ windows = [], failOnce = {} } = {}) {
  const done = new Set();
  return async ({ dispatch }) => {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 20));
    windows.push({ task: dispatch.taskId, stage: dispatch.stage, start, end: Date.now() });
    const evDir = join(dispatch.cwd, "evidence");
    mkdirSync(evDir, { recursive: true });
    writeFileSync(join(evDir, `${dispatch.stage}.md`), `${dispatch.stage} ok\n`);
    if (dispatch.stage === "builder") {
      mkdirSync(join(dispatch.cwd, "src"), { recursive: true });
      writeFileSync(join(dispatch.cwd, "src", `${dispatch.taskId}.mjs`), `export const id = ${JSON.stringify(dispatch.taskId)};\n`);
    }
    const key = `${dispatch.taskId}:${dispatch.stage}`;
    let outcome = "pass";
    if (failOnce[key] && !done.has(key)) { done.add(key); outcome = "fail"; }
    writeFileSync(dispatch.resultPath, JSON.stringify({
      version: 1, dispatchId: dispatch.dispatchId, stage: dispatch.stage, actor: dispatch.actor,
      outcome, summary: `${dispatch.stage} ${outcome}`, evidence: [`evidence/${dispatch.stage}.md`],
    }));
  };
}

function writeObjective(root, repo, nodes) {
  const g = buildObjectiveStateFromNodes({ objective: "demo objective", project: "app", repo, nodes });
  const dir = join(root, "data", "factory", "app", "objectives", g.objectiveId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "objective-state.json");
  writeFileSync(path, `${JSON.stringify(g, null, 2)}\n`);
  return { objectivePath: path, objDir: dir, objectiveId: g.objectiveId };
}

const NODES = [
  { id: "a", role: "backend-builder", objective: "Build part A", acceptanceCriteria: ["A works"], workType: "backend", risk: "low", dependsOn: [] },
  { id: "b", role: "frontend-builder", objective: "Build part B", acceptanceCriteria: ["B works"], workType: "ui", risk: "low", dependsOn: [] },
  { id: "c", role: "backend-builder", objective: "Build part C on top of A", acceptanceCriteria: ["C works"], workType: "backend", risk: "low", dependsOn: ["a"] },
];

test("runObjective: A+B concurrent, C waits for A, integration merges all, gates run on the combined tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "objective-orch-"));
  const { repo } = makeRepo(root);
  const { objectivePath, objDir } = writeObjective(root, repo, NODES);
  const windows = [];
  const stateRoot = join(root, "factory-state");

  const res = await runObjective({
    hqRoot: HQ, objectivePath, maxConcurrent: 3, stateRoot,
    execute: makeExecute({ windows }),
    publish: () => ({ published: false, reason: "no remote in this test" }),
  });

  assert.equal(res.status, "complete", JSON.stringify(res.integrationResp || res.status));
  const obj = readObjState(objectivePath);
  for (const id of Object.keys(obj.nodes)) assert.equal(obj.nodes[id].status, "gate-satisfied", `${id} not satisfied`);
  assert.equal(obj.integration.status, "gate-satisfied");

  const span = (suffix) => {
    const w = windows.filter((x) => x.task.endsWith(`-${suffix}`));
    return { start: Math.min(...w.map((x) => x.start)), end: Math.max(...w.map((x) => x.end)) };
  };
  const A = span("a"), B = span("b"), C = span("c");
  assert.ok(A.start < B.end && B.start < A.end, "A and B ran concurrently");
  assert.ok(C.start >= A.end - 10, "C started only after A completed");

  const worktrees = Object.values(obj.nodes).map((n) => n.worktree);
  assert.equal(new Set(worktrees).size, 3, "each node got its own worktree");
  assert.equal(new Set(Object.values(obj.nodes).map((n) => n.branch)).size, 3);

  assert.equal(obj.integration.mergeLog.filter((m) => m.ok).length, 3, "all three branches merged");
  for (const n of Object.values(obj.nodes)) {
    assert.ok(existsSync(join(obj.integration.worktree, "src", `${n.id}.mjs`)), `${n.id}'s file is on the integration branch`);
  }

  const metrics = JSON.parse(readFileSync(join(objDir, "metrics.json"), "utf8"));
  assert.equal(metrics.nodeCount, 3);
  assert.ok(metrics.maxParallelNodes >= 2, "recorded real parallelism");
  assert.ok(metrics.nodes.every((m) => Number.isFinite(m.durationMs)));
  assert.ok(Number.isFinite(metrics.integration.durationMs));
});

test("runObjective: a failed node blocks its dependents but not its siblings", async () => {
  const root = mkdtempSync(join(tmpdir(), "objective-fail-"));
  const { repo } = makeRepo(root);
  const { objectivePath } = writeObjective(root, repo, NODES);
  const stateRoot = join(root, "factory-state");

  // node A's builder fails every attempt (failOnce only fires once, so allow retries to also fail by keying per attempt-free)
  const execute = makeExecute({ failOnce: {} });
  const alwaysFailA = async (args) => {
    if (args.dispatch.taskId.endsWith("-a") && args.dispatch.stage === "builder") {
      writeFileSync(join(args.dispatch.cwd, "evidence.md"), "x"); // not used
      mkdirSync(join(args.dispatch.cwd, "evidence"), { recursive: true });
      writeFileSync(join(args.dispatch.cwd, "evidence", "builder.md"), "fail\n");
      writeFileSync(args.dispatch.resultPath, JSON.stringify({
        version: 1, dispatchId: args.dispatch.dispatchId, stage: "builder", actor: args.dispatch.actor,
        outcome: "fail", summary: "builder could not implement A", evidence: ["evidence/builder.md"],
      }));
      return;
    }
    return execute(args);
  };

  const res = await runObjective({ hqRoot: HQ, objectivePath, maxConcurrent: 3, stateRoot, execute: alwaysFailA, publish: () => ({ published: false }) });
  const obj = readObjState(objectivePath);
  assert.equal(obj.nodes[`${obj.objectiveId}-a`].status, "failed");
  assert.equal(obj.nodes[`${obj.objectiveId}-c`].status, "blocked-by-dep", "C blocked because it depends on A");
  assert.equal(obj.nodes[`${obj.objectiveId}-b`].status, "gate-satisfied", "B (independent) still completed");
  assert.notEqual(res.status, "complete");
  assert.equal(obj.integration.status, "pending", "integration never ran");
});

test("runObjective: an infrastructure failure becomes an actionable decision, not a dead `failed`", async () => {
  const root = mkdtempSync(join(tmpdir(), "objective-infra-"));
  const { repo } = makeRepo(root);
  const { objectivePath } = writeObjective(root, repo, NODES.slice(0, 1)); // one node, no deps
  const stateRoot = join(root, "factory-state");
  const base = makeExecute();

  const rateLimited = async (args) => {
    if (args.dispatch.stage === "builder") {
      mkdirSync(join(args.dispatch.cwd, "evidence"), { recursive: true });
      writeFileSync(join(args.dispatch.cwd, "evidence", "builder.md"), "rl\n");
      writeFileSync(args.dispatch.resultPath, JSON.stringify({
        version: 1, dispatchId: args.dispatch.dispatchId, stage: "builder", actor: args.dispatch.actor,
        outcome: "fail", summary: "[openclaw] Could not start the CLI. Reason: All models failed (rate_limit)", evidence: ["evidence/builder.md"],
      }));
      return;
    }
    return base(args);
  };

  const res = await runObjective({ hqRoot: HQ, objectivePath, maxConcurrent: 2, stateRoot, execute: rateLimited, publish: () => ({ published: false }) });
  const obj = readObjState(objectivePath);
  const node = Object.values(obj.nodes)[0];
  assert.equal(node.status, "blocked", "an infra failure blocks (needs the founder), it does not just die");
  assert.equal(node.blocker.outcome, "decision-required");
  assert.match(node.blocker.summary, /could not run|Retry the objective later|adjust model routing/i);
  assert.notEqual(res.status, "complete");
});

test("runObjective: report.md is written next to metrics.json", async () => {
  const root = mkdtempSync(join(tmpdir(), "objective-report-"));
  const { repo } = makeRepo(root);
  const { objectivePath, objDir } = writeObjective(root, repo, NODES.slice(0, 2));
  await runObjective({ hqRoot: HQ, objectivePath, maxConcurrent: 2, stateRoot: join(root, "factory-state"), execute: makeExecute(), publish: () => ({ published: false }) });
  const report = readFileSync(join(objDir, "report.md"), "utf8");
  assert.match(report, /# Objective report/);
  assert.match(report, /## Build nodes/);
  assert.match(report, /## Integration/);
});

test("runObjective: publishes and records one PR per build node before publishing integration", async () => {
  const root = mkdtempSync(join(tmpdir(), "objective-publish-"));
  const { repo } = makeRepo(root);
  const { objectivePath } = writeObjective(root, repo, NODES);
  const calls = [];
  const publish = ({ state }) => {
    calls.push(state.task.id);
    return {
      published: true,
      pushed: true,
      ownerRepo: "objective-smoke/app",
      prUrl: `https://github.com/objective-smoke/app/pull/${calls.length}`,
    };
  };

  const res = await runObjective({
    hqRoot: HQ, objectivePath, maxConcurrent: 3,
    stateRoot: join(root, "factory-state"), execute: makeExecute(), publish,
  });

  assert.equal(res.status, "complete");
  const obj = readObjState(objectivePath);
  assert.equal(calls.length, NODES.length + 1, "one publication per node plus integration");
  for (const node of Object.values(obj.nodes)) {
    assert.equal(calls.filter((id) => id === node.id).length, 1, `${node.id} published once`);
    assert.match(node.prUrl, /^https:\/\/github\.com\/objective-smoke\/app\/pull\/\d+$/);
    assert.equal(node.githubPublish.prUrl, node.prUrl);
    const taskState = JSON.parse(readFileSync(node.statePath, "utf8"));
    assert.equal(taskState.githubPublish.prUrl, node.prUrl, "task and objective record the same PR");
  }
  assert.equal(calls.filter((id) => id === obj.integration.id).length, 1, "integration published once");
  assert.match(obj.integration.githubPublish.prUrl, /^https:\/\/github\.com\/objective-smoke\/app\/pull\/\d+$/);
});

test("runObjective: a configured node publication failure blocks the objective and withholds integration", async () => {
  const root = mkdtempSync(join(tmpdir(), "objective-publish-fail-"));
  const { repo } = makeRepo(root);
  const { objectivePath } = writeObjective(root, repo, NODES.slice(0, 1));
  const calls = [];
  const publish = ({ state }) => {
    calls.push(state.task.id);
    return { published: false, pushed: false, ownerRepo: "objective-smoke/app", reason: "git push failed: permission denied" };
  };

  const res = await runObjective({
    hqRoot: HQ, objectivePath, stateRoot: join(root, "factory-state"),
    execute: makeExecute(), publish,
  });

  const obj = readObjState(objectivePath);
  const node = Object.values(obj.nodes)[0];
  assert.equal(res.status, "blocked");
  assert.equal(node.status, "blocked");
  assert.equal(node.blocker.stage, "publish");
  assert.equal(node.blocker.outcome, "decision-required");
  assert.match(node.blocker.summary, /permission denied.*Fix GitHub access/i);
  assert.equal(node.githubPublish.reason, "git push failed: permission denied");
  assert.equal(obj.integration.status, "pending", "integration never started");
  assert.deepEqual(calls, [node.id], "only the build node attempted publication");
});

test("runObjective: rerun retries only a publish-blocked node, then integrates", async () => {
  const root = mkdtempSync(join(tmpdir(), "objective-publish-resume-"));
  const { repo } = makeRepo(root);
  const { objectivePath } = writeObjective(root, repo, NODES.slice(0, 1));
  const executed = [];
  const baseExecute = makeExecute();
  const execute = async (args) => {
    executed.push(`${args.dispatch.taskId}:${args.dispatch.stage}`);
    return baseExecute(args);
  };
  const calls = [];
  const publish = ({ state }) => {
    calls.push(state.task.id);
    if (calls.length === 1) {
      return { published: false, pushed: false, ownerRepo: "objective-smoke/app", reason: "temporary GitHub outage" };
    }
    return {
      published: true, pushed: true, ownerRepo: "objective-smoke/app",
      prUrl: `https://github.com/objective-smoke/app/pull/${calls.length}`,
    };
  };

  const options = {
    hqRoot: HQ, objectivePath, stateRoot: join(root, "factory-state"), execute, publish,
  };
  const first = await runObjective(options);
  assert.equal(first.status, "blocked");
  const nodeId = Object.keys(first.objective.nodes)[0];
  const nodeExecutions = executed.filter((entry) => entry.startsWith(`${nodeId}:`)).length;

  const second = await runObjective(options);
  assert.equal(second.status, "complete");
  const obj = readObjState(objectivePath);
  assert.equal(executed.filter((entry) => entry.startsWith(`${nodeId}:`)).length, nodeExecutions, "seven node stages were not rerun");
  assert.equal(calls.filter((id) => id === nodeId).length, 2, "node publication was retried once");
  assert.equal(calls.filter((id) => id === obj.integration.id).length, 1, "integration published once after node PR existed");
  assert.match(obj.nodes[nodeId].prUrl, /^https:\/\/github\.com\/objective-smoke\/app\/pull\/2$/);
});

test("resuming an infrastructure-blocked node reuses its task and passed stages", async () => {
  const { resumeState, readState, writeState } = await import("../lib/task-workflow.mjs");
  const root = mkdtempSync(join(tmpdir(), "objective-resume-"));
  const { repo } = makeRepo(root);
  const { objectivePath } = writeObjective(root, repo, NODES.slice(0, 1));
  const opts = { hqRoot: HQ, objectivePath, stateRoot: join(root, "states"), maxAttemptsPerStage: 1, concurrentGroups: [], publish: () => ({ published: false }) };
  const normal = makeExecute();
  await runObjective({ ...opts, execute: async (input) => {
    if (input.dispatch.stage === "architect") throw new Error("provider temporarily unavailable");
    return normal(input);
  } });
  const node = Object.values(readObjState(objectivePath).nodes)[0];
  const before = readState(node.statePath);
  assert.equal(before.stages.product.status, "pass");
  writeState(node.statePath, resumeState(before));
  const windows = [];
  const result = await runObjective({ ...opts, execute: makeExecute({ windows }) });
  assert.equal(result.status, "complete");
  assert.equal(windows.filter((w) => w.task === node.id && w.stage === "product").length, 0);
  assert.equal(result.objective.nodes[node.id].worktree, node.worktree);
});
