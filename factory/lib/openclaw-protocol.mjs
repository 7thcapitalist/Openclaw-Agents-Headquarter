import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { completeStage, readState, recordRecoveryResult, routeStageFailure, startRecovery, verifyEvidence, writeState } from "./task-workflow.mjs";

// Which stages the workflow can route a failure AWAY from.
//
// A review stage judges someone else's work, so a FAIL there has a destination:
// the builder, who can fix it. That is the review loop, not a malfunction, and
// it is what #56 broke by putting recovery in front of every `fail` outcome —
// "the reviewer found a bug", the most routine event in a code factory, was
// diagnosed as an environment problem, burned the whole recovery budget, and
// escalated to the founder.
//
// A non-review stage (product, architect, builder) failed at its OWN work.
// There is nowhere to route it: the builder is already the one who failed, so
// re-dispatching it unchanged just repeats the failure. Those keep going to
// recovery first, which diagnoses before anyone retries.
const ROUTABLE_STAGES = new Set(["reviewer", "qa", "security", "release"]);
import { writeHandoff } from "./handoff.mjs";

export const PROTOCOL_VERSION = 1;

// The deterministic dispatch id and result path for a (task, stage) at its next
// attempt. `prepareDispatch` is the only writer of dispatch state; the concurrent
// review fan-out in openclaw-runner.mjs pre-computes the same ids/paths so the
// result files it writes are picked up verbatim by a later `prepareDispatch`.
export function computeDispatchPaths({ state, stage, statePath }) {
  const recovery = state.recovery?.active;
  const attempt = recovery ? recovery.attempt : (state.dispatches || []).filter((item) => item.stage === stage && (item.kind === "stage" || !item.kind)).length + 1;
  const dispatchId = recovery ? `${state.task.id}-recovery-${attempt}-${recovery.phase}` : `${state.task.id}-${stage}-${attempt}`;
  const resultPath = join(dirname(statePath), "results", `${dispatchId}.json`);
  return { dispatchId, resultPath, attempt };
}

export function prepareDispatch({ hqRoot, statePath, now = new Date().toISOString() }) {
  const state = readState(statePath);
  if (state.status !== "active") return terminalResponse(state);
  if (state.currentDispatch?.status === "ready" || state.currentDispatch?.status === "running") {
    return dispatchResponse(state.currentDispatch, state);
  }
  const recovery = state.recovery?.active;
  const stage = recovery?.failedStage || state.currentStage;
  const { dispatchId, resultPath, attempt } = computeDispatchPaths({ state, stage, statePath });
  mkdirSync(dirname(resultPath), { recursive: true });
  const promptPath = writeHandoff({ hqRoot, statePath, state, resultPath, dispatchId });
  const dispatch = {
    id: dispatchId,
    stage,
    actor: recovery ? (recovery.phase === "diagnose" ? "recovery" : state.assignments[recovery.verificationStage || "qa"]) : state.assignments[stage],
    kind: recovery ? `recovery-${recovery.phase}` : "stage",
    ...(recovery?.phase === "verify" ? { verificationStage: recovery.verificationStage || "qa" } : {}),
    status: "ready",
    attempt,
    promptPath,
    resultPath,
    createdAt: now,
  };
  state.currentDispatch = dispatch;
  state.updatedAt = now;
  state.events.push({ at: now, type: "dispatch-ready", stage, actor: dispatch.actor, dispatchId });
  writeState(statePath, state);
  return dispatchResponse(dispatch, state);
}

// A dispatch names its worker twice. `actor` is the workflow's logical actor
// (`codex`, `claude`, `openclaw`); `agentId` is the OpenClaw runtime agent that
// actually ran it (`backend-builder`). The handoff asks the agent to echo the
// logical actor, but an agent that knows its canonical id from AGENTS.md
// reports that instead — `backend-builder` rather than `codex`. Both name the
// same worker, so either is a truthful self-report. Accepting only the logical
// one discards a valid deliverable and sends an already-finished stage back
// into recovery, which is how one green builder result burned 11 attempts.
export function actorMatchesDispatch(resultActor, dispatch) {
  if (resultActor === dispatch.actor) return true;
  return Boolean(dispatch.agentId) && resultActor === dispatch.agentId;
}

function dispatchIdentityMismatch(result, dispatch) {
  const accepted = [dispatch.actor, dispatch.agentId].filter(Boolean).join("' or '");
  return `Agent result stage/actor does not match the active dispatch. ` +
    `Dispatch ${dispatch.id} is stage '${dispatch.stage}' by '${accepted}'; ` +
    `the result claims stage '${result.stage}' by '${result.actor}'.`;
}

