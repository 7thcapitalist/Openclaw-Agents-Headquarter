import { join } from "path";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { mutateTransactionalState, readTransactionalState } from "../../../factory/lib/store/transactional-json.mjs";

const MAX_ITEMS = 8;
const MAX_OBJECTIVE_LENGTH = 1000;

function queuePath(root) {
  return join(root, "dashboard", "backend", "data", "factory", "overnight-queue.json");
}

// `runnerPid` is the durable half of "is anything actually driving this queue".
// The module-scope `rootInFlight` below is the authoritative answer only inside
// the process that owns the run; it does not survive a restart, and a dashboard
// restarted mid-run used to leave `status: "running"` with no child, forever,
// with nothing anywhere able to clear it. Recording who owns the run lets any
// later process tell a live run from an abandoned one.
function blank() { return { version: 1, status: "idle", items: [], startedAt: null, stoppedAt: null, currentItemId: null, stopRequested: false, runnerPid: null }; }

export function readOvernightQueue(root) {
  try {
    const value = readTransactionalState(queuePath(root));
    return { ...blank(), ...value, items: Array.isArray(value.items) ? value.items : [] };
  } catch { return blank(); }
}

// The one write primitive: read-modify-write as one atomic transaction, so a
// dashboard "add"/"remove" can never race the background runner's own
// status updates and silently drop one side's change.
function mutate(root, commandId, fn) {
  return mutateTransactionalState(queuePath(root), {
    commandId,
    mutate: (state) => {
      const next = { ...blank(), ...(state || {}), items: Array.isArray(state?.items) ? [...state.items] : [] };
      fn(next);
      return next;
    },
  });
}

export function addOvernightItem(root, { objective, projectId, repo }) {
  const text = String(objective || "").trim();
  if (!text || text.length > MAX_OBJECTIVE_LENGTH) throw new Error(`Each overnight objective must be 1–${MAX_OBJECTIVE_LENGTH} characters.`);
  if (!projectId || !repo) throw new Error("projectId and repo are required.");
  reconcileOvernight(root);
  return mutate(root, `overnight-add:${randomUUID()}`, (state) => {
    if (state.status === "running") throw new Error("Stop the overnight run before changing its plan.");
    if (state.items.length >= MAX_ITEMS) throw new Error(`Overnight plans are limited to ${MAX_ITEMS} objectives.`);
    state.items.push({ id: `night-${randomUUID()}`, objective: text, projectId: String(projectId), repo: String(repo), status: "queued", addedAt: new Date().toISOString() });
  });
}

export function removeOvernightItem(root, id) {
  reconcileOvernight(root);
  return mutate(root, `overnight-remove:${randomUUID()}`, (state) => {
    if (state.status === "running") throw new Error("Stop the overnight run before changing its plan.");
    state.items = state.items.filter((item) => item.id !== id);
  });
}

let child = null;
let rootInFlight = null;

// Test seam. The runner's own process is the one case `process.kill(pid, 0)`
// cannot answer — it would report "alive" for this very process even when this
// process has no run in flight — so ownership is decided before liveness.
export function __setRootInFlight(value) { rootInFlight = value; }

/**
 * Is something still driving this queue?
 *
 * Ownership first, liveness second:
 *   - no recorded pid: a run started before this marker existed, or a state
 *     hand-written. Nothing can vouch for it, so it is not alive.
 *   - our pid: `rootInFlight` is the truth. It is null after a restart even
 *     though the pid may coincidentally match, which is exactly the case that
 *     used to strand the queue.
 *   - another pid: ask the OS.
 *
 * `process.kill(pid, 0)` cannot rule out pid reuse, so a recycled pid can read
 * as alive. That is strictly better than the previous answer, which was to
 * assume every `running` queue was live forever, and it fails toward "leave it
 * alone" rather than toward killing a real run's bookkeeping.
 */
