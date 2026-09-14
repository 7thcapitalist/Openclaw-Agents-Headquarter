// Regressions for the second independent review (of PR #162).
//
// That review proved the anchor introduced in #162 was wired into exactly ONE
// production call path, so the builder gate, the release gate, every resume
// path and all six CLI scripts still trusted the key stored in the task file —
// the original vulnerability, intact. It also found that an unreadable anchor
// silently downgraded the gate, and that the audit refactor had regressed.

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  completeStage,
  createState,
  evidenceSha256,
  founderApprovalPayload,
  hasValidFounderApproval,
  recordFounderApproval,
  unsignedFounderAssertion,
} from "../lib/task-workflow.mjs";
import {
  enrolledKeyPath,
  fingerprintOf,
  resolveTrustedFounderAuthority,
} from "../lib/founder-authority.mjs";
import { redact, redactText } from "../../dashboard/backend/lib/securityAudit.mjs";
import { anchorFounderKey, clearFounderAnchor, detachAmbientAnchor } from "./helpers/anchor.mjs";

// This suite reasons about roots it creates, not about the checkout it happens
// to run inside — see detachAmbientAnchor's own comment for what that cost.
detachAmbientAnchor();

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

function blockedTask(publicKeyPem) {
  const worktree = mkdtempSync(join(tmpdir(), "hq-anchor2-"));
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

function swapAuthority(state, attackerPublicKeyPem) {
  const tampered = structuredClone(state);
  const fingerprint = fingerprintOf(attackerPublicKeyPem);
  tampered.founderApprovalAuthority = { algorithm: "Ed25519", publicKey: attackerPublicKeyPem, fingerprint };
  tampered.founderApprovalRequest = { ...tampered.founderApprovalRequest, authorityFingerprint: fingerprint };
  return tampered;
}

// ── finding 1: the gate must be anchored on the DEFAULT call signature ───────

test("finding 1: a key swap is refused with NO options argument at all", () => {
  // This is the exact call shape production uses — hasValidFounderApproval(state),
  // recordFounderApproval(state, {assertion, evidence}) — with nothing threaded
  // through. Previously this path fell back to the task's own key.
  const founder = newKeypair();
  const attacker = newKeypair();
  anchorFounderKey(founder.publicKeyPem);

  const { state, worktree, evidence } = blockedTask(founder.publicKeyPem);
  const tampered = swapAuthority(state, attacker.publicKeyPem);
  const selfSigned = signFor(tampered, worktree, evidence, attacker.privateKey);

  assert.throws(
    () => recordFounderApproval(tampered, { assertion: selfSigned, evidence }),
    /does not match the key this deployment trusts/i,
  );
  assert.equal(
    hasValidFounderApproval({ ...tampered, founderApproval: { assertion: selfSigned, evidence } }),
    false,
    "the default call signature must not fall back to the task's own key",
  );
});

test("finding 1: the genuine key still passes with no options argument", () => {
  const founder = newKeypair();
  anchorFounderKey(founder.publicKeyPem);
  const { state, worktree, evidence } = blockedTask(founder.publicKeyPem);

  const genuine = signFor(state, worktree, evidence, founder.privateKey);
  const approved = recordFounderApproval(state, { assertion: genuine, evidence });
  assert.equal(approved.status, "active");
  assert.equal(hasValidFounderApproval(approved), true);
});

// ── finding 4: an unresolvable anchor must fail closed ───────────────────────

test("finding 4: no anchor means no high-risk approval, not a silent downgrade", (t) => {
  const founder = newKeypair();
  const previous = process.env.FACTORY_FOUNDER_PUBLIC_KEY;
  const previousEscape = process.env.FACTORY_ALLOW_UNANCHORED_APPROVAL;
  t.after(() => {
    if (previous) process.env.FACTORY_FOUNDER_PUBLIC_KEY = previous;
    if (previousEscape) process.env.FACTORY_ALLOW_UNANCHORED_APPROVAL = previousEscape;
    else delete process.env.FACTORY_ALLOW_UNANCHORED_APPROVAL;
  });

  const { state, worktree, evidence } = blockedTask(founder.publicKeyPem);
  const genuine = signFor(state, worktree, evidence, founder.privateKey);

  // Deleting one small file used to be a complete, silent bypass.
  clearFounderAnchor();
  delete process.env.FACTORY_ALLOW_UNANCHORED_APPROVAL;

  assert.throws(
    () => recordFounderApproval(state, { assertion: genuine, evidence, authority: { env: {} } }),
    /No trusted founder approval key is configured/i,
    "an unresolvable anchor must refuse, not fall back",
  );
});

test("finding 4: the unanchored escape hatch is explicit and opt-in", (t) => {
  const founder = newKeypair();
  const previous = process.env.FACTORY_FOUNDER_PUBLIC_KEY;
  t.after(() => {
    if (previous) process.env.FACTORY_FOUNDER_PUBLIC_KEY = previous;
    delete process.env.FACTORY_ALLOW_UNANCHORED_APPROVAL;
  });

  const { state, worktree, evidence } = blockedTask(founder.publicKeyPem);
  const genuine = signFor(state, worktree, evidence, founder.privateKey);

  clearFounderAnchor();
  process.env.FACTORY_ALLOW_UNANCHORED_APPROVAL = "1";
  const approved = recordFounderApproval(state, { assertion: genuine, evidence, authority: { env: {} } });
  assert.equal(approved.status, "active", "the escape hatch must work when deliberately set");
});

// ── finding 3: a symlinked anchor is not an anchor ───────────────────────────

test("finding 3: a symlinked approval key is refused", () => {
  const founder = newKeypair();
  const attacker = newKeypair();

  const root = mkdtempSync(join(tmpdir(), "hq-symlink-"));
  const anchorPath = enrolledKeyPath(root);
  mkdirSync(dirname(anchorPath), { recursive: true });

  const attackerKey = join(root, "attacker.pem");
  writeFileSync(attackerKey, attacker.publicKeyPem);
  symlinkSync(attackerKey, anchorPath);

  const resolved = resolveTrustedFounderAuthority({ hqRoot: root, env: {} });
  assert.equal(resolved, null, "a symlinked anchor must not be followed");

  // A real file at the same path still works.
  rmSync(anchorPath);
  writeFileSync(anchorPath, founder.publicKeyPem, { mode: 0o600 });
  assert.equal(
    resolveTrustedFounderAuthority({ hqRoot: root, env: {} }).fingerprint,
    fingerprintOf(founder.publicKeyPem),
  );
});

// ── finding 5: the audit redaction regression ────────────────────────────────

test("finding 5: the field literally named `key` is redacted again", () => {
  const out = redact({
    key: "-----BEGIN PRIVATE KEY-----MIIB",
    accessKey: "AKIAIOSFODNN7EXAMPLE",
    signingKey: "s3cret",
    sshKey: "ssh-rsa AAAA",
    auth: "Basic dXNlcjpwdw==",
    bearer: "ghp_abcdefghijklmnop",
    jwt: "eyJhbGciOi.eyJzdWIi.sig",
    databaseUrl: "postgres://user:hunter2@db/x",
    connectionString: "Server=x;Password=hunter2",
    salt: "abc123",
  });
  const serialized = JSON.stringify(out);
  for (const leaked of [
    "BEGIN PRIVATE KEY", "AKIAIOSFODNN7EXAMPLE", "s3cret", "ssh-rsa AAAA",
    "dXNlcjpwdw==", "ghp_abcdefghijklmnop", "hunter2", "abc123",
  ]) {
    assert.ok(!serialized.includes(leaked), `audit leaked ${leaked}: ${serialized}`);
  }
});

test("finding 5: approval evidence is still loggable, not over-redacted", () => {
  // An approval audit is useless if it cannot record whether a signature
  // verified, or which public key approved.
  const out = redact({
    signatureValid: true,
    signatureVerified: true,
    assertionPresent: true,
    publicKeyPem: "-----BEGIN PUBLIC KEY-----AAA",
    keyFingerprint: "abc123def456",
    authoritySource: "enrolled",
    authorityFingerprint: "abc123",
  });
  assert.equal(out.signatureValid, true);
  assert.equal(out.signatureVerified, true);
  assert.equal(out.assertionPresent, true);
  assert.match(String(out.publicKeyPem), /BEGIN PUBLIC KEY/);
  assert.equal(out.keyFingerprint, "abc123def456");
  assert.equal(out.authoritySource, "enrolled");
});

// ── finding 6: redactText gaps ───────────────────────────────────────────────

test("finding 6: free text leaks its own documented cases no longer", () => {
  const cases = [
    ["DASHBOARD_PASSWORD=hunter2", "hunter2"],
    ["SESSION_SECRET=abc123xyz", "abc123xyz"],
    ['{"password": "hunter2"}', "hunter2"],
    ["password 'hunter2'", "hunter2"],
    ["Authorization: Bearer ghp_abcdefghijklmnop", "ghp_abcdefghijklmnop"],
    ["postgres://user:hunter2@host/db", "hunter2"],
    ["-----BEGIN PRIVATE KEY-----\nMIIBpayload\n", "MIIBpayload"],
  ];
  for (const [input, secret] of cases) {
    const scrubbed = redactText(input);
    assert.ok(!scrubbed.includes(secret), `redactText leaked ${secret} from ${JSON.stringify(input)} -> ${scrubbed}`);
  }
});

test("finding 6: string values inside details are scrubbed, not just key names", () => {
  const out = redact({ message: "login failed for DASHBOARD_PASSWORD=hunter2" });
  assert.ok(!JSON.stringify(out).includes("hunter2"), `value leaked: ${JSON.stringify(out)}`);
});

test("finding 6: ordinary prose is left readable", () => {
  const text = "QA could not reach the staging host after 3 attempts.";
  assert.equal(redactText(text), text);
  assert.equal(redact({ note: text }).note, text);
});
