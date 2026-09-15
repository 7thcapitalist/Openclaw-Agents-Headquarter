import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { setTimeout as delay } from "timers/promises";
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from "fs";
import { basename, dirname, join } from "path";
import { PROTOCOL_VERSION, blockDispatch, computeDispatchPaths, failDispatch, ingestResult, markDispatchRunning, prepareDispatch, readResultFile, recordDispatchAgentId } from "./openclaw-protocol.mjs";
import { describeAgentCompletion, parseAgentMeta } from "./hq/agent-meta.mjs";
import { DEFAULT_MAX_INFRA_ATTEMPTS, STAGES, readState } from "./task-workflow.mjs";
import { mutateTransactionalState, peekRevision } from "./store/transactional-json.mjs";
import { writeHandoff } from "./handoff.mjs";
import { publishMergeReadyTask } from "./hq/github-publish.mjs";
import { buildCompletionReport } from "./hq/completion-report.mjs";
import { sanitizeExcerpt } from "./common/redact.mjs";
import { observeDispatchState } from "./telemetry/dispatch.mjs";

const execFileAsync = promisify(execFile);

// A caller-supplied `execute` does not only stand in for an agent. The objective
// orchestrator uses one to perform the integration merge itself, and that merge
// can fail deterministically — two sub-task branches that conflict.
//
// Every other error out of `execute` means "the agent attempt failed", so the
// catch below converts it into a missing-result dispatch failure and lets the
// retry ladder work. Applying that to a merge conflict is how objective
// obj-c58897c0 stalled for two days: the conflict was rewritten as `builder
// dispatch wrote no result file ... Reason: merge conflict integrating
// factory/obj-c58897c0-game-backend`, the generic wrapper classified it
// INFRASTRUCTURE_ERROR, and three recovery attempts logged inside one second
// without an agent ever running. The orchestrator's own MergeConflict handler,
// which would have raised a clean founder decision naming the conflict, was
// unreachable because the error never escaped the runner.
//
// An error tagged `fatal` is therefore a control-flow signal for the CALLER:
// park the dispatch as a decision and rethrow it untouched.
export const isControlFlowError = (error) => error?.fatal === true;

// Stages that may run concurrently once the builder is done and the branch is
// frozen. All three read-only against the same worktree; order of results does
// not matter because the engine still applies them one at a time.
export const DEFAULT_CONCURRENT_GROUPS = [["reviewer", "qa", "security"]];

// The task workflow uses logical actors (for example `codex`) while OpenClaw
// dispatches to configured runtime agent ids (for example `backend-builder`).
// Keep that translation at the runner boundary so every caller, including
// recovery and scheduled retries, uses the same routing contract.
export function configuredAgentIds(hqRoot, agentIds = {}) {
  let fromConfig = {};
  try {
    const config = JSON.parse(readFileSync(join(hqRoot, "factory", "factory.config.json"), "utf8"));
    // Always import stage+harness routes ("qa:claude") and recovery routes.
    //
    // Bare PIPELINE STAGE routes ("reviewer", "security", "release") are
    // imported only when the caller supplied no map of its own. The
    // orchestrator passes the whole config explicitly and so already has them;
    // the approval-triggered run path passes nothing, and without this
    // selectAgentId finds no route for a stage whose config key has no colon
    // and silently falls back to the LOGICAL ACTOR as the agent id.
    //
    // That is `Unknown agent id "claude"` on lifemaxing
    // obj-c58897c0-game-frontend: `qa:claude` resolved and QA ran, while bare
    // `reviewer` and `security` were dropped and both stages failed to start
    // three times each on a route that could never have worked.
    //
    // Gating on "caller supplied nothing" keeps the guarantee the original
    // filter existed for: a direct caller or unit harness that deliberately
    // routes by logical actor (`{ openclaw: "main-agent" }`) still wins, and an
    // implicitly imported stage route never shadows it.
    const explicit = Object.keys(agentIds).length > 0;
    fromConfig = Object.fromEntries(Object.entries(config.openclawIntegration?.agentIds || {})
      .filter(([key]) => key.includes(":")
        || key === "recovery"
        || key === "recovery-verify"
        || (!explicit && STAGES.includes(key))));
  } catch { /* isolated unit tests may not have a factory config */ }
  return { ...fromConfig, ...agentIds };
}


export function isYieldedExecution(executed) {
  let envelope;
  try { envelope = JSON.parse(executed?.stdout || "{}"); } catch { return false; }
  if (envelope.status && envelope.status !== "ok") return false;
  return [envelope, envelope.result, envelope.result?.meta].some((part) =>
    part?.yielded === true || part?.livenessState === "paused");
}