function runnerIsAlive(state) {
  const pid = Number(state?.runnerPid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return rootInFlight !== null;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Settle a queue whose runner is gone.
 *
 * Returns the queue either way, so every caller can simply reconcile first and
 * then act on what it gets back. A run that is genuinely live is untouched.
 */
export function reconcileOvernight(root) {
  const state = readOvernightQueue(root);
  if (state.status !== "running" || runnerIsAlive(state)) return state;
  const now = new Date().toISOString();
  return mutate(root, `overnight-reconcile:${randomUUID()}`, (next) => {
    // The item that was mid-flight when the runner died did not finish, and
    // saying it "completed" would be a wrong answer about work that may have
    // half-run. It is failed, with the reason named.
    for (const item of next.items) {
      if (item.status === "running") {
        item.status = "failed";
        item.endedAt = now;
        item.error = "The overnight runner stopped before this finished — the machine restarted mid-run.";
      }
    }
    // Computed after the mid-flight item is marked, so its failure counts.
    next.status = next.items.some((item) => item.status === "failed") ? "needs-attention" : "stopped";
    next.currentItemId = null;
    next.stoppedAt = now;
    next.stopRequested = false;
    next.runnerPid = null;
  });
}

export function startOvernight(root, { scriptPath, spawnChild = spawn }) {
  // A stranded queue must not block a fresh night. Before this, the founder's
  // only recovery was to edit state on the machine — from a phone, none.
  const state = reconcileOvernight(root);
  if (state.status === "running") return state;
  const pending = state.items.filter((item) => item.status === "queued");
  if (!pending.length) throw new Error("Add at least one objective to the overnight plan first.");
  mutate(root, `overnight-start:${randomUUID()}`, (next) => {
    next.status = "running"; next.startedAt = new Date().toISOString(); next.stoppedAt = null; next.stopRequested = false;
    next.runnerPid = process.pid;
  });
  runNext(root, scriptPath, spawnChild);
  return readOvernightQueue(root);
}

function runNext(root, scriptPath, spawnChild) {
  if (rootInFlight) return;
  rootInFlight = root;
  const state = readOvernightQueue(root);
  if (state.stopRequested || !state.items.some((item) => item.status === "queued")) {
    mutate(root, `overnight-drain:${randomUUID()}`, (next) => {
      next.status = state.stopRequested ? "stopped" : next.items.some((item) => item.status === "failed") ? "needs-attention" : "complete";
      next.currentItemId = null; next.stoppedAt = new Date().toISOString(); next.runnerPid = null;
    });
    rootInFlight = null; return;
  }
  const itemId = state.items.find((entry) => entry.status === "queued").id;
  const item = mutate(root, `overnight-item-start:${itemId}`, (next) => {
    const target = next.items.find((entry) => entry.id === itemId);
    target.status = "running"; target.startedAt = new Date().toISOString(); next.currentItemId = target.id;
  }).items.find((entry) => entry.id === itemId);
  let settled = false;
  const finish = (code, error = null) => {
    if (settled) return;
    settled = true;
    const next = mutate(root, `overnight-item-finish:${itemId}`, (state) => {
      const finished = state.items.find((entry) => entry.id === item.id);
      if (finished) { finished.status = code === 0 ? "complete" : "failed"; finished.endedAt = new Date().toISOString(); finished.exitCode = code; finished.error = error ? "The objective worker could not start." : code === 0 ? null : "The objective stopped before delivery. Review its execution record."; }
    });
    child = null; rootInFlight = null;
    if (next.status === "running") runNext(root, scriptPath, spawnChild);
  };
  try {
    child = spawnChild(process.execPath, [scriptPath, "start", "--objective", item.objective, "--project", item.projectId, "--repo", item.repo], { cwd: root, stdio: "ignore" });
    child.once("error", () => finish(null, true));
    child.once("close", (code) => finish(code));
  } catch { finish(null, true); }
}

export function stopOvernight(root) {
  // `stopRequested` is a flag the RUNNER observes between items. Setting it on
  // a queue whose runner is gone would change nothing and report success, so a
  // dead run is settled outright instead.
  const state = reconcileOvernight(root);
  if (state.status !== "running") return state;
  mutate(root, `overnight-stop:${randomUUID()}`, (next) => { next.stopRequested = true; });
  return readOvernightQueue(root);
}

export const overnightLimit = MAX_ITEMS;
