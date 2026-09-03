import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { createHash, randomUUID, verify as verifySignature } from "crypto";

export const STAGES = [
  "product",
  "architect",
  "builder",
  "reviewer",
  "qa",
  "security",
  "release",
];

const REQUIRED_TASK_FIELDS = ["id", "outcome", "acceptanceCriteria", "project", "workType", "risk"];
const WORK_TYPES = new Set(["ui", "backend", "architecture", "bugfix", "research", "ops"]);
const RISKS = new Set(["low", "medium", "high"]);

export function validateTaskContract(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new Error("Task contract must be a JSON object.");
  }
  for (const field of REQUIRED_TASK_FIELDS) {
    if (task[field] === undefined || task[field] === null || task[field] === "") {
      throw new Error(`Task contract is missing ${field}.`);
    }
  }
  assertSlug(task.id, "task id");
  if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0) {
    throw new Error("Task contract acceptanceCriteria must be a non-empty array.");
  }
  if (!task.acceptanceCriteria.every((item) => typeof item === "string" && item.trim())) {
    throw new Error("Every acceptance criterion must be a non-empty string.");
  }
  if (!WORK_TYPES.has(task.workType)) throw new Error(`Unsupported workType: ${task.workType}`);
  if (!RISKS.has(task.risk)) throw new Error(`Unsupported risk: ${task.risk}`);
  if (!task.issue || !String(task.issue).trim()) {
    throw new Error("Task contract is missing issue (GitHub issue number or URL).");
  }
  return task;
}

export function defaultAssignments(task) {
  const builder = task.preferredBuilder && task.preferredBuilder !== "auto"
    ? task.preferredBuilder
    : task.workType === "ui" ? "cursor" : "codex";
  const reviewer = builder === "claude" ? "codex" : "claude";
  const qa = builder === "cursor" ? "codex" : builder === "codex" ? "claude" : "codex";
  return {
    product: "openclaw",
    architect: "claude",
    builder,
    reviewer,
    qa,
    security: "claude",
    release: "openclaw",
  };
}

export function createState({ task, repo, branch, worktree, founderPublicKey = null, now = new Date().toISOString() }) {
  validateTaskContract(task);
  const safeTask = sanitizeTaskContract(task);
  if (safeTask.risk === "high" && !founderPublicKey) {
    throw new Error("High-risk task initialization requires the configured founder public key.");
  }
  const assignments = defaultAssignments(safeTask);
  validateIndependence(assignments);
  const state = {
    version: 1,
    task: safeTask,
    repo: resolve(repo),
    branch,
    worktree: resolve(worktree),
    status: "active",
    currentStage: STAGES[0],
    assignments,
    stages: Object.fromEntries(STAGES.map((stage) => [stage, { status: "pending" }])),
    events: [{ at: now, type: "task-created", stage: STAGES[0] }],
    createdAt: now,
    updatedAt: now,
  };
  if (safeTask.risk === "high") {
    state.founderApprovalAuthority = {
      algorithm: "Ed25519",
      publicKey: founderPublicKey,
      fingerprint: publicKeyFingerprint(founderPublicKey),
    };
    state.founderApprovalRequest = {
      version: 1,
      taskId: safeTask.id,
      challenge: randomUUID(),
      decision: "approve-high-risk-build",
    };
  }
  return state;
}

export function completeStage(state, { stage, actor, outcome, summary, evidence = [], now = new Date().toISOString() }) {
  if (state.status !== "active") throw new Error(`Task is ${state.status}; it cannot advance.`);
  if (stage !== state.currentStage) throw new Error(`Expected stage ${state.currentStage}, received ${stage}.`);
  if (actor !== state.assignments[stage]) {
    throw new Error(`Stage ${stage} is assigned to ${state.assignments[stage]}, not ${actor}.`);
  }
  if (!summary || !String(summary).trim()) throw new Error("A non-empty summary is required.");
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new Error(`Stage ${stage} requires at least one evidence artifact.`);
  }
  if (!new Set(["pass", "fail", "decision-required"]).has(outcome)) {
    throw new Error("Outcome must be pass, fail, or decision-required.");
  }

  const next = structuredClone(state);
  next.stages[stage] = { status: outcome, actor, summary: String(summary), evidence, completedAt: now };
  next.updatedAt = now;
  next.events.push({ at: now, type: `stage-${outcome}`, stage, actor });

  if (outcome !== "pass") {
    next.status = "blocked";
    next.blocker = { stage, outcome, summary: String(summary), actor, at: now };
    return next;
  }

  const index = STAGES.indexOf(stage);
  if (index === STAGES.length - 1) {
    assertReleaseReady(next);
    next.status = "merge-ready";
    next.currentStage = null;
    next.events.push({ at: now, type: "merge-ready", stage: "release", actor });
  } else {
    next.currentStage = STAGES[index + 1];
    if (next.currentStage === "builder" && next.task.risk === "high" && !hasValidFounderApproval(next)) {
      next.status = "blocked";
      next.blocker = {
        stage: "builder",
        outcome: "decision-required",
        summary: "High-risk work requires founder approval before build.",
        actor: "system",
        at: now,
      };
      next.events.push({ at: now, type: "stage-decision-required", stage: "builder", actor: "system" });
      return next;
    }
    next.events.push({ at: now, type: "handoff-ready", stage: next.currentStage });
  }
  return next;
}

