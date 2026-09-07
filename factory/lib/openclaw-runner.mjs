import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { PROTOCOL_VERSION, computeDispatchPaths, failDispatch, ingestResult, markDispatchRunning, prepareDispatch, readResultFile } from "./openclaw-protocol.mjs";
import { readState, writeState } from "./task-workflow.mjs";
import { writeHandoff } from "./handoff.mjs";
import { publishMergeReadyTask } from "./hq/github-publish.mjs";
import { buildCompletionReport } from "./hq/completion-report.mjs";

const execFileAsync = promisify(execFile);

// Stages that may run concurrently once the builder is done and the branch is
// frozen. All three read-only against the same worktree; order of results does
// not matter because the engine still applies them one at a time.
export const DEFAULT_CONCURRENT_GROUPS = [["reviewer", "qa", "security"]];

export async function runOneStage({ hqRoot, statePath, agentIds = {}, maxAttemptsPerStage = 3, execute = executeOpenClaw, publish = publishMergeReadyTask }) {
  const prepared = prepareDispatch({ hqRoot, statePath });
  if (prepared.status !== "dispatch") return prepared;
  markDispatchRunning({ statePath, dispatchId: prepared.dispatchId });
  const agentId = selectAgentId(prepared, agentIds);
  let response;
  try {
    await execute({
      agentId,
      messageFile: prepared.promptPath,
      sessionKey: `agent:${agentId}:factory-${prepared.dispatchId}`,
      cwd: prepared.cwd,
      dispatch: prepared,
    });
    response = ingestResult({ statePath, result: readResultFile(prepared.resultPath), maxAttemptsPerStage });
    if (response.status === "merge-ready") {
      response.githubPublish = publishAndRecord({ hqRoot, statePath, publish });
    }
  } catch (error) {
    response = failDispatch({ statePath, dispatchId: prepared.dispatchId, error: summarizeError(error), maxAttemptsPerStage });
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
    const next = structuredClone(state);
    const generatedAt = new Date().toISOString();
    next.completionReport = { path, generatedAt, status: state.status };
    next.events.push({ at: generatedAt, type: "completion-report", stage: state.currentStage || "release", actor: "system", outcome: state.status });
    writeState(statePath, next);
    return { path, generatedAt };
  } catch (error) {
    return { error: summarizeError(error) };
  }
}

// Push the task's own branch + open a PR, then record the outcome on the
// task's own state.json so the dashboard/CLI can show it. A GitHub failure
// here is recorded, never thrown — the task already reached merge-ready
// through the workflow engine's own gates regardless of what GitHub does.
function publishAndRecord({ hqRoot, statePath, publish }) {
  const state = readState(statePath);
  let result;
  try {
    result = publish({ hqRoot, state });
  } catch (error) {
    result = { published: false, reason: summarizeError(error) };
  }
  const next = structuredClone(state);
  next.githubPublish = result;
  next.events.push({
    at: new Date().toISOString(),
    type: "github-publish",
    stage: "release",
    actor: "system",
    outcome: result.published ? (result.prUrl ? "pr-opened" : result.pushed ? "pushed" : "skipped") : "skipped",
  });
  writeState(statePath, next);
  return result;
}

export async function runToTerminal(options) {
  const groups = options.concurrentGroups || DEFAULT_CONCURRENT_GROUPS;
  let response;
  do {
    response = (await runConcurrentGroupIfReady({ ...options, groups })) || (await runOneStage(options));
  } while (response.status === "active");
  return response;
}

// When the task is parked at the head of a concurrent group with the rest of the
// group still pending, run every member's `openclaw agent` call at once (the
// slow part), then feed each result back through the UNCHANGED engine one stage
// at a time. Returns the engine response, or null when no fan-out applies (the
// caller then does a normal sequential `runOneStage`).
export async function runConcurrentGroupIfReady({ hqRoot, statePath, agentIds = {}, maxAttemptsPerStage = 3, execute = executeOpenClaw, publish = publishMergeReadyTask, groups = DEFAULT_CONCURRENT_GROUPS }) {
  const state = readState(statePath);
  if (state.status !== "active" || state.currentDispatch) return null;
  const pending = (s) => {
    const st = state.stages?.[s]?.status;
    return st === undefined || st === "pending";
  };
  const group = (groups || []).find((g) => Array.isArray(g) && g.length >= 2 && g[0] === state.currentStage && g.slice(1).every(pending));
  if (!group) return null;

  const members = group.map((stage) => {
    const { dispatchId, resultPath } = computeDispatchPaths({ state, stage, statePath });
    const actor = state.assignments[stage];
    const agentId = selectAgentId({ stage, actor }, agentIds);
    const promptPath = writeHandoff({ hqRoot, statePath, state, resultPath, dispatchId, stage });
    return { stage, actor, dispatchId, resultPath, promptPath, agentId };
  });

  // The expensive part, concurrent. If a member's agent throws OR leaves no
  // result file, synthesize a `fail` result carrying the real reason so the
  // engine routes it as a normal retry with a legible message — parity with the
  // single-stage `failDispatch` path, instead of an opaque "did not write its
  // result file".
  const settled = await Promise.allSettled(members.map((m) => execute({
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
  })));
  for (let i = 0; i < members.length; i += 1) {
    const m = members[i];
    const rejected = settled[i].status === "rejected";
    if (rejected || !existsSync(m.resultPath)) {
      const reason = rejected
        ? summarizeError(settled[i].reason)
        : `the ${m.stage} agent (${m.agentId}) produced no result file`;
      synthesizeFailResult({ worktree: state.worktree, member: m, reason });
    }
  }

  // Apply through the real engine, one stage at a time, with a no-op execute so
  // `runOneStage` consumes the result file each member already wrote.
  const noop = async () => {};
  const applied = new Set();
  let response;
  for (const m of members) {
    response = await runOneStage({ hqRoot, statePath, agentIds, maxAttemptsPerStage, execute: noop, publish });
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

export async function executeOpenClaw({ agentId, messageFile, sessionKey }) {
  return execFileAsync(
    "openclaw",
    ["agent", "--agent", agentId, "--session-key", sessionKey, "--message-file", messageFile, "--json", "--timeout", "3600"],
    { timeout: 60 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }
  );
}

function selectAgentId(dispatch, agentIds) {
  return agentIds[`${dispatch.stage}:${dispatch.actor}`]
    || agentIds[dispatch.stage]
    || agentIds[dispatch.actor]
    || dispatch.actor;
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
      summary: `${member.stage} agent could not run: ${String(reason).split("\n")[0].slice(0, 240)}`,
      evidence: [rel],
    }), "utf8");
  } catch { /* best effort — a missing file still routes as a failure downstream */ }
}

function summarizeError(error) {
  const stderr = String(error?.stderr || "").trim();
  return stderr || error?.message || String(error);
}
