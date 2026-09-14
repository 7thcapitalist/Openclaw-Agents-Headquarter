// The high-risk founder authority gate (FCT-P0-04).
//
// Everything here asks one question: can something other than a fresh, valid,
// task-scoped Ed25519 signature from the enrolled authority move a high-risk
// task past `builder`? The answer must be no, for every variation.

import test from "node:test";
import { anchorFounderKey, detachAmbientAnchor } from "./helpers/anchor.mjs";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FOUNDER_APPROVAL_VERSION,
  completeStage,
  createState,
  evidenceSha256,
  founderApprovalPayload,
  hasValidFounderApproval,
  isAwaitingFounderApproval,
  recordFounderApproval,
  resumeState,
  revokeFounderApprovalKey,
  unsignedFounderAssertion,
} from "../lib/task-workflow.mjs";

// This suite reasons about roots it creates, not about the checkout it happens
// to run inside — see detachAmbientAnchor's own comment for what that cost.
detachAmbientAnchor();

const task = {
  id: "issue-42",
  outcome: "Ship the thing",
  acceptanceCriteria: ["It works"],
  project: "demo",
  workType: "backend",
  risk: "high",
  issue: "https://github.com/example/repo/issues/42",
};

function newKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function completion(stage, actor) {
  return { stage, actor, outcome: "pass", summary: `${stage} ok`, evidence: [{ path: `evidence/${stage}.md` }] };
}

// Build a high-risk task parked at the gate, with evidence on disk.
function blockedTask({ publicKeyPem, evidenceText = "Founder approved.\n" } = {}) {
  // The gate fails closed without a key vouched for outside task state, so a
  // test that drives the approval path must configure one, as a deployment does.
  anchorFounderKey(publicKeyPem);
  const worktree = mkdtempSync(join(tmpdir(), "hq-gate-"));
  mkdirSync(join(worktree, "evidence"), { recursive: true });
  for (const stage of ["product", "architect"]) {
    writeFileSync(join(worktree, "evidence", `${stage}.md`), `${stage} evidence\n`);
  }
  const evidenceRel = "evidence/approval.md";
  writeFileSync(join(worktree, evidenceRel), evidenceText);

  let state = createState({
    task,
    repo: "/tmp/repo",
    branch: "factory/issue-42",
    worktree,
    founderPublicKey: publicKeyPem,
  });
  state = completeStage(state, completion("product", state.assignments.product));
  state = completeStage(state, completion("architect", state.assignments.architect));
  return { state, worktree, evidence: { path: evidenceRel } };
}

function signAssertion(state, evidenceAbs, privateKey, overrides = {}) {
  const unsigned = {
    ...unsignedFounderAssertion(state, {
      approvedAt: new Date().toISOString(),
      evidenceSha256: evidenceSha256(evidenceAbs),
    }),
    ...overrides,
  };
  const signature = sign(null, Buffer.from(founderApprovalPayload(state, unsigned)), privateKey).toString("base64");
  return { ...unsigned, signature };
}

// ── the happy path still works ───────────────────────────────────────────────

test("a correct signature moves the task past the gate", () => {
  const key = newKeypair();
  const { state, worktree, evidence } = blockedTask({ publicKeyPem: key.publicKeyPem });
  assert.equal(isAwaitingFounderApproval(state), true);

  const assertion = signAssertion(state, join(worktree, evidence.path), key.privateKey);
  const next = recordFounderApproval(state, { assertion, evidence });

  assert.equal(next.status, "active");
  assert.equal(next.currentStage, "builder");
  assert.equal(hasValidFounderApproval(next), true);
});

test("new tasks are issued at the current assertion version", () => {
  const key = newKeypair();
  const { state } = blockedTask({ publicKeyPem: key.publicKeyPem });
  assert.equal(state.founderApprovalRequest.version, FOUNDER_APPROVAL_VERSION);
  // v2 binds the approval authority into the signed bytes.
  assert.ok(state.founderApprovalRequest.authorityFingerprint);
});

// ── tampering ────────────────────────────────────────────────────────────────

test("a changed evidence digest is rejected", () => {
  const key = newKeypair();
  const { state, worktree, evidence } = blockedTask({ publicKeyPem: key.publicKeyPem });
  const assertion = signAssertion(state, join(worktree, evidence.path), key.privateKey);

  // The founder signed one document; a different one is on disk at execution.
  writeFileSync(join(worktree, evidence.path), "Something else entirely.\n");

  assert.throws(() => recordFounderApproval(state, { assertion, evidence }), /evidence digest/i);
});

test("a changed requested action is rejected", () => {
  const key = newKeypair();
  const { state, worktree, evidence } = blockedTask({ publicKeyPem: key.publicKeyPem });
  const assertion = signAssertion(state, join(worktree, evidence.path), key.privateKey, {
    decision: "approve-production-deploy",
  });
  assert.throws(() => recordFounderApproval(state, { assertion, evidence }), /does not match this task challenge/i);
});