export function resumeState(state, now = new Date().toISOString()) {
  if (state.status !== "blocked") throw new Error("Only a blocked task can be resumed.");
  if (state.blocker?.stage === "builder" && state.task.risk === "high" && !hasValidFounderApproval(state)) {
    throw new Error("High-risk build cannot resume without recorded founder approval.");
  }
  const next = structuredClone(state);
  next.status = "active";
  next.stages[next.currentStage] = { status: "pending" };
  delete next.blocker;
  next.updatedAt = now;
  next.events.push({ at: now, type: "task-resumed", stage: next.currentStage });
  return next;
}

export function recordFounderApproval(state, { assertion, evidence, now = new Date().toISOString() }) {
  if (state.task.risk !== "high") throw new Error("Founder approval is only required for high-risk tasks.");
  if (!evidence?.path) throw new Error("Founder approval requires an evidence artifact.");
  validateFounderAssertion(state, assertion, evidence);
  const next = structuredClone(state);
  next.founderApproval = { assertion: structuredClone(assertion), evidence, verifiedAt: now };
  next.updatedAt = now;
  next.events.push({ at: now, type: "founder-approval-recorded", stage: next.currentStage, actor: "founder" });
  if (next.status === "blocked" && next.blocker?.stage === "builder") {
    next.status = "active";
    delete next.blocker;
    next.events.push({ at: now, type: "task-resumed", stage: next.currentStage });
  }
  return next;
}

export function assertReleaseReady(state) {
  validateIndependence(state.assignments);
  for (const stage of STAGES) {
    const result = state.stages[stage];
    if (result?.status !== "pass") throw new Error(`Release gate failed: ${stage} has not passed.`);
    if (!Array.isArray(result.evidence) || result.evidence.length === 0) {
      throw new Error(`Release gate failed: ${stage} has no evidence.`);
    }
  }
  if (state.task.risk === "high" && !hasValidFounderApproval(state)) {
    throw new Error("Release gate failed: high-risk task has no recorded founderApproval.");
  }
}

export function founderApprovalPayload(state, { approvedAt, evidenceSha256 }) {
  return JSON.stringify({
    version: 1,
    taskId: state.task.id,
    challenge: state.founderApprovalRequest?.challenge,
    decision: "approve-high-risk-build",
    approvedAt,
    evidenceSha256,
  });
}

export function evidenceSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sanitizeTaskContract(task) {
  const safe = structuredClone(task);
  for (const field of ["founderApproval", "founderApprovalAuthority", "founderApprovalRequest", "approval", "approvals"]) delete safe[field];
  return safe;
}

function validateFounderAssertion(state, assertion, evidence) {
  if (!assertion || typeof assertion !== "object") throw new Error("Founder approval assertion is required.");
  const expected = state.founderApprovalRequest;
  if (!expected || assertion.taskId !== expected.taskId || assertion.challenge !== expected.challenge || assertion.decision !== expected.decision) {
    throw new Error("Founder approval assertion does not match this task challenge.");
  }
  if (!assertion.approvedAt || !assertion.evidenceSha256 || !assertion.signature) throw new Error("Founder approval assertion is incomplete.");
  const evidencePath = resolve(state.worktree, evidence.path);
  if (assertion.evidenceSha256 !== evidenceSha256(evidencePath)) throw new Error("Founder approval evidence digest does not match.");
  const payload = founderApprovalPayload(state, assertion);
  const valid = verifySignature(null, Buffer.from(payload), state.founderApprovalAuthority.publicKey, Buffer.from(assertion.signature, "base64"));
  if (!valid) throw new Error("Founder approval signature is invalid.");
}

function hasValidFounderApproval(state) {
  if (!state.founderApproval?.assertion || !state.founderApproval?.evidence) return false;
  try {
    validateFounderAssertion(state, state.founderApproval.assertion, state.founderApproval.evidence);
    return true;
  } catch {
    return false;
  }
}

function publicKeyFingerprint(publicKey) {
  return createHash("sha256").update(String(publicKey)).digest("hex");
}

export function validateIndependence(assignments) {
  if (assignments.builder === assignments.reviewer) {
    throw new Error("Reviewer must use a different harness from the builder.");
  }
  if (assignments.builder === assignments.qa) {
    throw new Error("QA must use a different harness from the builder.");
  }
}

export function taskStatePath(stateRoot, taskId) {
  assertSlug(taskId, "task id");
  return join(resolve(stateRoot), "tasks", taskId, "state.json");
}

export function readState(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

export function verifyEvidence(paths, worktree) {
  return paths.map((item) => {
    const path = resolve(worktree, item);
    if (!path.startsWith(resolve(worktree) + "/")) throw new Error(`Evidence escapes worktree: ${item}`);
    if (!existsSync(path)) throw new Error(`Evidence does not exist: ${item}`);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size === 0) throw new Error(`Evidence must be a non-empty file: ${item}`);
    return { path: item, recordedAt: new Date().toISOString() };
  });
}

function assertSlug(value, label) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(value || ""))) {
    throw new Error(`Invalid ${label}; use lowercase letters, numbers, and hyphens.`);
  }
}
