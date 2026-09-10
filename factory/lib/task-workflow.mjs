import { existsSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { createHash, randomUUID, sign as signPayload, verify as verifySignature } from "crypto";
import { classifyBlocker } from "./hq/blocker-class.mjs";
import { classifyFailure, isRecoverableFailure, recoveryStrategy, repairTargetFor } from "./failure-classification.mjs";
import { mutateTransactionalState, readTransactionalState } from "./store/transactional-json.mjs";

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

// Founder approval assertion format. v1 signed {version,taskId,challenge,
// decision,approvedAt,evidenceSha256}; v2 additionally binds the approval
// authority's fingerprint. Pending v1 tasks stay verifiable — see
// docs/software-factory/FOUNDER_AUTHORITY.md for the migration path.
export const FOUNDER_APPROVAL_VERSION = 2;
// How long a signed approval stays usable. An approval is a decision about a
// moment; a stale one must not authorize a build days later.
export const FOUNDER_APPROVAL_TTL_SECONDS = Number(process.env.FACTORY_APPROVAL_TTL_SECONDS || 24 * 60 * 60);
const FOUNDER_APPROVAL_SKEW_MS = 2 * 60 * 1000;

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
    : task.workType === "ui" ? "frontend" : "codex";
  const reviewer = builder === "claude" ? "codex" : "claude";
  const qa = builder === "frontend" ? "claude" : builder === "codex" ? "claude" : "codex";
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

export function createState({ task, repo, branch, worktree, founderPublicKey = null, baseSha = null, maxRecoveryAttempts = 3, now = new Date().toISOString() }) {
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
    baseSha: baseSha || null,
    status: "active",
    currentStage: STAGES[0],
    assignments,
    stages: Object.fromEntries(STAGES.map((stage) => [stage, { status: "pending" }])),
    failures: [],
    recovery: { maxAttempts: Number(maxRecoveryAttempts) || 3, attempts: [], active: null },
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
      // v2 binds the approval to the authority fingerprint as well, so a
      // signature made for a task under one key cannot be replayed onto the
      // same task after it has been re-keyed to a different one.
      version: FOUNDER_APPROVAL_VERSION,
      taskId: safeTask.id,
      challenge: randomUUID(),
      decision: "approve-high-risk-build",
      authorityFingerprint: state.founderApprovalAuthority.fingerprint,
      requestedAt: now,
      expiresAfterSeconds: FOUNDER_APPROVAL_TTL_SECONDS,
    };
  }
  return state;
}

