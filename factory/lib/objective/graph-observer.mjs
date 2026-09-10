// Durable, best-effort projection of objective graph health, plus the durable
// wakeups that let a parked objective resume without an operator noticing it.
//
// Why this exists: `runObjective` schedules ready nodes in-process and exits
// when nothing is running and nothing is ready. When it exits with work still
// pending — a delegate node left `running`, a subtree stranded behind a failure
// — nothing re-enters the objective on its own. The objective wrapper goes
// stale while its nodes are individually fine, which is the exact divergence
// that leaves dependent nodes permanently unstarted.
//
// Two outputs, both of which must never change a canonical outcome:
//
//   graph-health.json  next to objective-state.json — what is wrong and what is
//                      stranded, for the operator API and panel.
//   wakeups            one identifier-only request per node that became
//                      runnable during the run, into the same durable queue the
//                      wakeup worker already drains.
//
// Every write here is wrapped: telemetry and resumption are best-effort
// projections of canonical state, exactly as dispatch telemetry is. A failure
// to record must never fail the objective.

import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { dependencyWakeups, diagnoseDependencyGraph } from "./dependency-diagnostics.mjs";
import { enqueueWakeup } from "../wakeups/queue.mjs";

// Where the wakeup worker looks: defaultWakeupPaths() in wakeups/worker.mjs
// resolves the queue and `tasks/<taskRef>/state.json` under the same root, so a
// node id enqueued here is exactly what the worker can resolve.
export function objectiveWakeupQueuePath(nodeStateRoot) {
  return join(nodeStateRoot, "wakeups.json");
}

export function observeObjectiveGraph({ objectivePath, nodeStateRoot, before, after, agentForNode = () => "openclaw-factory", now = Date.now }) {
  const health = recordGraphHealth({ objectivePath, nodeStateRoot, objective: after, now });
  const wakeups = enqueueDependencyWakeups({ nodeStateRoot, before, after, objectiveId: after?.objectiveId, agentForNode });
  return { health, wakeups };
}

function recordGraphHealth({ objectivePath, nodeStateRoot, objective, now }) {
  try {
    const diagnosis = diagnoseDependencyGraph(objective, { now });
    const divergences = detectTaskDivergence({ nodeStateRoot, objective });
    const findings = [...diagnosis.findings, ...divergences];
    const counts = {
      critical: findings.filter((finding) => finding.severity === "critical").length,
      high: findings.filter((finding) => finding.severity === "high").length,
      medium: findings.filter((finding) => finding.severity === "medium").length,
    };
    const payload = {
      ...diagnosis,
      findings,
      counts,
      healthy: counts.critical === 0 && counts.high === 0,
      objectiveId: objective?.objectiveId || null,
      recordedAt: new Date(now()).toISOString(),
    };
    const path = join(dirname(objectivePath), "graph-health.json");
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
    return { recorded: true, healthy: payload.healthy, findings: payload.findings.length };
  } catch (error) {
    return { recorded: false, reason: String(error?.message || error) };
  }
}

function enqueueDependencyWakeups({ nodeStateRoot, before, after, objectiveId, agentForNode }) {
  if (!objectiveId) return { enqueued: 0, duplicates: 0, skipped: "objective has no id" };
  let requests;
  try {
    requests = dependencyWakeups({ before, after, objectiveId, actorForNode: agentForNode });
  } catch (error) {
    return { enqueued: 0, duplicates: 0, skipped: String(error?.message || error) };
  }

  const path = objectiveWakeupQueuePath(nodeStateRoot);
  let enqueued = 0;
  let duplicates = 0;
  const errors = [];
  for (const request of requests) {
    try {
      // The queue dedupes on idempotencyKey across all history, so re-running
      // an objective re-enqueues nothing and a genuine retry (a new attempt
      // number) does get its own wakeup.
      if (enqueueWakeup(path, request).duplicate) duplicates += 1;
      else enqueued += 1;
    } catch (error) {
      errors.push(`${request.taskRef}: ${String(error?.message || error)}`);
    }
  }
  return { enqueued, duplicates, ...(errors.length ? { errors } : {}) };
}

// The objective wrapper and its nodes' task states are written by different
// paths. `POST /api/founder/tasks/:id/retry` re-runs one task to terminal
// without touching the objective, so a node can sit `blocked` (and its
// dependents `blocked-by-dep`, permanently unstarted) while the task under it
// has actually finished. Nothing surfaced that divergence, so it was only ever
// found by hand.
//
// This reports it. It deliberately does not repair it: rewriting objective
// state from task state is a canonical mutation and belongs behind an explicit,
// reviewed action, not inside a projection that runs on every objective exit.
const NODE_SETTLED = new Set(["gate-satisfied", "published", "skipped"]);
const TASK_MOVED_ON = new Set(["merge-ready", "complete", "completed", "merged", "active"]);

function detectTaskDivergence({ nodeStateRoot, objective }) {
  const findings = [];
  const nodes = [...Object.values(objective?.nodes || {}), objective?.integration].filter(Boolean);
  for (const node of nodes) {
    if (!node.id || NODE_SETTLED.has(node.status)) continue;
    const statePath = node.statePath || join(nodeStateRoot, "tasks", node.id, "state.json");
    if (!existsSync(statePath)) continue;
    let taskStatus;
    try {
      taskStatus = String(JSON.parse(readFileSync(statePath, "utf8")).status || "");
    } catch {
      continue; // an unreadable task state is the task layer's problem to report
    }
    if (!TASK_MOVED_ON.has(taskStatus)) continue;
    findings.push({
      severity: "high",
      code: "objective-task-divergence",
      message: `node ${node.id} is '${node.status}' but its task is '${taskStatus}'`,
      nodeIds: [node.id],
      strandedNodeIds: dependentsOf(objective, node.id),
    });
  }
  return findings;
}

// Every pending node that is waiting on this one, and therefore cannot start
// while the divergence stands.
function dependentsOf(objective, nodeId) {
  const nodes = Object.values(objective?.nodes || {});
  const blocked = new Set();
  let frontier = [nodeId];
  while (frontier.length) {
    const next = [];
    for (const node of nodes) {
      if (blocked.has(node.id) || node.id === nodeId) continue;
      if ((node.dependsOn || []).some((dep) => frontier.includes(dep))) {
        blocked.add(node.id);
        next.push(node.id);
      }
    }
    frontier = next;
  }
  return [...blocked];
}
