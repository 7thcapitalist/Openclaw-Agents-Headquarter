import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";

const MAX_ITEMS = 8;
const MAX_OBJECTIVE_LENGTH = 1000;

function queuePath(root) {
  return join(root, "dashboard", "backend", "data", "factory", "overnight-queue.json");
}

function blank() { return { version: 1, status: "idle", items: [], startedAt: null, stoppedAt: null, currentItemId: null, stopRequested: false }; }

export function readOvernightQueue(root) {
  try {
    const value = JSON.parse(readFileSync(queuePath(root), "utf8"));
    return { ...blank(), ...value, items: Array.isArray(value.items) ? value.items : [] };
  } catch { return blank(); }
}

function write(root, state) {
  const path = queuePath(root);
  mkdirSync(join(root, "dashboard", "backend", "data", "factory"), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  return state;
}

export function addOvernightItem(root, { objective, projectId, repo }) {
  const text = String(objective || "").trim();
  if (!text || text.length > MAX_OBJECTIVE_LENGTH) throw new Error(`Each overnight objective must be 1–${MAX_OBJECTIVE_LENGTH} characters.`);
  if (!projectId || !repo) throw new Error("projectId and repo are required.");
  const state = readOvernightQueue(root);
  if (state.status === "running") throw new Error("Stop the overnight run before changing its plan.");
  if (state.items.length >= MAX_ITEMS) throw new Error(`Overnight plans are limited to ${MAX_ITEMS} objectives.`);
  state.items.push({ id: `night-${Date.now().toString(36)}`, objective: text, projectId: String(projectId), repo: String(repo), status: "queued", addedAt: new Date().toISOString() });
  return write(root, state);
}

export function removeOvernightItem(root, id) {
  const state = readOvernightQueue(root);
  if (state.status === "running") throw new Error("Stop the overnight run before changing its plan.");
  state.items = state.items.filter((item) => item.id !== id);
  return write(root, state);
}

let child = null;
let rootInFlight = null;

export function startOvernight(root, { scriptPath }) {
  const state = readOvernightQueue(root);
  if (state.status === "running") return state;
  const pending = state.items.filter((item) => item.status === "queued" || item.status === "failed");
  if (!pending.length) throw new Error("Add at least one objective to the overnight plan first.");
  state.status = "running"; state.startedAt = new Date().toISOString(); state.stoppedAt = null; state.stopRequested = false;
  write(root, state);
  runNext(root, scriptPath);
  return readOvernightQueue(root);
}

function runNext(root, scriptPath) {
  if (rootInFlight) return;
  rootInFlight = root;
  let state = readOvernightQueue(root);
  if (state.stopRequested || !state.items.some((item) => item.status === "queued" || item.status === "failed")) {
    state.status = state.stopRequested ? "stopped" : "complete"; state.currentItemId = null; state.stoppedAt = new Date().toISOString();
    write(root, state); rootInFlight = null; return;
  }
  const item = state.items.find((entry) => entry.status === "queued" || entry.status === "failed");
  item.status = "running"; item.startedAt = new Date().toISOString(); state.currentItemId = item.id; write(root, state);
  child = spawn(process.execPath, [scriptPath, "start", "--objective", item.objective, "--project", item.projectId, "--repo", item.repo], { cwd: root, stdio: "ignore" });
  child.once("close", (code) => {
    const next = readOvernightQueue(root);
    const finished = next.items.find((entry) => entry.id === item.id);
    if (finished) { finished.status = code === 0 ? "complete" : "failed"; finished.endedAt = new Date().toISOString(); finished.exitCode = code; }
    child = null; rootInFlight = null; write(root, next);
    if (next.status === "running") runNext(root, scriptPath);
  });
}

export function stopOvernight(root) {
  const state = readOvernightQueue(root);
  if (state.status !== "running") return state;
  state.stopRequested = true; write(root, state);
  if (child) child.kill("SIGTERM");
  return readOvernightQueue(root);
}

export const overnightLimit = MAX_ITEMS;