// A yielded gateway turn is still owned by its delegated worker. Wait for the
// exact dispatch artifact; a bounded wait expiring is NOT a failed execution.
export async function waitForYieldedResult({ resultPath, wait = delay, now = Date.now,
  timeoutMs = 60 * 60 * 1000, pollMs = 5000, heartbeat = () => {} }) {
  const deadline = now() + timeoutMs;
  const ready = () => {
    try { return Boolean(readResultFile(resultPath)); } catch { return false; }
  };
  while (!ready()) {
    if (now() >= deadline) return false;
    heartbeat();
    await wait(Math.min(pollMs, deadline - now()));
  }
  return true;
}

export async function runOneStage({ hqRoot, statePath, agentIds = {}, maxAttemptsPerStage = 3, maxInfraAttemptsPerStage = DEFAULT_MAX_INFRA_ATTEMPTS, execute = executeOpenClaw, publish = publishMergeReadyTask, agentMetaByDispatchId = null, waitForResult = waitForYieldedResult }) {
  const initial = readState(statePath);
  if (initial.yieldedGroup) return { version: PROTOCOL_VERSION, status: "dispatch", taskId: initial.task.id, waiting: true };
  const prepared = prepareDispatch({ hqRoot, statePath });
  if (prepared.status !== "dispatch") return prepared;
  observeDispatchState({ hqRoot, statePath, phase: "ready", dispatchId: prepared.dispatchId });
  const owned = readState(statePath).currentDispatch;
  // A dispatcher can be restarted after it has claimed a dispatch but before
  // it writes the result. The state file is durable, so prepareDispatch returns
  // that same running dispatch on the next invocation. It is still owned by a
  // possible worker; never claim it twice and never turn this normal recovery
  // case into an exception. The recovery layer may later clear a genuinely
  // orphaned dispatch after its stale-work threshold.
  if (owned?.status === "running" && !owned.yieldedAt) {
    if (existsSync(prepared.resultPath)) {
      const resumed = ingestResult({ statePath, result: readResultFile(prepared.resultPath), maxAttemptsPerStage, maxInfraAttemptsPerStage });
      if (resumed.status === "merge-ready") resumed.githubPublish = publishAndRecord({ hqRoot, statePath, publish });
      if (["merge-ready", "blocked"].includes(resumed.status)) writeCompletionReport({ statePath });
      return resumed;
    }
    return { ...prepared, waiting: true };
  }
  if (owned?.status === "running" && owned.yieldedAt) {
    if (!existsSync(prepared.resultPath)) return { ...prepared, waiting: true };
    const resumed = ingestResult({ statePath, result: readResultFile(prepared.resultPath), maxAttemptsPerStage, maxInfraAttemptsPerStage });
    if (resumed.status === "merge-ready") resumed.githubPublish = publishAndRecord({ hqRoot, statePath, publish });
    if (["merge-ready", "blocked"].includes(resumed.status)) writeCompletionReport({ statePath });
    return resumed;
  }
  const routes = configuredAgentIds(hqRoot, agentIds);
  markDispatchRunning({ statePath, dispatchId: prepared.dispatchId });
  observeDispatchState({ hqRoot, statePath, phase: "running", dispatchId: prepared.dispatchId });
  let agentId;
  try {
    agentId = selectAgentId(prepared, routes, { strict: Object.keys(routes).some((key) => key === `${prepared.stage}:${prepared.actor}` || key.startsWith(`${prepared.stage}:`)) });
  } catch (error) {
    const diagnostic = `Factory routing error: ${error.message || error}`;
    const response = failDispatch({ statePath, dispatchId: prepared.dispatchId, error: diagnostic, maxAttemptsPerStage, maxInfraAttemptsPerStage });
    observeDispatchState({ hqRoot, statePath, phase: "failed", dispatchId: prepared.dispatchId, error: diagnostic });
    if (["merge-ready", "blocked"].includes(response.status)) writeCompletionReport({ statePath });
    return response;
  }
  // The agent will self-report either the logical actor or this runtime id.
  // Persist the routing decision so ingest recognises both.
  recordDispatchAgentId({ statePath, dispatchId: prepared.dispatchId, agentId });
  const sessionKey = `agent:${agentId}:factory-${prepared.dispatchId}`;
  let response;
  const startedAt = Date.now();
  try {
    const executed = existsSync(prepared.resultPath) ? {} : await execute({
      agentId,
      messageFile: prepared.promptPath,
      sessionKey,
      cwd: prepared.cwd,
      dispatch: prepared,
    });
    if (!existsSync(prepared.resultPath) && isYieldedExecution(executed)) {
      markYielded(statePath, prepared.dispatchId, prepared.stage);
      observeDispatchState({ hqRoot, statePath, phase: "yielded", dispatchId: prepared.dispatchId });
      const ready = await waitForResult({ resultPath: prepared.resultPath, heartbeat: () => touchState(statePath, prepared.dispatchId) });
      if (!ready) return { ...prepared, waiting: true };
    }
    const agentMeta = parseAgentMeta(executed, { durationMsFallback: Date.now() - startedAt })
      || agentMetaByDispatchId?.get(prepared.dispatchId)
      || null;
    if (!existsSync(prepared.resultPath)) {
      const diagnostic = writeMissingResultDiagnostic({
        worktree: prepared.cwd,
        dispatchId: prepared.dispatchId,
        stage: prepared.stage,
        actor: prepared.actor,
        sessionKey,
        resultPath: prepared.resultPath,
        stdout: executed?.stdout,
        stderr: executed?.stderr,
      });
      response = failDispatch({ statePath, dispatchId: prepared.dispatchId, error: diagnostic.summary, maxAttemptsPerStage, maxInfraAttemptsPerStage });
      observeDispatchState({ hqRoot, statePath, phase: "failed", dispatchId: prepared.dispatchId, agentMeta, error: diagnostic.summary });
    } else {
      response = ingestResult({ statePath, result: readResultFile(prepared.resultPath), agentMeta, maxAttemptsPerStage, maxInfraAttemptsPerStage });
      observeDispatchState({ hqRoot, statePath, phase: "completed", dispatchId: prepared.dispatchId, agentMeta });
      if (response.status === "merge-ready") {
        response.githubPublish = publishAndRecord({ hqRoot, statePath, publish });
      }
    }
  } catch (error) {
    if (isControlFlowError(error)) {
      const reason = summarizeError(error);
      try {
        blockDispatch({ statePath, dispatchId: prepared.dispatchId, error: reason });
      } catch { /* the dispatch moved on under us; the throw below still reaches the caller */ }
      observeDispatchState({ hqRoot, statePath, phase: "failed", dispatchId: prepared.dispatchId, error: reason });
      writeCompletionReport({ statePath });
      throw error;
    }
    const current = readState(statePath);
    if (current.currentDispatch?.id !== prepared.dispatchId) {
      return { version: PROTOCOL_VERSION, status: current.status, taskId: current.task.id,
        currentStage: current.currentStage, blocker: current.blocker || null };
    }
    const agentMeta = parseAgentMeta(error, { durationMsFallback: Date.now() - startedAt })
      || agentMetaByDispatchId?.get(prepared.dispatchId)
      || null;
    const failure = existsSync(prepared.resultPath)
      ? summarizeError(error)
      : writeMissingResultDiagnostic({
        worktree: prepared.cwd,
        dispatchId: prepared.dispatchId,
        stage: prepared.stage,
        actor: prepared.actor,
        sessionKey,
        resultPath: prepared.resultPath,
        stdout: error?.stdout,
        stderr: error?.stderr,
        reason: summarizeError(error),
      }).summary;
    if (existsSync(prepared.resultPath)) {
      try {
        response = ingestResult({ statePath, result: readResultFile(prepared.resultPath), agentMeta, maxAttemptsPerStage, maxInfraAttemptsPerStage });
        observeDispatchState({ hqRoot, statePath, phase: "completed", dispatchId: prepared.dispatchId, agentMeta });
      } catch (ingestError) {
        response = failDispatch({ statePath, dispatchId: prepared.dispatchId, error: summarizeError(ingestError), maxAttemptsPerStage, maxInfraAttemptsPerStage });
        observeDispatchState({ hqRoot, statePath, phase: "failed", dispatchId: prepared.dispatchId, agentMeta, error: summarizeError(ingestError) });
      }
    } else {
      response = failDispatch({ statePath, dispatchId: prepared.dispatchId, error: failure, maxAttemptsPerStage, maxInfraAttemptsPerStage });
      observeDispatchState({ hqRoot, statePath, phase: "failed", dispatchId: prepared.dispatchId, agentMeta, error: failure });
    }
  }
  // A founder-readable completion report for every terminal or paused outcome —
  // successes and blockers alike. Rewritten (idempotent) each time the task
  // settles, and never allowed to break the run.
  if (response.status === "merge-ready" || response.status === "blocked") {
    writeCompletionReport({ statePath });
  }
  return response;
}

