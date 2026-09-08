import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { classifyBlocker } from "../lib/hq/blocker-class.mjs";
import { runOneStage } from "../lib/openclaw-runner.mjs";
import { createState, readState, writeState } from "../lib/task-workflow.mjs";

const hqRoot = resolve(".");
const task = {
  id: "issue-901",
  issue: "901",
  outcome: "Diagnose a missing result.",
  acceptanceCriteria: ["Missing results leave redacted evidence"],
  project: "sample",
  workType: "backend",
  risk: "low",
};

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "runner-missing-result-"));
  const worktree = join(root, "worktree");
  const statePath = join(root, "state", "state.json");
  mkdirSync(worktree);
  writeState(statePath, createState({ task, repo: join(root, "repo"), branch: "factory/issue-901", worktree }));
  return { worktree, statePath };
}

test("a resolved execution with no result writes redacted diagnostics and a legible retry summary", async () => {
  const fixture = makeFixture();
  const aws = `AKIA${"X".repeat(16)}`;
  const openai = `sk-${"a".repeat(24)}`;
  const execute = async () => ({
    stdout: `starting\n${aws}\n${openai}\nboom no result`,
    stderr: "Error: model overloaded",
  });

  const response = await runOneStage({ hqRoot, statePath: fixture.statePath, execute });
  assert.equal(response.status, "active");

  const rel = "evidence/issue-901-product-1-missing-result.md";
  const artifactPath = join(fixture.worktree, rel);
  assert.equal(existsSync(artifactPath), true);
  assert.ok(statSync(artifactPath).size > 0);
  const artifact = readFileSync(artifactPath, "utf8");
  assert.match(artifact, /sessionKey: agent:openclaw:factory-issue-901-product-1/);
  assert.match(artifact, /\[redacted: aws-akia\]/);
  assert.match(artifact, /\[redacted: openai-sk\]/);
  assert.doesNotMatch(artifact, new RegExp(aws));
  assert.doesNotMatch(artifact, new RegExp(openai));
  assert.match(artifact, /Executor stdout/);
  assert.match(artifact, /Executor stderr/);
  assert.match(artifact, /model overloaded/);

  const state = readState(fixture.statePath);
  assert.equal(state.currentStage, "product");
  assert.equal(state.dispatches.length, 1);
  assert.equal(state.dispatches[0].status, "failed");
  assert.match(state.dispatches[0].error, /wrote no result file/);
  assert.match(state.dispatches[0].error, new RegExp(rel));
  assert.equal(state.events.at(-1).type, "failure-routed");
});

test("missing-result failures keep the three-attempt limit and infra classification", async () => {
  const fixture = makeFixture();
  const execute = async () => ({ stdout: "agent exited cleanly", stderr: "" });

  assert.equal((await runOneStage({ hqRoot, statePath: fixture.statePath, execute })).status, "active");
  assert.equal((await runOneStage({ hqRoot, statePath: fixture.statePath, execute })).status, "active");
  const response = await runOneStage({ hqRoot, statePath: fixture.statePath, execute });

  assert.equal(response.status, "blocked");
  const state = readState(fixture.statePath);
  assert.equal(state.dispatches.length, 3);
  assert.equal(classifyBlocker(state.blocker), "infra");
  assert.equal(state.currentStage, "product");
  assert.ok(state.events.some((event) => event.type === "failure-routed"));
  assert.equal(existsSync(join(fixture.worktree, "evidence/issue-901-product-3-missing-result.md")), true);
});

test("a thrown executor with no result uses the same redacted diagnostic path", async () => {
  const fixture = makeFixture();
  const token = `ghp_${"z".repeat(24)}`;
  const execute = async () => {
    throw Object.assign(new Error("[openclaw] All models failed"), {
      stdout: `context ${token}`,
      stderr: `trace ${token}`,
    });
  };

  const response = await runOneStage({ hqRoot, statePath: fixture.statePath, execute });
  assert.equal(response.status, "active");
  const state = readState(fixture.statePath);
  assert.match(state.dispatches[0].error, /wrote no result file/);
  assert.match(state.dispatches[0].error, /evidence\/issue-901-product-1-missing-result\.md/);
  assert.doesNotMatch(state.dispatches[0].error, new RegExp(token));
  assert.equal(classifyBlocker({ outcome: "fail", summary: state.dispatches[0].error }), "infra");
  assert.equal(state.events.at(-1).type, "failure-routed");

  const artifact = readFileSync(join(fixture.worktree, "evidence/issue-901-product-1-missing-result.md"), "utf8");
  assert.match(artifact, /\[redacted: gh-token\]/);
  assert.doesNotMatch(artifact, new RegExp(token));
  assert.match(artifact, /reason: trace \[redacted: gh-token\]/);
});

test("executor output is tail-limited and truncated before persistence", async () => {
  const fixture = makeFixture();
  const execute = async () => ({ stdout: `${"a".repeat(50000)}TAIL_FAILURE`, stderr: "" });

  await runOneStage({ hqRoot, statePath: fixture.statePath, execute });
  const artifactPath = join(fixture.worktree, "evidence/issue-901-product-1-missing-result.md");
  const artifact = readFileSync(artifactPath, "utf8");
  assert.match(artifact, /…/);
  assert.match(artifact, /TAIL_FAILURE/);
  assert.ok(statSync(artifactPath).size < 10000, "diagnostic stays far below the raw output size");
});
