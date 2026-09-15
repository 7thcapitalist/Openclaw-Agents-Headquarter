import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { readAuditEvents } from "../audit/envelope.mjs";
import { readCostEvents, summarizeCostLedger } from "./cost-ledger.mjs";
import { loadPricing, priceCostEvents } from "./cost.mjs";
import { readWakeupQueue, wakeupQueueHealth } from "../wakeups/queue.mjs";
import { readLease } from "../leases/task-lease.mjs";
import { defaultStateRoot } from "./tasks.mjs";
import { buildRewakeReport } from "./rewake-throttle.mjs";

export function buildOperationsSnapshot({ hqRoot, stateRoot = null, now = new Date().toISOString(), eventLimit = 30 } = {}) {
  const root = resolve(stateRoot || defaultStateRoot(hqRoot));
  const warnings = [];
  const tasks = stateFiles(root).map((statePath) => taskOperations(statePath, warnings));
  const queuePath = join(root, "wakeups.json");
  let queue = emptyQueue();
  try { queue = { ...wakeupQueueHealth(queuePath, now), recent: readWakeupQueue(queuePath).items.slice(-20).reverse().map(sanitizeWakeup) }; }
  catch (error) { warnings.push(`wakeup queue unavailable: ${error.message}`); queue = { ...emptyQueue(), available: false }; }
  const costPath = join(resolve(hqRoot), ".openclaw-factory", "telemetry", "cost-events.ndjson");
  let costs = summarizeCostLedger([]);
  // Priced through the same function budgets uses, so the two panels of one
  // snapshot can no longer report different totals for the same ledger.
  try { costs = summarizeCostLedger(priceCostEvents(readCostEvents(costPath), loadPricing(hqRoot)).events); }
  catch (error) { warnings.push(`cost ledger unavailable: ${error.message}`); costs = { ...costs, available: false }; }
  const objectives = objectiveHealth(root, warnings);
  // Which tasks are paying for runs that change nothing. Read-only; the
  // throttle itself is consulted by the wakeup worker, not here.
  let rewake = { version: 1, mode: "off", summary: { stallingTasks: 0, overThreshold: 0, wastedRuns: 0 }, tasks: [] };
  try { rewake = buildRewakeReport({ hqRoot, states: taskStates(root), now }); }
  catch (error) { warnings.push(`re-wake report unavailable: ${error.message}`); }
  const audit = tasks.flatMap((task) => task.audit).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, bounded(eventLimit, 1, 100));
  return { version: 1, asOf: now, available: warnings.length === 0, warnings, summary: {
    tasks: tasks.length, activeRuns: tasks.filter((task) => ["needs-followup", "advanced"].includes(task.liveness?.state)).length,
    blockedRuns: tasks.filter((task) => ["blocked", "failed"].includes(task.liveness?.state)).length,
    leasedTasks: tasks.filter((task) => task.lease).length, queuedWakeups: queue.counts.queued, deadLetters: queue.counts["dead-letter"],
    inputTokens: costs.totals.inputTokens, outputTokens: costs.totals.outputTokens, costMicros: costs.totals.costMicros, unpricedEvents: costs.totals.unpricedEvents,
    stallingTasks: rewake.summary.overThreshold, wastedRuns: rewake.summary.wastedRuns,
    unhealthyObjectives: objectives.filter((objective) => objective.healthy === false).length,
    strandedNodes: objectives.reduce((sum, objective) => sum + objective.strandedNodeIds.length, 0),
  }, tasks: tasks.map(({ audit: _audit, ...task }) => task), objectives, rewake, queue, audit, costs };
}

