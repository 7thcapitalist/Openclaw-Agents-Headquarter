// The evidence ENFORCEMENT half (FCT-P0-05).
//
// Adversarial QA found the library was sound and the gate was dead code: an
// initialization-ordering bug put every real task on the `legacy` policy, so
// none of assertReleaseReady's new checks ran in production, and not one
// enforcement export had a test. The suite stayed green through all of it.
//
// These tests cover the gate itself.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EVIDENCE_POLICY_STRONG,
  assertReleaseReady,
  completeStage,
  createState,
  currentHeadSha,
  evidenceLedger,
  evidencePolicyOf,
  evidenceStrengthOf,
  excusedCriteria,
  recordVerifiedCommit,
  unprovenCriteria,
} from "../lib/task-workflow.mjs";
import { buildManifest, resolveContainedPath } from "../lib/evidence-manifest.mjs";
import { criteriaForState } from "../lib/evidence-criteria.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

// A real git repo, because the policy now depends on one.
function realRepo() {
  const repo = mkdtempSync(join(tmpdir(), "hq-gate-repo-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "T"]);
  writeFileSync(join(repo, "README.md"), "seed\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "seed"]);
  return repo;
}

const task = {
  id: "issue-42",
  outcome: "Ship it",
  acceptanceCriteria: ["The endpoint returns 200", "The suite passes"],
  project: "demo",
  workType: "backend",
  risk: "low",
  issue: "1",
};

function seededState() {
  const repo = realRepo();
  const worktree = mkdtempSync(join(tmpdir(), "hq-gate-wt-"));
  // Make the worktree a checkout of its own so HEAD is readable.
  git(worktree, ["init", "-q", "-b", "main"]);
  git(worktree, ["config", "user.email", "t@example.com"]);
  git(worktree, ["config", "user.name", "T"]);
  mkdirSync(join(worktree, "evidence"), { recursive: true });
  writeFileSync(join(worktree, "seed.txt"), "1\n");
  git(worktree, ["add", "-A"]);
  git(worktree, ["commit", "-qm", "one"]);

  const state = createState({ task, repo, branch: "factory/issue-42", worktree });
  return { state, repo, worktree };
}

function evidenceFor(worktree, stage) {
  const rel = `evidence/${stage}.md`;
  writeFileSync(join(worktree, rel), `${stage} evidence\n`);
  return [{ path: rel }];
}

// Drive every stage to release, freezing the commit after the builder the way
// the protocol does.
function driveToRelease(state, worktree, { freeze = true } = {}) {
  let s = state;
  for (const stage of ["product", "architect", "builder", "reviewer", "qa", "security"]) {
    s = completeStage(s, {
      stage,
      actor: s.assignments[stage],
      outcome: "pass",
      summary: `${stage} ok`,
      evidence: evidenceFor(worktree, stage),
    });
    if (stage === "builder" && freeze) {
      s = recordVerifiedCommit(s, { sha: currentHeadSha(worktree) });
    }
  }
  // Mark release passed WITHOUT going through completeStage, which would call
  // assertReleaseReady itself. These tests call the gate directly so they can
  // assert on its specific refusal rather than on a generic stage error.
  const rel = evidenceFor(worktree, "release");
  s.stages.release = { status: "pass", actor: s.assignments.release, summary: "release ok", evidence: rel };
  return s;
}

// ── C1: the policy must actually be strong for a real task ───────────────────

test("C1: a task in a git repo is created with the strong evidence policy", () => {
  const repo = realRepo();
  // The worktree does NOT exist yet — initializeTask creates it only after
  // createState, which is exactly what made the old worktree probe always fail.
  const worktree = join(tmpdir(), `hq-not-created-yet-${Date.now()}`);
  const state = createState({ task, repo, branch: "factory/issue-42", worktree });

  assert.equal(state.evidencePolicy, EVIDENCE_POLICY_STRONG);
  assert.equal(evidencePolicyOf(state), EVIDENCE_POLICY_STRONG);
});

test("C1: a task with no git repo stays legacy rather than demanding the impossible", () => {
  const bare = mkdtempSync(join(tmpdir(), "hq-nogit-"));
  const state = createState({ task, repo: bare, branch: "factory/issue-42", worktree: join(bare, "wt") });
  assert.equal(evidencePolicyOf(state), "legacy");
});

test("C1: the strong gate actually runs — no manifests means no release", () => {
  const { state, worktree } = seededState();
  let s = driveToRelease(state, worktree, { freeze: true });
  // Strip the manifests the workflow built, simulating the old weak world.
  for (const stage of ["reviewer", "qa", "security"]) delete s.stages[stage].manifest;

  assert.throws(() => assertReleaseReady(s), /has no commit-bound evidence manifest/);
});

test("C1: deleting the verified commit does not open a way through", () => {
  const { state, worktree } = seededState();
  const s = driveToRelease(state, worktree, { freeze: true });
  delete s.verifiedCommit;
  assert.throws(() => assertReleaseReady(s), /no verified commit was recorded/);
});

test("C1: a task that never froze a commit cannot release", () => {
  const { state, worktree } = seededState();
  const s = driveToRelease(state, worktree, { freeze: false });
  assert.throws(() => assertReleaseReady(s), /no verified commit was recorded/);
});

// ── C2: a commit landing after QA must be caught AT the gate ─────────────────

test("C2: code committed after the reviewers signed off blocks release", () => {
  const { state, worktree } = seededState();
  const s = driveToRelease(state, worktree, { freeze: true });

  // Clean run releases.
  assert.doesNotThrow(() => assertReleaseReady(s));

  // Now a backdoor lands after every reviewer has passed.
  writeFileSync(join(worktree, "backdoor.js"), "require('child_process').execSync('id');\n");
  git(worktree, ["add", "-A"]);
  git(worktree, ["commit", "-qm", "sneak"]);

  assert.throws(
    () => assertReleaseReady(s),
    /worktree has moved to .* since the reviewed commit/,
    "a post-QA commit must be caught by re-reading HEAD, not by comparing two frozen values",
  );
});

test("C2: currentHeadSha reads the tree now, and tolerates a non-repo", () => {
  const { worktree } = seededState();
  const head = currentHeadSha(worktree);
  assert.match(head, /^[0-9a-f]{40}$/);

  git(worktree, ["commit", "-qm", "two", "--allow-empty"]);
  assert.notEqual(currentHeadSha(worktree), head, "it must re-read, not cache");

  assert.equal(currentHeadSha(mkdtempSync(join(tmpdir(), "hq-norepo-"))), null);
});

// ── H1: symlinked evidence must not escape the worktree ──────────────────────

test("H1: a symlink pointing outside the worktree is refused", () => {
  const worktree = mkdtempSync(join(tmpdir(), "hq-sym-"));
  mkdirSync(join(worktree, "evidence"), { recursive: true });

  const outside = mkdtempSync(join(tmpdir(), "hq-outside-"));
  const secret = join(outside, "secret.txt");
  writeFileSync(secret, "founder private key material\n");
  symlinkSync(secret, join(worktree, "evidence", "leak.txt"));

  assert.throws(
    () => resolveContainedPath(worktree, "evidence/leak.txt"),
    /escapes worktree via a symlink/,
  );

  // A symlinked DIRECTORY is the same escape by another route.
  symlinkSync(outside, join(worktree, "evidence", "dir"));
  assert.throws(() => resolveContainedPath(worktree, "evidence/dir/secret.txt"), /escapes worktree/);
});

test("H1: an ordinary file and an internal symlink still work", () => {
  const worktree = mkdtempSync(join(tmpdir(), "hq-sym-ok-"));
  mkdirSync(join(worktree, "evidence"), { recursive: true });
  writeFileSync(join(worktree, "evidence", "real.md"), "x\n");
  assert.ok(resolveContainedPath(worktree, "evidence/real.md"));

  symlinkSync(join(worktree, "evidence", "real.md"), join(worktree, "evidence", "alias.md"));
  assert.ok(resolveContainedPath(worktree, "evidence/alias.md"), "an in-worktree symlink is fine");
});

// ── H2: `not-applicable` must not settle a criterion on an agent's say-so ────

test("H2: declaring every criterion not-applicable does not satisfy coverage", () => {
  const { state, worktree } = seededState();
  const criteria = criteriaForState(state);
  writeFileSync(join(worktree, "evidence", "qa.md"), "x\n");

  const s = structuredClone(state);
  s.stages.qa = {
    status: "pass",
    manifest: buildManifest(s, {
      stage: "qa",
      actor: "claude",
      dispatchId: "d-1",
      artifacts: [{ id: "a", path: "evidence/qa.md" }],
      criteriaProofs: criteria.map((c) => ({ id: c.id, status: "not-applicable", note: "n/a per agent" })),
    }),
  };

  const outstanding = unprovenCriteria(s).map((c) => c.id);
  assert.deepEqual(outstanding.sort(), criteria.map((c) => c.id).sort(), "N/A is a scope call, not a proof");

  // It is still reported, not discarded.
  assert.equal(excusedCriteria(s).length, criteria.length);
  assert.equal(excusedCriteria(s)[0].note, "n/a per agent");
});

test("H2: an asserted 'proven' claim does not settle a criterion either", () => {
  const { state, worktree } = seededState();
  const criteria = criteriaForState(state);
  writeFileSync(join(worktree, "evidence", "qa.md"), "x\n");

  const s = structuredClone(state);
  s.stages.qa = {
    status: "pass",
    manifest: buildManifest(s, {
      stage: "qa",
      actor: "claude",
      dispatchId: "d-1",
      artifacts: [{ id: "a", path: "evidence/qa.md" }],
      criteriaProofs: criteria.map((c) => ({ id: c.id, status: "proven", kind: "asserted", artifacts: ["a"] })),
    }),
  };
  assert.equal(unprovenCriteria(s).length, criteria.length, "unprovenCriteria must agree with verifyManifest");
});

// ── H3: dispatch binding must not compare a value to itself ──────────────────

test("H3: a manifest from another dispatch is refused, not self-satisfied", () => {
  const { state, worktree } = seededState();
  writeFileSync(join(worktree, "evidence", "product.md"), "x\n");

  const alien = buildManifest(state, {
    stage: "product",
    actor: state.assignments.product,
    dispatchId: "SOME-OTHER-DISPATCH",
    attempt: 99,
    artifacts: [{ id: "a", path: "evidence/product.md" }],
  });

  assert.throws(
    () => completeStage(state, {
      stage: "product",
      actor: state.assignments.product,
      outcome: "pass",
      summary: "ok",
      evidence: [{ path: "evidence/product.md" }],
      manifest: alien,
      dispatchId: "d-real",
    }),
    /belongs to dispatch SOME-OTHER-DISPATCH/,
  );
});

test("H3: a manifest with no caller-supplied dispatch id is refused", () => {
  const { state, worktree } = seededState();
  writeFileSync(join(worktree, "evidence", "product.md"), "x\n");
  const m = buildManifest(state, {
    stage: "product",
    actor: state.assignments.product,
    dispatchId: "d-whatever",
    artifacts: [{ id: "a", path: "evidence/product.md" }],
  });

  assert.throws(
    () => completeStage(state, {
      stage: "product",
      actor: state.assignments.product,
      outcome: "pass",
      summary: "ok",
      evidence: [{ path: "evidence/product.md" }],
      manifest: m,
      // no dispatchId
    }),
    /did not say which dispatch is completing/,
  );
});

// ── M3: duplicate artifact ids ───────────────────────────────────────────────

test("M3: duplicate artifact ids are refused so nothing can shadow a failure", () => {
  const { state, worktree } = seededState();
  writeFileSync(join(worktree, "evidence", "a.log"), "A\n");
  writeFileSync(join(worktree, "evidence", "b.log"), "B\n");

  assert.throws(
    () => buildManifest(state, {
      stage: "qa",
      actor: "claude",
      dispatchId: "d-1",
      artifacts: [
        { id: "run", path: "evidence/a.log", type: "screenshot" },
        { id: "run", path: "evidence/b.log", type: "command-output", exitStatus: 1, observed: true },
      ],
    }),
    /Duplicate evidence artifact id/,
  );
});

// ── the ledger reports honestly ──────────────────────────────────────────────

test("the ledger distinguishes asserted from verified", () => {
  const { state, worktree } = seededState();
  const s = driveToRelease(state, worktree, { freeze: true });
  const ledger = evidenceLedger(s);

  const qa = ledger.find((e) => e.stage === "qa");
  assert.equal(qa.status, "pass");
  // No observed proofs were supplied, so it must NOT read as verified.
  assert.equal(qa.strength, "asserted");
  assert.equal(evidenceStrengthOf(s, "qa"), "asserted");
  // Nothing anywhere reads as `verified` without observed proofs.
  assert.ok(!ledger.some((e) => e.strength === "verified"), JSON.stringify(ledger));
});
