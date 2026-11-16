// A recovery repair that lands a new commit, and a task blocked at release
// because HEAD moved, must re-run review, QA and security on the new commit
// (recordVerifiedCommit) instead of failing release again. assertReleaseReady
// stays exactly as strict: HEAD must equal the commit the gates judged.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertReleaseReady, completeStage, createState, currentHeadSha, recordRecoveryResult,
  recordVerifiedCommit, resumeState, startRecovery,
} from "../lib/task-workflow.mjs";

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const task = { id: "issue-77", outcome: "Ship it", acceptanceCriteria: ["The suite passes"], project: "demo", workType: "backend", risk: "low", issue: "1" };

function setup() {
  const repo = mkdtempSync(join(tmpdir(), "hq-rv-repo-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "T"]);
  writeFileSync(join(repo, "README.md"), "seed\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "seed"]);
  const worktree = mkdtempSync(join(tmpdir(), "hq-rv-wt-"));
  git(worktree, ["init", "-q", "-b", "main"]);
  git(worktree, ["config", "user.email", "t@example.com"]);
  git(worktree, ["config", "user.name", "T"]);
  mkdirSync(join(worktree, "evidence"), { recursive: true });
  writeFileSync(join(worktree, "a.txt"), "A\n");
  git(worktree, ["add", "-A"]);
  git(worktree, ["commit", "-qm", "A"]);
  return { state: createState({ task, repo, branch: "factory/issue-77", worktree }), worktree };
}

const commit = (worktree, name) => {
  writeFileSync(join(worktree, `${name}.txt`), `${name}\n`);
  git(worktree, ["add", "-A"]);
  git(worktree, ["commit", "-qm", name]);
  return currentHeadSha(worktree);
};

function pass(s, worktree, stage) {
  const rel = `evidence/${stage}-${s.dispatches?.length || 0}-${Date.now()}.md`;
  writeFileSync(join(worktree, rel), `${stage}\n`);
  return completeStage(s, { stage, actor: s.assignments[stage], outcome: "pass", summary: `${stage} ok`, evidence: [{ path: rel }] });
}

// Run every gate the way the protocol does, freezing HEAD after the builder.
function runGates(s, worktree, stages) {
  let cur = s;
  for (const stage of stages) {
    cur = pass(cur, worktree, stage);
    if (stage === "builder") cur = recordVerifiedCommit(cur, { sha: currentHeadSha(worktree) });
  }
  return cur;
}

const GATES = ["product", "architect", "builder", "reviewer", "qa", "security"];

// Put a state at "recovery verified" for a failed reviewer-side stage.
function recoveredFrom(s) {
  let r = startRecovery(s, { failedStage: "qa", actor: s.assignments.qa, error: "AssertionError: expected 200 but got 500 in tests" });
  assert.equal(r.recovery.active?.phase, "diagnose", "precondition: recovery started");
  r.recovery.attempts.at(-1).repairTarget = "project";
  r = recordRecoveryResult(r, { outcome: "pass", actor: "recovery", summary: "fixed", evidence: [] });
  assert.equal(r.recovery.active.phase, "verify");
  return r;
}

test("recovery commit B is recorded, gates re-run on B, release passes, every manifest binds B", () => {
  const { state, worktree } = setup();
  let s = runGates(state, worktree, GATES.slice(0, 5)); // through qa
  const A = currentHeadSha(worktree);
  s = recoveredFrom(s);
  const B = commit(worktree, "repair-B");

  const builderPasses = s.dispatches?.length || 0;
  s = recordRecoveryResult(s, { outcome: "pass", actor: "recovery", summary: "verified", evidence: [] });

  assert.equal(s.status, "active");
  assert.equal(s.verifiedCommit.sha, B);
  assert.notEqual(A, B);
  assert.equal(s.currentStage, "reviewer", "gates re-run; the builder is not re-run");
  assert.equal(s.stages.builder.status, "pass");
  for (const stage of ["reviewer", "qa", "security", "release"]) assert.equal(s.stages[stage].status, "pending", stage);
  assert.ok(s.events.some((e) => e.type === "evidence-invalidated" && e.commit === B));
  assert.equal(s.dispatches?.length || 0, builderPasses, "no builder verdict charged");

  for (const stage of ["reviewer", "qa", "security", "release"]) s = pass(s, worktree, stage);
  assert.equal(s.stages.release.status, "pass");
  assert.doesNotThrow(() => assertReleaseReady(s));
  for (const stage of ["reviewer", "qa", "security"]) assert.equal(s.stages[stage].manifest.commitSha, B, `${stage} manifest`);
});

test("release still refuses a HEAD no gate judged", () => {
  const { state, worktree } = setup();
  const s = runGates(state, worktree, GATES);
  const withRelease = { ...s, stages: { ...s.stages, release: { status: "pass", actor: s.assignments.release, summary: "ok", evidence: [{ path: "evidence/security.md" }] } } };
  commit(worktree, "sneaky");
  assert.throws(() => assertReleaseReady(withRelease), /worktree has moved/);
});

// The obj-81994a81-render-plain-founder-events shape: blocked at release, the
// recovery commit was never judged by the reviewer.
test("resume of a task blocked at release with HEAD != verifiedCommit re-verifies HEAD", () => {
  const { state, worktree } = setup();
  let s = runGates(state, worktree, GATES);
  const A = s.verifiedCommit.sha;
  const recovery = commit(worktree, "recovery-ba66472");
  s.status = "blocked";
  s.currentStage = "release";
  s.blocker = { stage: "release", outcome: "fail", summary: "worktree has moved" };

  const resumed = resumeState(s, undefined, {});
  assert.equal(resumed.status, "active");
  assert.equal(resumed.verifiedCommit.sha, recovery);
  assert.notEqual(resumed.verifiedCommit.sha, A);
  assert.equal(resumed.currentStage, "reviewer");
  for (const stage of ["reviewer", "qa", "security", "release"]) assert.equal(resumed.stages[stage].status, "pending", stage);
  assert.equal(resumed.stages.builder.status, "pass");

  let done = resumed;
  for (const stage of ["reviewer", "qa", "security", "release"]) done = pass(done, worktree, stage);
  assert.doesNotThrow(() => assertReleaseReady(done));
  for (const stage of ["reviewer", "qa", "security"]) assert.equal(done.stages[stage].manifest.commitSha, recovery);
});

test("resume at release with HEAD unchanged does not invalidate anything", () => {
  const { state, worktree } = setup();
  const s = runGates(state, worktree, GATES);
  s.status = "blocked";
  s.currentStage = "release";
  s.blocker = { stage: "release", outcome: "fail", summary: "flaky" };
  const resumed = resumeState(s);
  assert.equal(resumed.currentStage, "release");
  assert.equal(resumed.stages.reviewer.status, "pass");
  assert.ok(!resumed.events.some((e) => e.type === "evidence-invalidated"));
});

test("legacy-policy task keeps the old resume behaviour", () => {
  const { state, worktree } = setup();
  let s = runGates(state, worktree, GATES);
  commit(worktree, "moved");
  s.evidencePolicy = "legacy";
  s.status = "blocked";
  s.currentStage = "release";
  s.blocker = { stage: "release", outcome: "fail", summary: "x" };
  const resumed = resumeState(s);
  assert.equal(resumed.currentStage, "release");
  assert.equal(resumed.stages.reviewer.status, "pass");
});