// Render the task's completion report from its own recorded state and drop it
// next to state.json as completion-report.md. Guarded: a report failure is
// swallowed — the workflow outcome stands regardless.
export function writeCompletionReport({ statePath }) {
  try {
    const state = readState(statePath);
    const markdown = buildCompletionReport(state);
    const path = join(dirname(statePath), "completion-report.md");
    writeFileSync(path, `${markdown}\n`, "utf8");
    const generatedAt = new Date().toISOString();
    mutateTransactionalState(statePath, {
      commandId: `completion-report:${randomUUID()}`,
      replayable: false,
      now: () => generatedAt,
      mutate: (current) => {
        const next = structuredClone(current);
        next.completionReport = { path, generatedAt, status: current.status };
        next.events.push({ at: generatedAt, type: "completion-report", stage: current.currentStage || "release", actor: "system", outcome: current.status });
        return next;
      },
    });
    return { path, generatedAt };
  } catch (error) {
    return { error: summarizeError(error) };
  }
}

// Push the task's own branch + open a PR, then record the outcome on the
// task's own state.json so the dashboard/CLI can show it. A GitHub failure
// here is recorded, never thrown — the task already reached merge-ready
// through the workflow engine's own gates regardless of what GitHub does.
export function publishAndRecord({ hqRoot, statePath, publish = publishMergeReadyTask }) {
  const state = readState(statePath);
  let result;
  try {
    result = publish({ hqRoot, state });
  } catch (error) {
    result = { published: false, reason: summarizeError(error) };
  }
  mutateTransactionalState(statePath, {
    commandId: `github-publish:${randomUUID()}`,
    replayable: false,
    mutate: (current) => {
      const next = structuredClone(current);
      next.githubPublish = result;
      next.events.push({
        at: new Date().toISOString(),
        type: "github-publish",
        stage: "release",
        actor: "system",
        outcome: result.published ? (result.prUrl ? "pr-opened" : result.pushed ? "pushed" : "skipped") : "skipped",
      });
      return next;
    },
  });
  return result;
}

