import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto, sign as nodeSign, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  createState,
  completeStage,
  founderApprovalPayload,
  isAwaitingFounderApproval,
  readState,
} from "../lib/task-workflow.mjs";
import {
  enrollFounderKey,
  getEnrolledFounderKey,
  prepareFounderApproval,
  rejectFounderApproval,
  rekeyPendingApproval,
  submitFounderApproval,
} from "../../dashboard/backend/lib/founderApproval.mjs";

const { subtle } = webcrypto;

// ── browser simulation ──────────────────────────────────────────────────────
async function makeBrowserKey() {
  const pair = await subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  const spki = Buffer.from(await subtle.exportKey("spki", pair.publicKey));
  const pem = `-----BEGIN PUBLIC KEY-----\n${spki.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END PUBLIC KEY-----\n`;
  return { pair, pem };
}
async function browserSign(pair, payloadString) {
  const sig = await subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(payloadString));
  return Buffer.from(sig).toString("base64");
}

// ── factory-shaped fixture ──────────────────────────────────────────────────
function completion(stage, actor) {
  return { stage, actor, outcome: "pass", summary: `${stage} ok`, evidence: [{ path: `evidence/${stage}.md` }] };
}

function seedTask(root, id, founderPublicKeyPem, { project = "demo" } = {}) {
  const worktree = join(root, "worktrees", id);
  mkdirSync(join(worktree, "evidence"), { recursive: true });
  let state = createState({
    task: {
      id, issue: `local:${id}`, outcome: `Ship the risky part of ${id}`,
      acceptanceCriteria: ["Observable", "Failure reported"], project, workType: "backend", risk: "high",
    },
    repo: join(root, "repo"), branch: `factory/${id}`, worktree,
    founderPublicKey: founderPublicKeyPem,
  });
  state = completeStage(state, completion("product", state.assignments.product));
  state = completeStage(state, completion("architect", state.assignments.architect));
  assert.equal(isAwaitingFounderApproval(state), true);
  const path = join(root, "dashboard", "backend", "data", "factory", project, "tasks", id, "state.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
  return { path, worktree };
}

function newRoot() {
  const root = mkdtempSync(join(tmpdir(), "oneclick-"));
  mkdirSync(join(root, "dashboard", "backend", "data", "factory"), { recursive: true });
  return root;
}

// ── enrollment ──────────────────────────────────────────────────────────────

test("enrollment: TOFU first, then rotation requires a signature by the current key", async () => {
  const root = newRoot();
  const a = await makeBrowserKey();
  const b = await makeBrowserKey();

  const first = enrollFounderKey(root, { publicKeyPem: a.pem });
  assert.equal(first.rotated, false);
  assert.ok(getEnrolledFounderKey(root).enrolled);
  assert.equal(getEnrolledFounderKey(root).source, "browser");

  // same key again → no-op
  assert.equal(enrollFounderKey(root, { publicKeyPem: a.pem }).unchanged, true);

  // different key, no rotation signature → refused
  assert.throws(() => enrollFounderKey(root, { publicKeyPem: b.pem }), /Rotation must be signed/);

  // different key, signed by the CURRENT key → rotates
  const rotSig = await browserSign(a.pair, b.pem);
  const rotated = enrollFounderKey(root, { publicKeyPem: b.pem, rotationSignature: rotSig });
  assert.equal(rotated.rotated, true);
  assert.equal(getEnrolledFounderKey(root).fingerprint, rotated.fingerprint);

  // a rotation signed by a stranger key → refused
  const c = await makeBrowserKey();
  const badSig = await browserSign(c.pair, a.pem);
  assert.throws(() => enrollFounderKey(root, { publicKeyPem: a.pem, rotationSignature: badSig }), /not valid for the currently enrolled/);
});

test("enrollment rejects non-Ed25519 keys", async () => {
  const root = newRoot();
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" });
  assert.throws(() => enrollFounderKey(root, { publicKeyPem: rsa }), /Ed25519/);
});

// ── prepare → sign → submit ─────────────────────────────────────────────────

test("one-click: prepare returns the exact gate payload; a browser signature resumes the task", async () => {
  const root = newRoot();
  const browser = await makeBrowserKey();
  enrollFounderKey(root, { publicKeyPem: browser.pem });
  const { path } = seedTask(root, "deploy-node", getEnrolledFounderKey(root).pem);

  const prep = prepareFounderApproval(root, "deploy-node");
  // the browser signs JSON.stringify(unsigned) verbatim; it must equal the gate payload
  assert.equal(JSON.stringify(prep.unsigned), prep.payloadToSign);
  assert.equal(prep.unsigned.taskId, "deploy-node");
  assert.equal(prep.unsigned.decision, "approve-high-risk-build");
  assert.ok(existsSync(join(root, "worktrees", "deploy-node", "evidence", "founder-approval.md")));

  const signature = await browserSign(browser.pair, JSON.stringify(prep.unsigned));
  const runTask = mock();
  const out = await submitFounderApproval(root, root, "deploy-node", { assertion: { ...prep.unsigned, signature } }, { runTask });
  assert.equal(out.status, "active");
  assert.equal(out.currentStage, "builder");
  assert.equal(runTask.calls.length, 1);

  const state = readState(path);
  assert.equal(isAwaitingFounderApproval(state), false);
  assert.ok(state.founderApproval?.assertion?.signature);
  assert.ok(state.events.some((e) => e.type === "founder-approval-recorded"));
});

test("one-click: an objective node resumes its objective, not a bare task", async () => {
  const root = newRoot();
  const browser = await makeBrowserKey();
  enrollFounderKey(root, { publicKeyPem: browser.pem });
  const objId = "obj-abcd1234";
  const { path } = seedTask(root, `${objId}-capability`, getEnrolledFounderKey(root).pem, { project: "demo" });
  // an objective-state file so findObjectiveStatePath resolves
  const objPath = join(root, "dashboard", "backend", "data", "factory", "demo", "objectives", objId, "objective-state.json");
  mkdirSync(dirname(objPath), { recursive: true });
  writeFileSync(objPath, JSON.stringify({ version: 1, objectiveId: objId, nodes: {}, integration: {}, events: [] }));

  const prep = prepareFounderApproval(root, `${objId}-capability`);
  const signature = await browserSign(browser.pair, JSON.stringify(prep.unsigned));
  const runObjective = mock();
  const runTask = mock();
  await submitFounderApproval(root, root, `${objId}-capability`, { assertion: { ...prep.unsigned, signature } }, { runObjective, runTask });
  assert.equal(runObjective.calls.length, 1);
  assert.equal(runTask.calls.length, 0);
  assert.match(runObjective.calls[0][0].objectivePath, /objective-state\.json$/);
  assert.equal(readState(path).status, "active");
});

// ── the security boundary ───────────────────────────────────────────────────

test("an agent cannot forge: a signature by the wrong key is rejected and the task stays blocked", async () => {
  const root = newRoot();
  const browser = await makeBrowserKey();
  enrollFounderKey(root, { publicKeyPem: browser.pem });
  const { path } = seedTask(root, "guarded", getEnrolledFounderKey(root).pem);

  const prep = prepareFounderApproval(root, "guarded");
  const attacker = await makeBrowserKey();
  const forged = await browserSign(attacker.pair, JSON.stringify(prep.unsigned));

  await assert.rejects(
    submitFounderApproval(root, root, "guarded", { assertion: { ...prep.unsigned, signature: forged } }, { runTask: mock() }),
    /Approval rejected/,
  );
  const state = readState(path);
  assert.equal(state.status, "blocked");
  assert.equal(state.founderApproval, undefined);
  assert.equal(isAwaitingFounderApproval(state), true);
});

test("an agent cannot forge: tampering the evidence digest is rejected", async () => {
  const root = newRoot();
  const browser = await makeBrowserKey();
  enrollFounderKey(root, { publicKeyPem: browser.pem });
  seedTask(root, "tamper", getEnrolledFounderKey(root).pem);

  const prep = prepareFounderApproval(root, "tamper");
  const tampered = { ...prep.unsigned, evidenceSha256: "0".repeat(64) };
  const signature = await browserSign(browser.pair, JSON.stringify(tampered));
  await assert.rejects(
    submitFounderApproval(root, root, "tamper", { assertion: { ...tampered, signature } }, { runTask: mock() }),
    /Approval rejected/,
  );
});

// ── reject ──────────────────────────────────────────────────────────────────

test("reject stops the task, records the reason, and does not resume", async () => {
  const root = newRoot();
  const browser = await makeBrowserKey();
  enrollFounderKey(root, { publicKeyPem: browser.pem });
  const { path } = seedTask(root, "declined", getEnrolledFounderKey(root).pem);

  const out = rejectFounderApproval(root, "declined", { reason: "Revisit after infra work" });
  assert.equal(out.rejected, true);
  const state = readState(path);
  assert.equal(state.blocker.founderRejected, true);
  assert.match(state.blocker.summary, /Revisit after infra work/);
  assert.equal(isAwaitingFounderApproval(state), false);
  assert.ok(state.events.some((e) => e.type === "founder-approval-rejected"));
  assert.equal(state.founderApproval, undefined);
});

// ── re-key a pending task created under an older key ─────────────────────────

test("a task created under an older key is re-keyed, then approves one-click", async () => {
  const root = newRoot();
  const old = await makeBrowserKey();
  const { path } = seedTask(root, "legacy", old.pem);           // task authority = old key
  const browser = await makeBrowserKey();
  enrollFounderKey(root, { publicKeyPem: browser.pem });         // enrolled = new key

  assert.throws(() => prepareFounderApproval(root, "legacy"), (e) => e.code === "KEY_MISMATCH");

  const rk = rekeyPendingApproval(root, "legacy");
  assert.equal(rk.rekeyed, true);
  assert.equal(readState(path).founderApprovalAuthority.fingerprint, getEnrolledFounderKey(root).fingerprint);
  assert.ok(readState(path).events.some((e) => e.type === "founder-approval-authority-rekeyed"));

  const prep = prepareFounderApproval(root, "legacy");
  const signature = await browserSign(browser.pair, JSON.stringify(prep.unsigned));
  const out = await submitFounderApproval(root, root, "legacy", { assertion: { ...prep.unsigned, signature } }, { runTask: mock() });
  assert.equal(out.status, "active");
});

// ── objective-node lookup (regression for the "Not found" report) ────────────
//
// obj-039f0f5a-deployment-capability-core reached the Founder Inbox and Approve
// returned "Not found". Root cause was a stale dashboard process (the routes
// didn't exist yet in the running server) — but it also exposed that the
// approval endpoints re-derived the task path by walking every state file and
// matching `task.id`, instead of using the exact `statePath` the inbox carries.
// These lock in direct-path resolution for objective-node tasks.

function seedObjectiveNode(root, objectiveId, slug, keyPem) {
  const nodeId = `${objectiveId}-${slug}`;
  const { path, worktree } = seedTask(root, nodeId, keyPem, { project: "Openclaw-Agents-Headquarter" });
  const objPath = join(root, "dashboard", "backend", "data", "factory", "Openclaw-Agents-Headquarter", "objectives", objectiveId, "objective-state.json");
  mkdirSync(dirname(objPath), { recursive: true });
  writeFileSync(objPath, JSON.stringify({ version: 1, objectiveId, nodes: { [nodeId]: { id: nodeId, statePath: path } }, integration: {}, events: [] }));
  return { nodeId, statePath: path, worktree, objPath };
}

test("objective-node approval resolves from the inbox-provided statePath and resumes the objective", async () => {
  const root = newRoot();
  const browser = await makeBrowserKey();
  enrollFounderKey(root, { publicKeyPem: browser.pem });
  const { nodeId, statePath } = seedObjectiveNode(root, "obj-039f0f5a", "deployment-capability-core", getEnrolledFounderKey(root).pem);

  const prep = prepareFounderApproval(root, nodeId, { statePath }); // exactly what the card now sends
  assert.equal(prep.unsigned.taskId, nodeId);
  assert.equal(JSON.stringify(prep.unsigned), prep.payloadToSign);

  const signature = await browserSign(browser.pair, JSON.stringify(prep.unsigned));
  const runObjective = mock();
  const out = await submitFounderApproval(root, root, nodeId, { assertion: { ...prep.unsigned, signature }, statePath }, { runObjective, runTask: mock() });
  assert.equal(out.status, "active");
  assert.equal(runObjective.calls.length, 1, "the owning objective is resumed");
  assert.match(runObjective.calls[0][0].objectivePath, /obj-039f0f5a[/\\]objective-state\.json$/);
  assert.equal(isAwaitingFounderApproval(readState(statePath)), false);
});

test("objective-node approval still resolves with NO statePath (id fallback / CLI break-glass)", async () => {
  const root = newRoot();
  const b = await makeBrowserKey();
  enrollFounderKey(root, { publicKeyPem: b.pem });
  const { nodeId } = seedObjectiveNode(root, "obj-abcd1234", "capability-core", getEnrolledFounderKey(root).pem);
  const prep = prepareFounderApproval(root, nodeId); // no hint
  assert.equal(prep.unsigned.taskId, nodeId);
});

test("a statePath hint that escapes the factory dir or mismatches task.id is ignored", async () => {
  const root = newRoot();
  const browser = await makeBrowserKey();
  enrollFounderKey(root, { publicKeyPem: browser.pem });
  const { nodeId } = seedObjectiveNode(root, "obj-eeee1111", "node", getEnrolledFounderKey(root).pem);

  // escapes containment -> ignored, falls back to the id walk (which succeeds)
  assert.equal(prepareFounderApproval(root, nodeId, { statePath: "/etc/passwd" }).unsigned.taskId, nodeId);

  // points at a real state file for a DIFFERENT task -> task.id check fails -> fallback
  const other = seedObjectiveNode(root, "obj-ffff2222", "other", getEnrolledFounderKey(root).pem);
  assert.equal(prepareFounderApproval(root, nodeId, { statePath: other.statePath }).unsigned.taskId, nodeId);

  // genuinely unknown id, unusable hint -> 404
  assert.throws(() => prepareFounderApproval(root, "obj-0000dead-missing", { statePath: "/tmp/nope/state.json" }),
    (e) => e.statusCode === 404);
});

// ── helpers ─────────────────────────────────────────────────────────────────

function mock() {
  const fn = (...args) => { fn.calls.push(args); return Promise.resolve(); };
  fn.calls = [];
  return fn;
}
