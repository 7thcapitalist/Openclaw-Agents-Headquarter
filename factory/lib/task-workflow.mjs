import { existsSync, readFileSync, statSync } from "fs";
import { execFileSync } from "child_process";
import { join, resolve } from "path";
import { createHash, randomUUID, sign as signPayload, verify as verifySignature } from "crypto";
import { classifyBlocker } from "./hq/blocker-class.mjs";
import { escalationVerdict } from "./hq/escalation-gate.mjs";
import { classifyFailure, isRecoverableFailure, recoveryStrategy, repairTargetFor } from "./failure-classification.mjs";
import { mutateTransactionalState, readTransactionalState } from "./store/transactional-json.mjs";
import { authorityForVerification } from "./founder-authority.mjs";
import { buildManifest, summarizeManifest, verifyManifest } from "./evidence-manifest.mjs";
import { criteriaForState, stageMustProveCriteria } from "./evidence-criteria.mjs";

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
// Evidence policy. Tasks created from this version forward owe commit-bound
// evidence at every verification stage. Tasks that predate it carry no policy
// field and keep the older file-existence gate — labelled `legacy`, never
// silently reported as if it had been verified (FCT-P0-05, requirement 11).
export const EVIDENCE_POLICY_STRONG = "strong";
export const EVIDENCE_POLICY_LEGACY = "legacy";

// True when this task's work will live in a git checkout, so commits exist to
// bind evidence to.
//
// This probes the REPO, not the worktree. initializeTask() calls createState()
// BEFORE `git worktree add` — it even refuses to start if the worktree path
// already exists — so probing the worktree tested a directory that could not
// exist yet and always answered "no". Every real task was therefore created as
// `legacy` and the entire release gate below became dead code in production.
// The repo is present and is what the worktree is cut from.
function canBindEvidenceToCommits(repo) {
  try {
    const root = resolve(repo);
    // A worktree added by `git worktree add` has a .git FILE pointing at the
    // real gitdir; a clone has a .git directory. Either is bindable.
    return existsSync(join(root, ".git"));
  } catch {
    return false;
  }
}

export function evidencePolicyOf(state) {
  return state?.evidencePolicy === EVIDENCE_POLICY_STRONG ? EVIDENCE_POLICY_STRONG : EVIDENCE_POLICY_LEGACY;
}

export const FOUNDER_APPROVAL_VERSION = 2;
// How long a signed approval stays usable. An approval is a decision about a
// moment; a stale one must not authorize a build days later.
export const FOUNDER_APPROVAL_TTL_SECONDS = Number(process.env.FACTORY_APPROVAL_TTL_SECONDS || 24 * 60 * 60);
const FOUNDER_APPROVAL_SKEW_MS = 2 * 60 * 1000;

// Opt-in only, and never the default: a high-risk build should not be
// authorizable by a key nothing outside the task file vouches for.
function allowUnanchoredApproval() {
  return process.env.FACTORY_ALLOW_UNANCHORED_APPROVAL === "1";
}

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
    // Commit-bound evidence is owed by every task whose worktree is a real git
    // checkout — which is every task the factory actually runs. A worktree that
    // is not a checkout cannot produce commit-bound evidence at all, so
    // demanding it would fail the task for its environment rather than for its
    // work. The decision is made once, here, from the environment, and recorded:
    // it is never inferred later at the gate, where a missing commit would be
    // indistinguishable from a task that simply never froze one.
    evidencePolicy: canBindEvidenceToCommits(repo) ? EVIDENCE_POLICY_STRONG : EVIDENCE_POLICY_LEGACY,
    status: "active",
    currentStage: STAGES[0],
    assignments,
    stages: Object.fromEntries(STAGES.map((stage) => [stage, { status: "pending" }])),
    failures: [],
    recovery: normalizeRecovery({ maxAttempts: Number(maxRecoveryAttempts) || 3 }),
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

