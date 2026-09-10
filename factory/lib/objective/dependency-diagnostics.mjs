// Inspired by Paperclip issue-dependency-wakeups and issue-graph-liveness at
// pinned commit 6abeb67334348dcb6fde2d591a27ffc7efc7118d (MIT).
import { assertAcyclic, descendants, readyNodes, GATE_SATISFIED } from "./graph.mjs";

const TERMINAL_FAILURE = new Set(["blocked", "failed", "blocked-by-dep"]);
export function diagnoseDependencyGraph(objective, { now = Date.now, staleAfterMs = 30 * 60_000 } = {}) {
  const nodes = objective?.nodes || {}; const findings = [];
  try { assertAcyclic(nodes); } catch (error) { findings.push({ severity: "critical", code: "invalid-graph", message: error.message, nodeIds: [] }); return summary(findings, []); }
  const ready = readyNodes(objective);
  for (const node of Object.values(nodes)) {
    const unmet = (node.dependsOn || []).filter((id) => nodes[id]?.status !== GATE_SATISFIED);
    const failed = unmet.filter((id) => TERMINAL_FAILURE.has(nodes[id]?.status));
    if (node.status === "pending" && failed.length) findings.push({ severity: "high", code: "blocked-subtree", message: `${node.id} is blocked by failed dependencies`, nodeIds: [node.id, ...failed] });
    const updated = Date.parse(node.updatedAt || node.startedAt || objective.updatedAt || "");
    if (node.status === "running" && Number.isFinite(updated) && now() - updated > staleAfterMs) findings.push({ severity: "high", code: "stale-running", message: `${node.id} has no recent progress`, nodeIds: [node.id] });
  }
  const active = Object.values(nodes).some((n) => n.status === "running");
  const complete = Object.values(nodes).length > 0 && Object.values(nodes).every((n) => n.status === GATE_SATISFIED);
  if (!active && !ready.length && !complete && !findings.some((f) => f.code === "blocked-subtree")) findings.push({ severity: "medium", code: "no-runnable-node", message: "Objective has no running or runnable node", nodeIds: [] });
  return summary(findings, ready);
}

export function dependencyWakeups({ before, after, objectiveId, actorForNode }) {
  assertAcyclic(after?.nodes || {}); const priorReady = new Set(readyNodes(before || { nodes: {} }));
  return readyNodes(after).filter((id) => !priorReady.has(id)).map((id) => ({ source: "dependency", taskRef: id,
    actorId: actorForNode(id, after.nodes[id]), contextRef: `objective:${objectiveId}`, idempotencyKey: `dependency:${objectiveId}:${id}:${dependencyRevision(after.nodes[id], after.nodes)}` }));
}
function dependencyRevision(node, nodes) { return (node.dependsOn || []).map((id) => `${id}-${nodes[id]?.status || "missing"}`).sort().join("--") || "root"; }
function summary(findings, ready) { return { version: 1, healthy: !findings.some((f) => ["critical", "high"].includes(f.severity)), ready, findings, counts: { critical: findings.filter((f) => f.severity === "critical").length, high: findings.filter((f) => f.severity === "high").length, medium: findings.filter((f) => f.severity === "medium").length } }; }