// Record which runtime agent a dispatch was routed to. The runner resolves this
// only after the dispatch is already `ready`, so persist it separately rather
// than widening prepareDispatch — it is additive and lets a later ingest (after
// a restart, or through the concurrent fan-out) still recognise the identity
// the agent will report.
export function recordDispatchAgentId({ statePath, dispatchId, agentId }) {
  if (!agentId) return null;
  return withStateLock(statePath, () => {
    const state = readState(statePath);
    if (state.currentDispatch?.id !== dispatchId) return null;
    if (state.currentDispatch.agentId === agentId) return state.currentDispatch.agentId;
    state.currentDispatch.agentId = agentId;
    writeState(statePath, state);
    return agentId;
  });
}

export function markDispatchRunning({ statePath, dispatchId, now = new Date().toISOString() }) {
  return withStateLock(statePath, () => {
    const state = readState(statePath);
    assertCurrentDispatch(state, dispatchId);
    if (state.currentDispatch.status === "running") throw new Error(`Dispatch ${dispatchId} is already running.`);
    if (state.currentDispatch.status !== "ready") throw new Error(`Dispatch ${dispatchId} is not ready.`);
    state.currentDispatch.status = "running";
    state.currentDispatch.startedAt = now;
    state.updatedAt = now;
    state.events.push({ at: now, type: "dispatch-running", stage: state.currentStage, actor: state.currentDispatch.actor, dispatchId });
    writeState(statePath, state);
    return dispatchResponse(state.currentDispatch, state);
  });
}

export function ingestResult({ statePath, result, agentMeta = null, maxAttemptsPerStage = 3, now = new Date().toISOString() }) {
  validateAgentResult(result);
  const state = readState(statePath);
  assertCurrentDispatch(state, result.dispatchId);
  const dispatch = state.currentDispatch;
  if (result.stage !== dispatch.stage || !actorMatchesDispatch(result.actor, dispatch)) {
    throw new Error(dispatchIdentityMismatch(result, dispatch));
  }
  // Past the identity gate, the workflow speaks only logical actors: the
  // independence gates (builder != reviewer != qa) and every stage record
  // compare against `assignments`. Normalise here so a runtime-id self-report
  // never leaks into state and trip those comparisons downstream.
  const actor = dispatch.actor;
  if (dispatch.kind?.startsWith("recovery-")) {
    const evidence = verifyEvidence(result.evidence, state.worktree);
    const next = recordRecoveryResult(state, {
      outcome: result.outcome === "decision-deferred" ? "pass" : result.outcome,
      actor, summary: result.summary, evidence, diagnosis: result.diagnosis || null,
      maxAttemptsPerStage, now,
    });
    next.dispatches = [...(state.dispatches || []), { ...dispatch, status: "completed", outcome: result.outcome, summary: result.summary, completedAt: now, ...(agentMeta ? { usage: sanitizeUsage(agentMeta) } : {}) }];
    delete next.currentDispatch;
    writeState(statePath, next);
    return terminalResponse(next);
  }
  const evidence = verifyEvidence(result.evidence, state.worktree);
  const deferredDecision = result.outcome === "decision-deferred" ? result.decision : null;
  let next = completeStage(state, {
    stage: result.stage,
    actor,
    outcome: result.outcome === "decision-deferred" ? "pass" : result.outcome,
    summary: result.summary,
    evidence,
    deferredDecision,
    now,
  });
  const finished = { ...dispatch, status: "completed", outcome: result.outcome, summary: result.summary, completedAt: now };
  if (agentMeta) {
    finished.usage = sanitizeUsage(agentMeta);
  }
  next.dispatches = [...(state.dispatches || []), finished];
  delete next.currentDispatch;
  if (result.outcome === "fail") {
    // For a review stage the workflow's own loop runs first: a FAIL verdict
    // there is a judgement about the code, and it belongs back with the
    // builder. `routeStageFailure` already draws the right distinctions (review
    // FAIL to builder, infrastructure retried in place, release conflicts kept
    // at release) — since #56 it was simply unreachable. It returns the state
    // unchanged when it declines, which is how the per-stage budget still ends
    // the loop: once the stage has spent its attempts, recovery takes over and,
    // failing that, escalates to the founder.
    const routed = ROUTABLE_STAGES.has(result.stage)
      ? routeStageFailure(next, { failedStage: result.stage, maxAttemptsPerStage, now })
      : next;
    next = routed !== next
      ? routed
      : startRecovery(next, { failedStage: result.stage, actor, error: result.summary, evidence, source: "project", maxRecoveryAttempts: state.recovery?.maxAttempts || 3, now });
  }
  writeState(statePath, next);
  return terminalResponse(next);
}

