// Commit-bound evidence manifests (FCT-P0-05).
//
// The question every test here asks: can a stage claim an acceptance criterion
// is satisfied without having actually established it? The old gate only
// checked that a non-empty file existed inside the worktree, so writing "all
// tests passed" into a text file was enough.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assignCriterionIds,
  criterionId,
  criteriaForState,
  stageMustProveCriteria,
} from "../lib/evidence-criteria.mjs";
import {
  EVIDENCE_MANIFEST_VERSION,
  buildManifest,
  describeArtifact,
  resolveContainedPath,
  summarizeManifest,
  verifyManifest,
} from "../lib/evidence-manifest.mjs";

// ── fixture ──────────────────────────────────────────────────────────────────

function fixture({ criteria = ["The endpoint returns 200", "The suite passes"] } = {}) {
  const worktree = mkdtempSync(join(tmpdir(), "hq-evidence-"));
  mkdirSync(join(worktree, "evidence"), { recursive: true });
  const state = {
    task: { id: "issue-42", acceptanceCriteria: criteria, project: "demo" },
    worktree,
    repo: "/tmp/repo",
    branch: "factory/issue-42",
  };
  return { state, worktree };
}

function writeArtifact(worktree, rel, contents = "ok\n") {
  const abs = join(worktree, rel);
  mkdirSync(join(abs, "..").replace(/\/\.\.$/, ""), { recursive: true });
  writeFileSync(abs, contents);
  return abs;
}

const DISPATCH = "dispatch-1";
const COMMIT = "a".repeat(40);

// A well-formed passing manifest: the factory observed a successful test run.
function goodManifest(state, overrides = {}) {
  const criteria = criteriaForState(state);
  return buildManifest(state, {
    stage: "qa",
    actor: "qa",
    dispatchId: DISPATCH,
    attempt: 1,
    commitSha: COMMIT,
    artifacts: [
      {
        id: "test-run",
        path: "evidence/qa.log",
        type: "command-output",
        command: "npm test",
        exitStatus: 0,
        observed: true,
      },
    ],
    criteriaProofs: criteria.map((c) => ({
      id: c.id,
      status: "proven",
      kind: "independently-verified",
      artifacts: ["test-run"],
    })),
    ...overrides,
  });
}

// ── criterion identity ───────────────────────────────────────────────────────

test("criterion ids are stable across formatting but change with wording", () => {
  const a = criterionId("The endpoint returns 200");
  assert.equal(a, criterionId("  the   ENDPOINT returns 200 \n"), "formatting must not churn the id");
  assert.notEqual(a, criterionId("The endpoint returns 201"), "a wording change must change the id");
});

test("criterion ids do not depend on position", () => {
  const first = assignCriterionIds(["alpha", "beta"]);
  const swapped = assignCriterionIds(["beta", "alpha"]);
  assert.equal(first[0].id, swapped[1].id);
  assert.equal(first[1].id, swapped[0].id);
});

test("duplicate criteria stay distinct so one proof cannot satisfy both", () => {
  const ids = assignCriterionIds(["same", "same"]).map((c) => c.id);
  assert.notEqual(ids[0], ids[1]);
});

test("only verification stages must account for criteria", () => {
  assert.equal(stageMustProveCriteria("qa"), true);
  assert.equal(stageMustProveCriteria("security"), true);
  assert.equal(stageMustProveCriteria("reviewer"), true);
  assert.equal(stageMustProveCriteria("builder"), false);
  assert.equal(stageMustProveCriteria("product"), false);
});

// ── the fabrication that used to work ────────────────────────────────────────

