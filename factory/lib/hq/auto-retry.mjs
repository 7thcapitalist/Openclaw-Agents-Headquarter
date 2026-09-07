// "Infra failures should fix themselves, not page the founder."
//
// Scans the factory state tree for tasks that are `blocked` on an INFRA-class
// blocker (transient agent/process failure — see blocker-class.mjs), resumes
// each one and drives it again, up to `max` automatic attempts. Everything is
// bounded, recorded on the task's own event log, and guarded so one bad state
// file never stops the sweep.
//
// A genuine founder decision ("decision-required") or a hard FAIL is left
// untouched — those still surface in the Founder Inbox.

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { readState, writeState, resumeState } from "../task-workflow.mjs";
import { runToTerminal, executeOpenClaw } from "../openclaw-runner.mjs";
import { classifyBlocker } from "./blocker-class.mjs";

function walkStateFiles(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkStateFiles(full, out);
    else if (entry.name === "state.json") out.push(full);
  }
  return out;
}

function readConfig(hqRoot) {
  try { return JSON.parse(readFileSync(join(hqRoot, "factory", "factory.config.json"), "utf8")); }
  catch { return {}; }
}

/**
 * @param {object}   input
 * @param {string}   input.hqRoot        HQ root (for factory.config.json + runner)
 * @param {string}   input.stateRoot     directory to scan for state.json files
 * @param {number}  [input.max=3]        automatic attempts per task before it is left for the founder
 * @param {Function}[input.execute]      injected agent executor (tests)
 * @param {Function}[input.runTask]      injected `runToTerminal` (tests)
 * @param {Function}[input.now]
 * @param {Function}[input.log]
 * @returns {Promise<{scanned:number, retried:Array, skipped:Array}>}
 */
export async function retryStuckTasks({
  hqRoot,
  stateRoot,
  max = 3,
  execute = executeOpenClaw,
  runTask = runToTerminal,
  now = () => new Date().toISOString(),
  log = () => {},
}) {
  const cfg = readConfig(hqRoot);
  const runnerOpts = {
    agentIds: cfg.openclawIntegration?.agentIds || {},
    maxAttemptsPerStage: cfg.openclawIntegration?.maxAttemptsPerStage || 3,
    concurrentGroups: cfg.openclawIntegration?.concurrentGroups,
  };

  const files = existsSync(stateRoot) ? walkStateFiles(stateRoot) : [];
  const retried = [];
  const skipped = [];

  for (const statePath of files) {
    let state;
    try { state = readState(statePath); } catch { continue; }
    if (state.status !== "blocked") continue;
    if (classifyBlocker(state.blocker) !== "infra") continue;

    const attempts = state.autoRetries || 0;
    if (attempts >= max) { skipped.push({ taskId: state.task?.id, statePath, reason: "auto-retry budget exhausted", attempts }); continue; }

    const at = now();
    let resumed;
    try {
      resumed = resumeState(state, at);
    } catch (error) {
      skipped.push({ taskId: state.task?.id, statePath, reason: `cannot resume: ${error.message || error}` });
      continue;
    }
    resumed.autoRetries = attempts + 1;
    resumed.events.push({ at, type: "auto-retry", stage: resumed.currentStage, actor: "system", attempt: resumed.autoRetries, of: max });
    writeState(statePath, resumed);
    log(`[auto-retry] ${state.task?.id}: infra failure at ${state.blocker?.stage}, attempt ${resumed.autoRetries}/${max}`);

    try {
      const res = await runTask({ hqRoot, statePath, execute, ...runnerOpts });
      retried.push({ taskId: state.task?.id, stage: state.blocker?.stage, attempt: resumed.autoRetries, status: res.status });
      log(`[auto-retry] ${state.task?.id}: now ${res.status}`);
    } catch (error) {
      retried.push({ taskId: state.task?.id, stage: state.blocker?.stage, attempt: resumed.autoRetries, error: String(error.message || error) });
      log(`[auto-retry] ${state.task?.id}: threw ${error.message || error}`);
    }
  }

  return { scanned: files.length, retried, skipped };
}
