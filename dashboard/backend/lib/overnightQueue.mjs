import { join } from "path";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { mutateTransactionalState, readTransactionalState } from "../../../factory/lib/store/transactional-json.mjs";

const MAX_ITEMS = 8;
const MAX_OBJECTIVE_LENGTH = 1000;

function queuePath(root) {
  return join(root, "dashboard", "backend", "data", "factory", "overnight-queue.json");
}

function blank() { return { version: 1, status: "idle", items: [], startedAt: null, stoppedAt: null, currentItemId: null, stopRequested: false }; }

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
  return mutate(root, `overnight-add:${randomUUID()}`, (state) => {
    if (state.status === "running") throw new Error("Stop the overnight run before changing its plan.");
    if (state.items.length >= MAX_ITEMS) throw new Error(`Overnight plans are limited to ${MAX_ITEMS} objectives.`);
    state.items.push({ id: `night-${randomUUID()}`, objective: text, projectId: String(projectId), repo: String(repo), status: "queued", addedAt: new Date().toISOString() });
  });
}

export function removeOvernightItem(root, id) {
  return mutate(root, `overnight-remove:${randomUUID()}`, (state) => {
    if (state.status === "running") throw new Error("Stop the overnight run before changing its plan.");
    state.items = state.items.filter((item) => item.id !== id);
  });
}

let child = null;
let rootInFlight = null;

export function startOvernight(root, { scriptPath, spawnChild = spawn }) {
  const state = readOvernightQueue(root);
  if (state.status === "running") return state;
  const pending = state.items.filter((item) => item.status === "queued");
  if (!pending.length) throw new Error("Add at least one objective to the overnight plan first.");
  mutate(root, `overnight-start:${randomUUID()}`, (next) => {
    next.status = "running"; next.startedAt = new Date().toISOString(); next.stoppedAt = null; next.stopRequested = false;
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
      next.currentItemId = null; next.stoppedAt = new Date().toISOString();
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
  const state = readOvernightQueue(root);
  if (state.status !== "running") return state;
  mutate(root, `overnight-stop:${randomUUID()}`, (next) => { next.stopRequested = true; });
  return readOvernightQueue(root);
}

export const overnightLimit = MAX_ITEMS;
