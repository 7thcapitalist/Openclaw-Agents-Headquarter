// One timeline for one run.
//
// Adapted from Paperclip's `activity`, `issue-liveness` and `work-timeline`
// services at pinned commit 6abeb67334348dcb6fde2d591a27ffc7efc7118d (MIT).
// Issue #122.
//
// The operational record of a task is spread across seven files written by
// different layers: canonical workflow events in state.json, attributed audit
// records in audit.ndjson, run liveness in liveness.json, ownership in the
// lease store, durable wakeups in the queue, usage in the cost ledger, and
// graph findings in graph-health.json. Answering "what happened to this run"
// meant opening all seven and merging them by hand.
//
// This merges them once, in order, with the source of every entry named — so a
// disagreement between layers is visible rather than averaged away.
//
// Two rules constrain what may cross this boundary:
//
//   Nothing here reads a prompt, a private conversation, a credential, or an
//   arbitrary file. Evidence appears as a PATH, never as content.
//
//   A source that cannot be read is reported as unavailable with its reason.
//   It is never silently omitted, because an incomplete timeline that looks
//   complete is worse than an obviously broken one.

import { existsSync, readFileSync, readdirSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { readAuditEvents } from "../audit/envelope.mjs";
import { readCostEvents, summarizeCostLedger } from "./cost-ledger.mjs";
import { readWakeupQueue } from "../wakeups/queue.mjs";
import { readLease } from "../leases/task-lease.mjs";
import { defaultStateRoot } from "./tasks.mjs";

const MAX_ENTRIES = 500;
const MAX_TEXT = 300;

export function buildRunTimeline({ hqRoot, taskId, stateRoot = null, now = new Date().toISOString(), limit = 200 } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(String(taskId || ""))) {
    throw new Error("taskId is invalid");
  }
  const root = resolve(stateRoot || defaultStateRoot(hqRoot));
  const taskDir = findTaskDir(root, taskId);
  if (!taskDir) return null;

  const sources = [];
  const entries = [];

  const state = read(sources, "workflow", join(taskDir, "state.json"), (path) => JSON.parse(readFileSync(path, "utf8")));
  if (state) entries.push(...workflowEntries(state));

  const audit = read(sources, "audit", join(taskDir, "audit.ndjson"), readAuditEvents, []);
  if (audit) entries.push(...auditEntries(audit));

  const liveness = read(sources, "liveness", join(taskDir, "liveness.json"), (path) => JSON.parse(readFileSync(path, "utf8")));
  if (liveness) entries.push(...livenessEntries(liveness));

  const leaseRoot = join(dirname(dirname(taskDir)), "leases");
  const lease = read(sources, "lease", leaseRoot, () => readLease(leaseRoot, taskId));
  if (lease) entries.push(...leaseEntries(lease));

  const queuePath = join(dirname(dirname(taskDir)), "wakeups.json");
  const wakeups = read(sources, "wakeups", queuePath, (path) => readWakeupQueue(path).items.filter((item) => item.taskRef === taskId), []);
  if (wakeups) entries.push(...wakeupEntries(wakeups));

  const costPath = join(resolve(hqRoot), ".openclaw-factory", "telemetry", "cost-events.ndjson");
  const costEvents = read(sources, "cost", costPath, (path) => readCostEvents(path).filter((event) => event.taskId === taskId), []);

  const graphHealth = read(sources, "graph", objectiveHealthPath(root, taskId), (path) => JSON.parse(readFileSync(path, "utf8")));
  if (graphHealth) entries.push(...graphEntries(graphHealth, taskId));

  entries.sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.source.localeCompare(b.source));
  const bounded = entries.slice(-Math.min(Math.max(1, limit), MAX_ENTRIES));

  return {
    version: 1,
    asOf: now,
    taskId,
    // A timeline is only as honest as its worst source, so say so at the top.
    available: sources.every((source) => source.available !== false),
    sources,
    task: state
      ? {
        outcome: text(state.task?.outcome),
        project: state.task?.project || null,
        risk: state.task?.risk || null,
        status: state.status || null,
        currentStage: state.currentStage || null,
        branch: state.branch || null,
        createdAt: state.createdAt || null,
        updatedAt: state.updatedAt || null,
      }
      : null,
    ownership: lease ? { actorId: lease.actorId, runId: lease.runId, expiresAt: lease.expiresAt } : null,
    cost: costEvents ? summarizeCostLedger(costEvents).totals : null,
    // Paths only. Reading evidence content is the task view's job, behind its
    // own authorisation — not something a timeline hands out.
    evidence: state ? evidencePaths(state) : [],
    counts: countBySource(entries),
    truncated: entries.length > bounded.length,
    entries: bounded,
  };
}

