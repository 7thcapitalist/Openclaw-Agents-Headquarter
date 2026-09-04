import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { completeStage, readState, routeStageFailure, verifyEvidence, writeState } from "./task-workflow.mjs";
import { writeHandoff } from "./handoff.mjs";

export const PROTOCOL_VERSION = 1;

export function prepareDispatch({ hqRoot, statePath, now = new Date().toISOString() }) {
  const state = readState(statePath);
  if (state.status !== "active") return terminalResponse(state);
  if (state.currentDispatch?.status === "ready" || state.currentDispatch?.status === "running") {
    return dispatchResponse(state.currentDispatch, state);
  }
  const stage = state.currentStage;
  const attempt = (state.dispatches || []).filter((item) => item.stage === stage).length + 1;
  const dispatchId = `${state.task.id}-${stage}-${attempt}`;
  const resultDir = join(dirname(statePath), "results");
  mkdirSync(resultDir, { recursive: true });
  const resultPath = join(resultDir, `${dispatchId}.json`);
  const promptPath = writeHandoff({ hqRoot, statePath, state, resultPath, dispatchId });
  const dispatch = {
    id: dispatchId,
    stage,
    actor: state.assignments[stage],
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

export function ingestResult({ statePath, result, maxAttemptsPerStage = 3, now = new Date().toISOString() }) {
  validateAgentResult(result);
  const state = readState(statePath);
  assertCurrentDispatch(state, result.dispatchId);
  const dispatch = state.currentDispatch;
  if (result.stage !== dispatch.stage || result.actor !== dispatch.actor) {
    throw new Error("Agent result stage/actor does not match the active dispatch.");
  }
  const evidence = verifyEvidence(result.evidence, state.worktree);
  let next = completeStage(state, {
    stage: result.stage,
    actor: result.actor,
    outcome: result.outcome,
    summary: result.summary,
    evidence,
    now,
  });
  const finished = { ...dispatch, status: "completed", outcome: result.outcome, summary: result.summary, completedAt: now };
  next.dispatches = [...(state.dispatches || []), finished];
  delete next.currentDispatch;
  if (result.outcome === "fail") next = routeStageFailure(next, { failedStage: result.stage, maxAttemptsPerStage, now });
  writeState(statePath, next);
  return terminalResponse(next);
}

export function failDispatch({ statePath, dispatchId, error, maxAttemptsPerStage = 3, now = new Date().toISOString() }) {
  const state = readState(statePath);
  assertCurrentDispatch(state, dispatchId);
  const dispatch = state.currentDispatch;
  state.status = "blocked";
  state.blocker = { stage: dispatch.stage, outcome: "fail", summary: String(error), actor: dispatch.actor, at: now };
  state.dispatches = [...(state.dispatches || []), { ...dispatch, status: "failed", error: String(error), completedAt: now }];
  delete state.currentDispatch;
  state.updatedAt = now;
  state.events.push({ at: now, type: "dispatch-failed", stage: dispatch.stage, actor: dispatch.actor, dispatchId });
  const next = routeStageFailure(state, { failedStage: dispatch.stage, targetStage: dispatch.stage, maxAttemptsPerStage, now });
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
  if (!new Set(["pass", "fail", "decision-required"]).has(result.outcome)) throw new Error("Invalid agent result outcome.");
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