test("a cross-task replay is rejected", () => {
  const key = newKeypair();
  const a = blockedTask({ publicKeyPem: key.publicKeyPem });
  const b = blockedTask({ publicKeyPem: key.publicKeyPem });

  const assertionForA = signAssertion(a.state, join(a.worktree, a.evidence.path), key.privateKey);
  // Same key, same everything — except this signature was made for task A's
  // challenge, and B has its own.
  assert.throws(
    () => recordFounderApproval(b.state, { assertion: assertionForA, evidence: b.evidence }),
    /does not match this task challenge/i,
  );
});

test("a malformed signature fails closed instead of throwing a crypto error", () => {
  const key = newKeypair();
  const { state, worktree, evidence } = blockedTask({ publicKeyPem: key.publicKeyPem });

  for (const bad of ["", "not-base64!!", "AAAA", Buffer.alloc(63).toString("base64"), Buffer.alloc(65).toString("base64")]) {
    const assertion = signAssertion(state, join(worktree, evidence.path), key.privateKey);
    assertion.signature = bad;
    assert.throws(
      () => recordFounderApproval(state, { assertion, evidence }),
      /signature is invalid|assertion is incomplete/i,
      `signature ${JSON.stringify(bad)} should be refused`,
    );
  }
});

test("a signature from the wrong key is rejected", () => {
  const enrolled = newKeypair();
  const attacker = newKeypair();
  const { state, worktree, evidence } = blockedTask({ publicKeyPem: enrolled.publicKeyPem });

  const assertion = signAssertion(state, join(worktree, evidence.path), attacker.privateKey);
  assert.throws(() => recordFounderApproval(state, { assertion, evidence }), /signature is invalid/i);
});

// ── expiry and revocation ────────────────────────────────────────────────────

test("an expired approval no longer authorizes the build", () => {
  const key = newKeypair();
  const { state, worktree, evidence } = blockedTask({ publicKeyPem: key.publicKeyPem });
  state.founderApprovalRequest.expiresAfterSeconds = 60;

  const approvedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const assertion = signAssertion(state, join(worktree, evidence.path), key.privateKey, { approvedAt });

  assert.throws(() => recordFounderApproval(state, { assertion, evidence }), /expired/i);
});

test("a future-dated approval is rejected", () => {
  const key = newKeypair();
  const { state, worktree, evidence } = blockedTask({ publicKeyPem: key.publicKeyPem });
  const approvedAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const assertion = signAssertion(state, join(worktree, evidence.path), key.privateKey, { approvedAt });

  assert.throws(() => recordFounderApproval(state, { assertion, evidence }), /future/i);
});

test("an approval that was valid stops verifying once its key is revoked", () => {
  const key = newKeypair();
  const { state, worktree, evidence } = blockedTask({ publicKeyPem: key.publicKeyPem });
  const assertion = signAssertion(state, join(worktree, evidence.path), key.privateKey);

  let approved = recordFounderApproval(state, { assertion, evidence });
  assert.equal(hasValidFounderApproval(approved), true);

  approved = revokeFounderApprovalKey(approved, {
    fingerprint: approved.founderApprovalAuthority.fingerprint,
    reason: "laptop lost",
  });

  assert.equal(hasValidFounderApproval(approved), false, "a revoked key must stop authorizing");
  assert.ok(approved.events.some((e) => e.type === "founder-approval-key-revoked"));
});

// ── downgrade ────────────────────────────────────────────────────────────────

test("a v1 assertion cannot be presented against a v2 request", () => {
  const key = newKeypair();
  const { state, worktree, evidence } = blockedTask({ publicKeyPem: key.publicKeyPem });

  // Strip the authority binding and re-sign as if the older format were still
  // acceptable — a classic downgrade.
  const unsigned = {
    version: 1,
    taskId: state.task.id,
    challenge: state.founderApprovalRequest.challenge,
    decision: "approve-high-risk-build",
    approvedAt: new Date().toISOString(),
    evidenceSha256: evidenceSha256(join(worktree, evidence.path)),
  };
  const payload = JSON.stringify(unsigned);
  const assertion = { ...unsigned, signature: sign(null, Buffer.from(payload), key.privateKey).toString("base64") };

  assert.throws(() => recordFounderApproval(state, { assertion, evidence }), /version mismatch/i);
});

// ── the gate holds the whole pipeline ────────────────────────────────────────

test("an unapproved high-risk task cannot be resumed by any other means", () => {
  const key = newKeypair();
  const { state } = blockedTask({ publicKeyPem: key.publicKeyPem });

  assert.throws(() => resumeState(state), /founder approval/i);

  // Nor by inventing an approval record on the state object.
  const forged = structuredClone(state);
  forged.founderApproval = { assertion: { taskId: task.id }, evidence: { path: "evidence/approval.md" } };
  assert.equal(hasValidFounderApproval(forged), false);
  assert.throws(() => resumeState(forged), /founder approval/i);

  // Nor by claiming a decision authorized it.
  const decided = structuredClone(state);
  decided.founderDecisions = [{ at: new Date().toISOString(), direction: "yes, approve the high-risk build" }];
  assert.equal(hasValidFounderApproval(decided), false);
  assert.throws(() => resumeState(decided), /founder approval/i);
});
