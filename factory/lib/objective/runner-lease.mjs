// Who is running an objective, and is that process still alive?
//
// runObjective is a function, not a daemon. It lives in whichever process
// called it — the dashboard, a terminal running scripts/factory-objective.mjs,
// the improve loop — and nothing recorded which. So when a dashboard restart
// killed a run, the reconciler that wakes up afterwards could not tell "its
// runner is dead" from "another process is driving it right now", and fell
// back to the only evidence it had: how recently the task state was written.
// Anything touched in the last 90 minutes was presumed live.
//
// obj-154e9b39 on 2026-09-16 is what that costs. Its builder passed at
// 19:28:04Z, the dashboard restarted at 19:31:29Z, the reconciler found the
// task written three minutes earlier, called it "still live", and — because it
// only runs at boot — never looked again. The objective read "Running" for
// eleven hours with nothing running.
//
// So a run now leaves a record on the objective: the pid, that process's start
// time from /proc (which is what makes a recycled pid distinguishable from the
// original), and a random id for this process. The record answers the question
// the timestamp only guessed at.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";

// Unique to this process. Two processes can share a pid over time; they cannot
// share this.
const INSTANCE = randomUUID();

// Runs this process is driving right now, by objective path. A count, not a
// flag: the founder's retry can start a second runObjective on an objective
// this process is already driving.
const live = new Map();

/** The process start time the kernel reports, or null off Linux. */
export function processStartTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 2 (comm) may contain spaces and parentheses; everything after the
    // LAST ")" is space-separated from field 3 onward, so starttime (field 22)
    // is index 19 there.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it just is not ours to signal.
    return error?.code === "EPERM";
  }
}

export function runnerIdentity({ now = () => new Date().toISOString() } = {}) {
  return {
    pid: process.pid,
    processStart: processStartTicks(process.pid),
    instance: INSTANCE,
    host: hostname(),
    startedAt: now(),
  };
}

export function beginRun(objectivePath) {
  live.set(objectivePath, (live.get(objectivePath) || 0) + 1);
}

/** Returns true when this was the last run of that objective in this process. */
export function endRun(objectivePath) {
  const left = (live.get(objectivePath) || 1) - 1;
  if (left > 0) { live.set(objectivePath, left); return false; }
  live.delete(objectivePath);
  return true;
}

export function isOurs(runner) {
  return runner?.instance === INSTANCE;
}

/**
 * What the recorded runner tells us.
 *
 *   "none"    no record — never stamped (older state) or the run ended cleanly
 *   "live"    a process is driving it: leave it alone
 *   "gone"    the recorded process is provably dead: adopt it now
 *   "unknown" recorded on another host, or unreadable — fall back to age
 *
 * `isAlive` and `startOf` are injectable so the decision is testable without
 * real processes.
 */
export function runnerStatus(runner, objectivePath, { isAlive = pidAlive, startOf = processStartTicks, host = hostname() } = {}) {
  if (!runner || typeof runner !== "object") return "none";
  if (runner.instance === INSTANCE) return live.has(objectivePath) ? "live" : "gone";
  if (runner.host && runner.host !== host) return "unknown";
  const pid = Number(runner.pid);
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  if (!isAlive(pid)) return "gone";
  // Alive — but is it the same process, or a new one that was handed the pid?
  const current = startOf(pid);
  if (runner.processStart && current && String(current) !== String(runner.processStart)) return "gone";
  return "live";
}
