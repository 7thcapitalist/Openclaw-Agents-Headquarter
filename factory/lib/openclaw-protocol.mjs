import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "fs";
import { basename, dirname, join } from "path";
import { randomUUID } from "crypto";
import { completeStage, recordRecoveryResult, routeStageFailure, startRecovery, verifyEvidence } from "./task-workflow.mjs";
import { mutateTransactionalState } from "./store/transactional-json.mjs";
import { writeHandoff } from "./handoff.mjs";

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


// A recovery dispatch id is `<task>-recovery-<attempt>-<phase>`, and `attempt`
// comes from the length of `recovery.attempts`. That number goes DOWN whenever
// the recovery budget is reset — after an operator repair, or any future
// automatic reset — while the result files from the previous cycle stay on
// disk. The next cycle then computes an id that already has a file, and
// `runOneStage` treats an existing result file as "this dispatch already
// answered".
//
// Observed on lifemaxing obj-c58897c0: three stale files were picked up this
// way. Two were rejected by the stage/actor check. The third happened to carry
// the same stage and actor, so it was ingested as a genuine `pass` and the
// orchestrator recorded a recovery cycle it never ran as independently
// verified — then resumed the stage on that basis.
//
// A newly prepared dispatch cannot legitimately have a result yet. Stage
// dispatches are the exception (the concurrent review fan-out pre-writes them
// by design), so this is limited to recovery dispatches, which nothing
// pre-writes. The file is parked under results/stale/ rather than deleted.
export function quarantineStaleResult(resultPath) {
  if (!existsSync(resultPath)) return null;
  const parked = join(dirname(resultPath), "stale", `${basename(resultPath, ".json")}-${Date.now()}.json`);
  try {
    mkdirSync(dirname(parked), { recursive: true });
    renameSync(resultPath, parked);
    return parked;
  } catch {
    try { unlinkSync(resultPath); } catch { /* best effort: never block a dispatch */ }
    return null;
  }
}

export function prepareDispatch({ hqRoot, statePath, now = new Date().toISOString() }) {
  let freshDispatch = null;
  const nextState = mutateTransactionalState(statePath, {
    // Preparing a dispatch is derived deterministically from state that is
    // itself only readable inside the transaction (the current attempt
    // count), so there is no stable idempotency key to pass in up front.
    // Correctness instead comes from the read-decide-write happening as one
    // atomic unit: a second concurrent caller's transaction only starts
    // after the first commits, and by then it observes the dispatch the
    // first one just created and takes the early-return branch below.
    commandId: `prepare:${randomUUID()}`,
    now,
    mutate: (state) => {
      if (!state) throw new Error(`No state at ${statePath}`);
      if (state.status !== "active") return undefined;
      if (state.currentDispatch?.status === "ready" || state.currentDispatch?.status === "running") return undefined;
      const recovery = state.recovery?.active;
      const stage = recovery?.failedStage || state.currentStage;
      const { dispatchId, resultPath, attempt } = computeDispatchPaths({ state, stage, statePath });
      const dispatch = {
        id: dispatchId,
        stage,
        actor: recovery ? (recovery.phase === "diagnose" ? "recovery" : state.assignments[recovery.verificationStage || "qa"]) : state.assignments[stage],
        kind: recovery ? `recovery-${recovery.phase}` : "stage",
        ...(recovery?.phase === "verify" ? { verificationStage: recovery.verificationStage || "qa" } : {}),
        status: "ready",
        attempt,
        promptPath: handoffPathFor(statePath, stage),
        resultPath,
        createdAt: now,
      };
      freshDispatch = dispatch;
      const next = structuredClone(state);
      next.currentDispatch = dispatch;
      next.updatedAt = now;
      next.events.push({ at: now, type: "dispatch-ready", stage, actor: dispatch.actor, dispatchId });
      return next;
    },
  });
  if (nextState.status !== "active") return terminalResponse(nextState);
  if (freshDispatch) {
    // File I/O (the handoff prompt) happens once, after the transaction that
    // decided this dispatch is the one that gets to exist has committed —
    // never inside the transaction itself.
    mkdirSync(dirname(freshDispatch.resultPath), { recursive: true });
    if (freshDispatch.kind?.startsWith("recovery-")) quarantineStaleResult(freshDispatch.resultPath);
    writeHandoff({ hqRoot, statePath, state: nextState, resultPath: freshDispatch.resultPath, dispatchId: freshDispatch.id });
  }
  return dispatchResponse(nextState.currentDispatch, nextState);
}

