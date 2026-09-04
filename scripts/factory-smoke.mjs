#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { handleRequest } from "./openclaw-factory.mjs";

const root = mkdtempSync(join(tmpdir(), "openclaw-factory-smoke-"));
const repo = join(root, "tiny-project");
const stateRoot = join(root, "factory-state");
mkdirSync(join(repo, "test"), { recursive: true });
writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "factory-smoke-project", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`);
writeFileSync(join(repo, "README.md"), "# Tiny factory smoke project\n\nA disposable project used to prove real agent orchestration.\n");
writeFileSync(join(repo, "test", "baseline.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('baseline', () => assert.equal(1 + 1, 2));\n");
git(repo, ["init", "-b", "main"]);
git(repo, ["config", "user.name", "Factory Smoke"]);
git(repo, ["config", "user.email", "factory-smoke@invalid.local"]);
git(repo, ["add", "."]);
git(repo, ["commit", "-m", "Initialize tiny smoke project"]);

const objective = "Add a small dependency-free JavaScript module at src/greeting.mjs that exports greet(name). It must trim the name, return `Hello, <name>!`, and throw TypeError for a blank or non-string name. Add automated tests for success, whitespace, blank input, and non-string input. This is a disposable local repository with no remote: do not create or push a PR; the factory branch and evidence are the delivery record.";
const response = await handleRequest({ version: 1, action: "start", repo, stateRoot, objective });
assert.equal(response.status, "merge-ready", JSON.stringify(response.blocker));
const state = JSON.parse(readFileSync(response.statePath, "utf8"));
assert.deepEqual(Object.keys(state.stages), ["product", "architect", "builder", "reviewer", "qa", "security", "release"]);
for (const [stage, result] of Object.entries(state.stages)) assert.equal(result.status, "pass", `${stage} did not pass`);
assert.notEqual(state.assignments.builder, state.assignments.reviewer);
assert.notEqual(state.assignments.builder, state.assignments.qa);
execFileSync("npm", ["test"], { cwd: response.worktree, stdio: "inherit" });
assert.match(readFileSync(join(response.worktree, "src", "greeting.mjs"), "utf8"), /greet/);
console.log(JSON.stringify({ ok: true, status: response.status, taskId: response.taskId, branch: response.branch, worktree: response.worktree, statePath: response.statePath, dispatches: state.dispatches.map(({ stage, actor, status, outcome, attempt }) => ({ stage, actor, status, outcome, attempt })) }, null, 2));

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}
