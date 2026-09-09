// Adapted from Paperclip run-liveness-continuations.ts at pinned commit
// 6abeb67334348dcb6fde2d591a27ffc7efc7118d (MIT).
export const RUN_LIVENESS_STATES = Object.freeze(["completed", "advanced", "blocked", "failed", "plan-only", "empty-response", "needs-followup"]);
export const DEFAULT_MAX_LIVENESS_CONTINUATIONS = 2;
const ACTIONABLE = new Set(["plan-only", "empty-response"]);
const ACTIVE_TASK_STATUSES = new Set(["active", "ready", "building"]);

export function createRunLiveness(input, { now = () => new Date().toISOString() } = {}) {
  if (!RUN_LIVENESS_STATES.includes(input?.state)) throw new Error("Invalid run liveness state");
  const reason = String(input.reason || "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!reason) throw new Error("Run liveness reason is required");
  return { version: 1, runId: safe(input.runId, "runId"), taskId: safe(input.taskId, "taskId"), state: input.state, reason,
    nextAction: input.nextAction ? String(input.nextAction).replace(/\s+/g, " ").trim().slice(0, 500) : null,
    continuationAttempt: attempt(input.continuationAttempt), recoveryAttempt: attempt(input.recoveryAttempt), recordedAt: now() };
}

export function decideLivenessContinuation({ liveness, taskStatus, assignedActorId, runActorId, budgetBlocked = false, existingWakeup = false, maxAttempts = DEFAULT_MAX_LIVENESS_CONTINUATIONS }) {
  if (!liveness || !ACTIONABLE.has(liveness.state)) return { kind: "skip", reason: "liveness state is not actionable" };
  if (!ACTIVE_TASK_STATUSES.has(taskStatus)) return { kind: "skip", reason: `task status '${taskStatus}' is not continuable` };
  if (!assignedActorId || assignedActorId !== runActorId) return { kind: "skip", reason: "task is no longer assigned to the run actor" };
  if (budgetBlocked) return { kind: "skip", reason: "budget policy blocks continuation" };
  if (!Number.isInteger(maxAttempts) || maxAttempts < 0 || maxAttempts > 10) throw new Error("maxAttempts must be between 0 and 10");
  if (liveness.continuationAttempt >= maxAttempts) return { kind: "exhausted", attempt: liveness.continuationAttempt, maxAttempts,
    audit: { action: "run.liveness-exhausted", subject: { type: "task", id: liveness.taskId }, data: { state: liveness.state, reason: liveness.reason, nextAction: liveness.nextAction } } };
  const nextAttempt = liveness.continuationAttempt + 1;
  const idempotencyKey = ["run-liveness", liveness.taskId, liveness.runId, liveness.state, nextAttempt].join(":");
  if (existingWakeup) return { kind: "skip", reason: "continuation wakeup already exists", idempotencyKey };
  return { kind: "enqueue", nextAttempt, idempotencyKey,
    wakeup: { source: "recovery", taskRef: liveness.taskId, actorId: assignedActorId, idempotencyKey, contextRef: `run:${liveness.runId}` },
    instruction: liveness.nextAction || "Take the first concrete action now or mark the task blocked with a specific unblock request." };
}

export function applyLivenessToRun(run, liveness) {
  if (run?.id !== liveness?.runId) throw new Error("Liveness runId does not match run");
  return { ...run, liveness: { ...liveness } };
}

function attempt(value) { const number = Number(value || 0); return Number.isInteger(number) && number >= 0 ? number : 0; }
function safe(value, label) { const text = String(value || ""); if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(text)) throw new Error(`${label} is invalid`); return text; }
