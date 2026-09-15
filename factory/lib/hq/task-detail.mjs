// One task, in the detail the console's task screen needs.
//
// operations.tasks[] carries a single scalar `stage` — the CURRENT one — so
// there is no way to see the seven stages, what each one decided, what evidence
// it produced, why it failed, or what it cost. That detail does not belong in
// the list blob either: at 10x it is ~600 KB of payload nobody is looking at,
// rewritten whole every time anything anywhere changes.
//
// So: one document per task, following the one-blob-per-record pattern
// _lib/queue.mjs already uses for intents.
//
// EVIDENCE PATHS ONLY. Never a body, never a diff, never a patch. The paths are
// how a founder finds the proof on the machine; shipping the proof itself is
// what mirror.mjs's FORBIDDEN_KEYS and field ceilings exist to prevent.

export const TASK_DETAIL_CONTRACT = "hq.task/1";

const STAGES = ["product", "architect", "builder", "reviewer", "qa", "security", "release"];

function evidencePaths(evidence) {
  if (!Array.isArray(evidence)) return [];
  return evidence
    .map((item) => (typeof item === "string" ? item : item?.path))
    .filter((path) => typeof path === "string" && path.trim())
    .map((path) => String(path).trim())
    .slice(0, 20);
}

/** Dispatches that belong to one stage, oldest first. */
function dispatchesFor(state, stage) {
  return (Array.isArray(state?.dispatches) ? state.dispatches : [])
    .filter((d) => d?.stage === stage)
    .map((d) => ({
      id: d.id || d.dispatchId || null,
      kind: d.kind || "stage",
      actor: d.actor || null,
      status: d.status || null,
      outcome: d.outcome || null,
      attempt: Number.isFinite(d.attempt) ? d.attempt : null,
      infraFailure: d.infraFailure === true ? true : undefined,
      completedAt: d.completedAt || null,
      // Token usage per dispatch, when the ledger captured it.
      usage: d.usage ? { provider: d.usage.provider || null, model: d.usage.model || null, tokensIn: d.usage.tokensIn ?? null, tokensOut: d.usage.tokensOut ?? null, cachedInputTokens: d.usage.cachedInputTokens ?? null } : null,
    }));
}

/**
 * Build the detail document for one task.
 *
 * `costByStage` and `costTotal` are passed in rather than read here, so this
 * stays pure and the caller can price every task from one ledger read instead
 * of N.
 */
export function buildTaskDetail({ state, costByStage = {}, costTotal = null, maxAttemptsPerStage = 3, now = new Date().toISOString() } = {}) {
  if (!state?.task?.id) return null;

  const stages = STAGES.map((name) => {
    const record = state.stages?.[name] || {};
    const dispatches = dispatchesFor(state, name);
    const failures = (Array.isArray(state.failures) ? state.failures : []).filter((f) => f?.stage === name);
    return {
      stage: name,
      // pass / fail / decision-required / pending — exactly what the workflow wrote.
      status: record.status || "pending",
      agent: record.actor || state.assignments?.[name] || null,
      summary: record.summary || null,
      evidence: evidencePaths(record.evidence),
      evidenceStrength: record.evidenceStrength || null,
      completedAt: record.completedAt || null,
      attempts: dispatches.length,
      maxAttempts: maxAttemptsPerStage,
      dispatches,
      // Why it failed, in the words the stage used. This is the field the
      // console most needs and the one most likely to be long.
      failures: failures.map((f) => ({ at: f.at || null, classification: f.classification || null, agent: f.agent || null, error: f.error || null })),
      cost: costByStage[name] || null,
    };
  });

  const recovery = state.recovery
    ? {
        incident: state.recovery.incident ?? null,
        maxAttempts: state.recovery.maxAttempts ?? null,
        maxTotalAttempts: state.recovery.maxTotalAttempts ?? null,
        active: state.recovery.active ? { phase: state.recovery.active.phase, failedStage: state.recovery.active.failedStage, attempt: state.recovery.active.attempt ?? null, ordinal: state.recovery.active.ordinal ?? null } : null,
        attempts: (Array.isArray(state.recovery.attempts) ? state.recovery.attempts : []).map((a) => ({
          incident: a.incident ?? null, ordinal: a.ordinal ?? null, number: a.number ?? a.attempt ?? null,
          strategy: a.strategy || null, failedStage: a.failedStage || null, classification: a.classification || null,
          status: a.status || null, startedAt: a.startedAt || null, completedAt: a.completedAt || null, error: a.error || null,
        })),
      }
    : null;

  return {
    version: 1,
    contract: TASK_DETAIL_CONTRACT,
    generatedAt: now,
    taskId: state.task.id,
    projectId: state.task.project || null,
    objective: state.task.outcome || null,
    acceptanceCriteria: Array.isArray(state.task.acceptanceCriteria) ? state.task.acceptanceCriteria : [],
    risk: state.task.risk || null,
    status: state.status || "unknown",
    currentStage: state.currentStage || null,
    branch: state.branch || null,
    baseSha: state.baseSha || null,
    verifiedCommit: state.verifiedCommit?.sha || null,
    createdAt: state.createdAt || null,
    updatedAt: state.updatedAt || null,
    blocker: state.blocker || null,
    stages,
    recovery,
    cost: costTotal,
    // Where the work landed, when the release stage got that far.
    prUrl: state.pullRequest?.url || state.publish?.prUrl || null,
    previewUrl: state.deployment?.previewUrl || state.publish?.previewUrl || null,
  };
}

/** The ids a publisher should write detail blobs for. */
export function taskDetailId(taskId) {
  return String(taskId || "").trim();
}
