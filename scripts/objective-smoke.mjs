#!/usr/bin/env node
// Hermetic end-to-end for objective decomposition + parallel orchestration.
// Mock agents, but REAL git/worktrees/graph/scheduler/integration-merge and a
// REAL local bare remote. Proves: independent nodes run concurrently, a
// dependent waits for its dependency's gate, the integration node merges every
// branch and runs the gates on the combined tree, ONE PR is pushed to the
// remote, `main` is never touched, and metrics.json is written.

import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { buildObjectiveStateFromNodes } from "../factory/lib/objective/decompose.mjs";
import { runObjective, readObjState } from "../factory/lib/objective/orchestrator.mjs";
import { publishMergeReadyTask } from "../factory/lib/hq/github-publish.mjs";

const HQ = join(dirname(fileURLToPath(import.meta.url)), "..");
const GH_URL = "https://github.com/objective-smoke/app.git";
const root = mkdtempSync(join(tmpdir(), "objective-smoke-"));
const repo = join(root, "app");
const bare = join(root, "remote.git");
const stateRoot = join(root, "factory-state");

const g = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
mkdirSync(bare, { recursive: true });
g(bare, ["init", "--bare", "-b", "main"]);
mkdirSync(join(repo, "test"), { recursive: true });
writeFileSync(join(repo, "README.md"), "# app\n");
g(repo, ["init", "-b", "main"]);
g(repo, ["config", "user.name", "Smoke"]); g(repo, ["config", "user.email", "s@x.l"]);
g(repo, ["add", "."]); g(repo, ["commit", "-m", "base"]);
g(repo, ["remote", "add", "origin", GH_URL]);
g(repo, ["config", `url.${bare}.insteadOf`, GH_URL]);
g(repo, ["push", "-u", "origin", "main"]);
const remoteMainBefore = g(bare, ["rev-parse", "main"]).trim();

const nodes = [
  { id: "api", role: "backend-builder", objective: "Add the API", acceptanceCriteria: ["endpoint works"], workType: "backend", risk: "low", dependsOn: [] },
  { id: "ui", role: "frontend-builder", objective: "Add the UI", acceptanceCriteria: ["screen renders"], workType: "ui", risk: "low", dependsOn: [] },
  { id: "wire", role: "frontend-builder", objective: "Wire UI to API", acceptanceCriteria: ["end to end works"], workType: "ui", risk: "low", dependsOn: ["api", "ui"] },
];
const obj = buildObjectiveStateFromNodes({ objective: "Build the demo feature", project: "app", repo, nodes });
const objDir = join(stateRoot, "objectives", obj.objectiveId);
mkdirSync(objDir, { recursive: true });
const objectivePath = join(objDir, "objective-state.json");
writeFileSync(objectivePath, `${JSON.stringify(obj, null, 2)}\n`);

const windows = [];
const execute = async ({ dispatch }) => {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 25));
  windows.push({ task: dispatch.taskId, stage: dispatch.stage, start, end: Date.now() });
  const evDir = join(dispatch.cwd, "evidence");
  mkdirSync(evDir, { recursive: true });
  writeFileSync(join(evDir, `${dispatch.stage}.md`), `${dispatch.stage} ok\n`);
  if (dispatch.stage === "builder") {
    mkdirSync(join(dispatch.cwd, "src"), { recursive: true });
    writeFileSync(join(dispatch.cwd, "src", `${dispatch.taskId}.mjs`), `export const id = ${JSON.stringify(dispatch.taskId)};\n`);
  }
  writeFileSync(dispatch.resultPath, JSON.stringify({
    version: 1, dispatchId: dispatch.dispatchId, stage: dispatch.stage, actor: dispatch.actor,
    outcome: "pass", summary: `${dispatch.stage} pass`, evidence: [`evidence/${dispatch.stage}.md`],
  }));
};

const result = await runObjective({
  hqRoot: HQ, objectivePath, maxConcurrent: 3, stateRoot, execute,
  publish: (args) => publishMergeReadyTask({ ...args, ghAvailable: () => false }),
});

assert.equal(result.status, "complete", JSON.stringify(result.integrationResp || result.status));
const final = readObjState(objectivePath);

// concurrency: api + ui overlapped; wire waited for both
const span = (s) => { const w = windows.filter((x) => x.task.endsWith(`-${s}`)); return { start: Math.min(...w.map((x) => x.start)), end: Math.max(...w.map((x) => x.end)) }; };
const API = span("api"), UI = span("ui"), WIRE = span("wire");
assert.ok(API.start < UI.end && UI.start < API.end, "api and ui ran concurrently");
assert.ok(WIRE.start >= Math.max(API.end, UI.end) - 15, "wire waited for its dependencies");

// each node isolated
assert.equal(new Set(Object.values(final.nodes).map((n) => n.worktree)).size, 3);

// integration merged everything and pushed ONE PR branch; main untouched
assert.equal(final.integration.status, "gate-satisfied");
assert.equal(final.integration.mergeLog.filter((m) => m.ok).length, 3);
assert.equal(final.integration.githubPublish?.pushed, true, "integration branch pushed");
assert.match(final.integration.githubPublish.ownerRepo, /objective-smoke\/app/);
const remoteBranches = g(bare, ["branch", "--list"]);
assert.match(remoteBranches, new RegExp(`integration-${obj.objectiveId}`), "integration branch on the remote");
assert.equal(g(bare, ["rev-parse", "main"]).trim(), remoteMainBefore, "remote main untouched");
const tree = g(bare, ["ls-tree", "-r", "--name-only", final.integration.branch]);
for (const n of Object.values(final.nodes)) assert.match(tree, new RegExp(`src/${n.id}\\.mjs`), `${n.id} on the integration branch`);

// metrics
const metrics = JSON.parse(readFileSync(join(objDir, "metrics.json"), "utf8"));
assert.equal(metrics.nodeCount, 3);
assert.ok(metrics.maxParallelNodes >= 2);
assert.ok(metrics.nodes.every((m) => Number.isFinite(m.durationMs)));

console.log(JSON.stringify({
  ok: true,
  objectiveId: obj.objectiveId,
  status: result.status,
  nodes: Object.values(final.nodes).map((n) => ({ id: n.id, status: n.status, branch: n.branch })),
  integrationBranch: final.integration.branch,
  pr: final.integration.githubPublish?.prUrl || final.integration.githubPublish?.reason,
  maxParallelNodes: metrics.maxParallelNodes,
  remoteMainUnchanged: g(bare, ["rev-parse", "main"]).trim() === remoteMainBefore,
}, null, 2));