test("a fabricated text file cannot prove a test passed", () => {
  const { state, worktree } = fixture();
  writeArtifact(worktree, "evidence/qa.log", "All tests passed! 100% success!\n");
  const criteria = criteriaForState(state);

  // The agent writes a convincing log and claims the criteria are proven — but
  // nothing observed an exit status.
  const manifest = buildManifest(state, {
    stage: "qa",
    actor: "qa",
    dispatchId: DISPATCH,
    commitSha: COMMIT,
    artifacts: [{ id: "log", path: "evidence/qa.log", type: "command-output", command: "npm test", observed: false }],
    criteriaProofs: criteria.map((c) => ({ id: c.id, status: "proven", kind: "observed", artifacts: ["log"] })),
  });

  const result = verifyManifest(state, manifest, { stage: "qa", dispatchId: DISPATCH, commitSha: COMMIT });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => /never observed by the factory/.test(e)),
    `expected an unobserved-exit-status error, got ${JSON.stringify(result.errors)}`,
  );
});

test("an agent assertion cannot prove a criterion", () => {
  const { state, worktree } = fixture();
  writeArtifact(worktree, "evidence/qa.log");
  const criteria = criteriaForState(state);

  const manifest = buildManifest(state, {
    stage: "qa",
    actor: "qa",
    dispatchId: DISPATCH,
    commitSha: COMMIT,
    artifacts: [{ id: "log", path: "evidence/qa.log", type: "report" }],
    criteriaProofs: criteria.map((c) => ({ id: c.id, status: "proven", kind: "asserted", artifacts: ["log"] })),
  });

  const result = verifyManifest(state, manifest, { stage: "qa", dispatchId: DISPATCH, commitSha: COMMIT });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /agent assertion/.test(e)));
});

test("a non-zero exit status cannot prove a criterion", () => {
  const { state, worktree } = fixture();
  writeArtifact(worktree, "evidence/qa.log", "1 test failed\n");
  const criteria = criteriaForState(state);

  const manifest = buildManifest(state, {
    stage: "qa",
    actor: "qa",
    dispatchId: DISPATCH,
    commitSha: COMMIT,
    artifacts: [{ id: "log", path: "evidence/qa.log", type: "command-output", exitStatus: 1, observed: true }],
    criteriaProofs: criteria.map((c) => ({ id: c.id, status: "proven", kind: "observed", artifacts: ["log"] })),
  });

  const result = verifyManifest(state, manifest, { stage: "qa", dispatchId: DISPATCH, commitSha: COMMIT });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /exited 1/.test(e)));
});

// ── the happy path ───────────────────────────────────────────────────────────

test("observed, independently verified evidence passes", () => {
  const { state, worktree } = fixture();
  writeArtifact(worktree, "evidence/qa.log", "3 passing\n");
  const manifest = goodManifest(state);

  const result = verifyManifest(state, manifest, { stage: "qa", dispatchId: DISPATCH, attempt: 1, commitSha: COMMIT });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(manifest.version, EVIDENCE_MANIFEST_VERSION);
});

test("legitimate manual/UI evidence is accepted", () => {
  const { state, worktree } = fixture({ criteria: ["The button is visible on mobile"] });
  writeArtifact(worktree, "evidence/shot.png", "PNGDATA");
  const criteria = criteriaForState(state);

  const manifest = buildManifest(state, {
    stage: "qa",
    actor: "qa",
    dispatchId: DISPATCH,
    commitSha: COMMIT,
    artifacts: [{ id: "shot", path: "evidence/shot.png", type: "screenshot", scenario: "375px viewport" }],
    criteriaProofs: [{ id: criteria[0].id, status: "proven", kind: "independently-verified", artifacts: ["shot"] }],
  });

  const result = verifyManifest(state, manifest, { stage: "qa", dispatchId: DISPATCH, commitSha: COMMIT });
  assert.deepEqual(result.errors, []);
});

// ── binding ──────────────────────────────────────────────────────────────────

