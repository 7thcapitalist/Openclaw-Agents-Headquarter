// Bounded activation layer for the Paperclip-derived wakeup queue and lease
// store. A wakeup identifies work; it never carries a command.
import { join, resolve } from "path";
import { existsSync, mkdirSync } from "fs";
import { acquireTaskLease, LeaseConflictError, releaseTaskLease, renewTaskLease } from "../leases/task-lease.mjs";
import { claimNextWakeup, finishWakeup } from "./queue.mjs";
import { runOneStage } from "../openclaw-runner.mjs";

export async function processNextWakeup({ hqRoot, stateRoot, queuePath, actorId = "openclaw-wakeup-worker", leaseTtlMs = 60_000, run = runOneStage, now = () => new Date().toISOString() }) {
  const claimed = claimNextWakeup(queuePath, { actorId, now });
  if (!claimed) return { status: "idle" };
  const statePath = resolve(stateRoot, "tasks", claimed.taskRef, "state.json");
  const leaseRoot = resolve(stateRoot, "leases");
  const runId = `wakeup-${claimed.wakeupId}`;
  let leased = false;
  try {
    if (!existsSync(statePath)) throw new Error(`Unknown task state '${claimed.taskRef}'`);
    mkdirSync(leaseRoot, { recursive: true, mode: 0o700 });
    acquireTaskLease({ root: leaseRoot, taskId: claimed.taskRef, actorId, runId, ttlMs: leaseTtlMs });
    leased = true;
    const heartbeat = () => renewTaskLease({ root: leaseRoot, taskId: claimed.taskRef, actorId, runId, ttlMs: leaseTtlMs });
    const result = await run({ hqRoot, statePath, wakeup: claimed, heartbeat });
    finishWakeup(queuePath, { wakeupId: claimed.wakeupId, actorId, outcome: "succeeded", now });
    return { status: "processed", wakeupId: claimed.wakeupId, taskId: claimed.taskRef, result };
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

export function defaultWakeupPaths(hqRoot) {
  const stateRoot = join(resolve(hqRoot), "dashboard", "backend", "data", "factory", "Openclaw-Agents-Headquarter");
  return { stateRoot, queuePath: join(stateRoot, "wakeups.json") };
}
