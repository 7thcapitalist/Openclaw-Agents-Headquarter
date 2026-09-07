// Run a decomposed objective: schedule independent build nodes concurrently
// (bounded), each as a full 7-stage `runToTerminal`, then integrate their
// branches and run review/QA/security/release on the combined tree.
//
// This is orchestration ABOVE the engine. It does not touch task-workflow.mjs
// or the protocol. Every node/integration goes through the unchanged engine, so
// every gate (evidence, independence, high-risk approval, no-push-to-main) is
// enforced exactly as for a single task.

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { initializeTask } from "../task-initializer.mjs";
import { readState, validateTaskContract } from "../task-workflow.mjs";
import { runToTerminal } from "../openclaw-runner.mjs";
import { ensureBranchHasCommit } from "../hq/github-publish.mjs";
import { assertAcyclic, buildNodesComplete, descendants, isDeadlocked, readyNodes, GATE_SATISFIED } from "./graph.mjs";

const INTEGRATION_SYNTHETIC_STAGES = new Set(["product", "architect", "builder"]);

class MergeConflict extends Error {
  constructor(nodeId, detail) { super(`merge conflict integrating ${nodeId}`); this.nodeId = nodeId; this.detail = detail; }
}

// ── objective-state.json IO (the file is the source of truth; every mutation is
// a fresh read+write so concurrent node runs never clobber each other) ─────────

export function readObjState(path) { return JSON.parse(readFileSync(path, "utf8")); }

function writeObjState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function mutate(path, fn) {
  const state = readObjState(path);
  fn(state);
  writeObjState(path, state);
  return state;
}

function patchNode(path, nodeId, patch, event) {
  return mutate(path, (s) => {
    const target = s.nodes[nodeId] || (s.integration.id === nodeId ? s.integration : null);
    if (!target) throw new Error(`unknown node ${nodeId}`);
    Object.assign(target, patch);
    if (event) s.events.push({ at: new Date().toISOString(), node: nodeId, ...event });
  });
}

// ── git ──────────────────────────────────────────────────────────────────────

