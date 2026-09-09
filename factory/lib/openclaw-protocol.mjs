import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { completeStage, readState, recordRecoveryResult, routeStageFailure, startRecovery, verifyEvidence, writeState } from "./task-workflow.mjs";
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
  if (result.stage !== dispatch.stage || result.actor !== dispatch.actor) {
    throw new Error("Agent result stage/actor does not match the active dispatch.");
  }
  if (dispatch.kind?.startsWith("recovery-")) {
    const evidence = verifyEvidence(result.evidence, state.worktree);
    const next = recordRecoveryResult(state, {
      outcome: result.outcome === "decision-deferred" ? "pass" : result.outcome,
      actor: result.actor, summary: result.summary, evidence, diagnosis: result.diagnosis || null, now,
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
    actor: result.actor,
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
    next = startRecovery(next, { failedStage: result.stage, actor: result.actor, error: result.summary, evidence, source: "project", maxRecoveryAttempts: state.recovery?.maxAttempts || 3, now });
    if (!next.recovery?.active && next.status === "blocked") next = routeStageFailure(next, { failedStage: result.stage, maxAttemptsPerStage, now });
  }
  writeState(statePath, next);
  return terminalResponse(next);
}

export function failDispatch({ statePath, dispatchId, error, maxAttemptsPerStage = 3, now = new Date().toISOString() }) {
  const state = readState(statePath);
  assertCurrentDispatch(state, dispatchId);
  const dispatch = state.currentDispatch;
  if (dispatch.kind?.startsWith("recovery-")) {
    const next = recordRecoveryResult(state, { outcome: "fail", actor: dispatch.actor, summary: String(error), evidence: [], now });
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
  const recovered = startRecovery(state, { failedStage: dispatch.stage, actor: dispatch.actor, error: String(error), source: "harness", maxRecoveryAttempts: state.recovery?.maxAttempts || 3, now });
  const next = recovered.recovery?.active ? recovered : routeStageFailure(recovered, { failedStage: dispatch.stage, targetStage: dispatch.stage, maxAttemptsPerStage, now });
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