function taskOperations(statePath, warnings) {
  const dir = dirname(statePath); const taskId = basename(dir);
  let state = null; let liveness = null; let audit = []; let lease = null;
  try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch (error) { warnings.push(`task ${taskId} state unavailable: ${error.message}`); }
  try { const path = join(dir, "liveness.json"); if (existsSync(path)) liveness = JSON.parse(readFileSync(path, "utf8")); } catch (error) { warnings.push(`task ${taskId} liveness unavailable: ${error.message}`); }
  try { audit = readAuditEvents(join(dir, "audit.ndjson")); } catch (error) { warnings.push(`task ${taskId} audit unavailable: ${error.message}`); }
  try { lease = readLease(join(dirname(dirname(dir)), "leases"), taskId); } catch (error) { warnings.push(`task ${taskId} lease unavailable: ${error.message}`); }
  const stage = state?.currentStage || null;
  return {
    taskId,
    // Without a projectId the console cannot group a task list by project
    // without parsing the id string, which is not a contract.
    projectId: state?.task?.project || null,
    status: state?.status || "unknown",
    stage,
    // `actor` is whichever runtime happens to hold the CURRENT dispatch and is
    // null whenever nothing is in flight — which is most of the time, and is
    // why the live mirror shows `actor: null` on nearly every row. The
    // assignment is the durable answer to "whose stage is this".
    assignee: (stage && state?.assignments?.[stage]) || null,
    actor: state?.currentDispatch?.agentId || state?.currentDispatch?.actor || null,
    risk: state?.task?.risk || null,
    createdAt: state?.createdAt || null,
    updatedAt: state?.updatedAt || null,
    liveness: sanitizeLiveness(liveness),
    lease: lease ? { actorId: lease.actorId, runId: lease.runId, expiresAt: lease.expiresAt } : null,
    audit,
  };
}

function stateFiles(root, out = []) { if (!existsSync(root)) return out; for (const entry of safeReadDir(root)) { const path = join(root, entry.name); if (entry.isDirectory()) stateFiles(path, out); else if (entry.isFile() && entry.name === "state.json") out.push(path); } return out; }
function safeReadDir(path) { try { return readdirSync(path, { withFileTypes: true }); } catch { return []; } }
function sanitizeLiveness(value) { if (!value || typeof value !== "object") return null; return { runId: String(value.runId || ""), state: String(value.state || "unknown"), reason: String(value.reason || "").slice(0, 500), nextAction: value.nextAction ? String(value.nextAction).slice(0, 500) : null, recordedAt: value.recordedAt || null }; }
function sanitizeWakeup(item) { return { wakeupId: item.wakeupId, source: item.source, taskRef: item.taskRef, actorId: item.actorId, status: item.status, attempt: item.attempt, maxAttempts: item.maxAttempts, createdAt: item.createdAt, updatedAt: item.updatedAt, error: item.error || null }; }
function emptyQueue() { return { version: 1, available: true, counts: { queued: 0, claimed: 0, succeeded: 0, failed: 0, "dead-letter": 0 }, oldestQueuedAt: null, ready: 0, recent: [] }; }
function bounded(value, min, max) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : min; }

// Graph health recorded by the objective orchestrator (objective/graph-observer.mjs).
// A missing file is normal — the objective has not run since the observer
// existed — and is reported as unknown rather than as healthy.
function objectiveHealth(root, warnings) {
  const out = [];
  for (const path of healthFiles(root)) {
    const objectiveId = basename(dirname(path));
    try {
      const health = JSON.parse(readFileSync(path, "utf8"));
      const findings = Array.isArray(health.findings) ? health.findings : [];
      out.push({
        objectiveId: String(health.objectiveId || objectiveId),
        healthy: health.healthy === true,
        recordedAt: health.recordedAt || null,
        ready: Array.isArray(health.ready) ? health.ready.slice(0, 20) : [],
        counts: health.counts || { critical: 0, high: 0, medium: 0 },
        // Codes and identifiers only: a finding message can quote a graph error
        // but never carries prompts, paths, or agent output.
        findings: findings.slice(0, 10).map((finding) => ({
          severity: String(finding.severity || "medium"),
          code: String(finding.code || "unknown"),
          message: String(finding.message || "").slice(0, 300),
          nodeIds: (finding.nodeIds || []).slice(0, 20).map(String),
        })),
        strandedNodeIds: [...new Set(findings.flatMap((finding) => finding.strandedNodeIds || []))].slice(0, 40).map(String),
      });
    } catch (error) {
      warnings.push(`objective ${objectiveId} graph health unavailable: ${error.message}`);
    }
  }
  return out.sort((a, b) => Number(a.healthy) - Number(b.healthy) || a.objectiveId.localeCompare(b.objectiveId));
}

function healthFiles(root, out = []) {
  if (!existsSync(root)) return out;
  for (const entry of safeReadDir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) healthFiles(path, out);
    else if (entry.isFile() && entry.name === "graph-health.json") out.push(path);
  }
  return out;
}

// Raw task states for projections that need the whole record rather than the
// operations summary of it.
function taskStates(root) {
  const out = [];
  for (const path of stateFiles(root)) {
    try { out.push(JSON.parse(readFileSync(path, "utf8"))); } catch { /* reported by taskOperations */ }
  }
  return out;
}