test("evidence from another dispatch, stage, task or attempt is rejected", () => {
  const { state, worktree } = fixture();
  writeArtifact(worktree, "evidence/qa.log");
  const manifest = goodManifest(state);

  const wrongDispatch = verifyManifest(state, manifest, { stage: "qa", dispatchId: "dispatch-2", commitSha: COMMIT });
  assert.ok(wrongDispatch.errors.some((e) => /belongs to dispatch/.test(e)));

  const wrongStage = verifyManifest(state, manifest, { stage: "security", dispatchId: DISPATCH, commitSha: COMMIT });
  assert.ok(wrongStage.errors.some((e) => /created for stage/.test(e)));

  const wrongAttempt = verifyManifest(state, manifest, { stage: "qa", dispatchId: DISPATCH, attempt: 2, commitSha: COMMIT });
  assert.ok(wrongAttempt.errors.some((e) => /from attempt/.test(e)));

  const otherTask = { ...state, task: { ...state.task, id: "issue-99" } };
  const wrongTask = verifyManifest(otherTask, manifest, { stage: "qa", dispatchId: DISPATCH, commitSha: COMMIT });
  assert.ok(wrongTask.errors.some((e) => /created for task/.test(e)));
});

test("changing the source after QA invalidates the evidence", () => {
  const { state, worktree } = fixture();
  writeArtifact(worktree, "evidence/qa.log");
  const manifest = goodManifest(state);

  // QA passed against COMMIT; the builder then pushed a new commit.
  const newCommit = "b".repeat(40);
  const result = verifyManifest(state, manifest, { stage: "qa", dispatchId: DISPATCH, commitSha: newCommit });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /but the tree is now/.test(e)));
});

test("evidence with no recorded commit cannot be tied to the reviewed tree", () => {
  const { state, worktree } = fixture();
  writeArtifact(worktree, "evidence/qa.log");
  const manifest = goodManifest(state, { commitSha: null });

  const result = verifyManifest(state, manifest, { stage: "qa", dispatchId: DISPATCH, commitSha: COMMIT });
  assert.ok(result.errors.some((e) => /records no commit/.test(e)));
});

// ── tampering ────────────────────────────────────────────────────────────────

test("an artifact modified after recording is detected", () => {
  const { state, worktree } = fixture();
  writeArtifact(worktree, "evidence/qa.log", "3 passing\n");
  const manifest = goodManifest(state);

  // Same length, different bytes — size alone would not catch this.
  writeFileSync(join(worktree, "evidence/qa.log"), "0 passing\n");

  const result = verifyManifest(state, manifest, { stage: "qa", dispatchId: DISPATCH, commitSha: COMMIT });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /modified after it was recorded/.test(e)));
});

test("a deleted artifact is detected", () => {
  const { state, worktree } = fixture();
  writeArtifact(worktree, "evidence/qa.log");
  const manifest = goodManifest(state);
  writeFileSync(join(worktree, "evidence/qa.log"), "");

  const result = verifyManifest(state, manifest, { stage: "qa", dispatchId: DISPATCH, commitSha: COMMIT });
  assert.equal(result.ok, false);
});

// ── criterion coverage ───────────────────────────────────────────────────────

test("one stage may prove a subset; completeness is the release gate's question", () => {
  // QA proves behaviour, security proves its own criteria. Demanding that each
  // stage account for ALL criteria would force every stage to restate the
  // others' work, so the manifest records what THIS stage established and
  // assertReleaseReady() sums them up across stages.
  const { state, worktree } = fixture();
  writeArtifact(worktree, "evidence/qa.log");
  const criteria = criteriaForState(state);

  const manifest = buildManifest(state, {
    stage: "qa",
    actor: "qa",
    dispatchId: DISPATCH,
    commitSha: COMMIT,
    artifacts: [{ id: "log", path: "evidence/qa.log", type: "command-output", exitStatus: 0, observed: true }],
    // Only the first criterion is addressed here.
    criteriaProofs: [{ id: criteria[0].id, status: "proven", kind: "observed", artifacts: ["log"] }],
  });

  assert.equal(manifest.criteria.length, 1);
  assert.equal(manifest.criteria[0].id, criteria[0].id);
  // And it is still a valid manifest on its own terms.
  const result = verifyManifest(state, manifest, { stage: "qa", dispatchId: DISPATCH, commitSha: COMMIT });
  assert.deepEqual(result.errors, []);
});

