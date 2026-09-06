import { execFile } from "child_process";
import { promisify } from "util";
import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { failDispatch, ingestResult, markDispatchRunning, prepareDispatch, readResultFile } from "./openclaw-protocol.mjs";
import { readState, writeState } from "./task-workflow.mjs";
import { publishMergeReadyTask } from "./hq/github-publish.mjs";
import { buildCompletionReport } from "./hq/completion-report.mjs";

const execFileAsync = promisify(execFile);

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
  let response;
  do response = await runOneStage(options);
  while (response.status === "active");
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

function summarizeError(error) {
  const stderr = String(error?.stderr || "").trim();
  return stderr || error?.message || String(error);
}
