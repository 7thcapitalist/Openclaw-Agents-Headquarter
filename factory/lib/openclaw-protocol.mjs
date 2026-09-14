import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "fs";
import { basename, dirname, join } from "path";
import { randomUUID } from "crypto";
import { DEFAULT_MAX_INFRA_ATTEMPTS, completeStage, recordRecoveryResult, recordVerifiedCommit, routeStageFailure, startRecovery, verifyEvidence } from "./task-workflow.mjs";
import { execFileSync } from "node:child_process";
import { mutateTransactionalState, readTransactionalState } from "./store/transactional-json.mjs";
import { writeHandoff } from "./handoff.mjs";
import { checkCapability } from "./hq/capability-check.mjs";

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
  // The id must be unique for the LIFE of the task, not within one incident.
  //
  // `recovery.active.attempt` counts within the open incident, so it restarts
  // at 1 every time an incident closes — and a dispatch id built from it then
  // collides with a dispatch from an earlier incident. Both halves of the
  // machinery key off that id:
  //
  //   * the result file — mitigated below by quarantineStaleResult()
  //   * markDispatchRunning's idempotency key, `running:<dispatchId>`, which
  //     is NOT mitigated. The store replays the earlier committed command
  //     instead of applying the mutation, so the dispatch stays "ready"
  //     forever while the agent call runs. The runner then waits on a
  //     dispatch the state machine believes was never started.
  //
  // Observed on obj-c58897c0: incident 2 attempt 1 recomputed
  // `-recovery-1-diagnose`, an id already spent by incident 1, and the run
  // wedged for ten hours with no blocker and no progress.
  //
  // `ordinal` is monotonic across the whole task and never reused. Legacy state
  // written before it existed falls back to `attempt`, which is what those
  // tasks already used.
  const ordinal = recovery ? (recovery.ordinal ?? recovery.attempt) : attempt;
  const dispatchId = recovery ? `${state.task.id}-recovery-${ordinal}-${recovery.phase}` : `${state.task.id}-${stage}-${attempt}`;
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

// The stage a dispatch would run, and who would run it — computed from a read
// outside the transaction so the capability check can happen before any state
// is written. Returns null when no dispatch would be created, so the check is
// skipped rather than recording a decision about work that cannot happen.
function prospectiveDispatch(statePath) {
  let state;
  try { state = readTransactionalState(statePath); } catch { return null; }
  if (!state || state.status !== "active") return null;
  if (state.currentDispatch?.status === "ready" || state.currentDispatch?.status === "running") return null;
  const recovery = state.recovery?.active;
  const stage = recovery?.failedStage || state.currentStage;
  if (!stage) return null;
  const actorId = recovery
    ? (recovery.phase === "diagnose" ? "recovery" : state.assignments?.[recovery.verificationStage || "qa"])
    : state.assignments?.[stage];
  return { state, stage, actorId };
}

function checkDispatchPermission({ hqRoot, statePath }) {
  if (!hqRoot) return;
  const prospective = prospectiveDispatch(statePath);
  if (!prospective) return;
  const { state, stage, actorId } = prospective;
  checkCapability({
    hqRoot,
    capability: "task.dispatch",
    action: `dispatch ${stage}`,
    actor: { type: "agent", id: actorId || "openclaw-factory" },
    scope: { type: "task", id: state.task?.id, projectId: state.task?.project || null },
    founderApproval: state.founderApproval || null,
    correlation: {
      taskId: state.task?.id,
      ...(state.task?.project ? { projectId: state.task.project } : {}),
      stage,
    },
  });
}