export function failDispatch({ statePath, dispatchId, error, maxAttemptsPerStage = 3, now = new Date().toISOString() }) {
  const state = readState(statePath);
  assertCurrentDispatch(state, dispatchId);
  const dispatch = state.currentDispatch;
  if (dispatch.kind?.startsWith("recovery-")) {
    const next = recordRecoveryResult(state, { outcome: "fail", actor: dispatch.actor, summary: String(error), evidence: [], maxAttemptsPerStage, now });
    next.dispatches = [...(state.dispatches || []), { ...dispatch, status: "failed", error: String(error), completedAt: now }];
    delete next.currentDispatch;
    writeState(statePath, next);
    return terminalResponse(next);
  }
  state.status = "blocked";
  state.blocker = { stage: dispatch.stage, outcome: "fail", summary: String(error), actor: dispatch.actor, at: now };
  state.dispatches = [...(state.dispatches || []), { ...dispatch, status: "failed", error: String(error), completedAt: now }];
  delete state.currentDispatch;
  state.updatedAt = now;
  state.events.push({ at: now, type: "dispatch-failed", stage: dispatch.stage, actor: dispatch.actor, dispatchId });
  // Same order as the verdict path above, and for the same reason. A review
  // member whose agent never started has nothing for the builder to fix, so
  // `routeStageFailure` retries that stage in place rather than rebuilding the
  // world — but it has to be reached to do so.
  const routedFirst = ROUTABLE_STAGES.has(dispatch.stage)
    ? routeStageFailure(state, { failedStage: dispatch.stage, targetStage: dispatch.stage, maxAttemptsPerStage, now })
    : state;
  const next = routedFirst !== state
    ? routedFirst
    : startRecovery(state, { failedStage: dispatch.stage, actor: dispatch.actor, error: String(error), source: "harness", maxRecoveryAttempts: state.recovery?.maxAttempts || 3, now });
  writeState(statePath, next);
  return terminalResponse(next);
}

export function readResultFile(path) {
  if (!existsSync(path)) throw new Error(`Agent did not write its result file: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function validateAgentResult(result) {
  if (!result || result.version !== PROTOCOL_VERSION) throw new Error("Unsupported or missing agent result version.");
  for (const field of ["dispatchId", "stage", "actor", "outcome", "summary"]) {
    if (typeof result[field] !== "string" || !result[field].trim()) throw new Error(`Agent result is missing ${field}.`);
  }
  if (!new Set(["pass", "fail", "decision-required", "decision-deferred"]).has(result.outcome)) throw new Error("Invalid agent result outcome.");
  if (result.outcome === "decision-deferred" && (!result.decision || typeof result.decision !== "object")) throw new Error("A deferred decision requires a decision object.");
  if (result.outcome === "decision-deferred" && (!Array.isArray(result.decision.options) || result.decision.options.length < 2)) throw new Error("A deferred decision requires at least two options.");
  if (!Array.isArray(result.evidence) || result.evidence.length === 0 || !result.evidence.every((x) => typeof x === "string" && x.trim())) {
    throw new Error("Agent result requires one or more evidence paths.");
  }
}

function assertCurrentDispatch(state, dispatchId) {
  if (!state.currentDispatch || state.currentDispatch.id !== dispatchId) throw new Error(`Dispatch is stale or unknown: ${dispatchId}`);
}

function dispatchResponse(dispatch, state) {
  return {
    version: PROTOCOL_VERSION,
    status: "dispatch",
    taskId: state.task.id,
    taskStatus: state.status,
    dispatchId: dispatch.id,
    stage: dispatch.stage,
    actor: dispatch.actor,
    cwd: state.worktree,
    promptPath: dispatch.promptPath,
    resultPath: dispatch.resultPath,
    kind: dispatch.kind || "stage",
    ...(dispatch.verificationStage ? { verificationStage: dispatch.verificationStage } : {}),
  };
}

function terminalResponse(state) {
  return {
    version: PROTOCOL_VERSION,
    status: state.status,
    taskId: state.task.id,
    currentStage: state.currentStage,
    blocker: state.blocker || null,
  };
}

function sanitizeUsage(agentMeta) {
  if (!agentMeta || typeof agentMeta !== "object" || Array.isArray(agentMeta)) return null;
  const provider = typeof agentMeta.provider === "string" && agentMeta.provider.trim() ? agentMeta.provider.trim() : null;
  const model = typeof agentMeta.model === "string" && agentMeta.model.trim() ? agentMeta.model.trim() : null;
  const tokensIn = toInteger(agentMeta.tokensIn);
  const tokensOut = toInteger(agentMeta.tokensOut);
  if (!provider || !model || tokensIn == null || tokensOut == null) return null;
  const usage = { provider, model, tokensIn, tokensOut };
  const durationMs = toInteger(agentMeta.durationMs);
  if (durationMs != null) usage.durationMs = durationMs;
  return usage;
}

function toInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.trunc(parsed);
}

function withStateLock(statePath, action) {
  const lockPath = `${statePath}.lock`;
  let fd;
  try {
    try {
      fd = openSync(lockPath, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const ageMs = Date.now() - statSync(lockPath).mtimeMs;
      if (ageMs < 5 * 60 * 1000) throw new Error("Task state is locked by another dispatcher.");
      unlinkSync(lockPath);
      fd = openSync(lockPath, "wx");
    }
    return action();
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (fd !== undefined && existsSync(lockPath)) unlinkSync(lockPath);
  }
}
