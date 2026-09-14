import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { classifyBlocker, isRetriableInfraBlocker } from "../lib/hq/blocker-class.mjs";
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
  // Routed to the configured `product` runtime agent. This used to read
  // `agent:openclaw:...` — the logical actor used as an agent id, which is the
  // silent fallback that made reviewer and security unrunnable in production.
  assert.match(artifact, /sessionKey: agent:product:factory-issue-901-product-1/);
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
  // #56: a stage failure is handed to recovery rather than routed directly.
  assert.equal(state.events.at(-1).type, "recovery-diagnosing");
});

test("missing-result failures stay bounded and machine-recoverable", async () => {
  const fixture = makeFixture();
  const execute = async () => ({ stdout: "agent exited cleanly", stderr: "" });

  // The three stage attempts are still spent first, then recovery takes over,
  // so the task stays live for several more turns before it settles. Bounded so
  // a contract change fails here instead of spinning forever.
  let response;
  const seen = [];
  for (let step = 0; step < 12; step += 1) {
    response = await runOneStage({ hqRoot, statePath: fixture.statePath, execute });
    seen.push(response.status);
    if (["blocked", "merge-ready"].includes(response.status)) break;
  }
  assert.equal(response.status, "blocked", `never settled; saw: ${seen.join(" -> ")}`);
  const state = readState(fixture.statePath);
  // FINDING (documented in the reliability handoff, not changed here): since
  // #56 recovery intercepts on the FIRST stage failure, so `maxAttemptsPerStage`
  // no longer gives the stage three tries — it gets one, then the recovery
  // budget applies. Total bounded effort is what actually protects the seat, so
  // that is what this asserts.
  const stageAttempts = state.dispatches.filter((d) => !String(d.kind || "").startsWith("recovery-"));
  const recoveryAttempts = state.dispatches.filter((d) => String(d.kind || "").startsWith("recovery-"));
  assert.equal(stageAttempts.length, 1);
  assert.equal(recoveryAttempts.length, state.recovery.maxAttempts);
  assert.ok(state.dispatches.length <= 1 + state.recovery.maxAttempts,
    "a missing result must never dispatch unboundedly");
  assert.equal(state.currentStage, "product");
  // The founder is told once recovery is exhausted, but an agent that never
  // wrote a result file stays machine-recoverable: the resume sweep must be
  // able to pick this up when the environment comes back.
  assert.equal(isRetriableInfraBlocker(state.blocker), true);
  assert.ok(state.events.some((event) => event.type === "recovery-diagnosing"));
  // A redacted diagnostic is written for the stage attempt that went missing.
  // Every dispatch that went missing leaves one — the stage attempt and each
  // recovery pass — and no more than the bounded total.
  const diagnostics = readdirSync(join(fixture.worktree, "evidence"))
    .filter((f) => f.endsWith("-missing-result.md"));
  assert.ok(diagnostics.includes("issue-901-product-1-missing-result.md"));
  assert.equal(diagnostics.length, state.dispatches.length);
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
  // #56: a stage failure is handed to recovery rather than routed directly.
  assert.equal(state.events.at(-1).type, "recovery-diagnosing");

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