export function prepareDispatch({ hqRoot, statePath, now = new Date().toISOString() }) {
  // Running a stage is checked here, before the transaction that creates the
  // dispatch.
  //
  // The actor is only knowable from state, and the decision has to be made
  // before any dispatch exists — a denial that arrives after the task already
  // records a dispatch has denied nothing. So the state is read first and the
  // transaction's own early-return conditions are mirrored, which keeps the
  // audit log free of decisions about dispatches that were never going to be
  // created. The remaining gap is a genuine race with a concurrent caller, and
  // an audit record for a dispatch someone else created in the same instant is
  // accurate, not misleading.
  checkDispatchPermission({ hqRoot, statePath });

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

// The commit at the worktree's HEAD, or null when the worktree is not a git
// checkout. Fixed argv, never a shell. Failure is non-fatal: an unreadable HEAD
// leaves the tree unfrozen and the release gate reports that, rather than
// breaking a stage transition over it.
function headCommitOf(worktree) {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktree,
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

export function ingestResult({ statePath, result, agentMeta = null, maxAttemptsPerStage = 3, maxInfraAttemptsPerStage = DEFAULT_MAX_INFRA_ATTEMPTS, now = new Date().toISOString() }) {
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
        const evidence = verifyEvidence(evidencePathsOf(result.evidence), state.worktree);
        const recovered = recordRecoveryResult(state, {
          outcome: result.outcome === "decision-deferred" ? "pass" : result.outcome,
          actor, summary: result.summary, evidence, diagnosis: result.diagnosis || null,
          // A recovery pass that escalates carries the question it wants
          // answered. This is the path the 2026-09-14 integration escalation
          // took, and where its question was being dropped.
          decision: result.outcome === "decision-required" ? result.decision || null : null,
          maxAttemptsPerStage, maxInfraAttemptsPerStage, now,
        });
        recovered.dispatches = [...(state.dispatches || []), { ...dispatch, status: "completed", outcome: result.outcome, summary: result.summary, completedAt: now, ...(agentMeta ? { usage: sanitizeUsage(agentMeta) } : {}) }];
        delete recovered.currentDispatch;
        return recovered;
      }
      const evidence = verifyEvidence(evidencePathsOf(result.evidence), state.worktree);
      const deferredDecision = result.outcome === "decision-deferred" ? result.decision : null;
      // `decision-required` carries a question too. It was previously read only
      // for `decision-deferred`, so a required decision's question and options
      // never reached task state and the founder queue had nothing to show.
      const requiredDecision = result.outcome === "decision-required" ? result.decision || null : null;
      // The agent's own description of its artifacts and which criteria they
      // settle. `observed:false` is not negotiable here — the factory did not
      // run these commands, so nothing in this result can be treated as an
      // observed exit status (FCT-P0-05 security requirement: all agent-provided
      // metadata is untrusted).
      const claimed = manifestInputsFromResult(result, { observed: false });

      let completed = completeStage(state, {
        stage: result.stage,
        actor,
        outcome: result.outcome === "decision-deferred" ? "pass" : result.outcome,
        summary: result.summary,
        evidence,
        agentEvidence: claimed,
        dispatchId: dispatch.id || dispatch.dispatchId || null,
        deferredDecision,
        decision: requiredDecision,
        now,
      });
      // Freeze the tree the review stages will judge (FCT-P0-05, requirement 7).
      //
      // Reviewer, QA and security run concurrently once the builder is done, so
      // they must all be judging the same commit. Recording it here — as the
      // builder's work settles, before the group is dispatched — is what lets
      // every downstream manifest bind to it, and what makes a later source
      // change detectable instead of passing unnoticed.
      if (result.stage === "builder" && completed.status === "active") {
        const head = headCommitOf(state.worktree);
        if (head) completed = recordVerifiedCommit(completed, { sha: head, actor: "system", now });
      }

      const finished = { ...dispatch, status: "completed", outcome: result.outcome, summary: result.summary, completedAt: now };
      // Carry the fan-out's "this agent never ran" marker onto the durable
      // record, so the per-stage budget can tell a routing artifact from a
      // verdict long after the result file is gone.
      if (result.infraFailure === true) finished.infraFailure = true;
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
          ? routeStageFailure(completed, { failedStage: result.stage, maxAttemptsPerStage, maxInfraAttemptsPerStage, now })
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

export function failDispatch({ statePath, dispatchId, error, maxAttemptsPerStage = 3, maxInfraAttemptsPerStage = DEFAULT_MAX_INFRA_ATTEMPTS, now = new Date().toISOString() }) {
  const next = mutateTransactionalState(statePath, {
    commandId: `fail:${dispatchId}`,
    now,
    mutate: (state) => {
      assertCurrentDispatch(state, dispatchId);
      const dispatch = state.currentDispatch;
      if (dispatch.kind?.startsWith("recovery-")) {
        const recovered = recordRecoveryResult(state, { outcome: "fail", actor: dispatch.actor, summary: String(error), evidence: [], maxAttemptsPerStage, maxInfraAttemptsPerStage, now });
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
        ? routeStageFailure(blocked, { failedStage: dispatch.stage, targetStage: dispatch.stage, maxAttemptsPerStage, maxInfraAttemptsPerStage, now })
        : blocked;
      return routedFirst !== blocked
        ? routedFirst
        : startRecovery(blocked, { failedStage: dispatch.stage, actor: dispatch.actor, error: String(error), source: "harness", maxRecoveryAttempts: state.recovery?.maxAttempts || 3, now });
    },
  });
  return terminalResponse(next);
}

// Park a dispatch that failed for a DETERMINISTIC reason the retry ladder can
// never clear, as a founder decision.
//
// `failDispatch` is the right home for a failure whose cause might go away on
// its own — a dropped seat, a model that returned nothing. It routes the stage
// for another attempt and then hands the task to recovery. That is exactly the
// wrong treatment for a merge conflict between two sub-task branches: the merge
// is a pure function of two commits, so re-running it reproduces the same
// conflict, and three bounded recovery attempts burn in under a second before
// escalating the whole objective as INFRASTRUCTURE_ERROR. The founder is then
// asked to decide about a failure no agent ever looked at.
//
// So: record the dispatch as failed, state the real cause, and block on
// `decision-required` WITHOUT routeStageFailure or startRecovery.
export function blockDispatch({ statePath, dispatchId, error, now = new Date().toISOString() }) {
  const next = mutateTransactionalState(statePath, {
    commandId: `block:${dispatchId}`,
    now,
    mutate: (state) => {
      assertCurrentDispatch(state, dispatchId);
      const dispatch = state.currentDispatch;
      const blocked = structuredClone(state);
      blocked.status = "blocked";
      blocked.blocker = {
        stage: dispatch.stage,
        outcome: "decision-required",
        founderAction: true,
        summary: String(error),
        actor: dispatch.actor,
        at: now,
      };
      blocked.dispatches = [...(state.dispatches || []), { ...dispatch, status: "failed", error: String(error), completedAt: now }];
      delete blocked.currentDispatch;
      blocked.updatedAt = now;
      blocked.events.push({ at: now, type: "dispatch-blocked", stage: dispatch.stage, actor: dispatch.actor, dispatchId });
      return blocked;
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
  // Evidence may be a plain path (what every agent emits today) or an object
  // describing how the artifact was produced. Both are accepted; neither is
  // trusted beyond the path itself.
  if (!Array.isArray(result.evidence) || result.evidence.length === 0) {
    throw new Error("Agent result requires one or more evidence paths.");
  }
  for (const item of result.evidence) {
    const path = typeof item === "string" ? item : item?.path;
    if (typeof path !== "string" || !path.trim()) {
      throw new Error("Agent result requires one or more evidence paths.");
    }
    if (item && typeof item === "object" && item.exitStatus !== undefined && !Number.isInteger(item.exitStatus)) {
      throw new Error("Evidence exitStatus must be an integer.");
    }
  }
  if (result.criteria !== undefined) {
    if (!Array.isArray(result.criteria)) throw new Error("Agent result criteria must be an array.");
    for (const entry of result.criteria) {
      if (!entry || typeof entry !== "object") throw new Error("Each criterion entry must be an object.");
      if (typeof entry.id !== "string" || !entry.id.trim()) throw new Error("Each criterion entry needs an id.");
      if (!["proven", "blocked", "not-applicable"].includes(entry.status)) {
        throw new Error(`Invalid criterion status: ${entry.status}`);
      }
    }
  }
}

// Evidence paths, for the containment/existence check. Object form is reduced to
// its path; the descriptive fields are handled separately when the manifest is
// built, and are never allowed to stand in for a path.
export function evidencePathsOf(evidence) {
  return (Array.isArray(evidence) ? evidence : []).map((x) => (typeof x === "string" ? x : x?.path));
}

// Turn an agent's evidence + criteria claims into manifest inputs.
//
// SECURITY: `kind` is decided here, not by the agent. An agent describing its
// own work is `asserted` — recorded, never accepted as proof. Only a check the
// FACTORY ran and whose exit status it observed can be `observed`, and
// verifyManifest() refuses to let an assertion prove a criterion. That is what
// stops "the agent says the tests passed" from clearing the gate.
export function manifestInputsFromResult(result, { observed = false } = {}) {
  const artifacts = (Array.isArray(result.evidence) ? result.evidence : []).map((item) => {
    if (typeof item === "string") return { path: item, id: item };
    return {
      path: item.path,
      id: item.id || item.path,
      type: item.type,
      command: item.command,
      scenario: item.scenario,
      startedAt: item.startedAt,
      endedAt: item.endedAt,
      exitStatus: item.exitStatus,
      // Never taken from the agent.
      observed: Boolean(observed),
    };
  });

  const criteriaProofs = (Array.isArray(result.criteria) ? result.criteria : []).map((entry) => ({
    id: entry.id,
    status: entry.status,
    artifacts: Array.isArray(entry.artifacts) ? entry.artifacts : [],
    note: entry.note,
    kind: observed ? "observed" : "asserted",
  }));

  return { artifacts, criteriaProofs, limitations: result.limitations || null };
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