// How many consecutive iterations may commit nothing before the loop is
// declared stuck. Three, not one, purely to absorb a caller that has genuinely
// arranged for external state to change between passes; at spin speed three
// iterations cost about thirty milliseconds, so the slack is free.
export const DEFAULT_MAX_STALLED_ITERATIONS = 3;

function storeRevision(statePath) {
  try { return peekRevision(statePath); } catch { return null; }
}

// Why the loop is judged on committed revisions rather than on a write RATE.
//
// A rate is a threshold that has to be tuned against a path that is
// legitimately fast — the hermetic smoke sustains 180 writes/s honestly — so it
// is always either too loose to catch a real spin or tight enough to fail real
// work. "This iteration committed no revision" needs no threshold, because it
// is true by construction: the iteration read the same inputs it read last
// time and will read them again next time. Nothing it can do differs.
//
// The message has to name the loop, because the whole point of halting here
// rather than at the store's size ceiling (#224) is that the ceiling says "this
// file got too big" — true, and useless to whoever has to fix it.
function stalledLoopError(statePath, revision, iterations) {
  let stage = null;
  let dispatch = null;
  try {
    const state = readState(statePath);
    stage = state.currentStage || null;
    dispatch = state.currentDispatch || null;
  } catch { /* the message degrades, the halt does not */ }
  const where = dispatch
    ? `dispatch "${dispatch.id}" stayed "${dispatch.status}"`
    : "no dispatch was ever created";
  const error = new Error(
    `runToTerminal is not making progress and has been stopped after ${iterations} consecutive `
    + `iterations that committed nothing: task state stayed at revision ${revision}, stage `
    + `"${stage}", and ${where}. An iteration that commits no revision reads the same inputs on `
    + "the next pass, so this loop cannot terminate on its own. The usual cause is an "
    + "idempotency-ledger replay: a dispatch id that an earlier dispatch already spent makes "
    + "markDispatchRunning and ingestResult return their previously committed responses instead "
    + "of applying the mutation, which pins the dispatch and discards the agent's result. "
    + "Check the `commands` table for `running:<dispatchId>` and `ingest:<dispatchId>`.",
  );
  error.stalledLoop = true;
  error.revision = revision;
  error.iterations = iterations;
  error.stage = stage;
  error.dispatchId = dispatch?.id || null;
  return error;
}

