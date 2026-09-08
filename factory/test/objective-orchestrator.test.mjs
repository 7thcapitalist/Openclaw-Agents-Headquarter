import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildObjectiveStateFromNodes } from "../lib/objective/decompose.mjs";
import { runObjective, readObjState, resumeObjectiveNodes } from "../lib/objective/orchestrator.mjs";
import { readState, writeState } from "../lib/task-workflow.mjs";

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
  assert.equal(node.blocker.infra, true, "synthesized blocker carries an explicit infra tag");
  assert.match(node.blocker.summary, /could not run|Retry the objective later|adjust model routing/i);
  assert.notEqual(res.status, "complete");
});

test("resumeObjectiveNodes + re-run: infra-blocked node reuses worktree and can complete", async () => {
  const root = mkdtempSync(join(tmpdir(), "objective-resume-"));
  const { repo } = makeRepo(root);
  const { objectivePath } = writeObjective(root, repo, NODES.slice(0, 1));
  const stateRoot = join(root, "factory-state");
  const base = makeExecute();
  let failBuilder = true;
  const failThenPass = async (args) => {
    if (args.dispatch.stage === "builder" && failBuilder) {
        mkdirSync(join(args.dispatch.cwd, "evidence"), { recursive: true });
        writeFileSync(join(args.dispatch.cwd, "evidence", "builder.md"), "rl\n");
        writeFileSync(args.dispatch.resultPath, JSON.stringify({
          version: 1, dispatchId: args.dispatch.dispatchId, stage: "builder", actor: args.dispatch.actor,
          outcome: "fail", summary: "[openclaw] Could not start the CLI. Reason: rate_limit", evidence: ["evidence/builder.md"],
        }));
        return;
    }
    return base(args);
  };

  await runObjective({ hqRoot: HQ, objectivePath, maxConcurrent: 2, stateRoot, execute: failThenPass, publish: () => ({ published: false }) });
  let obj = readObjState(objectivePath);
  const nodeId = Object.keys(obj.nodes)[0];
  const worktreeBefore = obj.nodes[nodeId].worktree;
  assert.equal(obj.nodes[nodeId].status, "blocked");
  assert.equal(obj.nodes[nodeId].blocker.infra, true);

  failBuilder = false;
  const out = resumeObjectiveNodes({ objectivePath, nodeIds: [nodeId] });
  assert.equal(out.resumed.length, 1);
  assert.equal(out.resumed[0].id, nodeId);

  const res2 = await runObjective({ hqRoot: HQ, objectivePath, maxConcurrent: 2, stateRoot, execute: failThenPass, publish: () => ({ published: false }) });
  obj = readObjState(objectivePath);
  assert.equal(obj.nodes[nodeId].worktree, worktreeBefore, "reuses existing worktree");
  assert.equal(obj.nodes[nodeId].status, "gate-satisfied");
  assert.equal(res2.status, "complete");
});