test("a criterion may be explicitly blocked, but must say why", () => {
  const { state, worktree } = fixture();
  writeArtifact(worktree, "evidence/qa.log");
  const criteria = criteriaForState(state);

  const base = {
    stage: "qa",
    actor: "qa",
    dispatchId: DISPATCH,
    commitSha: COMMIT,
    artifacts: [{ id: "log", path: "evidence/qa.log", type: "command-output", exitStatus: 0, observed: true }],
  };

  assert.throws(
    () => buildManifest(state, {
      ...base,
      criteriaProofs: [
        { id: criteria[0].id, status: "proven", kind: "observed", artifacts: ["log"] },
        { id: criteria[1].id, status: "blocked" },
      ],
    }),
    /must say why/,
  );

  const ok = buildManifest(state, {
    ...base,
    criteriaProofs: [
      { id: criteria[0].id, status: "proven", kind: "observed", artifacts: ["log"] },
      { id: criteria[1].id, status: "blocked", note: "Staging environment unavailable." },
    ],
  });
  assert.equal(ok.criteria[1].status, "blocked");
});

test("a proof for an unknown criterion is refused", () => {
  const { state, worktree } = fixture();
  writeArtifact(worktree, "evidence/qa.log");
  assert.throws(
    () => buildManifest(state, {
      stage: "builder",
      actor: "codex",
      dispatchId: DISPATCH,
      commitSha: COMMIT,
      artifacts: [{ id: "log", path: "evidence/qa.log" }],
      criteriaProofs: [{ id: "AC-deadbeef01", status: "proven", artifacts: ["log"] }],
    }),
    /unknown acceptance criterion/,
  );
});

test("a criterion citing an unknown artifact is refused", () => {
  const { state, worktree } = fixture();
  writeArtifact(worktree, "evidence/qa.log");
  const criteria = criteriaForState(state);
  assert.throws(
    () => buildManifest(state, {
      stage: "builder",
      actor: "codex",
      dispatchId: DISPATCH,
      commitSha: COMMIT,
      artifacts: [{ id: "log", path: "evidence/qa.log" }],
      criteriaProofs: [{ id: criteria[0].id, status: "proven", artifacts: ["nope"] }],
    }),
    /cites unknown artifact/,
  );
});

// ── containment ──────────────────────────────────────────────────────────────

test("evidence cannot escape the worktree", () => {
  const { state, worktree } = fixture();
  assert.throws(() => resolveContainedPath(worktree, "../outside.txt"), /escapes worktree/);
  assert.throws(() => resolveContainedPath(worktree, "/etc/passwd"), /escapes worktree/);
  assert.throws(
    () => describeArtifact(state.worktree, { path: "../../etc/passwd" }),
    /escapes worktree/,
  );
});

test("a manifest never carries an executable instruction the factory would run", () => {
  const { state, worktree } = fixture();
  writeArtifact(worktree, "evidence/qa.log");
  const manifest = goodManifest(state);
  // The command is recorded as text for a human to read, and nothing more.
  assert.equal(typeof manifest.artifacts[0].command, "string");
  assert.equal(manifest.artifacts[0].command, "npm test");
});

test("a bogus exit status is rejected at build time", () => {
  const { state, worktree } = fixture();
  writeArtifact(worktree, "evidence/qa.log");
  assert.throws(
    () => describeArtifact(worktree, { path: "evidence/qa.log", exitStatus: "0; rm -rf /" }),
    /exit status must be an integer/,
  );
});

// ── reporting ────────────────────────────────────────────────────────────────

test("the summary separates asserted from independently verified", () => {
  const { state, worktree } = fixture();
  writeArtifact(worktree, "evidence/qa.log");
  const summary = summarizeManifest(goodManifest(state));

  assert.equal(summary.proven, 2);
  assert.equal(summary.independentlyVerified, 2);
  assert.equal(summary.asserted, 0);
  assert.equal(summary.observedCommands, 1);
  assert.equal(summary.commitSha, COMMIT);
});

test("an unsupported manifest version is refused rather than guessed at", () => {
  const { state } = fixture();
  const result = verifyManifest(state, { version: 99, taskId: "issue-42" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /Unsupported evidence manifest version/.test(e)));
});