export async function runToTerminal(options) {
  const groups = options.concurrentGroups || DEFAULT_CONCURRENT_GROUPS;
  // 0 disables the guard, for a caller that genuinely wants the old behaviour.
  const maxStalledIterations = options.maxStalledIterations ?? DEFAULT_MAX_STALLED_ITERATIONS;
  let response;
  let stalled = 0;
  do {
    // Read from the SQLite authority, not from `state.json`: the JSON file is
    // an export, and a no-op mutation rewrites it byte-identically. Only the
    // revision distinguishes "nothing happened" from "nothing changed".
    const before = storeRevision(options.statePath);
    response = (await runConcurrentGroupIfReady({ ...options, groups })) || (await runOneStage(options));
    const after = storeRevision(options.statePath);
    // Only an iteration the loop is going to REPEAT can be a stall. An
    // iteration that commits nothing and then ends the loop is the normal way
    // an outstanding yielded dispatch reports itself: `runOneStage` returns
    // `waiting` with status "dispatch", having committed nothing because
    // `prepareDispatch` early-returns on a dispatch that is already running.
    // Judging that as a stall halts a task whose delegated worker is simply
    // still working — which is exactly the false positive this guard must not
    // have.
    //
    // The other half of the yielded path, the in-iteration wait itself, is
    // safe for a separate reason: waitForYieldedResult heartbeats through
    // touchState, which commits a revision per poll.
    if (response.status === "active" && before !== null && after === before) {
      stalled += 1;
      if (maxStalledIterations > 0 && stalled >= maxStalledIterations) {
        throw stalledLoopError(options.statePath, after, stalled);
      }
    } else {
      stalled = 0;
    }
  } while (response.status === "active");
  return response;
}

// A throw out of `runToTerminal` leaves the task exactly as it was.
//
// That is correct for the runner — it cannot know whether its caller will
// retry — and catastrophic for every caller that does not settle the task
// itself. Both of them did not:
//
//   * the dashboard's manual retry (server.mjs) runs the runner in a detached
//     promise whose only handler is `console.error`. The 202 has already gone
//     out, so the throw became one line on stdout and the task stayed `active`
//     with no blocker, looking alive forever.
//   * the auto-retry sweep recorded the error in its return value but left the
//     task `active` with a fresh `updatedAt`, so the next sweep picked it up
//     again, 90 minutes later, to fail identically — until the retry budget ran
//     out and it was skipped in silence from then on.
//
// This is how the 2026-09-14 dispatch-id collision could stay invisible: #226
// turned a silent 403 GiB write storm into a loud throw, and the throw landed
// nowhere. So every caller that is not going to retry must settle the task
// here instead.
//
// Two rules make this safe to call unconditionally on any escaped error:
//
//   1. A task already `blocked` is left alone. A control-flow error
//      (`isControlFlowError`) has already parked its own dispatch with a
//      specific reason via `blockDispatch`; overwriting that with the generic
//      wrapper would lose the better message.
//   2. `founderAction: true` is not decoration. An error that escapes the
//      runner is deterministic by construction — the same state reproduces it
//      on the next run — so it must never be classified as retriable
//      infrastructure and swept forever. The tag makes `classifyBlocker`
//      return "decision" without depending on what the message happens to say.
//
// `status: "blocked"` rather than "failed" is also deliberate. The Founder
// Inbox's blocked-task item (founderControlPlane.mjs) reads
// `status === "blocked" && blocker.outcome === "fail"`; a task marked "failed"
// is rendered with a FAILED badge and reaches no founder surface at all. That
// is why the store-size ceiling (#224) contains the disk but still loses the
// task, and why a task already marked "failed" is promoted here rather than
// left where it is.
export function recordRunnerCrash({ statePath, error, now = new Date().toISOString() }) {
  const summary = summarizeError(error);
  // Opening the store creates its directory. A path with no task behind it has
  // nothing to settle, so say so rather than leaving an empty database behind.
  if (!statePath || !existsSync(dirname(statePath))) {
    return { settled: false, reason: `no task state at ${statePath}` };
  }
  let settled = false;
  try {
    const next = mutateTransactionalState(statePath, {
      commandId: `runner-crash:${randomUUID()}`,
      replayable: false,
      now,
      mutate: (state) => {
        if (!state) return undefined;
        if (state.status === "blocked") return undefined;
        // A task that already finished is never re-opened by a late throw.
        if (state.status === "merge-ready" || state.status === "verified") return undefined;
        settled = true;
        const next = structuredClone(state);
        const stage = state.blocker?.stage || state.currentDispatch?.stage || state.currentStage || null;
        next.status = "blocked";
        next.blocker = {
          stage,
          outcome: "fail",
          actor: "system",
          // A task the ceiling already settled keeps its own, more specific
          // reason; only its visibility changes.
          summary: state.status === "failed" && state.blocker?.summary ? state.blocker.summary : summary,
          founderAction: true,
          runnerCrash: true,
          at: now,
        };
        // The dispatch this died on is not owned by anyone any more. Leaving it
        // in place makes the task look like it has a worker.
        delete next.currentDispatch;
        next.events.push({
          at: now,
          type: "runner-crash",
          stage,
          actor: "system",
          outcome: "blocked",
          error: summary,
        });
        next.updatedAt = now;
        return next;
      },
    });
    return settled
      ? { settled: true, status: next.status, blocker: next.blocker }
      : { settled: false, reason: `task is already ${next?.status ?? "absent"}`, status: next?.status ?? null };
  } catch (settleError) {
    // Settling must never replace the original failure with a worse one. The
    // store being unwritable is exactly the case where this can happen.
    return { settled: false, reason: summarizeError(settleError) };
  }
}

