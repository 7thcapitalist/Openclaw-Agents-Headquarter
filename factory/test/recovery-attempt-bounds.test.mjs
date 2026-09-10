import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createState, readState, writeState } from "../lib/task-workflow.mjs";
import { runOneStage } from "../lib/openclaw-runner.mjs";
import { ensureEvidenceIgnored } from "../lib/task-initializer.mjs";

const hqRoot = process.cwd();

function scaffold(name, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  const worktree = join(root, "worktree");
  const statePath = join(root, "state.json");
  mkdirSync(worktree);
  const task = {
    id: "issue-bounds", issue: "bounds", outcome: "Prove recovery re-entry is bounded",
    acceptanceCriteria: ["The task advances"], project: "sample", workType: "backend", risk: "low",
  };
  writeState(statePath, createState({ task, repo: root, branch: "factory/issue-bounds", worktree, maxRecoveryAttempts: 3, ...overrides }));
  return { root, worktree, statePath };
}

// Regression: recovery re-enters the failed stage after an independently
// verified repair. That re-entry is a stage attempt, but it never consulted the
// per-stage budget, so repeated recovery cycles could dispatch a stage far past
// maxAttemptsPerStage instead of surfacing the loop to the founder.
test("a verified recovery will not re-enter a stage that has spent its attempt budget", async () => {
  const { statePath } = scaffold("factory-attempt-bounds");
  const state = readState(statePath);
  state.currentStage = "builder";
  state.stages.product = { status: "pass", actor: "openclaw", summary: "ok", evidence: [{ path: "evidence/p.md" }] };
  state.stages.architect = { status: "pass", actor: "claude", summary: "ok", evidence: [{ path: "evidence/a.md" }] };
  // The builder has already burned two of its three attempts; the run below
  // spends the third, so the post-recovery re-entry would be a fourth.
  state.dispatches = [1, 2].map((attempt) => ({
    id: `issue-bounds-builder-${attempt}`, stage: "builder", actor: "codex",
    kind: "stage", status: "failed", attempt,
  }));
  writeState(statePath, state);

  const execute = async ({ dispatch, cwd }) => {
    mkdirSync(join(cwd, "evidence"), { recursive: true });
    const evidence = `evidence/${dispatch.dispatchId}.md`;
    writeFileSync(join(cwd, evidence), "observed proof\n");
    const outcome = dispatch.kind === "stage" ? "fail" : "pass";
    writeFileSync(dispatch.resultPath, JSON.stringify({
      version: 1, dispatchId: dispatch.dispatchId, stage: dispatch.stage, actor: dispatch.actor,
      outcome, summary: outcome === "fail" ? "test assertion failed" : "repair independently verified",
      evidence: [evidence],
    }));
  };
  let result;
  for (let i = 0; i < 30; i += 1) {
    result = await runOneStage({ hqRoot, statePath, execute, maxAttemptsPerStage: 3, concurrentGroups: [] });
    if (result.status !== "active") break;
  }
  const final = readState(statePath);
  assert.equal(final.status, "blocked");
  assert.equal(final.recovery.attempts.at(-1).status, "verified");
  assert.equal(final.blocker.stage, "builder");
  assert.match(final.blocker.why || final.blocker.summary || "", /stage attempts/);
  // The budget held: no fourth builder stage dispatch was ever created.
  assert.equal(final.dispatches.filter((d) => d.stage === "builder" && (d.kind === "stage" || !d.kind)).length, 3);
});

// The budget that applies must be the one the caller configured, not a default
// baked into the state layer. `ingestResult`/`failDispatch` own the value, so a
// task running with a tighter budget must escalate earlier, not at 3.
test("the configured per-stage budget is the one recovery re-entry respects", async () => {
  const { statePath } = scaffold("factory-attempt-bounds-configured");
  const state = readState(statePath);
  state.currentStage = "builder";
  state.stages.product = { status: "pass", actor: "openclaw", summary: "ok", evidence: [{ path: "evidence/p.md" }] };
  state.stages.architect = { status: "pass", actor: "claude", summary: "ok", evidence: [{ path: "evidence/a.md" }] };
  writeState(statePath, state);

  const execute = async ({ dispatch, cwd }) => {
    mkdirSync(join(cwd, "evidence"), { recursive: true });
    const evidence = `evidence/${dispatch.dispatchId}.md`;
    writeFileSync(join(cwd, evidence), "observed proof\n");
    const outcome = dispatch.kind === "stage" ? "fail" : "pass";
    writeFileSync(dispatch.resultPath, JSON.stringify({
      version: 1, dispatchId: dispatch.dispatchId, stage: dispatch.stage, actor: dispatch.actor,
      outcome, summary: outcome === "fail" ? "test assertion failed" : "repair independently verified",
      evidence: [evidence],
    }));
  };
  let result;
  for (let i = 0; i < 30; i += 1) {
    result = await runOneStage({ hqRoot, statePath, execute, maxAttemptsPerStage: 1, concurrentGroups: [] });
    if (result.status !== "active") break;
  }
  const final = readState(statePath);
  assert.equal(final.status, "blocked");
  // With a budget of 1 the single stage attempt is spent immediately, so the
  // verified repair cannot re-enter and the founder is asked at 1, not 3.
  assert.match(final.blocker.why || final.blocker.summary || "", /1 of 1 stage attempts/);
  assert.equal(final.dispatches.filter((d) => d.stage === "builder" && (d.kind === "stage" || !d.kind)).length, 1);
});

test("worktree initialization makes the evidence directory ignored", () => {
  const repo = mkdtempSync(join(tmpdir(), "factory-evidence-ignore-"));
  const git = (args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "factory@test"]);
  git(["config", "user.name", "Factory Test"]);
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  writeFileSync(join(repo, "README.md"), "sample\n");
  git(["add", "."]);
  git(["commit", "-qm", "init"]);

  const { runGit } = { runGit: (cwd, args, options = {}) => {
    try { return { ok: true, stdout: execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }) }; }
    catch (error) { if (options.allowFailure) return { ok: false, stdout: "" }; throw error; }
  } };
  assert.equal(ensureEvidenceIgnored({ worktree: repo, branch: "factory/x", git: runGit }), true);
  assert.match(readFileSync(join(repo, ".gitignore"), "utf8"), /^evidence\/$/m);

  // Evidence written by an agent no longer dirties the tree or reaches linters.
  mkdirSync(join(repo, "evidence"), { recursive: true });
  writeFileSync(join(repo, "evidence", "qa.md"), "unformatted   proof\n");
  assert.equal(git(["status", "--porcelain"]).trim(), "");

  // Idempotent: a project that already ignores evidence/ is left untouched.
  assert.equal(ensureEvidenceIgnored({ worktree: repo, branch: "factory/x", git: runGit }), false);
});
