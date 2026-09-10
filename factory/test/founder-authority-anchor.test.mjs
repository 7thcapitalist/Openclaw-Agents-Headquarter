// The approval gate's trust root (FCT-P0-04 follow-on).
//
// Independent review demonstrated, by execution, that an actor able to WRITE
// task state could swap `founderApprovalAuthority` for its own key, restate the
// v2 fingerprint, sign with its own private key, and walk a high-risk task past
// the gate. The fingerprint "binding" compared two fields in the same file the
// attacker controlled.
//
// The fix: when the deployment has an external anchor — the enrolled key file
// or FACTORY_FOUNDER_PUBLIC_KEY — verification uses THAT key, and a task whose
// recorded authority disagrees is refused as tampering.

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  completeStage,
  createState,
  evidenceSha256,
  founderApprovalPayload,
  founderApprovalStatus,
  hasValidFounderApproval,
  recordFounderApproval,
  resumeState,
  unsignedFounderAssertion,
} from "../lib/task-workflow.mjs";
import {
  authorityForVerification,
  enrolledKeyPath,
  fingerprintOf,
  resolveTrustedFounderAuthority,
} from "../lib/founder-authority.mjs";

const task = {
  id: "issue-42",
  outcome: "Ship it",
  acceptanceCriteria: ["It works"],
  project: "demo",
  workType: "backend",
  risk: "high",
  issue: "https://example.com/issues/42",
};

function newKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

// An HQ root with a real enrolled key file — the anchor a live deployment has.
function hqRootWithEnrolledKey(publicKeyPem) {
  const root = mkdtempSync(join(tmpdir(), "hq-anchor-"));
  const path = enrolledKeyPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, publicKeyPem, { mode: 0o600 });
  return root;
}

function blockedTask(publicKeyPem) {
  const worktree = mkdtempSync(join(tmpdir(), "hq-anchor-wt-"));
  mkdirSync(join(worktree, "evidence"), { recursive: true });
  for (const stage of ["product", "architect"]) {
    writeFileSync(join(worktree, "evidence", `${stage}.md`), `${stage}\n`);
  }
  writeFileSync(join(worktree, "evidence", "approval.md"), "approved\n");

  let state = createState({ task, repo: "/tmp/repo", branch: "factory/issue-42", worktree, founderPublicKey: publicKeyPem });
  for (const stage of ["product", "architect"]) {
    state = completeStage(state, {
      stage,
      actor: state.assignments[stage],
      outcome: "pass",
      summary: `${stage} ok`,
      evidence: [{ path: `evidence/${stage}.md` }],
    });
  }
  return { state, worktree, evidence: { path: "evidence/approval.md" } };
}

function signFor(state, worktree, evidence, privateKey) {
  const unsigned = unsignedFounderAssertion(state, {
    approvedAt: new Date().toISOString(),
    evidenceSha256: evidenceSha256(join(worktree, evidence.path)),
  });
  return {
    ...unsigned,
    signature: sign(null, Buffer.from(founderApprovalPayload(state, unsigned)), privateKey).toString("base64"),
  };
}

// The attack, exactly as the reviewer ran it: rewrite the authority in task
// state to a key the attacker holds, and self-sign.
function swapAuthority(state, attackerPublicKeyPem) {
  const tampered = structuredClone(state);
  const fingerprint = fingerprintOf(attackerPublicKeyPem);
  tampered.founderApprovalAuthority = {
    algorithm: "Ed25519",
    publicKey: attackerPublicKeyPem,
    fingerprint,
  };
  tampered.founderApprovalRequest = {
    ...tampered.founderApprovalRequest,
    authorityFingerprint: fingerprint,
  };
  return tampered;
}

// ── the attack is refused when an anchor exists ──────────────────────────────

test("an authority swap is refused when the enrolled key anchors the gate", () => {
  const founder = newKeypair();
  const attacker = newKeypair();
  const hqRoot = hqRootWithEnrolledKey(founder.publicKeyPem);

  const { state, worktree, evidence } = blockedTask(founder.publicKeyPem);
  const tampered = swapAuthority(state, attacker.publicKeyPem);
  const selfSigned = signFor(tampered, worktree, evidence, attacker.privateKey);

  assert.throws(
    () => recordFounderApproval(tampered, { assertion: selfSigned, evidence, authority: { hqRoot } }),
    /does not match the key this deployment trusts/i,
  );

  const withForged = { ...tampered, founderApproval: { assertion: selfSigned, evidence } };
  assert.equal(
    hasValidFounderApproval(withForged, { authority: { hqRoot } }),
    false,
    "a self-signed approval under a swapped key must not satisfy the gate",
  );
  assert.throws(() => resumeState(withForged, undefined, { authority: { hqRoot } }), /founder approval/i);
});