export function completeStage(state, { stage, actor, outcome, summary, evidence = [], deferredDecision = null, now = new Date().toISOString() }) {
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

  if (deferredDecision) {
    const decision = normalizeDeferredDecision(deferredDecision, stage, now);
    next.stages[stage].deferredDecision = decision;
    next.deferredDecisions = [...(next.deferredDecisions || []), decision];
    next.events.push({ at: now, type: "stage-decision-deferred", stage, actor, decisionId: decision.id });
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

function normalizeDeferredDecision(input, stage, now) {
  const question = String(input.question || "").trim();
  if (!question) throw new Error("A deferred decision requires a plain-language question.");
  const options = Array.isArray(input.options) ? input.options.map((x) => String(x).trim()).filter(Boolean).slice(0, 3) : [];
  if (options.length < 2) throw new Error("A deferred decision requires at least two options.");
  if (!options.some((option) => /^other\b/i.test(option))) options.push("Other: describe your preference");
  return {
    id: String(input.id || `${stage}-${Date.parse(now) || Date.now()}`),
    stage,
    question,
    why: String(input.why || "The team completed the safe work and is reporting this choice for your review.").trim(),
    options,
    recommendation: String(input.recommendation || "").trim(),
    requestedAt: now,
  };
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

const REVIEW_STAGES = new Set(["reviewer", "qa", "security", "release"]);

export function routeStageFailure(state, { failedStage, targetStage, maxAttemptsPerStage = 3, now = new Date().toISOString() }) {
  if (state.blocker?.outcome !== "fail") return state;
  const attempts = (state.dispatches || []).filter((item) => item.stage === failedStage).length;
  if (attempts >= maxAttemptsPerStage) return state;
  // A review-stage FAIL normally routes back to the builder so a real defect
  // gets fixed. But when the failure is infrastructural (the agent could not
  // run, produced no result file, timed out) there is nothing for the builder
  // to fix — re-running builder + the whole review group for a dropped model
  // call is pure waste. Retry the failed review stage in place instead. A real
  // FAIL verdict still routes to the builder.
  const releaseConflict = failedStage === "release" && /merge conflict|conflict(?:ing|s)?(?:\/dirty)?|branch.*(?:out.of.date|behind)/i.test(state.blocker.summary || "");
  const infra = REVIEW_STAGES.has(failedStage) && !releaseConflict && classifyBlocker(state.blocker) === "infra";
  const target = targetStage
    || (REVIEW_STAGES.has(failedStage) && !infra ? "builder" : failedStage);
  const next = structuredClone(state);
  const targetIndex = STAGES.indexOf(target);
  for (const stage of STAGES.slice(targetIndex)) next.stages[stage] = { status: "pending" };
  next.status = "active";
  next.currentStage = target;
  delete next.blocker;
  next.updatedAt = now;
  next.events.push({ at: now, type: "failure-routed", fromStage: failedStage, stage: target, actor: next.assignments[target], attempt: attempts + 1, ...(infra ? { infra: true } : {}) });
  return next;
}

// Start a recovery cycle on the same task. The original dispatch/failure is
// retained; recovery is only an additional sub-state of this state machine.
export function startRecovery(state, { failedStage, actor, error, evidence = [], source = "execution", maxRecoveryAttempts = 3, now = new Date().toISOString() }) {
  const kind = classifyFailure({ error, source });
  const next = structuredClone(state);
  next.failures = [...(next.failures || []), {
    at: now, stage: failedStage, agent: actor, error: String(error || "unknown failure"),
    classification: kind, evidence: structuredClone(evidence), disposition: "recovery-started",
  }];
  next.recovery = { ...(next.recovery || {}), maxAttempts: Number(maxRecoveryAttempts) || 3, attempts: next.recovery?.attempts || [], active: null };
  if (!isRecoverableFailure(kind)) return next;
  const used = next.recovery.attempts.length;
  if (used >= next.recovery.maxAttempts) return escalateRecovery(next, { failedStage, kind, error, now });
  const attempt = {
    number: used + 1, strategy: recoveryStrategy(used + 1), originalObjective: next.task.outcome,
    failedStage, agent: actor, error: String(error || "unknown failure"), classification: kind,
    repairTarget: repairTargetFor(kind), relevantEvidence: structuredClone(evidence),
    attemptedActions: [], currentState: next.status, diagnosis: null, repair: null, verification: null,
    status: "diagnosing", startedAt: now,
  };
  next.recovery.attempts = [...next.recovery.attempts, attempt];
  next.recovery.active = { phase: "diagnose", failedStage, attempt: attempt.number };
  next.status = "active";
  next.currentStage = failedStage;
  delete next.blocker;
  next.updatedAt = now;
  next.events.push({ at: now, type: "failure-classified", stage: failedStage, actor: "system", classification: kind, error: String(error || "") });
  next.events.push({ at: now, type: "recovery-diagnosing", stage: failedStage, actor: "recovery", attempt: attempt.number, classification: kind });
  return next;
}

export function recordRecoveryResult(state, { outcome, actor, summary, evidence = [], diagnosis = null, maxAttemptsPerStage = 3, now = new Date().toISOString() }) {
  const active = state.recovery?.active;
  if (!active) throw new Error("No recovery attempt is active.");
  const next = structuredClone(state);
  const attempt = next.recovery.attempts.at(-1);
  if (active.phase === "diagnose") {
    attempt.diagnosis = { summary: String(summary || ""), evidence: structuredClone(evidence), actor, at: now, ...(diagnosis || {}) };
    attempt.attemptedActions = Array.isArray(diagnosis?.attemptedActions) ? structuredClone(diagnosis.attemptedActions) : [];
    attempt.repair = { status: outcome === "pass" ? "attempted" : "not-attempted", summary: String(summary || ""), evidence: structuredClone(evidence), actor, at: now };
    next.events.push({ at: now, type: "recovery-repair-attempted", stage: active.failedStage, actor, attempt: active.attempt });
    if (outcome === "pass") {
      next.recovery.active.phase = "verify";
      next.recovery.active.verificationStage = active.failedStage === "qa" ? "reviewer" : "qa";
      next.events.push({ at: now, type: "recovery-verifying", stage: active.failedStage, actor: next.assignments[next.recovery.active.verificationStage], attempt: active.attempt });
      return next;
    }
    return finishRecoveryFailure(next, { summary, actor, evidence, outcome, now });
  }
  attempt.verification = { outcome, summary: String(summary || ""), evidence: structuredClone(evidence), actor, at: now };
  next.events.push({ at: now, type: "recovery-verification", stage: active.failedStage, actor, outcome, attempt: active.attempt });
  if (outcome === "pass") {
    attempt.status = "verified";
    attempt.completedAt = now;
    next.recovery.active = null;
    next.updatedAt = now;
    next.events.push({ at: now, type: "recovery-verified", stage: active.failedStage, actor, attempt: active.attempt });
    // A verified repair to the PROJECT rewrote the code every earlier gate
    // passed against, so those verdicts are stale — resume at the builder and
    // invalidate everything downstream. A factory repair (the agent could not
    // run) changed no code, so the failed stage retries in place and earlier
    // gates stand.
    const resumeAt = REVIEW_STAGES.has(active.failedStage) && attempt.repairTarget === "project"
      ? "builder"
      : active.failedStage;
    // That re-entry is a stage attempt like any other and must respect the
    // per-stage budget: without this check each recovery cycle silently minted
    // a fresh attempt, so a stage could be dispatched indefinitely while
    // `routeStageFailure`'s limit never applied. Counted against the stage we
    // are actually about to re-enter.
    const attempts = (next.dispatches || []).filter((item) => item.stage === resumeAt && (item.kind === "stage" || !item.kind)).length;
    if (attempts >= maxAttemptsPerStage) {
      return escalateRecovery(next, {
        failedStage: resumeAt,
        kind: "FOUNDER_DECISION_REQUIRED",
        error: `Recovery attempt ${active.attempt} was independently verified, but ${resumeAt} has already used ${attempts} of ${maxAttemptsPerStage} stage attempts. Re-running it would exceed the per-stage budget. Founder direction is required: accept the verified work and advance, raise the budget, or change scope.`,
        now,
      });
    }
    for (const stage of STAGES.slice(STAGES.indexOf(resumeAt))) next.stages[stage] = { status: "pending" };
    next.status = "active";
    next.currentStage = resumeAt;
    next.events.push({ at: now, type: "task-resumed", stage: resumeAt, actor: "system", reason: "recovery-verified", attempt: attempts + 1, ...(resumeAt !== active.failedStage ? { fromStage: active.failedStage, invalidatedDownstream: true } : {}) });
    return next;
  }
  return finishRecoveryFailure(next, { summary, actor, evidence, outcome, now });
}

function finishRecoveryFailure(state, { summary, actor, outcome, now }) {
  const next = structuredClone(state);
  const active = next.recovery.active;
  const attempt = next.recovery.attempts.at(-1);
  attempt.status = "failed";
  attempt.completedAt = now;
  const error = String(summary || "Recovery could not repair the failure.");
  const kind = attempt.classification;
  if (outcome === "decision-required") {
    return escalateRecovery(next, { failedStage: active.failedStage, kind: "FOUNDER_DECISION_REQUIRED", error, now });
  }
  if (next.recovery.attempts.length < next.recovery.maxAttempts && isRecoverableFailure(kind)) {
    next.recovery.active = { phase: "diagnose", failedStage: active.failedStage, attempt: next.recovery.attempts.length + 1 };
    next.recovery.attempts.push({ number: next.recovery.attempts.length + 1, strategy: recoveryStrategy(next.recovery.attempts.length + 1), originalObjective: next.task.outcome, failedStage: active.failedStage, agent: "recovery", error, classification: kind, repairTarget: repairTargetFor(kind), relevantEvidence: [], attemptedActions: [], currentState: next.status, diagnosis: null, repair: null, verification: null, status: "diagnosing", startedAt: now });
    next.events.push({ at: now, type: "recovery-diagnosing", stage: active.failedStage, actor: "recovery", attempt: next.recovery.attempts.length, classification: kind });
    return next;
  }
  return escalateRecovery(next, { failedStage: active.failedStage, kind, error, now });
}

function escalateRecovery(state, { failedStage, kind, error, now }) {
  const next = structuredClone(state);
  next.recovery.active = null;
  next.status = "blocked";
  next.blocker = {
    stage: failedStage, outcome: "decision-required", founderAction: true, classification: kind,
    whatFailed: `${failedStage} failed for the original task.`,
    why: String(error || "Recovery budget exhausted or failure is unsafe to automate."),
    whatFactoryTried: (next.recovery.attempts || []).map((a) => `${a.strategy}: ${a.status}`).join("; ") || "No recovery attempt was available.",
    whatItNeedsFromFounder: "Review the recorded failure and decide whether to repair the project, factory, or environment, or change the task scope.",
    whatHappensAfterApproval: "The original task will resume from the failed stage after the blocker is resolved.",
    summary: `Recovery could not continue after ${(next.recovery.attempts || []).length} bounded attempt(s): ${String(error || "unknown failure")}`,
    at: now,
  };
  next.events.push({ at: now, type: "recovery-escalated", stage: failedStage, actor: "system", classification: kind });
  next.updatedAt = now;
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

// The exact bytes the founder signs. The shape is version-tagged so an older
// pending approval (v1, no authority binding) stays verifiable while every new
// task gets the stronger v2 binding. See docs/software-factory/FOUNDER_AUTHORITY.md.
export function founderApprovalPayload(state, { approvedAt, evidenceSha256, version }) {
  const v = Number(version || state.founderApprovalRequest?.version || 1);
  const base = {
    version: v,
    taskId: state.task.id,
    challenge: state.founderApprovalRequest?.challenge,
    decision: "approve-high-risk-build",
    approvedAt,
    evidenceSha256,
  };
  if (v >= 2) base.authorityFingerprint = state.founderApprovalRequest?.authorityFingerprint;
  return JSON.stringify(base);
}

export function evidenceSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Build the signed founder-approval assertion for a high-risk task. The ONLY
// place a private key is used in the approval flow — callers must run this in a
// founder-controlled process (never the dashboard server or an agent). The
// produced object is exactly what recordFounderApproval() verifies.
//
//   state        — the task state (needs founderApprovalRequest + task.risk "high")
//   evidencePath — absolute path to the approval evidence file inside the worktree
//   privateKey   — Ed25519 private key (PEM string or KeyObject)
//   approvedAt   — ISO timestamp of the human decision (defaults to now)
export function createFounderApprovalAssertion(state, { evidencePath, privateKey, approvedAt = new Date().toISOString() }) {
  if (state?.task?.risk !== "high" || !state.founderApprovalRequest) {
    throw new Error("Task has no high-risk founder approval request.");
  }
  if (!evidencePath) throw new Error("Founder approval requires an evidence file path.");
  if (!privateKey) throw new Error("Founder approval requires the founder private key.");
  const unsigned = unsignedFounderAssertion(state, {
    approvedAt,
    evidenceSha256: evidenceSha256(evidencePath),
  });
  const signature = signPayload(null, Buffer.from(founderApprovalPayload(state, unsigned)), privateKey).toString("base64");
  return { ...unsigned, signature };
}

// The assertion fields that are actually signed, in the order the payload uses.
// Both the CLI signer and the browser one-click flow build the assertion here so
// the two can never drift apart and produce bytes the verifier will not accept.
export function unsignedFounderAssertion(state, { approvedAt, evidenceSha256: digest }) {
  const request = state.founderApprovalRequest || {};
  const version = Number(request.version || 1);
  const unsigned = {
    version,
    taskId: state.task.id,
    challenge: request.challenge,
    decision: request.decision || "approve-high-risk-build",
    approvedAt,
    evidenceSha256: digest,
  };
  if (version >= 2) unsigned.authorityFingerprint = request.authorityFingerprint;
  return unsigned;
}

function sanitizeTaskContract(task) {
  const safe = structuredClone(task);
  for (const field of ["founderApproval", "founderApprovalAuthority", "founderApprovalRequest", "approval", "approvals"]) delete safe[field];
  return safe;
}

function validateFounderAssertion(state, assertion, evidence, now = new Date().toISOString()) {
  if (!assertion || typeof assertion !== "object") throw new Error("Founder approval assertion is required.");
  const expected = state.founderApprovalRequest;
  if (!expected) throw new Error("This task has no founder approval request to satisfy.");

  // Task scope + exact requested action. A signature for another task, another
  // challenge, or another action is not an approval for this one.
  if (assertion.taskId !== expected.taskId
    || assertion.challenge !== expected.challenge
    || assertion.decision !== expected.decision) {
    throw new Error("Founder approval assertion does not match this task challenge.");
  }
  if (!assertion.approvedAt || !assertion.evidenceSha256 || !assertion.signature) {
    throw new Error("Founder approval assertion is incomplete.");
  }

  const authority = state.founderApprovalAuthority;
  if (!authority?.publicKey) throw new Error("This task has no recorded approval authority.");

  // v2 binds the authority fingerprint into the signed bytes. Reject a v1
  // assertion presented against a task that asked for v2 — that is a downgrade.
  const requestVersion = Number(expected.version || 1);
  const assertionVersion = Number(assertion.version || 1);
  if (assertionVersion !== requestVersion) {
    throw new Error(`Founder approval version mismatch: task expects v${requestVersion}, assertion is v${assertionVersion}.`);
  }
  if (requestVersion >= 2) {
    const bound = expected.authorityFingerprint;
    const actual = authority.fingerprint || publicKeyFingerprint(authority.publicKey);
    if (!bound || bound !== actual) {
      throw new Error("Founder approval was issued for a different approval key than the one now on this task.");
    }
    if (assertion.authorityFingerprint && assertion.authorityFingerprint !== bound) {
      throw new Error("Founder approval authority fingerprint does not match this task.");
    }
  }

  // Revocation: a key the founder has retired can no longer authorize anything,
  // even if the signature itself is mathematically valid.
  const fingerprint = authority.fingerprint || publicKeyFingerprint(authority.publicKey);
  if (isRevokedFingerprint(state, fingerprint)) {
    throw new Error("The approval key for this task has been revoked.");
  }

  // Expiry: an approval is a decision about a moment, not a standing grant.
  assertApprovalFreshness(expected, assertion, now);

  const evidencePath = resolve(state.worktree, evidence.path);
  if (assertion.evidenceSha256 !== evidenceSha256(evidencePath)) {
    throw new Error("Founder approval evidence digest does not match.");
  }
  const payload = founderApprovalPayload(state, assertion);
  const valid = safeVerifyEd25519(payload, authority.publicKey, assertion.signature);
  if (!valid) throw new Error("Founder approval signature is invalid.");
}

// A malformed signature must fail closed, not throw a crypto error that a
// caller might mistake for an infrastructure fault.
function safeVerifyEd25519(payload, publicKey, signatureB64) {
  let signature;
  try {
    signature = Buffer.from(String(signatureB64 || ""), "base64");
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;
  try {
    return verifySignature(null, Buffer.from(payload), publicKey, signature);
  } catch {
    return false;
  }
}

function isRevokedFingerprint(state, fingerprint) {
  const revoked = Array.isArray(state?.founderApprovalRevocations) ? state.founderApprovalRevocations : [];
  return revoked.some((entry) => String(entry?.fingerprint || entry || "") === fingerprint);
}

function assertApprovalFreshness(request, assertion, now) {
  const approvedAt = Date.parse(assertion.approvedAt);
  if (!Number.isFinite(approvedAt)) throw new Error("Founder approval timestamp is not a valid date.");
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return;

  // Reject a future-dated approval beyond a small clock-skew allowance; that is
  // an attempt to mint an approval that outlives its window.
  if (approvedAt - nowMs > FOUNDER_APPROVAL_SKEW_MS) {
    throw new Error("Founder approval is dated in the future.");
  }
  const ttlSeconds = Number(request.expiresAfterSeconds || 0);
  if (ttlSeconds > 0 && nowMs - approvedAt > ttlSeconds * 1000) {
    throw new Error(`Founder approval expired (signed ${assertion.approvedAt}, valid for ${ttlSeconds}s).`);
  }
}

// Record that an approval key is no longer trusted. Existing approvals signed by
// it stop verifying immediately.
export function revokeFounderApprovalKey(state, { fingerprint, reason = "", actor = "founder", now = new Date().toISOString() }) {
  const fp = String(fingerprint || "").trim();
  if (!fp) throw new Error("A key fingerprint is required to revoke it.");
  const next = structuredClone(state);
  next.founderApprovalRevocations = [
    ...(next.founderApprovalRevocations || []).filter((e) => String(e?.fingerprint || "") !== fp),
    { fingerprint: fp, revokedAt: now, reason: String(reason || "").slice(0, 500) || null, actor },
  ];
  next.updatedAt = now;
  next.events.push({ at: now, type: "founder-approval-key-revoked", stage: next.currentStage, actor, fingerprint: fp });
  return next;
}

// True when a task is parked at the high-risk gate before `builder` and still
// has no valid recorded approval — i.e. it is waiting for the founder to sign.
//
// A strategic `founderDecisions` entry deliberately does NOT count here. Those
// records answer "which direction should we take?"; they are plain text written
// through an authenticated dashboard session and carry no cryptographic proof of
// who wrote them. Treating one as an authorization let any writer of task state
// walk a high-risk task past this gate (SFD-2026-010 / FCT-P0-04).
export function isAwaitingFounderApproval(state) {
  return Boolean(
    state
    && state.task?.risk === "high"
    && state.status === "blocked"
    && state.blocker?.stage === "builder"
    && state.blocker?.outcome === "decision-required"
    && !hasValidFounderApproval(state),
  );
}

// The ONLY thing that satisfies the high-risk gate: a task-scoped Ed25519
// assertion that still verifies against the authority recorded on the task.
// There is no second, weaker path — by design. If this returns false the task
// stays blocked until a real signature arrives.
export function hasValidFounderApproval(state) {
  if (!state?.founderApproval?.assertion || !state.founderApproval?.evidence) return false;
  try {
    validateFounderAssertion(state, state.founderApproval.assertion, state.founderApproval.evidence);
    return true;
  } catch {
    return false;
  }
}

// Why a high-risk task is still blocked, in words a founder can act on. Used by
// the Inbox so "waiting for approval" is never confused with "approved".
export function founderApprovalStatus(state, now = new Date().toISOString()) {
  if (state?.task?.risk !== "high") return { required: false, satisfied: true, reason: null };
  if (!state.founderApproval?.assertion) {
    return { required: true, satisfied: false, reason: "No signed founder approval has been recorded." };
  }
  try {
    validateFounderAssertion(state, state.founderApproval.assertion, state.founderApproval.evidence, now);
    return { required: true, satisfied: true, reason: null };
  } catch (error) {
    return { required: true, satisfied: false, reason: String(error.message || error) };
  }
}

export function publicKeyFingerprint(publicKey) {
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
  return readTransactionalState(path);
}

// Every caller that still does its own external read -> mutate -> writeState
// (rather than going through mutateTransactionalState directly) gets routed
// through the same SQLite authority here, unconditionally. This does not by
// itself add compare-and-swap protection for those external callers (the
// read and the decision to write still happen outside any one transaction,
// same as before), but it closes a worse bug: once any code path has
// touched a given state.json transactionally, that entity has a live SQLite
// row, and readTransactionalState()/ensureImported() only auto-imports the
// legacy file when NO row exists yet. A caller that kept writing the plain
// JSON file directly here would therefore be silently ignored on the very
// next transactional read — a second, competing "source of truth" exactly
// like the one this store exists to remove. Routing every writeState() call
// through the same mutateTransactionalState() keeps there being exactly one.
export function writeState(path, state) {
  mutateTransactionalState(path, { commandId: `writeState:${randomUUID()}`, mutate: () => state });
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