test("resumeObjectiveNodes: orphaned running node re-arms task dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "objective-orphan-"));
  const { repo } = makeRepo(root);
  const { objectivePath } = writeObjective(root, repo, NODES.slice(0, 1));
  const stateRoot = join(root, "factory-state");
  // Seed by running once to create state, then stop mid-flight by mutating.
  await runObjective({ hqRoot: HQ, objectivePath, maxConcurrent: 2, stateRoot, execute: makeExecute(), publish: () => ({ published: false }) });
  const obj0 = readObjState(objectivePath);
  const nodeId = Object.keys(obj0.nodes)[0];
  // Force an orphaned shape: node running + task active with stale updatedAt.
  const st = readState(obj0.nodes[nodeId].statePath);
  st.status = "active";
  st.currentStage = "builder";
  st.currentDispatch = { dispatchId: "stuck", stage: "builder" };
  st.stages.builder = { status: "running" };
  st.updatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  writeState(obj0.nodes[nodeId].statePath, st);
  // Patch objective node to running
  const raw = JSON.parse(readFileSync(objectivePath, "utf8"));
  raw.nodes[nodeId].status = "running";
  raw.nodes[nodeId].blocker = null;
  raw.status = "active";
  writeFileSync(objectivePath, `${JSON.stringify(raw, null, 2)}\n`);

  const out = resumeObjectiveNodes({ objectivePath, nodeIds: [nodeId] });
  assert.equal(out.resumed.length, 1);
  assert.equal(out.resumed[0].reason, "restart-orphaned");
  const revived = readState(obj0.nodes[nodeId].statePath);
  assert.equal(revived.stages.builder.status, "pending");
  assert.equal(revived.currentDispatch, undefined);
  assert.equal(readObjState(objectivePath).nodes[nodeId].status, "pending");
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

test("resumeObjectiveNodes: skips decision nodes when mixed with infra", async () => {
  const root = mkdtempSync(join(tmpdir(), "objective-skip-dec-"));
  const { repo } = makeRepo(root);
  const { objectivePath } = writeObjective(root, repo, NODES.slice(0, 2));
  const stateRoot = join(root, "factory-state");
  const base = makeExecute();
  const execute = async (args) => {
    if (args.dispatch.taskId.endsWith("-a") && args.dispatch.stage === "builder") {
      mkdirSync(join(args.dispatch.cwd, "evidence"), { recursive: true });
      writeFileSync(join(args.dispatch.cwd, "evidence", "builder.md"), "rl\n");
      writeFileSync(args.dispatch.resultPath, JSON.stringify({
        version: 1, dispatchId: args.dispatch.dispatchId, stage: "builder", actor: args.dispatch.actor,
        outcome: "fail", summary: "[openclaw] Could not start the CLI. Reason: rate_limit", evidence: ["evidence/builder.md"],
      }));
      return;
    }
    return base(args);
  };
  await runObjective({ hqRoot: HQ, objectivePath, maxConcurrent: 2, stateRoot, execute, publish: () => ({ published: false }) });
  const obj = readObjState(objectivePath);
  const aId = `${obj.objectiveId}-a`;
  const bId = `${obj.objectiveId}-b`;
  const bst = readState(obj.nodes[bId].statePath);
  bst.status = "blocked";
  bst.blocker = { stage: "architect", outcome: "decision-required", summary: "Choose Postgres or SQLite" };
  writeState(obj.nodes[bId].statePath, bst);
  obj.nodes[bId].status = "blocked";
  obj.nodes[bId].blocker = bst.blocker;
  writeFileSync(objectivePath, `${JSON.stringify(obj, null, 2)}\n`);

  const out = resumeObjectiveNodes({ objectivePath, nodeIds: [aId, bId] });
  assert.equal(out.resumed.map((r) => r.id).join(","), aId);
  assert.ok(out.skipped.some((s) => s.id === bId && /decision/i.test(s.reason)));
  assert.equal(readState(obj.nodes[bId].statePath).status, "blocked");
  assert.equal(readState(obj.nodes[aId].statePath).status, "active");
});

test("resumeObjectiveNodes + integration infra: reuses worktree and completes", async () => {
  const root = mkdtempSync(join(tmpdir(), "objective-integ-rec-"));
  const { repo } = makeRepo(root);
  const { objectivePath } = writeObjective(root, repo, NODES.slice(0, 1));
  const stateRoot = join(root, "factory-state");
  const base = makeExecute();
  let failReview = true;
  const execute = async (args) => {
    if (failReview && String(args.dispatch.taskId).includes("integration") && args.dispatch.stage === "reviewer") {
      mkdirSync(join(args.dispatch.cwd, "evidence"), { recursive: true });
      writeFileSync(join(args.dispatch.cwd, "evidence", "reviewer.md"), "rl\n");
      writeFileSync(args.dispatch.resultPath, JSON.stringify({
        version: 1, dispatchId: args.dispatch.dispatchId, stage: "reviewer", actor: args.dispatch.actor,
        outcome: "fail", summary: "[openclaw] Could not start the CLI. Reason: provider unavailable", evidence: ["evidence/reviewer.md"],
      }));
      return;
    }
    return base(args);
  };

  await runObjective({ hqRoot: HQ, objectivePath, maxConcurrent: 1, stateRoot, execute, publish: () => ({ published: false }) });
  let obj = readObjState(objectivePath);
  assert.equal(obj.integration.status, "blocked");
  assert.equal(obj.integration.blocker.infra, true);
  const wt = obj.integration.worktree;

  const out = resumeObjectiveNodes({ objectivePath, nodeIds: [obj.integration.id] });
  assert.equal(out.resumed.length, 1);

  failReview = false;
  const res = await runObjective({ hqRoot: HQ, objectivePath, maxConcurrent: 1, stateRoot, execute, publish: () => ({ published: false }) });
  obj = readObjState(objectivePath);
  assert.equal(res.status, "complete");
  assert.equal(obj.integration.status, "gate-satisfied");
  assert.equal(obj.integration.worktree, wt);
});
