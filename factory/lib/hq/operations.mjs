import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { readAuditEvents } from "../audit/envelope.mjs";
import { readCostEvents, summarizeCostLedger } from "./cost-ledger.mjs";
import { readWakeupQueue, wakeupQueueHealth } from "../wakeups/queue.mjs";
import { readLease } from "../leases/task-lease.mjs";
import { defaultStateRoot } from "./tasks.mjs";

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
  try { costs = summarizeCostLedger(readCostEvents(costPath)); }
  catch (error) { warnings.push(`cost ledger unavailable: ${error.message}`); costs = { ...costs, available: false }; }
  const audit = tasks.flatMap((task) => task.audit).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, bounded(eventLimit, 1, 100));
  return { version: 1, asOf: now, available: warnings.length === 0, warnings, summary: {
    tasks: tasks.length, activeRuns: tasks.filter((task) => ["needs-followup", "advanced"].includes(task.liveness?.state)).length,
    blockedRuns: tasks.filter((task) => ["blocked", "failed"].includes(task.liveness?.state)).length,
    leasedTasks: tasks.filter((task) => task.lease).length, queuedWakeups: queue.counts.queued, deadLetters: queue.counts["dead-letter"],
    inputTokens: costs.totals.inputTokens, outputTokens: costs.totals.outputTokens, costMicros: costs.totals.costMicros, unpricedEvents: costs.totals.unpricedEvents,
  }, tasks: tasks.map(({ audit: _audit, ...task }) => task), queue, audit, costs };
}

function taskOperations(statePath, warnings) {
  const dir = dirname(statePath); const taskId = basename(dir);
  let state = null; let liveness = null; let audit = []; let lease = null;
  try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch (error) { warnings.push(`task ${taskId} state unavailable: ${error.message}`); }
  try { const path = join(dir, "liveness.json"); if (existsSync(path)) liveness = JSON.parse(readFileSync(path, "utf8")); } catch (error) { warnings.push(`task ${taskId} liveness unavailable: ${error.message}`); }
  try { audit = readAuditEvents(join(dir, "audit.ndjson")); } catch (error) { warnings.push(`task ${taskId} audit unavailable: ${error.message}`); }
  try { lease = readLease(join(dirname(dirname(dir)), "leases"), taskId); } catch (error) { warnings.push(`task ${taskId} lease unavailable: ${error.message}`); }
  return { taskId, status: state?.status || "unknown", stage: state?.currentStage || null, actor: state?.currentDispatch?.agentId || state?.currentDispatch?.actor || null,
    updatedAt: state?.updatedAt || null, liveness: sanitizeLiveness(liveness), lease: lease ? { actorId: lease.actorId, runId: lease.runId, expiresAt: lease.expiresAt } : null, audit };
}

function stateFiles(root, out = []) { if (!existsSync(root)) return out; for (const entry of safeReadDir(root)) { const path = join(root, entry.name); if (entry.isDirectory()) stateFiles(path, out); else if (entry.isFile() && entry.name === "state.json") out.push(path); } return out; }
function safeReadDir(path) { try { return readdirSync(path, { withFileTypes: true }); } catch { return []; } }
function sanitizeLiveness(value) { if (!value || typeof value !== "object") return null; return { runId: String(value.runId || ""), state: String(value.state || "unknown"), reason: String(value.reason || "").slice(0, 500), nextAction: value.nextAction ? String(value.nextAction).slice(0, 500) : null, recordedAt: value.recordedAt || null }; }
function sanitizeWakeup(item) { return { wakeupId: item.wakeupId, source: item.source, taskRef: item.taskRef, actorId: item.actorId, status: item.status, attempt: item.attempt, maxAttempts: item.maxAttempts, createdAt: item.createdAt, updatedAt: item.updatedAt, error: item.error || null }; }
function emptyQueue() { return { version: 1, available: true, counts: { queued: 0, claimed: 0, succeeded: 0, failed: 0, "dead-letter": 0 }, oldestQueuedAt: null, ready: 0, recent: [] }; }
function bounded(value, min, max) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : min; }
