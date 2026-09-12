// Bound how much work one run may touch, not only which work.
//
// Adapted from Paperclip's `cross-issue-influence-limit` service at pinned
// commit 6abeb67334348dcb6fde2d591a27ffc7efc7118d (MIT). Issue #160.
//
// THE GAP. #141 scopes capabilities by company / project / task. That bounds
// WHICH work an agent may touch. Nothing bounds HOW MUCH. An agent granted
// `company:*` -- which the shipped example grant table does for
// `task.initialize` and `task.dispatch` -- may act on an unlimited number of
// tasks inside that scope. Scope and blast radius are different properties and
// HQ had only the first.
//
// ALERT-ONLY, DELIBERATELY. Upstream ships a hard cap of 20 with an enforcement
// date. HQ gets the counter and the alert first, the same way budgets (#139)
// and permissions (#141) arrived, because a threshold tuned against no data
// stops legitimate work on its first day. Enforcement is a separate change with
// its own evidence.
//
// WHAT IS COUNTED. Distinct subjects a single run was ALLOWED to act on. A
// denial touched nothing, so it does not count. Acting on the same task twenty
// times is one subject, because the blast radius is how far the run reached,
// not how busy it was.
//
// THE FOUNDER IS NEVER COUNTED. A decision allowed by `founder-authority` is a
// person acting, and a person is not an agent with a scope. But
// `founder-approved-task` IS counted: the founder approved ONE task, and an
// agent carrying that approval into twenty other subjects is exactly the thing
// this measures.

