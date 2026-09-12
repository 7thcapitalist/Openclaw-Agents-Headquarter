// Bounded activation layer for the Paperclip-derived wakeup queue and lease
// store. A wakeup identifies work; it never carries a command.
import { join, resolve } from "path";
import { existsSync, mkdirSync } from "fs";
import { acquireTaskLease, LeaseConflictError, releaseTaskLease, renewTaskLease } from "../leases/task-lease.mjs";
import { claimNextWakeup, deferWakeup, finishWakeup } from "./queue.mjs";
import { runOneStage } from "../openclaw-runner.mjs";
import { decideRewake, readThrottleConfig } from "../hq/rewake-throttle.mjs";
import { readState } from "../task-workflow.mjs";

export async function processNextWakeup({ hqRoot, stateRoot, queuePath, actorId = "openclaw-wakeup-worker", leaseTtlMs = 60_000, run = runOneStage, now = () => new Date().toISOString() }) {
  const claimed = claimNextWakeup(queuePath, { actorId, now });
  if (!claimed) return { status: "idle" };
  const statePath = resolve(stateRoot, "tasks", claimed.taskRef, "state.json");
  const leaseRoot = resolve(stateRoot, "leases");
  const runId = `wakeup-${claimed.wakeupId}`;
  let leased = false;
  try {
    if (!existsSync(statePath)) throw new Error(`Unknown task state '${claimed.taskRef}'`);

    // Has this task stopped producing information? A wake that pays a full
    // agent session for a run that changes nothing is pure cost. In `report`
    // the verdict is recorded and the wake proceeds; only `enforce` holds it
    // back, and `manual` and `recovery` wakes never reach here at all.
    const throttle = checkRewakeThrottle({ hqRoot, statePath, wakeup: claimed, now });
    if (!throttle.allowed) {
      // Not a failure: the wakeup is returned to the queue to be retried after
      // the cooldown, so nothing is lost and no attempt is consumed.
      deferWakeup(queuePath, { wakeupId: claimed.wakeupId, actorId, notBefore: throttle.cooldownUntil, now });
      return { status: "throttled", wakeupId: claimed.wakeupId, taskId: claimed.taskRef, streak: throttle.streak, retryAfter: throttle.cooldownUntil };
    }

    mkdirSync(leaseRoot, { recursive: true, mode: 0o700 });
    acquireTaskLease({ root: leaseRoot, taskId: claimed.taskRef, actorId, runId, ttlMs: leaseTtlMs });
    leased = true;
    const heartbeat = () => renewTaskLease({ root: leaseRoot, taskId: claimed.taskRef, actorId, runId, ttlMs: leaseTtlMs });
    const result = await run({ hqRoot, statePath, wakeup: claimed, heartbeat });
    finishWakeup(queuePath, { wakeupId: claimed.wakeupId, actorId, outcome: "succeeded", now });
    return { status: "processed", wakeupId: claimed.wakeupId, taskId: claimed.taskRef, result, throttle };
  } catch (error) {
    const message = error instanceof LeaseConflictError ? "Task is already owned by another active run" : (error?.message || String(error));
    const wakeup = finishWakeup(queuePath, { wakeupId: claimed.wakeupId, actorId, outcome: "failed", error: message, now });
    return { status: wakeup.status === "dead-letter" ? "dead-letter" : "retry", wakeupId: claimed.wakeupId, taskId: claimed.taskRef, error: message };
  } finally {
    if (leased) {
      try { releaseTaskLease({ root: leaseRoot, taskId: claimed.taskRef, actorId, runId }); }
      catch { /* expiry/recovery must not overwrite the wakeup outcome */ }
    }
  }
}

// Consulting the throttle must never be able to stop a wake by failing. An
// unreadable config, an unparsable task state, a bug here — every one of them
// resolves to "let the work through", because the cost of a wrongly-held wake
// is a stalled task and the cost of a wrongly-allowed one is one agent session.
function checkRewakeThrottle({ hqRoot, statePath, wakeup, now }) {
  try {
    const config = readThrottleConfig(hqRoot);
    if (config.mode === "off") return { allowed: true, reason: "throttle-disabled", streak: 0, cooldownUntil: null };
    return decideRewake({ config, state: readState(statePath), source: wakeup.source, now: now() });
  } catch (error) {
    return { allowed: true, reason: `throttle-unavailable: ${String(error?.message || error)}`, streak: 0, cooldownUntil: null };
  }
}

export function defaultWakeupPaths(hqRoot) {
  const stateRoot = join(resolve(hqRoot), "dashboard", "backend", "data", "factory", "Openclaw-Agents-Headquarter");
  return { stateRoot, queuePath: join(stateRoot, "wakeups.json") };
}
