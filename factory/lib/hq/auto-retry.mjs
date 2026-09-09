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

import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
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

// Auto-retry drives the task workflow directly, so the objective orchestrator
// is not necessarily in the call stack to project the new state. Reconcile the
// owning objective after the retry without creating a second registry or
// changing the task's durable evidence.
function reconcileObjectiveNode(stateRoot, statePath, taskState, at) {
  for (const objectivePath of walkFiles(stateRoot, "objective-state.json")) {
    let objective;
    try { objective = JSON.parse(readFileSync(objectivePath, "utf8")); } catch { continue; }
    let changed = false;
    for (const node of Object.values(objective.nodes || {})) {
      if (node.statePath !== statePath) continue;
      const nextStatus = taskState.status === "active" ? "running" : node.status;
      const nextBlocker = taskState.status === "active" ? (taskState.blocker || null) : (taskState.blocker || node.blocker || null);
      if (node.status !== nextStatus || JSON.stringify(node.blocker || null) !== JSON.stringify(nextBlocker)) {
        node.status = nextStatus;
        node.blocker = nextBlocker;
        changed = true;
      }
    }
    if (!changed) continue;
    if (Object.values(objective.nodes || {}).some((node) => node.statePath === statePath && taskState.status === "active")) objective.status = "active";
    objective.updatedAt = at;
    objective.events = [...(objective.events || []), { at, type: "node-reconciled", nodeStatePath: statePath, taskStatus: taskState.status, actor: "auto-retry" }];
    try { writeFileSync(objectivePath, `${JSON.stringify(objective, null, 2)}\n`, "utf8"); } catch { /* task evidence remains authoritative */ }
  }
}

function walkFiles(dir, fileName, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, fileName, out);
    else if (entry.name === fileName) out.push(full);
  }
  return out;
}

/**
 * @param {object}   input
 * @param {string}   input.hqRoot        HQ root (for factory.config.json + runner)
 * @param {string}   input.stateRoot     directory to scan for state.json files
 * @param {number}  [input.max=3]        automatic attempts per task before it is left for the founder
 * @param {number}  [input.staleActiveMs] an `active` task untouched this long is treated as orphaned by a host restart (default 90 min — longer than the 60 min dispatch hard-timeout, so a genuinely-running dispatch is never disturbed)
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
  staleActiveMs = 90 * 60 * 1000,
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

  const nowMs = () => Date.parse(now()) || Date.now();

  for (const statePath of files) {
    let state;
    try { state = readState(statePath); } catch { continue; }

    // A delegated worker may still be writing. Age is not proof of termination.
    if (state.currentDispatch?.yieldedAt || state.yieldedGroup) {
      skipped.push({ taskId: state.task?.id, statePath, reason: "delegated execution still owns its dispatch" });
      continue;
    }

    // Two recoverable situations, both "no live runner owns this task":
    //   1. blocked on an INFRA-class failure (transient agent/process error)
    //   2. active but untouched for > staleActiveMs — its in-process runner
    //      died with a host/dashboard restart, leaving a stuck dispatch.
    let reason;
    if (state.status === "blocked" && classifyBlocker(state.blocker) === "infra") {
      reason = `infra failure at ${state.blocker?.stage}`;
    } else if (state.status === "active") {
      const updMs = Date.parse(state.updatedAt);
      if (!updMs) continue; // no timestamp — can't judge staleness, leave it alone
      const ageMs = nowMs() - updMs;
      if (ageMs > staleActiveMs) reason = `orphaned ${Math.round(ageMs / 60000)}m ago (host restart)`;
      else continue;
    } else {
      continue;
    }

    const attempts = state.autoRetries || 0;
    if (attempts >= max) { skipped.push({ taskId: state.task?.id, statePath, reason: "auto-retry budget exhausted", attempts }); continue; }

    const at = now();
    let revived;
    try {
      if (state.status === "blocked") {
        revived = resumeState(state, at);
      } else {
        // Orphaned active task: drop the stuck dispatch and re-arm the current
        // stage so the runner issues a fresh one.
        revived = structuredClone(state);
        delete revived.currentDispatch;
        if (revived.currentStage) revived.stages[revived.currentStage] = { status: "pending" };
        revived.updatedAt = at;
        revived.events.push({ at, type: "task-resumed", stage: revived.currentStage, actor: "system" });
      }
    } catch (error) {
      skipped.push({ taskId: state.task?.id, statePath, reason: `cannot resume: ${error.message || error}` });
      continue;
    }
    revived.autoRetries = attempts + 1;
    revived.events.push({ at, type: "auto-retry", stage: revived.currentStage, actor: "system", attempt: revived.autoRetries, of: max, reason });
    writeState(statePath, revived);
    log(`[auto-retry] ${state.task?.id}: ${reason}, attempt ${revived.autoRetries}/${max}`);

    try {
      const res = await runTask({ hqRoot, statePath, execute, ...runnerOpts });
      try { reconcileObjectiveNode(stateRoot, statePath, readState(statePath), now()); } catch { /* projection repair is best effort */ }
      retried.push({ taskId: state.task?.id, stage: revived.currentStage, attempt: revived.autoRetries, status: res.status, reason });
      log(`[auto-retry] ${state.task?.id}: now ${res.status}`);
    } catch (error) {
      try { reconcileObjectiveNode(stateRoot, statePath, readState(statePath), now()); } catch { /* projection repair is best effort */ }
      retried.push({ taskId: state.task?.id, stage: revived.currentStage, attempt: revived.autoRetries, error: String(error.message || error), reason });
      log(`[auto-retry] ${state.task?.id}: threw ${error.message || error}`);
    }
  }

  return { scanned: files.length, retried, skipped };
}
