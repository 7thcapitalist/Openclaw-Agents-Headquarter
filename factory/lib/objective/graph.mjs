// Pure DAG helpers for a decomposed objective. No IO, no deps. The objective
// state shape is documented in orchestrator.mjs; here `nodes` is a plain object
// `{ [id]: { dependsOn: string[], gate: string, status: string } }`.

const SATISFIED = "gate-satisfied";
const RUNNABLE_BLOCKERS = new Set(["blocked", "blocked-by-dep", "failed"]);

// Throw on a dependency cycle or a dangling dependency reference.
export function assertAcyclic(nodes) {
  const ids = new Set(Object.keys(nodes));
  for (const [id, node] of Object.entries(nodes)) {
    for (const dep of node.dependsOn || []) {
      if (!ids.has(dep)) throw new Error(`node "${id}" depends on unknown node "${dep}"`);
      if (dep === id) throw new Error(`node "${id}" depends on itself`);
    }
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...ids].map((id) => [id, WHITE]));
  const stack = [];
  const visit = (id) => {
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of nodes[id].dependsOn || []) {
      if (color.get(dep) === GRAY) {
        const cycle = stack.slice(stack.indexOf(dep)).concat(dep).join(" -> ");
        throw new Error(`dependency cycle: ${cycle}`);
      }
      if (color.get(dep) === WHITE) visit(dep);
    }
    color.set(id, BLACK);
    stack.pop();
  };
  for (const id of ids) if (color.get(id) === WHITE) visit(id);
}

// Node ids that are `pending` and whose every dependency has reached its gate.
export function readyNodes(objState) {
  const nodes = objState.nodes || {};
  return Object.values(nodes)
    .filter((node) => node.status === "pending"
      && (node.dependsOn || []).every((dep) => nodes[dep]?.status === SATISFIED))
    .map((node) => node.id);
}

// Every node that (transitively) depends on `nodeId`.
export function descendants(objState, nodeId) {
  const nodes = objState.nodes || {};
  const out = new Set();
  const queue = [nodeId];
  while (queue.length) {
    const current = queue.shift();
    for (const node of Object.values(nodes)) {
      if ((node.dependsOn || []).includes(current) && !out.has(node.id)) {
        out.add(node.id);
        queue.push(node.id);
      }
    }
  }
  return [...out];
}

// All build nodes reached their gate (integration is tracked separately).
export function buildNodesComplete(objState) {
  const nodes = objState.nodes || {};
  const ids = Object.keys(nodes);
  return ids.length > 0 && ids.every((id) => nodes[id].status === SATISFIED);
}

// Nothing is running, nothing is ready, and it is not complete — i.e. progress
// is impossible without founder action (a blocked/failed node upstream).
export function isDeadlocked(objState) {
  const nodes = Object.values(objState.nodes || {});
  if (!nodes.length) return false;
  const running = nodes.some((n) => n.status === "running");
  const ready = readyNodes(objState).length > 0;
  const allSatisfied = nodes.every((n) => n.status === SATISFIED);
  const anyBlocked = nodes.some((n) => RUNNABLE_BLOCKERS.has(n.status));
  return !running && !ready && !allSatisfied && anyBlocked;
}

export const GATE_SATISFIED = SATISFIED;