// Mirrors handoff.mjs's own (deterministic, state-independent) path so it can
// be computed inside the transaction, before the file itself is written
// (writeHandoff() is real file I/O and must run after the commit).
function handoffPathFor(statePath, stage) {
  return join(dirname(statePath), `handoff-${stage}.md`);
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
  const nextState = mutateTransactionalState(statePath, {
    commandId: `agent-id:${dispatchId}:${agentId}`,
    mutate: (state) => {
      if (!state || state.currentDispatch?.id !== dispatchId) return undefined;
      if (state.currentDispatch.agentId === agentId) return undefined;
      const next = structuredClone(state);
      next.currentDispatch.agentId = agentId;
      return next;
    },
  });
  return nextState?.currentDispatch?.id === dispatchId ? (nextState.currentDispatch.agentId ?? null) : null;
}

export function markDispatchRunning({ statePath, dispatchId, now = new Date().toISOString() }) {
  const nextState = mutateTransactionalState(statePath, {
    // Stable per dispatch: a retried call after a crash or a timed-out
    // response replays the original success instead of erroring on
    // "already running".
    commandId: `running:${dispatchId}`,
    now,
    mutate: (state) => {
      assertCurrentDispatch(state, dispatchId);
      if (state.currentDispatch.status === "running") throw new Error(`Dispatch ${dispatchId} is already running.`);
      if (state.currentDispatch.status !== "ready") throw new Error(`Dispatch ${dispatchId} is not ready.`);
      const next = structuredClone(state);
      next.currentDispatch.status = "running";
      next.currentDispatch.startedAt = now;
      next.updatedAt = now;
      next.events.push({ at: now, type: "dispatch-running", stage: next.currentStage, actor: next.currentDispatch.actor, dispatchId });
      return next;
    },
  });
  return dispatchResponse(nextState.currentDispatch, nextState);
}

