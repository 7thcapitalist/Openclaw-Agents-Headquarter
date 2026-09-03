import { execFile } from "child_process";
import { promisify } from "util";
import { failDispatch, ingestResult, markDispatchRunning, prepareDispatch, readResultFile } from "./openclaw-protocol.mjs";

const execFileAsync = promisify(execFile);

export async function runOneStage({ hqRoot, statePath, agentIds = {}, execute = executeOpenClaw }) {
  const prepared = prepareDispatch({ hqRoot, statePath });
  if (prepared.status !== "dispatch") return prepared;
  markDispatchRunning({ statePath, dispatchId: prepared.dispatchId });
  const agentId = agentIds[prepared.actor] || prepared.actor;
  try {
    await execute({
      agentId,
      messageFile: prepared.promptPath,
      sessionKey: `agent:${agentId}:factory-${prepared.dispatchId}`,
      cwd: prepared.cwd,
      dispatch: prepared,
    });
    return ingestResult({ statePath, result: readResultFile(prepared.resultPath) });
  } catch (error) {
    return failDispatch({ statePath, dispatchId: prepared.dispatchId, error: summarizeError(error) });
  }
}

export async function executeOpenClaw({ agentId, messageFile, sessionKey }) {
  return execFileAsync(
    "openclaw",
    ["agent", "--agent", agentId, "--session-key", sessionKey, "--message-file", messageFile, "--json"],
    { timeout: 60 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }
  );
}

function summarizeError(error) {
  const stderr = String(error?.stderr || "").trim();
  return stderr || error?.message || String(error);
}
