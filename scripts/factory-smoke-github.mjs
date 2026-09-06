#!/usr/bin/env node
// Hermetic end-to-end for the GitHub publish path.
//
// Unlike scripts/factory-smoke.mjs (which drives the REAL OpenClaw harness
// against a no-remote repo), this one mocks the per-stage agent but uses REAL
// git: a real task worktree, a real `origin` that is a local bare repo, and the
// real publishMergeReadyTask. It proves the branch is committed and pushed to
// the remote after every gate passes, that state records the commit + repo, and
// that the remote's default branch is never touched. No network, no `gh`.

import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { initializeTask } from "../factory/lib/task-initializer.mjs";
import { runToTerminal } from "../factory/lib/openclaw-runner.mjs";
import { publishMergeReadyTask } from "../factory/lib/hq/github-publish.mjs";

const GH_URL = "https://github.com/openclaw-smoke/factory-smoke.git";
const OWNER_REPO = "openclaw-smoke/factory-smoke";

// The real repo root: writeHandoff reads factory/prompts/*.md from it, and
// publishMergeReadyTask reads factory/hq.config.json. There is no "factory-smoke"
// project in the real projects.json, so the publish target is derived from the
// task worktree's own origin remote — which is exactly what this smoke exercises.
const hqRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "factory-smoke-github-"));
const repo = join(root, "project");
const bare = join(root, "remote.git");
const stateRoot = join(root, "factory-state");

mkdirSync(bare, { recursive: true });
git(bare, ["init", "--bare", "-b", "main"]);

mkdirSync(join(repo, "test"), { recursive: true });
writeFileSync(join(repo, "README.md"), "# smoke\n");
writeFileSync(join(repo, "test", "baseline.test.mjs"), "import test from 'node:test';import assert from 'node:assert/strict';test('b',()=>assert.equal(1,1));\n");
git(repo, ["init", "-b", "main"]);
git(repo, ["config", "user.name", "Factory Smoke"]);
git(repo, ["config", "user.email", "smoke@invalid.local"]);
git(repo, ["add", "."]);
git(repo, ["commit", "-m", "baseline"]);
git(repo, ["remote", "add", "origin", GH_URL]);
// Pushes to the GitHub-shaped URL transparently hit the local bare repo.
git(repo, ["config", `url.${bare}.insteadOf`, GH_URL]);
git(repo, ["push", "-u", "origin", "main"]);
const remoteMainBefore = git(bare, ["rev-parse", "main"]).trim();

const contractPath = join(root, "task.json");
writeFileSync(contractPath, JSON.stringify({
  id: "smoke-gh", issue: "local:smoke-gh",
  outcome: "Add a greeting module with tests.",
  acceptanceCriteria: ["greet() returns a string", "blank input throws"],
  project: "factory-smoke", workType: "backend", risk: "low",
}));

const init = initializeTask({ hqRoot, contractPath, repo, stateRoot });
assert.equal(init.branch, "factory/smoke-gh");

// Mock one agent turn per stage: write the stage evidence, and at the builder
// stage also write real source so the branch carries actual work.
const execute = async ({ dispatch }) => {
  const evDir = join(dispatch.cwd, "evidence");
  mkdirSync(evDir, { recursive: true });
  writeFileSync(join(evDir, `${dispatch.stage}.md`), `${dispatch.stage} verified\n`);
  if (dispatch.stage === "builder") {
    mkdirSync(join(dispatch.cwd, "src"), { recursive: true });
    writeFileSync(join(dispatch.cwd, "src", "greeting.mjs"), "export const greet = (n) => { if (!n?.trim()) throw new TypeError('blank'); return `Hello, ${n.trim()}!`; };\n");
  }
  writeFileSync(dispatch.resultPath, JSON.stringify({
    version: 1, dispatchId: dispatch.dispatchId, stage: dispatch.stage, actor: dispatch.actor,
    outcome: "pass", summary: `${dispatch.stage} pass`, evidence: [`evidence/${dispatch.stage}.md`],
  }));
};

const publish = (args) => publishMergeReadyTask({ ...args, ghAvailable: () => false });

const response = await runToTerminal({
  hqRoot,
  statePath: init.state,
  agentIds: { product: "openclaw", architect: "claude", builder: "codex", reviewer: "claude", qa: "codex", security: "claude", release: "openclaw" },
  execute,
  publish,
});

assert.equal(response.status, "merge-ready", JSON.stringify(response.blocker || response));

const state = JSON.parse(readFileSync(init.state, "utf8"));
assert.equal(state.githubPublish.pushed, true, "branch pushed");
assert.equal(state.githubPublish.ownerRepo, OWNER_REPO, "repo derived from the origin remote");
assert.match(state.githubPublish.commitSha || "", /^[0-9a-f]{7,40}$/, "commit sha recorded");
assert.ok(state.githubPublish.commitRange, "commit range recorded");
assert.equal(state.githubPublish.prUrl, null);
assert.match(state.githubPublish.reason || "", /open the PR manually/);

// The branch really landed on the remote, with the builder's file, and main is untouched.
const remoteBranches = git(bare, ["branch", "--list"]);
assert.match(remoteBranches, /factory\/smoke-gh/, "task branch exists on the remote");
const remoteTree = git(bare, ["ls-tree", "-r", "--name-only", "factory/smoke-gh"]);
assert.match(remoteTree, /src\/greeting\.mjs/, "the builder's work is on the pushed branch");
assert.match(remoteTree, /evidence\/builder\.md/, "evidence is on the pushed branch");
assert.equal(git(bare, ["rev-parse", "main"]).trim(), remoteMainBefore, "remote main was never moved");

// The founder-readable completion report exists and reflects the publish.
const reportPath = join(init.state, "..", "completion-report.md");
assert.ok(existsSync(reportPath), "completion-report.md written next to state.json");
const report = readFileSync(reportPath, "utf8");
assert.match(report, /# Completion report — smoke-gh/);
assert.match(report, new RegExp(OWNER_REPO));
assert.match(report, /Branch pushed: `factory\/smoke-gh`/);

console.log(JSON.stringify({
  ok: true,
  status: response.status,
  branch: init.branch,
  ownerRepo: state.githubPublish.ownerRepo,
  commitSha: state.githubPublish.commitSha,
  pushed: state.githubPublish.pushed,
  remoteMainUnchanged: git(bare, ["rev-parse", "main"]).trim() === remoteMainBefore,
}, null, 2));

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