export function ingestResult({ statePath, result, agentMeta = null, maxAttemptsPerStage = 3, now = new Date().toISOString() }) {
  validateAgentResult(result);
  // Stable per dispatch: two processes (or a retried delivery) ingesting the
  // same result must apply exactly once and both observe the same outcome,
  // never advance the workflow twice.
  const commandId = `ingest:${result.dispatchId}`;
  const next = mutateTransactionalState(statePath, {
    commandId,
    now,
    mutate: (state) => {
      assertCurrentDispatch(state, result.dispatchId);
      const dispatch = state.currentDispatch;
      if (result.stage !== dispatch.stage || !actorMatchesDispatch(result.actor, dispatch)) {
        throw new Error(dispatchIdentityMismatch(result, dispatch));
      }
      // Past the identity gate, the workflow speaks only logical actors: the
      // independence gates (builder != reviewer != qa) and every stage record
      // compare against `assignments`. Normalise here so a runtime-id
      // self-report never leaks into state and trips those comparisons
      // downstream.
      const actor = dispatch.actor;
      if (dispatch.kind?.startsWith("recovery-")) {
        const evidence = verifyEvidence(result.evidence, state.worktree);
        const recovered = recordRecoveryResult(state, {
          outcome: result.outcome === "decision-deferred" ? "pass" : result.outcome,
          actor, summary: result.summary, evidence, diagnosis: result.diagnosis || null,
          maxAttemptsPerStage, now,
        });
        recovered.dispatches = [...(state.dispatches || []), { ...dispatch, status: "completed", outcome: result.outcome, summary: result.summary, completedAt: now, ...(agentMeta ? { usage: sanitizeUsage(agentMeta) } : {}) }];
        delete recovered.currentDispatch;
        return recovered;
      }
      const evidence = verifyEvidence(result.evidence, state.worktree);
      const deferredDecision = result.outcome === "decision-deferred" ? result.decision : null;
      let completed = completeStage(state, {
        stage: result.stage,
        actor,
        outcome: result.outcome === "decision-deferred" ? "pass" : result.outcome,
        summary: result.summary,
        evidence,
        deferredDecision,
        now,
      });
      // NOT YET WIRED: freezing the reviewed commit here (FCT-P0-05 req 7).
      //
      // recordVerifiedCommit() is implemented and unit-tested, but calling it
      // from this point regresses 27 tests in the recovery and concurrent-review
      // flows — the builder ends up exhausting its per-stage attempt budget and
      // the task blocks asking the founder to raise it. I could not account for
      // that from the failures alone (the call site does not even appear to
      // execute in the failing runs), and wiring a gate I do not understand is
      // worse than leaving it visibly unwired.
      //
      // Enabling it needs the interaction between commit invalidation,
      // routeStageFailure's review-FAIL-to-builder routing, and the attempt
      // budget worked out deliberately. Until then the manifests built below
      // still carry digests, dispatch and stage binding — everything except the
      // commit anchor.

      const finished = { ...dispatch, status: "completed", outcome: result.outcome, summary: result.summary, completedAt: now };
      if (agentMeta) finished.usage = sanitizeUsage(agentMeta);
      completed.dispatches = [...(state.dispatches || []), finished];
      delete completed.currentDispatch;
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
          ? routeStageFailure(completed, { failedStage: result.stage, maxAttemptsPerStage, now })
          : completed;
        completed = routed !== completed
          ? routed
          : startRecovery(completed, { failedStage: result.stage, actor, error: result.summary, evidence, source: "project", maxRecoveryAttempts: state.recovery?.maxAttempts || 3, now });
      }
      return completed;
    },
  });
  return terminalResponse(next);
}

export function failDispatch({ statePath, dispatchId, error, maxAttemptsPerStage = 3, now = new Date().toISOString() }) {
  const next = mutateTransactionalState(statePath, {
    commandId: `fail:${dispatchId}`,
    now,
    mutate: (state) => {
      assertCurrentDispatch(state, dispatchId);
      const dispatch = state.currentDispatch;
      if (dispatch.kind?.startsWith("recovery-")) {
        const recovered = recordRecoveryResult(state, { outcome: "fail", actor: dispatch.actor, summary: String(error), evidence: [], maxAttemptsPerStage, now });
        recovered.dispatches = [...(state.dispatches || []), { ...dispatch, status: "failed", error: String(error), completedAt: now }];
        delete recovered.currentDispatch;
        return recovered;
      }
      const blocked = structuredClone(state);
      blocked.status = "blocked";
      blocked.blocker = { stage: dispatch.stage, outcome: "fail", summary: String(error), actor: dispatch.actor, at: now };
      blocked.dispatches = [...(state.dispatches || []), { ...dispatch, status: "failed", error: String(error), completedAt: now }];
      delete blocked.currentDispatch;
      blocked.updatedAt = now;
      blocked.events.push({ at: now, type: "dispatch-failed", stage: dispatch.stage, actor: dispatch.actor, dispatchId });
      // Same order as ingestResult's verdict path above, and for the same
      // reason: a review member whose agent never started has nothing for
      // the builder to fix, so routeStageFailure retries that stage in
      // place rather than rebuilding the world — but it has to be reached
      // first, before recovery gets a chance to intercept every `fail`.
      const routedFirst = ROUTABLE_STAGES.has(dispatch.stage)
        ? routeStageFailure(blocked, { failedStage: dispatch.stage, targetStage: dispatch.stage, maxAttemptsPerStage, now })
        : blocked;
      return routedFirst !== blocked
        ? routedFirst
        : startRecovery(blocked, { failedStage: dispatch.stage, actor: dispatch.actor, error: String(error), source: "harness", maxRecoveryAttempts: state.recovery?.maxAttempts || 3, now });
    },
  });
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

