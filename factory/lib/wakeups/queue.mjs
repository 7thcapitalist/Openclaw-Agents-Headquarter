// Adapted from Paperclip's agent_wakeup_requests model at commit
// 6abeb67334348dcb6fde2d591a27ffc7efc7118d (MIT).
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { assertSupportedVersion } from "../store/durable-version.mjs";
import { dirname, resolve } from "path";

export const WAKEUP_SOURCES = Object.freeze(["schedule", "assignment", "mention", "dependency", "recovery", "manual"]);
export const WAKEUP_STATUSES = Object.freeze(["queued", "claimed", "succeeded", "failed", "dead-letter"]);
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;

export function enqueueWakeup(path, input, options = {}) {
  if (input && ("command" in input || "payload" in input)) throw new Error("Wakeups cannot contain commands or arbitrary payloads");
  return mutate(path, (state) => {
    const request = makeRequest(input, options);
    const duplicate = state.items.find((item) => item.idempotencyKey === request.idempotencyKey);
    if (duplicate) return { state, result: { ...duplicate, duplicate: true } };
    state.items.push(request); return { state, result: request };
  });
}

export function claimNextWakeup(path, { actorId, now = () => new Date().toISOString() }) {
  checkSafe(actorId, "actorId");
  return mutate(path, (state) => {
    const at = now();
    const item = state.items.filter((row) => row.status === "queued" && row.notBefore <= at)
      .sort((a, b) => a.notBefore.localeCompare(b.notBefore) || a.createdAt.localeCompare(b.createdAt) || a.wakeupId.localeCompare(b.wakeupId))[0];
    if (!item) return { state, result: null };
    item.status = "claimed"; item.claimedBy = actorId; item.claimedAt = at; item.attempt += 1; item.updatedAt = at;
    return { state, result: { ...item } };
  });
}

export function finishWakeup(path, { wakeupId, actorId, outcome, error = null, now = () => new Date().toISOString() }) {
  if (!['succeeded', 'failed'].includes(outcome)) throw new Error("outcome must be succeeded or failed");
  return mutate(path, (state) => {
    const item = state.items.find((row) => row.wakeupId === wakeupId);
    if (!item) throw new Error(`Unknown wakeup '${wakeupId}'`);
    if (item.status !== "claimed" || item.claimedBy !== actorId) throw new Error("Wakeup is not claimed by this actor");
    const at = now(); item.finishedAt = at; item.updatedAt = at;
    if (outcome === "failed" && item.attempt < item.maxAttempts) { item.status = "queued"; item.claimedBy = null; item.claimedAt = null; item.error = trim(error); }
    else { item.status = outcome === "failed" ? "dead-letter" : "succeeded"; item.error = outcome === "failed" ? trim(error) : null; }
    return { state, result: { ...item } };
  });
}

export function readWakeupQueue(path) {
  if (!existsSync(path)) return { version: 1, items: [] };
  const state = JSON.parse(readFileSync(path, "utf8"));
  assertSupportedVersion(state?.version, { format: "wakeup-queue", path });
  if (!Array.isArray(state.items)) throw new Error("Invalid wakeup queue");
  state.items.forEach(validateRequest); return state;
}

export function wakeupQueueHealth(path, now = new Date().toISOString()) {
  const items = readWakeupQueue(path).items;
  const counts = Object.fromEntries(WAKEUP_STATUSES.map((status) => [status, items.filter((x) => x.status === status).length]));
  const queued = items.filter((x) => x.status === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { version: 1, counts, oldestQueuedAt: queued[0]?.createdAt || null, ready: queued.filter((x) => x.notBefore <= now).length };
}

function makeRequest(input, { now = () => new Date().toISOString(), id = randomUUID } = {}) {
  const at = now(); const request = { version: 1, wakeupId: id(), source: input?.source, taskRef: input?.taskRef, actorId: input?.actorId,
    idempotencyKey: input?.idempotencyKey, notBefore: input?.notBefore || at, contextRef: input?.contextRef || null,
    status: "queued", attempt: 0, maxAttempts: input?.maxAttempts ?? 3, claimedBy: null, claimedAt: null, finishedAt: null, error: null, createdAt: at, updatedAt: at };
  validateRequest(request); return request;
}
function validateRequest(row) {
  if (row.version !== 1) throw new Error("Invalid wakeup version");
  if (!WAKEUP_SOURCES.includes(row.source)) throw new Error("Invalid wakeup source");
  for (const key of ["wakeupId", "taskRef", "actorId", "idempotencyKey"]) checkSafe(row[key], key);
  if (row.contextRef != null) checkSafe(row.contextRef, "contextRef");
  if (!WAKEUP_STATUSES.includes(row.status)) throw new Error("Invalid wakeup status");
  if (!Number.isInteger(row.attempt) || !Number.isInteger(row.maxAttempts) || row.maxAttempts < 1 || row.maxAttempts > 10) throw new Error("Invalid wakeup attempts");
  for (const key of ["notBefore", "createdAt", "updatedAt"]) if (!Number.isFinite(Date.parse(row[key] || ""))) throw new Error(`Invalid ${key}`);
  if ('command' in row || 'payload' in row) throw new Error("Wakeups cannot contain commands or arbitrary payloads"); return row;
}
function mutate(path, fn) {
  const target = resolve(path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); const lock = `${target}.lock`;
  try { mkdirSync(lock); } catch (error) { if (error.code === "EEXIST") throw new Error("Wakeup queue is busy"); throw error; }
  try { const { state, result } = fn(readWakeupQueue(target)); const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`; writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); renameSync(tmp, target); return result; }
  finally { rmSync(lock, { recursive: true, force: true }); }
}
function checkSafe(value, label) { if (!SAFE.test(String(value || ""))) throw new Error(`${label} is invalid`); }
function trim(value) { const text = String(value || "failed").replace(/\s+/g, " ").trim(); return text.slice(0, 500); }