test("an authority swap is refused when the env anchor is configured", () => {
  const founder = newKeypair();
  const attacker = newKeypair();

  const keyFile = join(mkdtempSync(join(tmpdir(), "hq-envkey-")), "founder.pem");
  writeFileSync(keyFile, founder.publicKeyPem, { mode: 0o600 });
  const env = { FACTORY_FOUNDER_PUBLIC_KEY: keyFile };

  const { state, worktree, evidence } = blockedTask(founder.publicKeyPem);
  const tampered = swapAuthority(state, attacker.publicKeyPem);
  const selfSigned = signFor(tampered, worktree, evidence, attacker.privateKey);

  assert.throws(
    () => recordFounderApproval(tampered, { assertion: selfSigned, evidence, authority: { env } }),
    /does not match the key this deployment trusts/i,
  );
});

test("the real founder key still works through the anchor", () => {
  const founder = newKeypair();
  const hqRoot = hqRootWithEnrolledKey(founder.publicKeyPem);
  const { state, worktree, evidence } = blockedTask(founder.publicKeyPem);

  const genuine = signFor(state, worktree, evidence, founder.privateKey);
  const approved = recordFounderApproval(state, { assertion: genuine, evidence, authority: { hqRoot } });

  assert.equal(approved.status, "active");
  assert.equal(hasValidFounderApproval(approved, { authority: { hqRoot } }), true);

  const status = founderApprovalStatus(approved, undefined, { authority: { hqRoot } });
  assert.equal(status.satisfied, true);
  assert.equal(status.anchored, true);
  assert.equal(status.authoritySource, "enrolled");
});

test("a signature from the anchored key is refused if the task was re-pointed elsewhere", () => {
  // The inverse tampering: keep the founder's own signature, but point the task
  // at a different authority so a later swap looks consistent.
  const founder = newKeypair();
  const other = newKeypair();
  const hqRoot = hqRootWithEnrolledKey(founder.publicKeyPem);

  const { state, worktree, evidence } = blockedTask(other.publicKeyPem);
  const signed = signFor(state, worktree, evidence, other.privateKey);

  assert.throws(
    () => recordFounderApproval(state, { assertion: signed, evidence, authority: { hqRoot } }),
    /does not match the key this deployment trusts/i,
  );
});

// ── anchoring is reported honestly when absent ───────────────────────────────

test("with no anchor configured the weaker posture is visible, not hidden", () => {
  const founder = newKeypair();
  const { state } = blockedTask(founder.publicKeyPem);

  // No hqRoot, and an env with no key path.
  const authority = authorityForVerification(state, { env: {} });
  assert.equal(authority.anchored, false);
  assert.equal(authority.source, "task-state");

  const status = founderApprovalStatus(state, undefined, { authority: { env: {} } });
  assert.equal(status.anchored, false, "an unanchored gate must say so");
});

test("resolveTrustedFounderAuthority prefers injected, then enrolled, then env", () => {
  const a = newKeypair();
  const b = newKeypair();
  const c = newKeypair();

  const hqRoot = hqRootWithEnrolledKey(b.publicKeyPem);
  const envFile = join(mkdtempSync(join(tmpdir(), "hq-env-")), "k.pem");
  writeFileSync(envFile, c.publicKeyPem);
  const env = { FACTORY_FOUNDER_PUBLIC_KEY: envFile };

  assert.equal(
    resolveTrustedFounderAuthority({ injected: a.publicKeyPem, hqRoot, env }).fingerprint,
    fingerprintOf(a.publicKeyPem),
  );
  assert.equal(resolveTrustedFounderAuthority({ hqRoot, env }).source, "enrolled");
  assert.equal(resolveTrustedFounderAuthority({ env }).source, "env");
  assert.equal(resolveTrustedFounderAuthority({ env: {} }), null);
});

test("a malformed or non-Ed25519 anchor is ignored rather than crashing the gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "hq-badkey-"));
  const junk = join(dir, "junk.pem");
  writeFileSync(junk, "not a key at all\n");
  assert.equal(resolveTrustedFounderAuthority({ env: { FACTORY_FOUNDER_PUBLIC_KEY: junk } }), null);

  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaFile = join(dir, "rsa.pem");
  writeFileSync(rsaFile, rsa.publicKey.export({ type: "spki", format: "pem" }).toString());
  assert.equal(
    resolveTrustedFounderAuthority({ env: { FACTORY_FOUNDER_PUBLIC_KEY: rsaFile } }),
    null,
    "only Ed25519 may anchor the gate",
  );

  assert.equal(resolveTrustedFounderAuthority({ env: { FACTORY_FOUNDER_PUBLIC_KEY: "/no/such/file" } }), null);
});