import { existsSync, readdirSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { appendAuditEvent, createAuditEvent, readAuditEvents } from "../audit/envelope.mjs";
import { defaultStateRoot } from "./tasks.mjs";

// Upstream's number. It is a starting point for observation, not a tuned limit.
export const DEFAULT_THRESHOLD = 20;

const MAX_TRACKED = 500;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

// Reasons that mean "a person did this", which is not an agent's blast radius.
const FOUNDER_REASONS = new Set(["founder-authority"]);

// One subject, named the way the audit log names it, so the live counter and
// the durable report can never disagree about what a subject is.
export function subjectKey(decision) {
  const type = decision?.subject?.type || decision?.scope?.type || null;
  const id = decision?.subject?.id || decision?.scope?.id || decision?.scope?.projectId || null;
  if (!type || !id) return null;
  if (!SAFE_ID.test(String(type)) || !SAFE_ID.test(String(id))) return null;
  return `${type}:${id}`;
}

// Per run, not per agent lifetime. The tracker lives as long as the run does
// and is thrown away with it -- an agent that touches three subjects in each of
// ten runs has a blast radius of three, not thirty.
export function createRunBlastRadius({ runId, actorId, threshold = DEFAULT_THRESHOLD }) {
  return {
    version: 1,
    runId: String(runId || "unknown"),
    actorId: String(actorId || "unknown"),
    threshold: bounded(threshold, 1, MAX_TRACKED, DEFAULT_THRESHOLD),
    subjects: new Set(),
    // The alert fires once. A run that reaches 80 subjects should produce one
    // alert, not sixty.
    alerted: false,
  };
}

export function recordAllowedSubject(tracker, decision) {
  const skip = (reason) => ({ counted: false, reason, count: tracker?.subjects?.size ?? 0, crossed: false, threshold: tracker?.threshold ?? DEFAULT_THRESHOLD });
  if (!tracker) return skip("no-tracker");
  if (!decision?.allowed) return skip("denied");
  // A `report`-mode verdict that WOULD have been denied did not really widen
  // anything an enforcing factory would have permitted, but it did touch the
  // subject, so it counts. Saying otherwise would make the observation useless
  // in exactly the mode it exists to be observed in.
  if (decision.actor?.type === "human" || FOUNDER_REASONS.has(decision.reason)) return skip("founder-action");

  const key = subjectKey(decision);
  if (!key) return skip("unnamed-subject");
  if (tracker.subjects.has(key)) return skip("already-counted");
  // A bound on memory, not on truth: past this the count stops rising and the
  // alert has long since fired.
  if (tracker.subjects.size >= MAX_TRACKED) return skip("tracking-limit");

  tracker.subjects.add(key);
  const count = tracker.subjects.size;
  const crossed = count >= tracker.threshold && !tracker.alerted;
  if (crossed) tracker.alerted = true;
  return { counted: true, reason: "counted", subject: key, count, crossed, threshold: tracker.threshold };
}

// Recorded with the same attribution as a permission decision, into the same
// append-only log, because an alert nobody can find later is not an alert.
// Best-effort in the same sense: failing to record must not turn an allowed
// action into an outage.
export function recordBlastRadiusAlert(auditPath, tracker, { correlation = {}, now = () => new Date().toISOString() } = {}) {
  try {
    appendAuditEvent(auditPath, createAuditEvent({
      occurredAt: now(),
      actor: { type: "agent", id: tracker.actorId },
      action: "blast-radius.exceeded",
      subject: { type: "system", id: "factory" },
      correlation: sanitizeCorrelation({ runId: tracker.runId, ...correlation }),
      data: {
        subjects: String(tracker.subjects.size),
        threshold: String(tracker.threshold),
        // Said in the record itself, so an operator reading raw NDJSON is not
        // left wondering whether something was stopped.
        enforcement: "alert-only",
      },
    }, { now }));
    return { recorded: true };
  } catch (error) {
    return { recorded: false, reason: String(error?.message || error) };
  }
}

// The convenience a caller uses: count, and alert exactly once on crossing.
export function observeSubject({ tracker, decision, auditPath = null, correlation = {}, now = () => new Date().toISOString() }) {
  const result = recordAllowedSubject(tracker, decision);
  // Alert-only: nothing here can refuse anything, and there is deliberately no
  // code path that throws.
  if (result.crossed && auditPath) recordBlastRadiusAlert(auditPath, tracker, { correlation, now });
  return result;
}

// ------------------------------------------------------- the durable analysis

// The live tracker dies with its run. The durable record is the permission
// ledger, which already names every allowed decision, its actor and its
// subject. Reading the count back from there means the operator report cannot
// drift from what actually happened.
export function analyzeBlastRadius(events, { threshold = DEFAULT_THRESHOLD } = {}) {
  const runs = new Map();
  for (const event of events || []) {
    if (event?.action !== "permission.allowed") continue;
    if (event.actor?.type === "human") continue;
    if (String(event.data?.wouldDeny) === "true") {
      // A report-mode verdict that would have been denied is counted, for the
      // same reason as above, but flagged so the operator can tell the two
      // apart.
    }
    const runId = event.correlation?.runId || event.correlation?.taskId || null;
    if (!runId) continue;
    const key = `${event.actor?.id || "unknown"}|${runId}`;
    if (!runs.has(key)) {
      runs.set(key, { actorId: event.actor?.id || "unknown", runId, subjects: new Set(), wouldDeny: 0, firstAt: event.occurredAt, lastAt: event.occurredAt });
    }
    const run = runs.get(key);
    const subject = subjectKey(event);
    if (subject) run.subjects.add(subject);
    if (String(event.data?.wouldDeny) === "true") run.wouldDeny += 1;
    if (String(event.occurredAt) < String(run.firstAt)) run.firstAt = event.occurredAt;
    if (String(event.occurredAt) > String(run.lastAt)) run.lastAt = event.occurredAt;
  }

  return [...runs.values()]
    .map((run) => ({
      actorId: run.actorId,
      runId: run.runId,
      subjects: run.subjects.size,
      atOrOverThreshold: run.subjects.size >= threshold,
      reportModeAllowances: run.wouldDeny,
      firstAt: run.firstAt,
      lastAt: run.lastAt,
    }))
    .sort((a, b) => b.subjects - a.subjects || String(a.runId).localeCompare(String(b.runId)));
}

// The operator view. Read-only over a log other things own, so it never throws:
// a degraded source is reported, because a panel that crashes on a bad line
// tells the operator nothing about the runs it could read.
export function buildBlastRadiusReport({ hqRoot, stateRoot = null, threshold = DEFAULT_THRESHOLD, now = new Date().toISOString(), limit = 20 } = {}) {
  const warnings = [];
  const cap = bounded(threshold, 1, MAX_TRACKED, DEFAULT_THRESHOLD);
  const events = [];

  for (const path of permissionLogs({ hqRoot, stateRoot })) {
    try { events.push(...readAuditEvents(path)); }
    catch (error) { warnings.push(`permission log ${basename(path)} unavailable: ${error.message}`); }
  }

  const runs = analyzeBlastRadius(events, { threshold: cap });
  const over = runs.filter((run) => run.atOrOverThreshold);

  return {
    version: 1,
    asOf: now,
    available: warnings.length === 0,
    warnings,
    // Said at the top, not buried: nothing here refuses anything.
    enforcement: "alert-only",
    threshold: cap,
    summary: {
      runs: runs.length,
      overThreshold: over.length,
      widestRun: runs[0]?.subjects ?? 0,
    },
    runs: runs.slice(0, bounded(limit, 1, 100, 20)),
  };
}

// ------------------------------------------------------------------ internals

// The central permission ledger, plus each task's own audit log where a
// decision was recorded against the task rather than the factory.
function permissionLogs({ hqRoot, stateRoot }) {
  const out = [];
  const central = join(resolve(hqRoot), ".openclaw-factory", "telemetry", "permissions.ndjson");
  if (existsSync(central)) out.push(central);
  const root = resolve(stateRoot || defaultStateRoot(hqRoot));
  for (const taskDir of taskDirs(root)) {
    const path = join(taskDir, "audit.ndjson");
    if (existsSync(path)) out.push(path);
  }
  return out;
}

function taskDirs(root, out = []) {
  if (!existsSync(root)) return out;
  for (const entry of safeReadDir(root)) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (existsSync(join(path, "state.json")) && basename(dirname(path)) === "tasks") out.push(path);
    else taskDirs(path, out);
  }
  return out;
}

function safeReadDir(path) {
  try { return readdirSync(path, { withFileTypes: true }); } catch { return []; }
}

function sanitizeCorrelation(correlation) {
  const out = {};
  for (const [key, value] of Object.entries(correlation || {})) {
    if (value != null && SAFE_ID.test(key) && SAFE_ID.test(String(value))) out[key] = String(value);
  }
  return out;
}

function bounded(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}