// ------------------------------------------------------------------ internals

function read(sources, name, path, parse, fallback = null) {
  if (!existsSync(path)) {
    sources.push({ name, available: true, present: false, reason: "not recorded for this task" });
    return fallback;
  }
  try {
    const value = parse(path);
    sources.push({ name, available: true, present: true });
    return value;
  } catch (error) {
    // Named and reported. A source that fails silently turns a partial
    // timeline into a confident one.
    sources.push({ name, available: false, present: true, reason: String(error?.message || error).slice(0, MAX_TEXT) });
    return fallback;
  }
}

function workflowEntries(state) {
  return (state.events || []).filter((event) => event.at).map((event) => ({
    at: event.at,
    source: "workflow",
    kind: String(event.type || "event"),
    actor: event.actor || null,
    stage: event.stage || null,
    detail: text(event.detail || event.reason || event.summary || event.classification || null),
  }));
}

function auditEntries(events) {
  return events.map((event) => ({
    at: event.occurredAt,
    source: "audit",
    kind: String(event.action || "audit"),
    actor: event.actor?.id || null,
    stage: event.correlation?.stage || null,
    // `data` is already sanitised by the audit envelope; take only scalars, so
    // a future field cannot smuggle a blob through this projection.
    detail: text(Object.entries(event.data || {})
      .filter(([, value]) => value != null && typeof value !== "object")
      .map(([key, value]) => `${key}=${value}`)
      .join(" ")),
  }));
}

function livenessEntries(liveness) {
  return [{
    at: liveness.recordedAt || null,
    source: "liveness",
    kind: `run.${String(liveness.state || "unknown")}`,
    actor: null,
    stage: null,
    detail: text([liveness.reason, liveness.nextAction].filter(Boolean).join(" — ")),
  }].filter((entry) => entry.at);
}

function leaseEntries(lease) {
  return [{
    at: lease.acquiredAt || lease.updatedAt || null,
    source: "lease",
    kind: "ownership.acquired",
    actor: lease.actorId || null,
    stage: null,
    detail: text(lease.expiresAt ? `held until ${lease.expiresAt}` : null),
  }].filter((entry) => entry.at);
}

function wakeupEntries(items) {
  return items.map((item) => ({
    at: item.updatedAt || item.createdAt,
    source: "wakeup",
    kind: `wakeup.${String(item.status || "queued")}`,
    actor: item.actorId || null,
    stage: null,
    detail: text([`source=${item.source}`, `attempt=${item.attempt}/${item.maxAttempts}`, item.error].filter(Boolean).join(" ")),
  })).filter((entry) => entry.at);
}

function graphEntries(health, taskId) {
  return (health.findings || [])
    .filter((finding) => (finding.nodeIds || []).includes(taskId) || (finding.strandedNodeIds || []).includes(taskId))
    .map((finding) => ({
      at: health.recordedAt || null,
      source: "graph",
      kind: `graph.${String(finding.code || "finding")}`,
      actor: null,
      stage: null,
      detail: text(finding.message),
    }))
    .filter((entry) => entry.at);
}

function evidencePaths(state) {
  const out = [];
  for (const [stage, result] of Object.entries(state.stages || {})) {
    for (const item of result?.evidence || []) {
      const path = typeof item === "string" ? item : item?.path;
      if (path) out.push({ stage, path: String(path).slice(0, MAX_TEXT) });
    }
  }
  return out;
}

function countBySource(entries) {
  const out = {};
  for (const entry of entries) out[entry.source] = (out[entry.source] || 0) + 1;
  return out;
}

function objectiveHealthPath(root, taskId) {
  const match = /^(obj-[a-z0-9]+)-/i.exec(taskId);
  if (!match) return join(root, "__no-objective__", "graph-health.json");
  for (const project of safeReadDir(root)) {
    if (!project.isDirectory()) continue;
    const path = join(root, project.name, "objectives", match[1], "graph-health.json");
    if (existsSync(path)) return path;
  }
  return join(root, "__no-objective__", "graph-health.json");
}

function findTaskDir(root, taskId) {
  for (const project of safeReadDir(root)) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name, "tasks", taskId);
    if (existsSync(join(dir, "state.json"))) return dir;
  }
  // Some layouts nest task state elsewhere; fall back to a bounded search.
  for (const path of stateFiles(root)) if (basename(dirname(path)) === taskId) return dirname(path);
  return null;
}

function stateFiles(root, out = []) {
  for (const entry of safeReadDir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) stateFiles(path, out);
    else if (entry.isFile() && entry.name === "state.json") out.push(path);
  }
  return out;
}

function safeReadDir(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function text(value) {
  return value == null ? null : String(value).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) || null;
}