// When the task is parked at the head of a concurrent group with the rest of the
// group still pending, run every member's `openclaw agent` call at once (the
// slow part), then feed each result back through the UNCHANGED engine one stage
// at a time. Returns the engine response, or null when no fan-out applies (the
// caller then does a normal sequential `runOneStage`).
export async function runConcurrentGroupIfReady({ hqRoot, statePath, agentIds = {}, maxAttemptsPerStage = 3, maxInfraAttemptsPerStage = DEFAULT_MAX_INFRA_ATTEMPTS, execute = executeOpenClaw, publish = publishMergeReadyTask, groups = DEFAULT_CONCURRENT_GROUPS, waitForResult = waitForYieldedResult }) {
  const state = readState(statePath);
  if (state.status !== "active" || state.currentDispatch || state.recovery?.active) return null;
  if (state.yieldedGroup) {
    if (state.yieldedGroup.some((m) => !existsSync(m.resultPath))) {
      return { version: PROTOCOL_VERSION, status: "dispatch", taskId: state.task.id, waiting: true };
    }
    execute = async () => {}; // consume the already-produced group, never re-dispatch
  }
  const pending = (s) => {
    const st = state.stages?.[s]?.status;
    return st === undefined || st === "pending";
  };
  const group = (groups || []).find((g) => Array.isArray(g) && g.length >= 2 && g[0] === state.currentStage && g.slice(1).every(pending));
  if (!group) return state.yieldedGroup
    ? { version: PROTOCOL_VERSION, status: "dispatch", taskId: state.task.id, waiting: true }
    : null;

  const routes = configuredAgentIds(hqRoot, agentIds);
  const members = group.map((stage) => {
    const { dispatchId, resultPath } = computeDispatchPaths({ state, stage, statePath });
    const actor = state.assignments[stage];
    const agentId = selectAgentId({ stage, actor }, routes, { strict: Object.keys(routes).some((key) => key === `${stage}:${actor}` || key.startsWith(`${stage}:`)) });
    const promptPath = writeHandoff({ hqRoot, statePath, state, resultPath, dispatchId, stage });
    return { stage, actor, dispatchId, resultPath, promptPath, agentId };
  });
  const agentMetaByDispatchId = new Map();

  // The expensive part, concurrent. If a member's agent throws OR leaves no
  // result file, synthesize a `fail` result carrying the real reason so the
  // engine routes it as a normal retry with a legible message — parity with the
  // single-stage `failDispatch` path, instead of an opaque "did not write its
  // result file".
  const settled = await Promise.allSettled(members.map(async (m) => {
    const startedAt = Date.now();
    try {
      const executed = existsSync(m.resultPath) ? {} : await execute({
        agentId: m.agentId,
        messageFile: m.promptPath,
        sessionKey: `agent:${m.agentId}:factory-${m.dispatchId}`,
        cwd: state.worktree,
        dispatch: {
          version: PROTOCOL_VERSION,
          status: "dispatch",
          taskId: state.task.id,
          dispatchId: m.dispatchId,
          stage: m.stage,
          actor: m.actor,
          cwd: state.worktree,
          promptPath: m.promptPath,
          resultPath: m.resultPath,
        },
      });
      if (!existsSync(m.resultPath) && isYieldedExecution(executed)) {
        markYieldedGroup(statePath, members);
        await waitForResult({ resultPath: m.resultPath, heartbeat: () => touchState(statePath) });
      }
      const meta = parseAgentMeta(executed, { durationMsFallback: Date.now() - startedAt });
      if (meta) agentMetaByDispatchId.set(m.dispatchId, meta);
      return executed;
    } catch (error) {
      const meta = parseAgentMeta(error, { durationMsFallback: Date.now() - startedAt });
      if (meta) agentMetaByDispatchId.set(m.dispatchId, meta);
      throw error;
    }
  }));
  // Same contract as the sequential path: a deterministic control-flow failure
  // belongs to the caller, not to the retry ladder.
  const fatal = settled.find((s) => s.status === "rejected" && isControlFlowError(s.reason));
  if (fatal) throw fatal.reason;
  for (let i = 0; i < members.length; i += 1) {
    const m = members[i];
    const rejected = settled[i].status === "rejected";
    if ((rejected || !existsSync(m.resultPath)) && !(settled[i].status === "fulfilled" && isYieldedExecution(settled[i].value))) {
      const reason = rejected
        ? summarizeError(settled[i].reason)
        : `the ${m.stage} agent (${m.agentId}) produced no result file`;
      synthesizeFailResult({ worktree: state.worktree, member: m, reason });
    }
  }

  if (settled.some((r, i) => r.status === "fulfilled" && isYieldedExecution(r.value) && !existsSync(members[i].resultPath))) {
    return { version: PROTOCOL_VERSION, status: "dispatch", taskId: state.task.id, waiting: true };
  }
  mutateTransactionalState(statePath, {
    commandId: `group-collected:${randomUUID()}`,
    replayable: false,
    mutate: (current) => {
      const next = structuredClone(current);
      delete next.yieldedGroup;
      return next;
    },
  });
  // Apply through the real engine, one stage at a time, with a no-op execute so
  // `runOneStage` consumes the result file each member already wrote.
  const noop = async () => {};
  const applied = new Set();
  let response;
  for (const m of members) {
    response = await runOneStage({ hqRoot, statePath, agentIds, maxAttemptsPerStage, execute: noop, publish, agentMetaByDispatchId });
    applied.add(m.stage);
    if (readState(statePath).stages?.[m.stage]?.status !== "pass") break; // failed → routed away
  }
  // Discard the not-yet-applied members' result files so a later attempt of
  // those stages regenerates them cleanly.
  for (const m of members) {
    if (applied.has(m.stage)) continue;
    try { if (existsSync(m.resultPath)) unlinkSync(m.resultPath); } catch { /* best effort */ }
  }
  return response;
}

