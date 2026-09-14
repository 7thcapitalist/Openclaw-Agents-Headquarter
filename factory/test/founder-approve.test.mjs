import test from "node:test";
import { anchorFounderKey, detachAmbientAnchor } from "./helpers/anchor.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  createState,
  completeStage,
  createFounderApprovalAssertion,
  isAwaitingFounderApproval,
  recordFounderApproval,
  readState,
} from "../lib/task-workflow.mjs";
import { findPending } from "../../scripts/founder-approve.mjs";

// This suite reasons about roots it creates, not about the checkout it happens
// to run inside — see detachAmbientAnchor's own comment for what that cost.
detachAmbientAnchor();

const HQ = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APPROVE = join(HQ, "scripts", "founder-approve.mjs");

const keys = generateKeyPairSync("ed25519");
const founderPublicKey = keys.publicKey.export({ type: "spki", format: "pem" });
// This suite's own key is what the deployment trusts. Without an anchor the
// high-risk gate fails closed, by design.
anchorFounderKey(founderPublicKey);
const founderPrivateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });

function highRiskTask(id) {
  return {
    id, issue: `local:${id}`, outcome: `Ship the risky part of ${id}`,
    acceptanceCriteria: ["It is observable", "Failure is reported"],
    project: "demo", workType: "backend", risk: "high",
  };
}

function completion(stage, actor) {
  return { stage, actor, outcome: "pass", summary: `${stage} ok`, evidence: [{ path: `evidence/${stage}.md` }] };
}

