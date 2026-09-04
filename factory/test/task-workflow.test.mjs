import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { generateKeyPairSync, sign } from "crypto";
import {
  STAGES,
  completeStage,
  createState,
  defaultAssignments,
  recordFounderApproval,
  resumeState,
  validateTaskContract,
  verifyEvidence,
  evidenceSha256,
  founderApprovalPayload,
} from "../lib/task-workflow.mjs";

const keys = generateKeyPairSync("ed25519");
const founderPublicKey = keys.publicKey.export({ type: "spki", format: "pem" });

const task = {
  id: "issue-42",
  issue: "42",
  outcome: "A real change is independently verified.",
  acceptanceCriteria: ["Behavior is observable", "Failure is reported"],
  project: "sample",
  workType: "backend",
  risk: "low",
};

test("validates contracts and routes independent harnesses", () => {
  assert.equal(validateTaskContract(task), task);
  const assignments = defaultAssignments(task);
  assert.equal(assignments.builder, "codex");
  assert.notEqual(assignments.reviewer, assignments.builder);
  assert.notEqual(assignments.qa, assignments.builder);
  assert.throws(() => validateTaskContract({ ...task, issue: "" }), /missing issue/);
  assert.throws(() => validateTaskContract({ ...task, acceptanceCriteria: [] }), /non-empty array/);
});

test("advances only in order and requires assigned actor and evidence", () => {
  let state = createState({ task, repo: "/tmp/repo", branch: "factory/issue-42", worktree: "/tmp/worktree" });
  assert.throws(() => completeStage(state, completion("architect")), /Expected stage product/);
  assert.throws(() => completeStage(state, { ...completion("product"), actor: "codex" }), /assigned to openclaw/);
  assert.throws(() => completeStage(state, { ...completion("product"), evidence: [] }), /requires at least one evidence/);
  state = completeStage(state, completion("product"));
  assert.equal(state.currentStage, "architect");
  assert.equal(state.stages.product.status, "pass");
});

test("failure blocks rather than advancing and can be explicitly resumed", () => {
  const initial = createState({ task, repo: "/tmp/repo", branch: "factory/issue-42", worktree: "/tmp/worktree" });
  const blocked = completeStage(initial, { ...completion("product"), outcome: "fail" });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.currentStage, "product");
  assert.throws(() => completeStage(blocked, completion("product")), /cannot advance/);
  const resumed = resumeState(blocked);
  assert.equal(resumed.status, "active");
  assert.equal(resumed.stages.product.status, "pending");
});

test("reaches merge-ready but never records merged", () => {
  let state = createState({ task, repo: "/tmp/repo", branch: "factory/issue-42", worktree: "/tmp/worktree" });
  for (const stage of STAGES) state = completeStage(state, completion(stage, state.assignments[stage]));
  assert.equal(state.status, "merge-ready");
  assert.equal(state.currentStage, null);
  assert.equal(state.events.some((event) => event.type === "merged"), false);
});

test("high-risk release requires recorded founder approval", () => {
  let state = createState({ task: { ...task, risk: "high", founderApproval: { by: "founder" } }, repo: "/tmp/repo", branch: "factory/issue-42", worktree: "/tmp/worktree", founderPublicKey });
  assert.equal(state.task.founderApproval, undefined);
  state.task.risk = "low";
  for (const stage of STAGES.slice(0, -1)) state = completeStage(state, completion(stage, state.assignments[stage]));
  state.task.risk = "high";
  assert.throws(() => completeStage(state, completion("release", state.assignments.release)), /founderApproval/);
});

test("high-risk work blocks before build until founder approval is recorded", () => {
  const worktree = mkdtempSync(join(tmpdir(), "factory-approval-"));
  mkdirSync(join(worktree, "evidence"));
  writeFileSync(join(worktree, "evidence", "approval.md"), "Founder approved high-risk build.\n");
  let state = createState({ task: { ...task, risk: "high" }, repo: "/tmp/repo", branch: "factory/issue-42", worktree, founderPublicKey });
  state = completeStage(state, completion("product", state.assignments.product));
  state = completeStage(state, completion("architect", state.assignments.architect));
  assert.equal(state.status, "blocked");
  assert.equal(state.currentStage, "builder");
  assert.throws(() => resumeState(state), /founder approval/);
  const evidence = { path: "evidence/approval.md" };
  const assertion = signedApproval(state, join(worktree, evidence.path));
  state = recordFounderApproval(state, { assertion, evidence });
  assert.equal(state.status, "active");
  assert.equal(state.founderApproval.assertion.taskId, task.id);
});

test("task input cannot forge founder approval", () => {
  const forged = { ...task, risk: "high", founderApproval: { by: "founder", verified: true }, approvals: { founder: true } };
  assert.throws(() => createState({ task: forged, repo: "/tmp/repo", branch: "factory/issue-42", worktree: "/tmp/worktree" }), /public key/);
  const state = createState({ task: forged, repo: "/tmp/repo", branch: "factory/issue-42", worktree: "/tmp/worktree", founderPublicKey });
  assert.equal(state.task.founderApproval, undefined);
  assert.equal(state.task.approvals, undefined);
  assert.equal(state.founderApproval, undefined);
});

test("founder approval rejects forged signatures and cross-task replay", () => {
  const worktree = mkdtempSync(join(tmpdir(), "factory-approval-forgery-"));
  mkdirSync(join(worktree, "evidence"));
  const evidencePath = join(worktree, "evidence", "approval.md");
  writeFileSync(evidencePath, "approved\n");
  const state = createState({ task: { ...task, risk: "high" }, repo: "/tmp/repo", branch: "factory/issue-42", worktree, founderPublicKey });
  const evidence = { path: "evidence/approval.md" };
  const assertion = signedApproval(state, evidencePath);
  assert.throws(() => recordFounderApproval(state, { assertion: { ...assertion, signature: Buffer.from("forged").toString("base64") }, evidence }), /signature is invalid/);
  assert.throws(() => recordFounderApproval(state, { assertion: { ...assertion, taskId: "another-task" }, evidence }), /does not match/);
});

test("evidence must exist inside the assigned worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-evidence-"));
  mkdirSync(join(root, "evidence"));
  writeFileSync(join(root, "evidence", "qa.txt"), "passed\n");
  assert.equal(verifyEvidence(["evidence/qa.txt"], root)[0].path, "evidence/qa.txt");
  assert.throws(() => verifyEvidence(["missing.txt"], root), /does not exist/);
  assert.throws(() => verifyEvidence(["../escape.txt"], root), /escapes worktree/);
  writeFileSync(join(root, "evidence", "empty.txt"), "");
  assert.throws(() => verifyEvidence(["evidence/empty.txt"], root), /non-empty file/);
});

function completion(stage, actor) {
  const defaults = defaultAssignments(task);
  return {
    stage,
    actor: actor || defaults[stage],
    outcome: "pass",
    summary: `${stage} completed`,
    evidence: [{ path: `evidence/${stage}.md` }],
  };
}

function signedApproval(state, evidencePath) {
  const unsigned = {
    ...state.founderApprovalRequest,
    approvedAt: new Date().toISOString(),
    evidenceSha256: evidenceSha256(evidencePath),
  };
  return {
    ...unsigned,
    signature: sign(null, Buffer.from(founderApprovalPayload(state, unsigned)), keys.privateKey).toString("base64"),
  };
}