function git(cwd, args) {
  try {
    return { ok: true, out: execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (error) {
    return { ok: false, out: String(error.stdout || "") + String(error.stderr || error.message || "") };
  }
}

function defaultBranch(repo) {
  const head = git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (head.ok && head.out) return head.out;
  for (const b of ["main", "master"]) if (git(repo, ["rev-parse", "--verify", "--quiet", b]).ok) return b;
  return "main";
}

// ── one build node ───────────────────────────────────────────────────────────

// Build nodes never open their own PR — their branches are merged into the
// integration branch, which is the single thing published.
const NODE_NO_PUBLISH = () => ({ published: false, reason: "objective build node — delivered via the integration branch" });

async function runNode({ hqRoot, objectivePath, nodeId, execute, agentIds, maxAttemptsPerStage, concurrentGroups, stateRoot }) {
  const obj = readObjState(objectivePath);
  const node = obj.nodes[nodeId];
  const contractDir = join(dirname(objectivePath), "contracts");
  mkdirSync(contractDir, { recursive: true });
  const contractPath = join(contractDir, `${nodeId}.json`);
  writeFileSync(contractPath, `${JSON.stringify(node.contract, null, 2)}\n`, "utf8");

  const init = initializeTask({ hqRoot, contractPath, repo: obj.repo, branch: node.branch, stateRoot });
  patchNode(objectivePath, nodeId, { statePath: init.state, worktree: init.worktree, branch: init.branch });

  const resp = await runToTerminal({ hqRoot, statePath: init.state, agentIds, maxAttemptsPerStage, concurrentGroups, execute, publish: NODE_NO_PUBLISH });
  const state = readState(init.state);
  const attempts = (state.dispatches || []).length;

  if (resp.status === "merge-ready") {
    // ensure the branch actually carries a commit even without a github remote
    try { ensureBranchHasCommit({ state }); } catch { /* recorded by the publish step if a remote exists */ }
    patchNode(objectivePath, nodeId, { status: GATE_SATISFIED, finishedAt: new Date().toISOString(), attempts, blocker: null },
      { type: "node-gate-satisfied" });
    return { nodeId, status: GATE_SATISFIED };
  }

  const blocker = state.blocker || { stage: state.currentStage, outcome: "fail", summary: resp.blocker?.summary || "blocked" };
  const status = blocker.outcome === "decision-required" ? "blocked" : "failed";
  patchNode(objectivePath, nodeId, { status, finishedAt: new Date().toISOString(), attempts, blocker },
    { type: `node-${status}`, detail: blocker.summary });
  // stop anything waiting on this node
  for (const d of descendants(readObjState(objectivePath), nodeId)) {
    const s = readObjState(objectivePath);
    if (s.nodes[d]?.status === "pending") patchNode(objectivePath, d, { status: "blocked-by-dep" }, { type: "node-blocked-by-dep", detail: `upstream ${nodeId}` });
  }
  return { nodeId, status };
}

// ── integration node ─────────────────────────────────────────────────────────

async function runIntegration({ hqRoot, objectivePath, execute, agentIds, maxAttemptsPerStage, concurrentGroups, stateRoot, publish }) {
  const obj = readObjState(objectivePath);
  const integ = obj.integration;
  const buildBranches = Object.values(obj.nodes).map((n) => n.branch);

  const contract = validateTaskContract({
    id: integ.id,
    issue: `local:${integ.id}`,
    outcome: `Integrate the parallel build tasks for: ${obj.objective}`,
    acceptanceCriteria: [
      "Every sub-task branch merges without conflict",
      "The combined change passes independent review, QA, and security",
      "Relevant automated checks pass on the merged tree",
    ],
    project: obj.project,
    workType: "ops",
    risk: "medium",
  });
  const contractDir = join(dirname(objectivePath), "contracts");
  mkdirSync(contractDir, { recursive: true });
  const contractPath = join(contractDir, `${integ.id}.json`);
  writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");

  const base = defaultBranch(obj.repo);
  const init = initializeTask({ hqRoot, contractPath, repo: obj.repo, branch: integ.branch, stateRoot });
  patchNode(objectivePath, integ.id, { statePath: init.state, worktree: init.worktree, branch: init.branch, status: "running", startedAt: new Date().toISOString() },
    { type: "integration-started", detail: `base ${base}, ${buildBranches.length} branch(es)` });

  const mergeLog = [];
  // product / architect / builder are done deterministically by the orchestrator
  // (the "build" of an integration IS the git merge); review/QA/security/release
  // run for real on the merged tree.
  const integExecute = async (args) => {
    const { dispatch } = args;
    if (!INTEGRATION_SYNTHETIC_STAGES.has(dispatch.stage)) return execute(args);

    const evDir = join(init.worktree, "evidence");
    mkdirSync(evDir, { recursive: true });
    let summary;
    if (dispatch.stage === "builder") {
      for (const branch of buildBranches) {
        const r = git(init.worktree, ["merge", "--no-ff", "-m", `factory: integrate ${branch}`, branch]);
        mergeLog.push({ branch, ok: r.ok, out: r.out.slice(0, 800) });
        if (!r.ok) { git(init.worktree, ["merge", "--abort"]); throw new MergeConflict(branch, r.out); }
      }
      writeFileSync(join(evDir, "integration-merge.md"), `# Integration merge\n\nBase: ${base}\n\n${mergeLog.map((m) => `- ${m.branch}: ${m.ok ? "merged" : "CONFLICT"}`).join("\n")}\n`, "utf8");
      summary = `merged ${buildBranches.length} sub-task branch(es) into ${integ.branch}`;
    } else {
      writeFileSync(join(evDir, `integration-${dispatch.stage}.md`), `# ${dispatch.stage}\n\nComposition of independently-reviewed sub-tasks for objective ${obj.objectiveId}. No new ${dispatch.stage} work.\n`, "utf8");
      summary = `integration ${dispatch.stage}: composition of reviewed sub-tasks`;
    }
    writeFileSync(dispatch.resultPath, JSON.stringify({
      version: 1, dispatchId: dispatch.dispatchId, stage: dispatch.stage, actor: dispatch.actor,
      outcome: "pass", summary, evidence: [dispatch.stage === "builder" ? "evidence/integration-merge.md" : `evidence/integration-${dispatch.stage}.md`],
    }));
  };

  let resp;
  try {
    resp = await runToTerminal({ hqRoot, statePath: init.state, agentIds, maxAttemptsPerStage, concurrentGroups, execute: integExecute, publish });
  } catch (error) {
    if (error instanceof MergeConflict) {
      patchNode(objectivePath, integ.id, {
        status: "blocked", mergeLog,
        blocker: { stage: "builder", outcome: "decision-required", summary: `merge conflict integrating ${error.nodeId}`, at: new Date().toISOString() },
      }, { type: "integration-conflict", detail: error.nodeId });
      return { status: "blocked", reason: "merge-conflict", node: error.nodeId };
    }
    throw error;
  }

  const state = readState(init.state);
  patchNode(objectivePath, integ.id, {
    mergeLog,
    status: resp.status === "merge-ready" ? GATE_SATISFIED : "blocked",
    finishedAt: new Date().toISOString(),
    githubPublish: state.githubPublish || null,
    blocker: resp.status === "merge-ready" ? null : (state.blocker || null),
  }, { type: resp.status === "merge-ready" ? "integration-gate-satisfied" : "integration-blocked" });
  return resp;
}

// ── metrics (measured only) ──────────────────────────────────────────────────

// Best-effort: which model/provider actually served each factory session for
// this objective. Empty if `openclaw` is unavailable (tests).
function sessionModelsByTaskId() {
  try {
    const out = execFileSync("openclaw", ["sessions", "--all-agents", "--json", "--limit", "all"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
    const sessions = JSON.parse(out).sessions || [];
    const byTask = {};
    for (const s of sessions) {
      const m = String(s.key || "").match(/:factory-(.+?)-(product|architect|builder|reviewer|qa|security|release)-\d+$/);
      if (!m) continue;
      (byTask[m[1]] ||= new Set()).add(`${s.modelProvider || "?"}/${s.model || "?"}`);
    }
    return Object.fromEntries(Object.entries(byTask).map(([k, v]) => [k, [...v]]));
  } catch { return {}; }
}

function collectMetrics(objectivePath) {
  const obj = readObjState(objectivePath);
  const models = sessionModelsByTaskId();
  const nodeMetric = (n) => {
    if (!n.statePath || !existsSync(n.statePath)) return { id: n.id, status: n.status };
    const st = readState(n.statePath);
    const start = Date.parse(n.startedAt || st.createdAt || "");
    const end = Date.parse(n.finishedAt || st.updatedAt || "");
    const dispatches = st.dispatches || [];
    const failedStages = dispatches.filter((d) => d.outcome === "fail" || d.status === "failed").map((d) => d.stage);
    return {
      id: n.id,
      role: n.role || "integration",
      status: n.status,
      durationMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null,
      attempts: dispatches.length,
      failedStages,
      reviewRejections: failedStages.filter((s) => s === "reviewer").length,
      qaRejections: failedStages.filter((s) => s === "qa").length,
      securityRejections: failedStages.filter((s) => s === "security").length,
      modelsUsed: models[n.id] || [],
      branch: n.branch,
    };
  };
  const nodes = Object.values(obj.nodes).map(nodeMetric);
  const integration = nodeMetric(obj.integration);
  const objStart = Date.parse(obj.createdAt || "");
  const objEnd = Date.parse(obj.updatedAt || "");
  const maxParallel = (obj.events || [])
    .reduce((acc, e) => {
      if (e.type === "node-started") acc.cur += 1;
      if (["node-gate-satisfied", "node-failed", "node-blocked"].includes(e.type)) acc.cur = Math.max(0, acc.cur - 1);
      acc.max = Math.max(acc.max, acc.cur);
      return acc;
    }, { cur: 0, max: 0 }).max;
  return {
    version: 1,
    objectiveId: obj.objectiveId,
    project: obj.project,
    status: obj.status,
    totalDurationMs: Number.isFinite(objStart) && Number.isFinite(objEnd) ? Math.max(0, objEnd - objStart) : null,
    maxParallelNodes: maxParallel,
    nodeCount: nodes.length,
    nodes,
    integration,
    generatedAt: new Date().toISOString(),
  };
}

// ── the loop ─────────────────────────────────────────────────────────────────

export async function runObjective({ hqRoot, objectivePath, maxConcurrent = 3, execute, agentIds = {}, maxAttemptsPerStage = 3, concurrentGroups, publish, stateRoot }) {
  let obj = readObjState(objectivePath);
  assertAcyclic(obj.nodes);
  const nodeStateRoot = stateRoot || join(dirname(objectivePath), "..", "..");
  mkdirSync(dirname(objectivePath), { recursive: true });

  // Resume: a node the founder unblocked (its state.json is `active` again) and
  // its stalled descendants go back to `pending` so the loop re-runs them.
  // Re-running runObjective after answering a decision card is all it takes.
  mutate(objectivePath, (s) => {
    for (const node of Object.values(s.nodes)) {
      if ((node.status === "blocked" || node.status === "failed") && node.statePath && existsSync(node.statePath)) {
        try {
          if (readState(node.statePath).status === "active") {
            node.status = "pending"; node.blocker = null; node.finishedAt = null;
            s.events.push({ at: new Date().toISOString(), node: node.id, type: "node-resumed" });
          }
        } catch { /* ignore */ }
      }
    }
    const live = new Set(Object.values(s.nodes).filter((n) => n.status !== "blocked" && n.status !== "failed").map((n) => n.id));
    for (const node of Object.values(s.nodes)) {
      if (node.status === "blocked-by-dep" && (node.dependsOn || []).every((d) => live.has(d))) {
        node.status = "pending";
        s.events.push({ at: new Date().toISOString(), node: node.id, type: "node-unblocked" });
      }
    }
    if (s.status !== "active") s.status = "active";
  });

  const inFlight = new Map();
  const launch = (nodeId) => {
    patchNode(objectivePath, nodeId, { status: "running", startedAt: new Date().toISOString() }, { type: "node-started" });
    const p = runNode({ hqRoot, objectivePath, nodeId, execute, agentIds, maxAttemptsPerStage, concurrentGroups, stateRoot: nodeStateRoot })
      .catch((error) => patchNode(objectivePath, nodeId, { status: "failed", blocker: { summary: String(error?.message || error) } }, { type: "node-failed", detail: String(error?.message || error) }))
      .finally(() => inFlight.delete(nodeId));
    inFlight.set(nodeId, p);
  };

  while (true) {
    obj = readObjState(objectivePath);
    if (buildNodesComplete(obj)) break;
    if (isDeadlocked(obj) && inFlight.size === 0) break;
    const ready = readyNodes(obj).filter((id) => !inFlight.has(id));
    while (ready.length && inFlight.size < maxConcurrent) launch(ready.shift());
    if (inFlight.size === 0) break; // nothing running, nothing ready
    await Promise.race(inFlight.values());
  }
  await Promise.allSettled(inFlight.values());

  obj = readObjState(objectivePath);
  let integrationResp = null;
  if (buildNodesComplete(obj)) {
    integrationResp = await runIntegration({ hqRoot, objectivePath, execute, agentIds, maxAttemptsPerStage, concurrentGroups, publish, stateRoot: nodeStateRoot });
  }

  obj = readObjState(objectivePath);
  const finalStatus = obj.integration.status === GATE_SATISFIED ? "complete"
    : buildNodesComplete(obj) ? "integration-blocked"
    : isDeadlocked(obj) ? "blocked" : "incomplete";
  mutate(objectivePath, (s) => { s.status = finalStatus; s.events.push({ at: new Date().toISOString(), type: "objective-finished", detail: finalStatus }); });

  const metrics = collectMetrics(objectivePath);
  writeFileSync(join(dirname(objectivePath), "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`, "utf8");

  return { status: finalStatus, objective: readObjState(objectivePath), metrics, integrationResp };
}