export async function executeOpenClaw({ agentId, messageFile, sessionKey, cwd }) {
  // Run the agent inside its assigned worktree. Both callers already pass
  // `cwd: state.worktree`; without forwarding it here the `openclaw agent`
  // process inherited the dashboard's cwd, so a relative-path edit could land
  // in the source checkout instead of the isolated worktree.
  return execFileAsync(
    "openclaw",
    ["agent", "--agent", agentId, "--session-key", sessionKey, "--message-file", messageFile, "--json", "--timeout", "3600"],
    { cwd: cwd || undefined, timeout: 60 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }
  );
}

export function selectAgentId(dispatch, agentIds, { strict = false } = {}) {
  if (dispatch.kind === "recovery-verify") {
    // The protocol stage remains the failed stage for result validation; route
    // verification by its actual responsibility, never by the failed builder.
    const stage = dispatch.verificationStage || "qa";
    const verifier = agentIds["recovery-verify"] || agentIds[`${stage}:${dispatch.actor}`] || agentIds[stage];
    if (verifier) {
      if (verifier === agentIds.recovery) throw new Error("Recovery repair and verification require different runtime agents");
      return verifier;
    }
    if (strict) throw new Error("No recovery verification runtime agent is configured");
    return dispatch.actor;
  }
  const selected = agentIds[dispatch.kind === "recovery-diagnose" ? "recovery" : `${dispatch.stage}:${dispatch.actor}`]
    || agentIds[dispatch.stage]
    || agentIds[dispatch.actor];
  if (selected) return selected;
  if (!strict) return dispatch.actor;
  throw new Error(`no runtime agent is configured for stage '${dispatch.stage}' and logical actor '${dispatch.actor}'`);
}

// Write a schema-valid `fail` result (+ its evidence file) for a concurrent
// group member whose agent threw or produced nothing, so the engine's normal
// retry routing applies with a clear reason.
function synthesizeFailResult({ worktree, member, reason }) {
  try {
    const evDir = join(worktree, "evidence");
    mkdirSync(evDir, { recursive: true });
    const rel = `evidence/${member.stage}-infra-failure.md`;
    writeFileSync(join(worktree, rel), `# ${member.stage} could not run\n\n${reason}\n`, "utf8");
    writeFileSync(member.resultPath, JSON.stringify({
      version: PROTOCOL_VERSION,
      dispatchId: member.dispatchId,
      stage: member.stage,
      actor: member.actor,
      outcome: "fail",
      // The protocol needs an outcome for the engine to route on, but this
      // stage never ran: nothing judged the work. Say so explicitly, so the
      // per-stage budget counts it against the infrastructure allowance rather
      // than spending a rejection the stage never actually made.
      infraFailure: true,
      summary: `${member.stage} agent could not run: ${String(reason).split("\n")[0].slice(0, 240)}`,
      evidence: [rel],
    }), "utf8");
  } catch { /* best effort — a missing file still routes as a failure downstream */ }
}