export function completeStage(state, { stage, actor, outcome, summary, evidence = [], manifest = null, agentEvidence = null, dispatchId = null, commitSha = null, deferredDecision = null, now = new Date().toISOString() }) {
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

  if (manifest) {
    // Verified against the execution that is actually completing — its own
    // dispatch, stage, attempt, and the commit under review. Evidence built for
    // a different one is refused rather than absorbed.
    const expectedCommit = commitSha || verifiedCommitFor(next, stage);
    // NOT `|| manifest.dispatchId`: falling back to the manifest's own value
    // makes the check compare a field to itself, so evidence from any execution
    // is accepted. If the caller cannot say which dispatch is completing, the
    // binding is unverifiable and must fail rather than pass.
    if (!dispatchId) {
      throw new Error(
        `Stage ${stage} evidence cannot be verified: the caller did not say which dispatch is completing.`,
      );
    }
    const check = verifyManifest(next, manifest, {
      stage,
      dispatchId,
      attempt: attemptNumberFor(next, stage),
      commitSha: expectedCommit,
      now,
    });
    if (!check.ok) throw new Error(`Stage ${stage} evidence was rejected: ${check.errors.join(" | ")}`);
    next.stages[stage].manifest = structuredClone(manifest);
    next.stages[stage].evidenceStrength = "verified";
    next.events.push({ at: now, type: "stage-evidence-verified", stage, actor, commitSha: manifest.commitSha || null });
  } else if (outcome === "pass" && evidencePolicyOf(next) === EVIDENCE_POLICY_STRONG) {
    // No manifest supplied. Build a binding-only one from what the factory can
    // establish by itself: the artifacts on disk, their digests, the dispatch,
    // and the commit under review. Enough to detect tampering, reuse from an
    // older attempt, and post-hoc source changes.
    //
    // It proves no acceptance criterion, and is recorded as `asserted` for
    // exactly that reason. The release gate is where an unproven criterion
    // stops the task, so a weak stage result is never promoted into a strong one.
    next.stages[stage].manifest = buildManifest(next, {
      stage,
      actor,
      // Which attempt at this stage produced the evidence. Recorded so reused
      // evidence from an earlier attempt is detectable; every manifest used to
      // say `1` because nothing ever supplied it.
      attempt: attemptNumberFor(next, stage),
      dispatchId: dispatchId || `${stage}-${Date.parse(now) || Date.now()}`,
      commitSha: commitSha || verifiedCommitFor(next, stage),
      // Prefer the agent's described artifacts and criterion claims when it
      // supplied them; fall back to bare paths otherwise. Either way the digests
      // are computed here, from the real files — never taken from the agent.
      artifacts: agentEvidence?.artifacts?.length ? agentEvidence.artifacts : evidence,
      criteriaProofs: agentEvidence?.criteriaProofs || [],
      limitations: agentEvidence?.limitations || null,
      verdict: outcome,
      // Bind what is on disk; do not fail the transition over an artifact the
      // protocol layer already checks with verifyEvidence().
      strict: false,
      now,
    });
    next.stages[stage].evidenceStrength = "asserted";
  } else {
    next.stages[stage].evidenceStrength = "asserted";
  }

  if (outcome !== "pass") {
    next.status = "blocked";
    next.blocker = { stage, outcome, summary: String(summary), actor, at: now };
    return next;
  }

  // The auto-retry sweep is the only thing that revives a task whose runner
  // died, and its budget was counted once per task for the task's whole life.
  // A task that needed reviving three times during a flaky builder phase then
  // had no supervision left for the five stages after it, so any later stall
  // was permanent until a human noticed. The budget is meant to stop a task
  // looping on one stuck point, not to cap how long a task may live: a stage
  // that actually passed is forward progress, so the allowance starts over.
  delete next.autoRetries;

  if (deferredDecision) {
    const decision = normalizeDeferredDecision(deferredDecision, stage, now);
    next.stages[stage].deferredDecision = decision;
    next.deferredDecisions = [...(next.deferredDecisions || []), decision];
    next.events.push({
      at: now,
      type: "stage-decision-deferred",
      stage,
      actor,
      decisionId: decision.id,
      // An unescalated decision is not a hidden one: the event log says the
      // stage asked, and says why the founder was not brought in.
      escalated: decision.escalate,
      impact: decision.impact,
      reason: decision.escalationReason,
    });
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
  // Whether this reaches the founder at all. Recorded on the decision rather
  // than decided by whoever renders it, so the task's own file says why the
  // founder was or was not asked. See hq/escalation-gate.mjs.
  const verdict = escalationVerdict(input);
  return {
    id: String(input.id || `${stage}-${Date.parse(now) || Date.now()}`),
    stage,
    question,
    why: String(input.why || "The team completed the safe work and is reporting this choice for your review.").trim(),
    options,
    recommendation: String(input.recommendation || "").trim(),
    requestedAt: now,
    impact: verdict.impact,
    escalate: verdict.escalate,
    escalationReason: verdict.reason,
  };
}

export function resumeState(state, now = new Date().toISOString(), options = {}) {
  if (state.status !== "blocked") throw new Error("Only a blocked task can be resumed.");
  if (state.blocker?.stage === "builder" && state.task.risk === "high" && !hasValidFounderApproval(state, options)) {
    throw new Error("High-risk build cannot resume without recorded founder approval.");
  }
  // Resuming means the blocker that spent the budget has been dealt with.
  // Carrying its attempts forward is what made a crashed gateway escalate on
  // its first occurrence, reported as three strategies that never ran.
  const next = closeRecoveryIncident(state, { reason: "founder-resumed", now });
  next.status = "active";
  next.stages[next.currentStage] = { status: "pending" };
  delete next.blocker;
  next.updatedAt = now;
  next.events.push({ at: now, type: "task-resumed", stage: next.currentStage });
  return next;
}

const REVIEW_STAGES = new Set(["reviewer", "qa", "security", "release"]);

// Infrastructure gets a longer rope than rejection: a flaky seat is worth
// retrying more often than a stage that keeps saying no, and neither is free.
export const DEFAULT_MAX_INFRA_ATTEMPTS = 6;


// A stage attempt only means "this stage rejected the work" when the stage
// actually returned a verdict. A dispatch that produced none — the agent could
// not be reached, the runner was orphaned, the route ran and wrote nothing —
// says nothing about the work, but was counted the same way.
//
// That is how lifemaxing obj-c58897c0 reached "builder has already used 7 of 3
// stage attempts" off a single genuine rejection: attempts 1-6 were an
// actor/agent-id mismatch, an orphaned runner and a provider quota failure.
// The budget meant for "this stage keeps rejecting the work" was spent on the
// factory failing to run it, and the task escalated to the founder.
//
// Both kinds still have to be bounded — an unreachable route must not retry
// forever — so they are counted separately against separate allowances rather
// than one of them being made free.
export function countStageAttempts(state, stage) {
  const dispatches = (state?.dispatches || []).filter(
    (item) => item.stage === stage && (item.kind === "stage" || !item.kind),
  );
  let verdicts = 0;
  let infra = 0;
  for (const item of dispatches) {
    // `infraFailure` is set by the concurrent review fan-out, which has to
    // write a real `fail` result for a member whose agent could not start so
    // the engine routes it. That outcome is a routing artifact, not a verdict —
    // nothing judged the work — so it belongs in the infrastructure allowance.
    if (item.outcome && !item.infraFailure) verdicts += 1;
    else infra += 1;
  }
  return { verdicts, infra, total: dispatches.length };
}

// Which budget, if either, this stage has exhausted.
export function stageBudgetExceeded(state, stage, { maxAttemptsPerStage = 3, maxInfraAttemptsPerStage = DEFAULT_MAX_INFRA_ATTEMPTS } = {}) {
  const { verdicts, infra } = countStageAttempts(state, stage);
  if (verdicts >= maxAttemptsPerStage) {
    return { exceeded: "verdicts", verdicts, infra, limit: maxAttemptsPerStage };
  }
  if (infra >= maxInfraAttemptsPerStage) {
    return { exceeded: "infra", verdicts, infra, limit: maxInfraAttemptsPerStage };
  }
  return { exceeded: null, verdicts, infra };
}

export function routeStageFailure(state, { failedStage, targetStage, maxAttemptsPerStage = 3, maxInfraAttemptsPerStage = DEFAULT_MAX_INFRA_ATTEMPTS, now = new Date().toISOString() }) {
  if (state.blocker?.outcome !== "fail") return state;
  const budget = stageBudgetExceeded(state, failedStage, { maxAttemptsPerStage, maxInfraAttemptsPerStage });
  if (budget.exceeded) return state;
  const attempts = budget.verdicts + budget.infra;
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

// ── recovery incidents ───────────────────────────────────────────────────────
//
// `maxAttempts` bounds ONE incident — one failure the factory is currently
// trying to repair — not the life of the task.
//
// It used to bound the life of the task, because nothing ever reset the count.
// Two consequences, both seen in production on obj-c58897c0:
//
//   * A repair that WORKED still spent budget forever. `recordRecoveryResult`
//     cleared `active` on a verified repair but left the attempt on the list,
//     so a task could only ever be recovered three times however well each one
//     went.
//   * A later, unrelated failure inherited an exhausted budget and escalated on
//     its FIRST occurrence. The reviewer stage died on a crashed OpenClaw
//     Gateway and went straight to the founder, never once retried, because
//     three attempts had been spent days earlier on a merge conflict that was
//     resolved long before.
//
// The second one also lied to the founder: `escalateRecovery` renders
// `whatFactoryTried` from the attempt list, so the blocker read "retry-recover:
// failed; deeper-diagnosis: failed; independent-review: failed" about a failure
// nothing had ever touched. Those three strings described the merge conflict.
//
// The fix scopes the BUDGET without touching the RECORD. Every attempt carries
// the incident it belongs to and stays on `attempts` forever — the dashboard,
// the learning evidence exporter and `recovery.attempts.at(-1)` all keep
// working, and no audit history is lost. Only the count that gates a new
// attempt is filtered to the open incident.
//
// An incident closes when the failure it was about stops being the task's
// problem: a verified repair, or a founder resuming past the blocker.
// `attempts.length` keeps growing across incidents and is bounded by
// `maxTotalAttempts`, so "budget per incident" can never mean "unbounded".
export function normalizeRecovery(recovery = {}) {
  const maxAttempts = Number(recovery.maxAttempts) || 3;
  return {
    ...recovery,
    maxAttempts,
    // A ceiling on automated recovery for the whole task, whatever the shape of
    // the incidents. Three full incidents by default.
    maxTotalAttempts: Number(recovery.maxTotalAttempts) || maxAttempts * 3,
    // Legacy state has attempts but no incident tag. They predate the split and
    // belong to whatever was open when they were written: incident 1.
    incident: Number(recovery.incident) || 1,
    attempts: Array.isArray(recovery.attempts) ? recovery.attempts : [],
    active: recovery.active ?? null,
  };
}

// The attempts that count against `maxAttempts` right now.
export function openIncidentAttempts(recovery = {}) {
  const incident = Number(recovery.incident) || 1;
  return (recovery.attempts || []).filter((a) => (Number(a.incident) || 1) === incident);
}

// Retire the open incident and return the budget. Pure; safe to call when no
// incident is open. Nothing is deleted — the attempts stay on the record under
// their old incident number.
export function closeRecoveryIncident(state, { reason, now = new Date().toISOString() } = {}) {
  const next = structuredClone(state);
  next.recovery = normalizeRecovery(next.recovery || {});
  const open = openIncidentAttempts(next.recovery);
  if (open.length) {
    next.recovery.incident += 1;
    next.events.push({ at: now, type: "recovery-incident-closed", stage: open[0]?.failedStage || null, actor: "system", reason: String(reason || "closed"), attempts: open.length });
  }
  next.recovery.active = null;
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
  next.recovery = normalizeRecovery({ ...(next.recovery || {}), maxAttempts: Number(maxRecoveryAttempts) || Number(next.recovery?.maxAttempts) || 3, active: null });
  if (!isRecoverableFailure(kind)) return next;
  const used = openIncidentAttempts(next.recovery).length;
  if (used >= next.recovery.maxAttempts) return escalateRecovery(next, { failedStage, kind, error, now });
  // The task-wide ceiling. Reaching it is its own kind of founder decision: the
  // open incident is still in budget, but this task has consumed more automated
  // repair than any task should, so say that rather than reporting it as one
  // more exhausted incident.
  if (next.recovery.attempts.length >= next.recovery.maxTotalAttempts) {
    return escalateRecovery(next, {
      failedStage,
      kind: "FOUNDER_DECISION_REQUIRED",
      error: `This task has spent ${next.recovery.attempts.length} recovery attempt(s) across ${next.recovery.incident} incident(s), reaching its task-wide ceiling of ${next.recovery.maxTotalAttempts}. The latest failure was: ${String(error || "unknown failure")}`,
      now,
    });
  }
  const attempt = {
    // Numbered WITHIN the incident, so `recoveryStrategy` still walks
    // retry-recover -> deeper-diagnosis -> independent-review for every
    // incident rather than falling off the end of the list on the second one.
    incident: next.recovery.incident,
    // Monotonic across the whole task and never reused. `number` restarts each
    // incident, and computeDispatchPaths built dispatch ids from it — so a new
    // incident recomputed an id an earlier one had already spent, and
    // markDispatchRunning's `running:<id>` idempotency key replayed the old
    // commit instead of marking the dispatch running. See the note there.
    ordinal: next.recovery.attempts.length + 1,
    number: used + 1, strategy: recoveryStrategy(used + 1), originalObjective: next.task.outcome,
    failedStage, agent: actor, error: String(error || "unknown failure"), classification: kind,
    repairTarget: repairTargetFor(kind), relevantEvidence: structuredClone(evidence),
    attemptedActions: [], currentState: next.status, diagnosis: null, repair: null, verification: null,
    status: "diagnosing", startedAt: now,
  };
  next.recovery.attempts = [...next.recovery.attempts, attempt];
  next.recovery.active = { phase: "diagnose", failedStage, attempt: attempt.number, ordinal: attempt.ordinal };
  next.status = "active";
  next.currentStage = failedStage;
  delete next.blocker;
  next.updatedAt = now;
  next.events.push({ at: now, type: "failure-classified", stage: failedStage, actor: "system", classification: kind, error: String(error || "") });
  next.events.push({ at: now, type: "recovery-diagnosing", stage: failedStage, actor: "recovery", attempt: attempt.number, classification: kind });
  return next;
}

export function recordRecoveryResult(state, { outcome, actor, summary, evidence = [], diagnosis = null, maxAttemptsPerStage = 3, maxInfraAttemptsPerStage = DEFAULT_MAX_INFRA_ATTEMPTS, now = new Date().toISOString() }) {
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
    const budget = stageBudgetExceeded(next, resumeAt, { maxAttemptsPerStage, maxInfraAttemptsPerStage });
    const attempts = budget.verdicts + budget.infra;
    if (budget.exceeded) {
      const spent = budget.exceeded === "verdicts"
        ? `returned ${budget.verdicts} verdict(s) of ${budget.limit} allowed`
        : `lost ${budget.infra} dispatch(es) of ${budget.limit} allowed before any verdict — the factory could not run it, rather than it rejecting the work`;
      return escalateRecovery(next, {
        failedStage: resumeAt,
        kind: "FOUNDER_DECISION_REQUIRED",
        error: `Recovery attempt ${active.attempt} was independently verified, but ${resumeAt} has ${spent}. Re-running it would exceed that budget. Founder direction is required: accept the verified work and advance, raise the budget, or change scope.`,
        now,
      });
    }
    // The failure this incident was about is repaired and independently
    // verified. Retire it so the NEXT failure, whatever it turns out to be,
    // gets its own attempts instead of inheriting a spent budget.
    Object.assign(next, closeRecoveryIncident(next, { reason: "recovery-verified", now }));
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
  const openCount = openIncidentAttempts(next.recovery).length;
  if (openCount < next.recovery.maxAttempts && next.recovery.attempts.length < next.recovery.maxTotalAttempts && isRecoverableFailure(kind)) {
    const ordinal = next.recovery.attempts.length + 1;
    next.recovery.active = { phase: "diagnose", failedStage: active.failedStage, attempt: openCount + 1, ordinal };
    next.recovery.attempts.push({ incident: next.recovery.incident, ordinal, number: openCount + 1, strategy: recoveryStrategy(openCount + 1), originalObjective: next.task.outcome, failedStage: active.failedStage, agent: "recovery", error, classification: kind, repairTarget: repairTargetFor(kind), relevantEvidence: [], attemptedActions: [], currentState: next.status, diagnosis: null, repair: null, verification: null, status: "diagnosing", startedAt: now });
    next.events.push({ at: now, type: "recovery-diagnosing", stage: active.failedStage, actor: "recovery", attempt: openCount + 1, classification: kind });
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
    // Only this incident. Rendering every attempt the task ever made is what
    // told the founder three strategies had been tried on a reviewer failure
    // that was never retried once.
    whatFactoryTried: openIncidentAttempts(next.recovery).map((a) => `${a.strategy}: ${a.status}`).join("; ") || "No recovery attempt was available.",
    whatItNeedsFromFounder: "Review the recorded failure and decide whether to repair the project, factory, or environment, or change the task scope.",
    whatHappensAfterApproval: "The original task will resume from the failed stage after the blocker is resolved.",
    summary: `Recovery could not continue after ${openIncidentAttempts(next.recovery).length} bounded attempt(s): ${String(error || "unknown failure")}`,
    at: now,
  };
  next.events.push({ at: now, type: "recovery-escalated", stage: failedStage, actor: "system", classification: kind });
  next.updatedAt = now;
  return next;
}

export function recordFounderApproval(state, { assertion, evidence, authority = {}, now = new Date().toISOString() }) {
  if (state.task.risk !== "high") throw new Error("Founder approval is only required for high-risk tasks.");
  if (!evidence?.path) throw new Error("Founder approval requires an evidence artifact.");
  validateFounderAssertion(state, assertion, evidence, now, { enforceFreshness: true, authority });
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

// The commit the review stages are judging.
//
// Reviewer, QA and security run concurrently once the builder is done, so they
// must all be judging the same tree. That SHA is recorded once, before the
// group starts, and every manifest from those stages is bound to it.
// How many times this stage has been dispatched, counting the one completing now.
export function attemptNumberFor(state, stage) {
  const prior = (state?.dispatches || []).filter((d) => d.stage === stage).length;
  return prior + 1;
}

export function verifiedCommitFor(state, stage) {
  if (!stageMustProveCriteria(stage) && stage !== "release") return null;
  return state?.verifiedCommit?.sha || null;
}

// Freeze the tree under review. Called when the builder finishes, before the
// concurrent review group is dispatched.
//
// If the SHA differs from one already recorded, the source changed: downstream
// evidence was produced against a tree that no longer exists, so it is
// invalidated rather than carried forward (requirement 8).
export function recordVerifiedCommit(state, { sha, actor = "system", now = new Date().toISOString() }) {
  const commit = String(sha || "").trim();
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error(`Not a valid commit sha: ${sha}`);

  const next = structuredClone(state);
  const previous = next.verifiedCommit?.sha || null;
  next.verifiedCommit = { sha: commit, recordedAt: now, actor };
  next.updatedAt = now;

  if (previous && previous !== commit) {
    // Evidence produced against a tree that no longer exists does not count, so
    // the review stages re-open. This is what makes "changing code after QA
    // invalidates review/QA/security" true rather than aspirational.
    const invalidated = [];
    for (const stage of STAGES) {
      if (!stageMustProveCriteria(stage)) continue;
      const result = next.stages[stage];
      if (!result || result.status === "pending") continue;
      invalidated.push(stage);
      next.stages[stage] = { status: "pending", invalidatedBy: { previous, commit, at: now } };
    }
    if (invalidated.length) {
      // Re-open the pipeline at the first stage whose verdict no longer applies.
      const firstIndex = Math.min(...invalidated.map((stage) => STAGES.indexOf(stage)));
      next.currentStage = STAGES[firstIndex];
      next.status = "active";
      delete next.blocker;
    }
    next.events.push({
      at: now,
      type: "evidence-invalidated",
      stage: next.currentStage,
      actor,
      reason: "source changed after verification",
      previous,
      commit,
      stages: invalidated,
    });
  } else if (!previous) {
    next.events.push({ at: now, type: "commit-frozen", stage: next.currentStage, actor, commit });
  }
  return next;
}

// What a stage's evidence actually establishes. Used by the release gate and the
// completion report so a weak claim is never presented as a strong one.
export function evidenceStrengthOf(state, stage) {
  const result = state?.stages?.[stage];
  if (!result) return "none";
  if (result.manifest) return result.evidenceStrength === "verified" ? "verified" : "asserted";
  if (Array.isArray(result.evidence) && result.evidence.length) return "asserted";
  return "none";
}

// Criteria that no verification stage marked `proven`.
export function unprovenCriteria(state) {
  const criteria = criteriaForState(state);
  const settled = new Set();
  for (const stage of STAGES) {
    const manifest = state?.stages?.[stage]?.manifest;
    if (!manifest) continue;
    for (const entry of manifest.criteria || []) {
      // Only a proof the factory can stand behind settles a criterion.
      //
      // `not-applicable` used to count, and nothing constrains who declares it:
      // an agent could mark every criterion N/A with a three-word note and walk
      // straight through the gate the docs hold out as the real enforcement.
      // Deciding a criterion does not apply is a scope judgement, and scope is
      // the founder's call — so it is surfaced as outstanding, not self-granted.
      //
      // `kind` is checked too, because this function and verifyManifest must
      // agree on what "proven" means. An asserted claim is not one.
      if (entry.status === "proven" && entry.kind && entry.kind !== "asserted") {
        settled.add(entry.id);
      }
    }
  }
  return criteria.filter((c) => !settled.has(c.id));
}

// Criteria a stage declared out of scope or blocked. Reported to the founder
// rather than silently counted as satisfied.
export function excusedCriteria(state) {
  const out = [];
  for (const stage of STAGES) {
    const manifest = state?.stages?.[stage]?.manifest;
    if (!manifest) continue;
    for (const entry of manifest.criteria || []) {
      if (entry.status === "not-applicable" || entry.status === "blocked") {
        out.push({ id: entry.id, stage, status: entry.status, note: entry.note || null });
      }
    }
  }
  return out;
}

// A founder-facing account of what each stage established, keeping asserted,
// observed and independently verified claims apart.
export function evidenceLedger(state) {
  return STAGES.map((stage) => {
    const result = state?.stages?.[stage] || {};
    return {
      stage,
      status: result.status || "pending",
      actor: result.actor || null,
      strength: evidenceStrengthOf(state, stage),
      ...(result.manifest ? { manifest: summarizeManifest(result.manifest) } : {}),
    };
  });
}

// The commit the worktree is actually on right now. Read at the gate, never
// cached: a value frozen earlier cannot detect a change that happened later.
// Fixed argv, no shell. An unreadable HEAD returns null and the caller keeps the
// frozen value rather than failing a task over a git hiccup.
export function currentHeadSha(worktree) {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: resolve(worktree),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    const sha = String(out).trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
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
  if (state.task.risk === "high") {
    const approval = founderApprovalStatus(state);
    if (!approval.satisfied) {
      // Say which of the several possible problems it actually is. "No recorded
      // founderApproval" was wrong whenever one WAS recorded but failed to
      // verify, and left the founder with nothing to act on.
      throw new Error(`Release gate failed: high-risk task is not authorized — ${approval.reason}`);
    }
  }

  // Legacy tasks keep the old gate. They are reported as `legacy` evidence and
  // are never described as verified.
  if (evidencePolicyOf(state) !== EVIDENCE_POLICY_STRONG) return;

  const verified = state.verifiedCommit?.sha || null;
  if (!verified) {
    throw new Error("Release gate failed: no verified commit was recorded for the reviewed tree.");
  }

  // Re-read the tree HERE.
  //
  // Comparing manifest.commitSha against state.verifiedCommit.sha compares two
  // values that were BOTH frozen when the builder finished, so they always
  // agree and a commit landing after the reviewers signed off sails through.
  // "Changing code after QA invalidates review/QA/security" is only true if
  // something actually looks at the tree at the moment of release.
  const head = currentHeadSha(state.worktree);
  if (head && head !== verified) {
    throw new Error(
      `Release gate failed: the worktree has moved to ${head.slice(0, 10)} since the reviewed commit `
      + `${verified.slice(0, 10)}. Review, QA and security evidence describes a tree that no longer exists; `
      + "re-run them against the current commit.",
    );
  }

  for (const stage of STAGES) {
    if (!stageMustProveCriteria(stage)) continue;
    const manifest = state.stages[stage]?.manifest;
    if (!manifest) {
      throw new Error(`Release gate failed: ${stage} has no commit-bound evidence manifest.`);
    }
    const check = verifyManifest(state, manifest, { stage, commitSha: verified });
    if (!check.ok) {
      throw new Error(`Release gate failed: ${stage} evidence is no longer valid — ${check.errors.join(" | ")}`);
    }
  }

  // Criterion coverage.
  //
  // Binding and integrity above are enforced unconditionally: the factory
  // establishes those itself, from the filesystem and git. Proving that a
  // specific artifact demonstrates a specific acceptance criterion is different
  // — only the agent that did the work knows that mapping, and the agent-result
  // schema does not carry it yet. Requiring it today would fail every task for
  // a field no agent has been asked to produce.
  //
  // So it is recorded and surfaced (evidenceLedger, unprovenCriteria) rather
  // than silently assumed, and becomes a hard gate the moment agents emit
  // proofs — flip FACTORY_REQUIRE_CRITERION_PROOFS=1. Weak evidence is never
  // reported as strong: a stage with no proofs reads `asserted`, never
  // `verified`. See docs/software-factory/EVIDENCE_BACKED_COMPLETION.md.
  if (process.env.FACTORY_REQUIRE_CRITERION_PROOFS === "1") {
    const outstanding = unprovenCriteria(state);
    if (outstanding.length) {
      throw new Error(
        `Release gate failed: no stage proved acceptance criteria: ${outstanding.map((c) => c.id).join(", ")}`,
      );
    }
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

// `enforceFreshness` is true only when an approval is being RECORDED. Once the
// factory has verified and recorded it, the approval is a historical fact and
// re-checking its age on every later gate would kill a task the founder really
// did approve — a pipeline that outruns the TTL would fail at release with no
// way back, because isAwaitingFounderApproval() is false and the Inbox would
// not offer it for re-approval. Revocation, not expiry, is how a recorded
// approval is withdrawn.
function validateFounderAssertion(state, assertion, evidence, now = new Date().toISOString(), { enforceFreshness = false, authority: authorityOptions = {} } = {}) {
  if (!assertion || typeof assertion !== "object") throw new Error("Founder approval assertion is required.");
  const expected = state.founderApprovalRequest;
  if (!expected) throw new Error("This task has no founder approval request to satisfy.");

  // Task scope + exact requested action. A signature for another task, another
  // challenge, or another action is not an approval for this one.
  // Each of these must be a real value on BOTH sides. Comparing two `undefined`
  // fields succeeds, so deleting `challenge` from the request would otherwise
  // satisfy the check rather than fail it.
  for (const field of ["taskId", "challenge", "decision"]) {
    const want = expected[field];
    const got = assertion[field];
    if (typeof want !== "string" || !want.trim()) {
      throw new Error(`Founder approval request is missing ${field}; it cannot authorize anything.`);
    }
    if (want !== got) throw new Error("Founder approval assertion does not match this task challenge.");
  }
  if (!assertion.approvedAt || !assertion.evidenceSha256 || !assertion.signature) {
    throw new Error("Founder approval assertion is incomplete.");
  }

  // Which key to trust. When the deployment has an external anchor (the enrolled
  // key file, or FACTORY_FOUNDER_PUBLIC_KEY) that anchor WINS over whatever the
  // task state claims — otherwise an actor who can write task state could
  // substitute its own key and sign for itself, and the fingerprint "binding"
  // would happily compare two fields it also controls.
  const authority = authorityForVerification(state, authorityOptions);
  if (!authority?.publicKey) throw new Error("This task has no recorded approval authority.");

  // Fail closed when nothing outside the task state vouches for the key.
  //
  // Previously an unresolvable anchor fell back to the task's own record, so
  // deleting or corrupting one small file silently restored the exact
  // vulnerability this gate exists to close — and "no anchor" was
  // indistinguishable from "approved" at the two places that matter. A
  // high-risk build now requires a real anchor.
  //
  // FACTORY_ALLOW_UNANCHORED_APPROVAL=1 is an explicit, deliberately awkward
  // escape hatch for a deployment that has not enrolled a key yet.
  if (!authority.anchored && !allowUnanchoredApproval()) {
    throw new Error(
      "No trusted founder approval key is configured, so this approval cannot be verified. "
      + "Enroll a key in Headquarters or set FACTORY_FOUNDER_PUBLIC_KEY.",
    );
  }

  // The task points at a different key than the one this deployment trusts.
  // That is a tampering signal, not a routine mismatch.
  if (authority.mismatch) {
    throw new Error(
      "This task's approval authority does not match the key this deployment trusts. "
      + "Re-key the task from Headquarters, or investigate how it changed.",
    );
  }

  // v2 binds the authority fingerprint into the signed bytes. Reject a v1
  // assertion presented against a task that asked for v2 — that is a downgrade.
  const requestVersion = Number(expected.version || 1);
  const assertionVersion = Number(assertion.version || 1);
  if (assertionVersion !== requestVersion) {
    throw new Error(`Founder approval version mismatch: task expects v${requestVersion}, assertion is v${assertionVersion}.`);
  }
  if (requestVersion >= 2) {
    const bound = expected.authorityFingerprint;
    const actual = authority.fingerprint;
    if (!bound || bound !== actual) {
      throw new Error("Founder approval was issued for a different approval key than the one now on this task.");
    }
    if (assertion.authorityFingerprint && assertion.authorityFingerprint !== bound) {
      throw new Error("Founder approval authority fingerprint does not match this task.");
    }
  }

  // Revocation: a key the founder has retired can no longer authorize anything,
  // even if the signature itself is mathematically valid.
  const fingerprint = authority.fingerprint;
  if (isRevokedFingerprint(state, fingerprint)) {
    throw new Error("The approval key for this task has been revoked.");
  }

  // Expiry: bounds how long a SIGNATURE may sit unused before it is recorded.
  if (enforceFreshness) assertApprovalFreshness(expected, assertion, now);

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
  // A request with no TTL field falls back to the configured default. Absence
  // must not read as "this approval never expires".
  const declared = Number(request.expiresAfterSeconds);
  const ttlSeconds = Number.isFinite(declared) && declared > 0 ? declared : FOUNDER_APPROVAL_TTL_SECONDS;
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
// assertion that verifies against the authority recorded on the task. If this
// returns false the task stays blocked until a real signature arrives.
//
// The key this verifies against is resolved by founder-authority.mjs from
// OUTSIDE the task state (enrolled key file, or FACTORY_FOUNDER_PUBLIC_KEY), so
// an actor who can write task state cannot swap in a key of their own and sign
// for themselves. Where no anchor is configured the task's own record is used
// and founderApprovalStatus() reports `anchored: false`.
export function hasValidFounderApproval(state, options = {}) {
  if (!state?.founderApproval?.assertion || !state.founderApproval?.evidence) return false;
  try {
    validateFounderAssertion(state, state.founderApproval.assertion, state.founderApproval.evidence, new Date().toISOString(), options);
    return true;
  } catch {
    return false;
  }
}

// Why a high-risk task is not authorized, in words a founder can act on.
// Used by the release gate, and exported for the dashboard so "waiting for
// approval" is never confused with "approved".
export function founderApprovalStatus(state, now = new Date().toISOString(), options = {}) {
  if (state?.task?.risk !== "high") return { required: false, satisfied: true, reason: null, anchored: true };

  // Whether the key we would verify against comes from outside the task file.
  const authority = authorityForVerification(state, options.authority || {});
  const anchored = Boolean(authority?.anchored);

  if (!state.founderApproval?.assertion) {
    return {
      required: true,
      satisfied: false,
      anchored,
      authoritySource: authority?.source || null,
      reason: "No signed founder approval has been recorded.",
    };
  }
  try {
    validateFounderAssertion(state, state.founderApproval.assertion, state.founderApproval.evidence, now, options);
    return { required: true, satisfied: true, anchored, authoritySource: authority?.source || null, reason: null };
  } catch (error) {
    return {
      required: true,
      satisfied: false,
      anchored,
      authoritySource: authority?.source || null,
      reason: String(error.message || error),
    };
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