// A high-risk task parked at the builder gate, its state written to a real
// factory-shaped state tree with a real worktree.
function seedBlockedHighRisk(root, id, { risk = "high", approved = false } = {}) {
  const worktree = join(root, "worktrees", id);
  mkdirSync(join(worktree, "evidence"), { recursive: true });
  let state = createState({
    task: { ...highRiskTask(id), risk },
    repo: join(root, "repo"), branch: `factory/${id}`, worktree,
    founderPublicKey: risk === "high" ? founderPublicKey : null,
  });
  state = completeStage(state, completion("product", state.assignments.product));
  if (risk === "high") {
    // architect pass parks it before builder
    state = completeStage(state, completion("architect", state.assignments.architect));
  }
  if (approved) {
    const evPath = join(worktree, "evidence", "founder-approval.md");
    writeFileSync(evPath, "approved\n");
    const assertion = createFounderApprovalAssertion(state, { evidencePath: evPath, privateKey: founderPrivateKey });
    state = recordFounderApproval(state, { assertion, evidence: { path: "evidence/founder-approval.md" } });
  }
  const path = join(root, "state", "demo", "tasks", id, "state.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
  return { path, worktree, state };
}

test("createFounderApprovalAssertion round-trips through recordFounderApproval", () => {
  const root = mkdtempSync(join(tmpdir(), "fa-roundtrip-"));
  const { state, worktree } = seedBlockedHighRisk(root, "round-trip");
  assert.equal(isAwaitingFounderApproval(state), true);

  const evPath = join(worktree, "evidence", "founder-approval.md");
  writeFileSync(evPath, "# Founder approval\n\nApproved.\n");
  const assertion = createFounderApprovalAssertion(state, { evidencePath: evPath, privateKey: founderPrivateKey });
  const next = recordFounderApproval(state, { assertion, evidence: { path: "evidence/founder-approval.md" } });
  assert.equal(next.status, "active");
  assert.equal(next.currentStage, "builder");
  assert.equal(isAwaitingFounderApproval(next), false);

  // A different key cannot produce an accepted assertion.
  const otherKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
  const forged = createFounderApprovalAssertion(state, { evidencePath: evPath, privateKey: otherKey });
  assert.throws(() => recordFounderApproval(state, { assertion: forged, evidence: { path: "evidence/founder-approval.md" } }), /signature is invalid/);
});

test("factory-sign-approval.mjs still emits an assertion recordFounderApproval accepts", () => {
  const root = mkdtempSync(join(tmpdir(), "fa-signcli-"));
  const { path, worktree, state } = seedBlockedHighRisk(root, "sign-cli");
  writeFileSync(join(worktree, "evidence", "founder-approval.md"), "approved via CLI\n");
  const keyFile = join(root, "founder.key");
  writeFileSync(keyFile, founderPrivateKey);
  const out = join(root, "assertion.json");
  execFileSync("node", [join(HQ, "scripts", "factory-sign-approval.mjs"),
    "--state", path, "--evidence", "evidence/founder-approval.md", "--private-key", keyFile, "--output", out], { stdio: "pipe" });
  const assertion = JSON.parse(readFileSync(out, "utf8"));
  const next = recordFounderApproval(state, { assertion, evidence: { path: "evidence/founder-approval.md" } });
  assert.equal(next.status, "active");
});

test("findPending sees only high-risk tasks parked at the gate without approval", () => {
  const root = mkdtempSync(join(tmpdir(), "fa-pending-"));
  seedBlockedHighRisk(root, "waiting-a");
  seedBlockedHighRisk(root, "waiting-b");
  seedBlockedHighRisk(root, "already-approved", { approved: true });
  seedBlockedHighRisk(root, "low-risk-blocked", { risk: "low" });

  const pending = findPending(join(root, "state"));
  assert.deepEqual(pending.map((p) => p.state.task.id).sort(), ["waiting-a", "waiting-b"]);
});

test("founder-approve --task --yes signs, records, and resumes the task", () => {
  const root = mkdtempSync(join(tmpdir(), "fa-cli-approve-"));
  const { path } = seedBlockedHighRisk(root, "deploy-node");
  const keyFile = join(root, "founder.key");
  writeFileSync(keyFile, founderPrivateKey);

  const stdout = execFileSync("node", [APPROVE,
    "--state-root", join(root, "state"), "--task", "deploy-node",
    "--yes", "--reason", "reviewed and authorised", "--key", keyFile,
  ], { encoding: "utf8" });
  assert.match(stdout, /approved deploy-node/);

  const state = readState(path);
  assert.equal(state.status, "active");
  assert.equal(state.currentStage, "builder");
  assert.equal(isAwaitingFounderApproval(state), false);
  assert.ok(state.founderApproval?.assertion?.signature, "a verified assertion was recorded");
  assert.equal(state.founderApproval.evidence.path, "evidence/founder-approval.md");
  assert.ok(existsSync(join(root, "worktrees", "deploy-node", "evidence", "founder-approval.md")));
  assert.match(readFileSync(join(root, "worktrees", "deploy-node", "evidence", "founder-approval.md"), "utf8"), /reviewed and authorised/);

  // Nothing left to approve.
  const again = execFileSync("node", [APPROVE, "--state-root", join(root, "state")], { encoding: "utf8" });
  assert.match(again, /Nothing is waiting/);
});

test("founder-approve rejects a wrong key and leaves the task blocked", () => {
  const root = mkdtempSync(join(tmpdir(), "fa-cli-wrongkey-"));
  const { path } = seedBlockedHighRisk(root, "guarded-node");
  const wrongKey = join(root, "wrong.key");
  writeFileSync(wrongKey, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));

  assert.throws(() => execFileSync("node", [APPROVE,
    "--state-root", join(root, "state"), "--task", "guarded-node", "--yes", "--reason", "x", "--key", wrongKey,
  ], { stdio: "pipe" }));

  const state = readState(path);
  assert.equal(state.status, "blocked");
  assert.equal(isAwaitingFounderApproval(state), true);
  assert.equal(state.founderApproval, undefined);
});

test("founder-approve --list changes nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "fa-cli-list-"));
  const { path } = seedBlockedHighRisk(root, "list-node");
  const before = readFileSync(path, "utf8");
  const stdout = execFileSync("node", [APPROVE, "--state-root", join(root, "state"), "--list"], { encoding: "utf8" });
  assert.match(stdout, /list-node/);
  assert.match(stdout, /after   :/);
  assert.equal(readFileSync(path, "utf8"), before);
});