// Preserve the useful executor signal when a single-stage dispatch exits
// without satisfying the result-file protocol. Like synthesizeFailResult(),
// this is best effort: diagnostic persistence must never alter retry routing.
function writeMissingResultDiagnostic({ worktree, dispatchId, stage, actor, sessionKey, resultPath, stdout, stderr, reason }) {
  const rel = `evidence/${dispatchId}-missing-result.md`;
  const out = redactTail(stdout);
  const err = redactTail(stderr);
  const cleanReason = reason ? sanitizeExcerpt(reason, { maxLength: 240 }).text : "";
  // An agent that ran, answered, and stopped without writing its result is a
  // different failure from an agent that could not be reached: retrying the
  // same route reproduces it exactly. Say so in the summary, because that
  // string is what the failure classifier and the founder both read.
  const finished = describeAgentCompletion({ stdout });
  const route = [finished.provider, finished.model].filter(Boolean).join("/");
  const summary = finished.completed
    ? `${stage} agent completed its turn without writing a result file${route ? ` (${route})` : ""}; ` +
      `the route ran but produced no gate artifact, so retrying it unchanged will repeat. ` +
      `Session ${sessionKey}; redacted executor output captured at ${rel}.${cleanReason ? ` Reason: ${cleanReason}` : ""}`
    : `${stage} dispatch wrote no result file (session ${sessionKey}); redacted executor output captured at ${rel}.${cleanReason ? ` Reason: ${cleanReason}` : ""}`;
  try {
    mkdirSync(join(worktree, "evidence"), { recursive: true });
    const lines = [
      `# ${stage} dispatch wrote no result file`,
      "",
      `- dispatchId: ${dispatchId}`,
      `- stage: ${stage}`,
      `- actor: ${actor}`,
      `- sessionKey: ${sessionKey}`,
      `- expectedResultFile: ${basename(resultPath)}`,
      finished.completed ? `- agentCompletedTurn: yes (stopReason ${finished.stopReason || "unknown"})` : null,
      finished.completed && route ? `- route: ${route}` : null,
      cleanReason ? `- reason: ${cleanReason}` : null,
      "",
      "## Executor stdout (redacted, truncated)",
      "",
      "```",
      out.text || "(empty)",
      "```",
      "",
      "## Executor stderr (redacted, truncated)",
      "",
      "```",
      err.text || "(empty)",
      "```",
      "",
    ].filter((line) => line !== null);
    writeFileSync(join(worktree, rel), lines.join("\n"), "utf8");
    return { rel, summary };
  } catch {
    return { rel: null, summary: `${summary} (diagnostic artifact could not be written)` };
  }
}

function redactTail(value) {
  const raw = String(value ?? "");
  const truncated = raw.length > 4000;
  const clean = sanitizeExcerpt(raw.slice(-4000), { maxLength: 4000 });
  return {
    ...clean,
    text: truncated ? `… ${clean.text}` : clean.text,
    truncated: truncated || clean.truncated,
  };
}

function markYielded(statePath, dispatchId, stage) {
  mutateTransactionalState(statePath, {
    commandId: `yielded:${dispatchId}`,
    // Stable key, but nothing reads the return: store the marker, not the
    // document.
    toResponse: (state) => ({ yieldedAt: state?.currentDispatch?.yieldedAt ?? null }),
    mutate: (current) => {
      if (current.currentDispatch?.id !== dispatchId) return undefined;
      const next = structuredClone(current);
      next.currentDispatch.yieldedAt = new Date().toISOString();
      next.events.push({ at: next.currentDispatch.yieldedAt, type: "dispatch-yielded", dispatchId, stage });
      return next;
    },
  });
}

function markYieldedGroup(statePath, members) {
  mutateTransactionalState(statePath, {
    commandId: `yielded-group:${randomUUID()}`,
    replayable: false,
    mutate: (current) => {
      const next = structuredClone(current);
      next.yieldedGroup = members.map(({ dispatchId, stage, resultPath }) => ({ dispatchId, stage, resultPath }));
      return next;
    },
  });
}

// A liveness ping while waiting on a yielded worker: bumps updatedAt so a
// watchdog does not mistake a slow delegate for a dead one. Never a source of
// truth for anything, so a fresh commandId (not deduped) every tick is
// correct — each tick is a genuinely new heartbeat, not a retry of a
// previous one.
function touchState(statePath, expectDispatchId = null) {
  mutateTransactionalState(statePath, {
    commandId: `heartbeat:${randomUUID()}`,
    replayable: false,
    mutate: (current) => {
      if (expectDispatchId && current.currentDispatch?.id !== expectDispatchId) throw new Error("Yielded dispatch ownership changed");
      const next = structuredClone(current);
      next.updatedAt = new Date().toISOString();
      return next;
    },
  });
}

function summarizeError(error) {
  const stderr = String(error?.stderr || "").trim();
  return stderr || error?.message || String(error);
}
