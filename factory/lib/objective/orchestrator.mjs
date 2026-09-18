// Run a decomposed objective: schedule independent build nodes concurrently
// (bounded), each as a full 7-stage `runToTerminal`, then integrate their
// branches and run review/QA/security/release on the combined tree.
//
// This is orchestration ABOVE the engine. It does not touch task-workflow.mjs
// or the protocol. Every node/integration goes through the unchanged engine, so
// every gate (evidence, independence, high-risk approval, no-push-to-main) is
// enforced exactly as for a single task.

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { dirname, join } from "path";
import { initializeTask } from "../task-initializer.mjs";
import { readState, resumeState, validateTaskContract } from "../task-workflow.mjs";
import { mutateTransactionalState, readTransactionalState } from "../store/transactional-json.mjs";
import { executeOpenClaw, runToTerminal } from "../openclaw-runner.mjs";
import { publishAndRecord } from "../openclaw-runner.mjs";
import { ensureBranchHasCommit } from "../hq/github-publish.mjs";
import { assertAcyclic, buildNodesComplete, descendants, isDeadlocked, readyNodes, GATE_SATISFIED } from "./graph.mjs";
import { observeObjectiveGraph } from "./graph-observer.mjs";
import { classifyBlocker, classifyObjectiveNodeBlocker, founderApprovalSetupBlocker, isFounderApprovalSetupFailure, isRetriableInfraBlocker } from "../hq/blocker-class.mjs";
import { classifyFailure, isDeterministicProjectFailure } from "../failure-classification.mjs";
import { checkCapability } from "../hq/capability-check.mjs";
import { beginRun, endRun, isOurs, runnerIdentity } from "./runner-lease.mjs";
import { triggerObjectiveLearningRun } from "../learning/objective-trigger.mjs";

const INTEGRATION_SYNTHETIC_STAGES = new Set(["product", "architect", "builder"]);

// `fatal` marks this as a control-flow signal for the runner (see
// isControlFlowError in openclaw-runner.mjs). Without the tag the runner caught
// it like any failed agent attempt, rewrote it as "wrote no result file", and
// the catch below never fired — so a two-line conflict became three silent
// recovery attempts and an INFRASTRUCTURE_ERROR escalation.
class MergeConflict extends Error {
  constructor(nodeId, detail) { super(`merge conflict integrating ${nodeId}`); this.nodeId = nodeId; this.detail = detail; this.fatal = true; }
}

const INFRA_FAILURE_RE = /could not start the cli|rate.?limit|cooldown|all models failed|did not write its result file|429|quota|usage limit|provider .* unavailable|ECONNREFUSED|ETIMEDOUT|agent call connection closed|gateway[^.;]{0,60}(?:connection closed|not reachable|unreachable)/i;
// Third of the three layers that must agree (see failure-classification.mjs).
// The missing-result wrapper matches INFRA_FAILURE_RE regardless of the real
// cause, so a conflict wrapped in it would be restated as "could not run ...
// Retry the objective later" — advice that can never work for a merge.
const isInfrastructureFailure = (text) => {
  const str = String(text || "");
  return !isDeterministicProjectFailure(str) && INFRA_FAILURE_RE.test(str);
};

// True when the underlying failure is environmental, however it was surfaced.
//
// Recovery (#56) escalates with `outcome: "decision-required"` and a machine
// `classification`, so the original `outcome === "fail"` guard below stopped
// firing for anything that went through recovery. The `infra` tag was then
// never set, `classifyObjectiveNodeBlocker()` fell through to "decision", and
// the founder was paged for an exhausted seat or an agent that never started —
// exactly what must never reach them. Trust the machine classification first
// and fall back to prose only when there is none.
const isInfraBlocker = (blocker) => !isDeterministicProjectFailure(blocker?.summary)
  && !isDeterministicProjectFailure(blocker?.why)
  && (blocker?.classification === "INFRASTRUCTURE_ERROR" || isInfrastructureFailure(blocker?.summary));

// Restate an infrastructure failure as the founder-legible, machine-taggable
// blocker the objective views and the retry sweep both key off.
const asInfraBlocker = (blocker) => ({
  ...blocker,
  outcome: "decision-required",
  infra: true, // machine-readable; recovery classifies without prose matching
  // A seat pause already says what happened, that nothing was charged, and
  // when it can resume; the generic "could not run" sentence would lose that.
  summary: blocker.outcome === "paused-credits"
    ? blocker.summary
    : `The ${blocker.stage || "agent"} for this task could not run (${firstLine(blocker.why || blocker.summary)}). Retry the objective later, or adjust model routing for that role.`,
});
const firstLine = (text) => String(text || "").split("\n").map((s) => s.trim()).filter(Boolean)[0] || "no detail";

// ── objective-state.json IO ─────────────────────────────────────────────────
// The SQLite authority colocated next to the JSON file (see
// store/transactional-json.mjs) is the source of truth: every mutation is one
// atomic transaction, so concurrent node runs — including across separate
// processes, not just concurrent code in this one — never clobber each
// other. readObjState() keeps its old signature/behaviour (a plain read of
// the always-current JSON export) so every existing caller is unaffected.

export function readObjState(path) { return readTransactionalState(path, { format: "objective-state" }); }

export const INTEGRATION_SKIPPED = "skipped";

function fireLearningTrigger(learningTrigger, payload) {
  if (!payload.hqRoot || typeof learningTrigger !== "function") return;
  // Defer invocation itself, not only its result. Synchronous setup in the
  // learning pass therefore cannot lengthen or fail the objective's return.
  void Promise.resolve().then(() => learningTrigger(payload)).catch(() => {});
}

/**
 * Finish an objective whose work is done but which nothing will ever finish.
 *
 * Every build node passed its gate and the integration was recorded `skipped`
 * — superseded because its work landed another way. runObjective is the only
 * thing that writes `complete`, and it only does so at the end of a run, so an
 * objective reconciled by hand into this shape (obj-c58897c0, 2026-09-15) reads
 * "active" forever. Returns true when it settled something.
 */
export function settleSupersededObjective(objectivePath, {
  now = () => new Date().toISOString(),
  hqRoot = null,
  learningTrigger = triggerObjectiveLearningRun,
} = {}) {
  // Read before writing. The reconciler calls this for every objective on
  // every sweep, and a sweep now repeats every ten minutes; opening a write
  // transaction each time to discover there is nothing to settle is exactly
  // the idle write amplification the publisher was just cured of.
  if (!isSupersededButActive(readObjState(objectivePath))) return false;
  let settled = false;
  const next = mutate(objectivePath, (s) => {
    if (!isSupersededButActive(s)) return;
    const at = now();
    s.status = "complete";
    s.events.push({ at, type: "objective-finished", detail: "complete", reason: "all build nodes passed; integration superseded" });
    settled = true;
  });
  if (settled) fireLearningTrigger(learningTrigger, {
    hqRoot, objectivePath, objectiveId: next.objectiveId, project: next.project, reason: "objective-finished:complete",
  });
  return settled;
}

function isSupersededButActive(s) {
  return s?.status === "active" && s.integration?.status === INTEGRATION_SKIPPED && buildNodesComplete(s);
}

// The one write primitive every node/integration step in this file uses,
// converted here so every call site is concurrency-safe without changing any
// of their call signatures: `fn` still mutates its `state` argument in place,
// it just now does so inside one atomic transaction instead of around a
// separate read and write.
function mutate(path, fn) {
  return mutateTransactionalState(path, {
    commandId: `mutate:${randomUUID()}`,
    replayable: false,
    mutate: (state) => {
      const next = structuredClone(state);
      fn(next);
      next.updatedAt = new Date().toISOString();
      return next;
    },
  });
}

function patchNode(path, nodeId, patch, event) {
  return mutate(path, (s) => {
    const target = s.nodes[nodeId] || (s.integration.id === nodeId ? s.integration : null);
    if (!target) throw new Error(`unknown node ${nodeId}`);
    Object.assign(target, patch);
    if (event) s.events.push({ at: new Date().toISOString(), node: nodeId, ...event });
  });
}

// Stop every pending node that transitively depends on a node that just
// blocked / failed, so the loop deadlocks cleanly instead of spinning.
function blockDescendants(objectivePath, nodeId, detail) {
  for (const d of descendants(readObjState(objectivePath), nodeId)) {
    const s = readObjState(objectivePath);
    if (s.nodes[d]?.status === "pending") {
      patchNode(objectivePath, d, { status: "blocked-by-dep" }, { type: "node-blocked-by-dep", detail: detail || `upstream ${nodeId}` });
    }
  }
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

// A build node may proceed without a PR only when GitHub publication is not
// configured for the project. Once a real target is resolved, the node must
// have a reviewable PR URL before integration can start.
export function classifyNodePublish(result) {
  if (result?.published && result?.prUrl) return { status: "published", prUrl: result.prUrl };
  if (!result?.ownerRepo) return { status: "skipped", reason: result?.reason || "GitHub publication is not configured" };
  return { status: "failed", reason: result?.reason || `GitHub publication for ${result.ownerRepo} did not produce a PR URL` };
}

function blockNodePublish(objectivePath, nodeId, githubPublish, attempts) {
  const classified = classifyNodePublish(githubPublish);
  const blocker = {
    stage: "publish",
    outcome: "decision-required",
    summary: `${classified.reason}. Fix GitHub access or repository publication configuration, then rerun the objective.`,
    at: new Date().toISOString(),
  };
  patchNode(objectivePath, nodeId, {
    status: "blocked", finishedAt: new Date().toISOString(), attempts,
    githubPublish, prUrl: null, blocker,
  }, { type: "node-blocked", detail: blocker.summary });
  for (const d of descendants(readObjState(objectivePath), nodeId)) {
    const state = readObjState(objectivePath);
    if (state.nodes[d]?.status === "pending") {
      patchNode(objectivePath, d, { status: "blocked-by-dep" }, { type: "node-blocked-by-dep", detail: `upstream ${nodeId}` });
    }
  }
  return { nodeId, status: "blocked" };
}

function recordNodePublish(objectivePath, nodeId, githubPublish, attempts) {
  const classified = classifyNodePublish(githubPublish);
  if (classified.status === "failed") return blockNodePublish(objectivePath, nodeId, githubPublish, attempts);
  patchNode(objectivePath, nodeId, {
    status: GATE_SATISFIED, finishedAt: new Date().toISOString(), attempts,
    githubPublish, prUrl: classified.prUrl || null, blocker: null,
  }, { type: "node-gate-satisfied", detail: classified.prUrl || classified.reason });
  return { nodeId, status: GATE_SATISFIED };
}

async function runNode({ hqRoot, objectivePath, nodeId, execute, agentIds, maxAttemptsPerStage, concurrentGroups, stateRoot, publish }) {
  const obj = readObjState(objectivePath);
  const node = obj.nodes[nodeId];
  let statePath = node.statePath;
  let worktree = node.worktree;

  const existing = statePath && existsSync(statePath) ? readState(statePath) : null;
  if (existing) {
    // Resume an already-initialized node without losing passed stages, dispatch
    // history, or the original single worktree for this branch.
    if (existing.task.id !== node.id || existing.branch !== node.branch || existing.repo !== obj.repo) {
      throw new Error(`Existing task does not match objective node ${node.id}`);
    }
    worktree = existing.worktree;
    patchNode(objectivePath, nodeId, { statePath, worktree, branch: existing.branch });
  } else {
    const contractDir = join(dirname(objectivePath), "contracts");
    mkdirSync(contractDir, { recursive: true });
    const contractPath = join(contractDir, `${nodeId}.json`);
    writeFileSync(contractPath, `${JSON.stringify(node.contract, null, 2)}\n`, "utf8");
    let init;
    try {
      init = initializeTask({ hqRoot, contractPath, repo: obj.repo, branch: node.branch, stateRoot });
    } catch (error) {
      // A high-risk node that cannot initialize because the founder approval key
      // is not configured is a founder action, not a dead failure. Record it as
      // a decision so it reaches the Founder Inbox and the objective shows
      // "waiting for you" rather than a cryptic red "failed".
      if (isFounderApprovalSetupFailure(error?.message)) {
        const blocker = founderApprovalSetupBlocker({ at: new Date().toISOString() });
        patchNode(objectivePath, nodeId, { status: "blocked", finishedAt: new Date().toISOString(), blocker },
          { type: "node-blocked", detail: blocker.summary });
        blockDescendants(objectivePath, nodeId);
        return { nodeId, status: "blocked" };
      }
      throw error;
    }
    statePath = init.state;
    worktree = init.worktree;
    patchNode(objectivePath, nodeId, { statePath, worktree, branch: init.branch });
  }

  // Let the workflow publish the completed build branch once it reaches the
  // merge-ready gate. The recorded result is then mirrored onto objective
  // state so integration only starts from reviewable branches.
  const resp = await runToTerminal({ hqRoot, statePath, agentIds, maxAttemptsPerStage, concurrentGroups, execute, publish });
  const state = readState(statePath);
  const attempts = (state.dispatches || []).length;

  if (resp.waiting) {
    patchNode(objectivePath, nodeId, { status: "running", blocker: null }, { type: "node-waiting-for-delegate" });
    return { nodeId, status: "running" };
  }
  if (resp.status === "merge-ready") {
    // ensure the branch actually carries a commit even without a github remote
    try { ensureBranchHasCommit({ state }); } catch { /* recorded by the publish step if a remote exists */ }
    return recordNodePublish(objectivePath, nodeId, state.githubPublish || resp.githubPublish || null, attempts);
  }

  let blocker = state.blocker || { stage: state.currentStage, outcome: "fail", summary: resp.blocker?.summary || "blocked" };
  // An infrastructure failure (agent CLI could not start / rate-limited / never
  // wrote a result) is not a code problem the builder can fix by retrying — it
  // needs the founder to retry later or adjust routing. Surface it as an
  // actionable decision, not a dead `failed`.
  if (isInfraBlocker(blocker)) blocker = asInfraBlocker(blocker);
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

// What the integration node should become when its runner returns.
//
// Pure, and exported, because the inline version of this produced a node with
// `status: "blocked", blocker: null` — blocked for no stated cause. There is
// then nothing for the founder to read, nothing for classifyBlocker to
// classify, and nothing for the retry sweep to decide on; the objective simply
// stops with an empty explanation. Observed on obj-c58897c0 after its
// orchestrator was killed mid-dispatch by a kernel OOM.
//
// Two rules, both already honoured by the build-node path above, which is why
// build nodes never showed this and integration did:
//
//   1. A task that is merely WAITING is not blocked. runToTerminal returns as
//      soon as the status stops being "active", and a claimed dispatch whose
//      result has not landed yet comes back `waiting` with the task perfectly
//      healthy. Recording that as blocked stops the objective on work that is
//      still in flight.
//   2. Never block without a reason. If the task recorded no blocker, say what
//      the runner actually did instead of writing null.
export function integrationOutcome({ resp, state, now = new Date().toISOString() }) {
  if (resp?.waiting) return { status: "running", blocker: null, waiting: true };
  if (resp?.status === "merge-ready") return { status: GATE_SATISFIED, blocker: null, waiting: false };
  const blocker = state?.blocker || {
    stage: state?.currentStage || "builder",
    outcome: "fail",
    summary: resp?.blocker?.summary
      || `the integration runner stopped at ${state?.currentStage || "an unknown stage"} with status "${resp?.status || "unknown"}" and the task recorded no blocker`,
    at: now,
  };
  return { status: "blocked", blocker, waiting: false };
}

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
  let statePath = integ.statePath;
  let worktree = integ.worktree;
  if (statePath && existsSync(statePath)) {
    // Re-entrant: reuse the existing integration worktree / task state.
  } else {
    const init = initializeTask({ hqRoot, contractPath, repo: obj.repo, branch: integ.branch, stateRoot });
    statePath = init.state;
    worktree = init.worktree;
  }
  patchNode(objectivePath, integ.id, { statePath, worktree, branch: integ.branch, status: "running", startedAt: new Date().toISOString() },
    { type: "integration-started", detail: `base ${base}, ${buildBranches.length} branch(es)` });

  const mergeLog = [];
  // product / architect / builder are done deterministically by the orchestrator
  // (the "build" of an integration IS the git merge); review/QA/security/release
  // run for real on the merged tree.
  const integExecute = async (args) => {
    const { dispatch } = args;
    if (!INTEGRATION_SYNTHETIC_STAGES.has(dispatch.stage)) return execute(args);

    const evDir = join(worktree, "evidence");
    mkdirSync(evDir, { recursive: true });
    let summary;
    if (dispatch.stage === "builder") {
      for (const branch of buildBranches) {
        const r = git(worktree, ["merge", "--no-ff", "-m", `factory: integrate ${branch}`, branch]);
        mergeLog.push({ branch, ok: r.ok, out: r.out.slice(0, 800) });
        if (!r.ok) { git(worktree, ["merge", "--abort"]); throw new MergeConflict(branch, r.out); }
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
    resp = await runToTerminal({ hqRoot, statePath, agentIds, maxAttemptsPerStage, concurrentGroups, execute: integExecute, publish });
  } catch (error) {
    if (error instanceof MergeConflict) {
      // Name the files. A conflict the founder can see is usually decided in
      // seconds; "merge conflict integrating <branch>" on its own sends them
      // into the worktree to run the merge by hand before they can judge it.
      const files = [...String(error.detail || "").matchAll(/^CONFLICT \([^)]*\): Merge conflict in (.+)$/gim)].map((m) => m[1].trim());
      const fileList = files.length ? files.join(", ") : "(see the merge log on this node)";
      patchNode(objectivePath, integ.id, {
        status: "blocked", mergeLog,
        blocker: {
          stage: "builder",
          outcome: "decision-required",
          founderAction: true,
          classification: "PROJECT_ERROR",
          conflictFiles: files,
          summary: `merge conflict integrating ${error.nodeId}: ${fileList}`,
          whatFailed: `Merging ${error.nodeId} into the integration branch stopped on ${files.length || "some"} conflicting file(s).`,
          why: "Two sub-task branches changed the same lines, so git cannot compose them without a human or agent choosing the result. This is deterministic: re-running the merge reproduces it exactly, so it was NOT retried.",
          whatItNeedsFromFounder: `Resolve the conflict in ${fileList} on the integration branch, or decide which sub-task branch wins, then resume the objective.`,
          whatHappensAfterApproval: "The integration resumes at the builder stage and the merged tree goes on to review, QA and security.",
          at: new Date().toISOString(),
        },
      }, { type: "integration-conflict", detail: `${error.nodeId}: ${fileList}` });
      return { status: "blocked", reason: "merge-conflict", node: error.nodeId, conflictFiles: files };
    }
    throw error;
  }

  const state = readState(statePath);
  const outcome = integrationOutcome({ resp, state });
  if (outcome.waiting) {
    patchNode(objectivePath, integ.id, { status: "running", blocker: null }, { type: "node-waiting-for-delegate" });
    return resp;
  }
  let blocker = outcome.blocker;
  if (blocker && isInfraBlocker(blocker)) blocker = asInfraBlocker(blocker);
  patchNode(objectivePath, integ.id, {
    mergeLog,
    status: outcome.status,
    finishedAt: new Date().toISOString(),
    githubPublish: state.githubPublish || null,
    blocker,
  }, { type: outcome.status === GATE_SATISFIED ? "integration-gate-satisfied" : "integration-blocked", detail: blocker?.summary });
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

// A founder-readable objective summary, composed from what already happened —
// no model call, no new report engine.
function buildObjectiveReport(obj, metrics) {
  const fmt = (ms) => (ms == null ? "—" : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`);
  const L = [];
  L.push(`# Objective report — ${obj.objectiveId}`, "", obj.objective, "");
  L.push(`**Status:** ${obj.status}  ·  **Wall time:** ${fmt(metrics.totalDurationMs)}  ·  **Max parallel nodes:** ${metrics.maxParallelNodes}`, "");
  L.push("## Build nodes", "");
  for (const n of metrics.nodes || []) {
    const failed = n.failedStages || [];
    const models = n.modelsUsed || [];
    L.push(`- **${n.id.replace(/^obj-[0-9a-f]{8}-/, "")}** (${n.role || "?"}) — ${n.status} · ${fmt(n.durationMs)} · ${n.attempts ?? 0} dispatch(es)`
      + (failed.length ? ` · retried: ${failed.join(", ")}` : "")
      + (models.length ? ` · models: ${models.join(", ")}` : ""));
    const node = obj.nodes[n.id];
    if (node?.blocker) L.push(`  - BLOCKED: ${node.blocker.summary}`);
  }
  L.push("", "## Integration", "");
  const im = metrics.integration || { status: obj.integration?.status || "pending" };
  L.push(`- ${im.status} · ${fmt(im.durationMs)}`);
  for (const m of obj.integration?.mergeLog || []) L.push(`  - merge ${m.branch}: ${m.ok ? "ok" : "CONFLICT"}`);
  if (obj.integration.blocker) L.push(`  - BLOCKED: ${obj.integration.blocker.summary}`);
  const gp = obj.integration.githubPublish;
  if (gp) L.push(`  - GitHub: ${gp.published ? (gp.prUrl || "branch pushed, open PR manually") : `not published (${gp.reason || "?"})`}`);
  L.push("", "_Composed from objective-state.json + metrics.json. Per-node detail is in each task's completion-report.md._", "");
  return L.join("\n");
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

// Resume safely-retryable objective nodes (infra-failed or restart-orphaned) so
// runObjective can re-drive them. Never answers founder decisions or approvals.
// Per-node try/catch: one bad node never aborts the batch.
// The objective-level capability check.
//
// The actor is the factory itself, not a named agent: an objective is scheduled
// by the orchestrator on the founder's instruction, and no agent is acting yet
// when the decision is made. `checkCapability` supplies that default.
function checkObjectiveCapability({ hqRoot, objectivePath, capability, action }) {
  if (!hqRoot) return;
  let objective;
  try { objective = readObjState(objectivePath); } catch { return; }
  checkCapability({
    hqRoot,
    capability,
    action,
    scope: { type: "project", id: objective.project || null, projectId: objective.project || null },
    correlation: { objectiveId: objective.objectiveId || null, ...(objective.project ? { projectId: objective.project } : {}) },
  });
}

// `by` names who asked. It defaults to the founder because every caller until
// now was the founder pressing a button; the boot sweep passes "system", so a
// recovery the machine performed on its own does not read, in the audit log the
// founder scrolls through, as a decision the founder made.
export function resumeObjectiveNodes({ hqRoot = null, objectivePath, nodeIds, by = "founder", now = () => new Date().toISOString(), staleActiveMs = 90 * 60 * 1000, ownerGone = false }) {
  const at = typeof now === "function" ? now() : now;
  // Resuming blocked nodes restarts real work, so it is checked once for the
  // whole call rather than per node: the founder asked to recover an objective,
  // not to recover each node separately, and one decision per node would say
  // the same thing several times in the audit log.
  checkObjectiveCapability({ hqRoot, objectivePath, capability: "objective.recover", action: "recover the objective" });
  const resumed = [];
  const skipped = [];
  const ids = [...new Set(nodeIds || [])];

  for (const nodeId of ids) {
    try {
      const obj = readObjState(objectivePath);
      const node = obj.nodes[nodeId] || (obj.integration?.id === nodeId ? obj.integration : null);
      if (!node) { skipped.push({ id: nodeId, reason: "unknown node" }); continue; }
      const kind = classifyObjectiveNodeBlocker(node.blocker);
      if (kind === "decision" || kind === "hard") {
        skipped.push({ id: nodeId, reason: kind === "decision" ? "needs founder decision" : "hard failure" });
        continue;
      }
      if (!node.statePath || !existsSync(node.statePath)) {
        skipped.push({ id: nodeId, reason: "no task state to resume" });
        continue;
      }
      const state = readState(node.statePath);
      if (state.currentDispatch?.yieldedAt || state.yieldedGroup) {
        skipped.push({ id: nodeId, reason: "delegated worker still owns dispatch" }); continue;
      }
      // The task engine is authoritative; a stale presentation-level infra tag
      // cannot override a newer real decision or substantive failure.
      if (state.status === "blocked" && !isRetriableInfraBlocker(state.blocker)) {
        skipped.push({ id: nodeId, reason: "task requires a decision or substantive repair" }); continue;
      }
      // The age guard is a proxy for "some process may still be writing this".
      // When the objective's recorded runner is provably dead, the proxy is not
      // needed — and waiting on it is what left obj-154e9b39 "Running" for
      // eleven hours after a restart three minutes into a stage.
      if (state.status === "active" && !ownerGone) {
        const age = Date.parse(at) - Date.parse(state.updatedAt);
        if (!Number.isFinite(age) || age <= staleActiveMs) {
          skipped.push({ id: nodeId, reason: "task is still live" }); continue;
        }
      }
      let revived;
      let reason;
      if (state.status === "blocked") {
        revived = resumeState(state, at);
        reason = "infra-failed";
      } else if (state.status === "active") {
        // Restart-orphaned: drop stuck dispatch and re-arm current stage.
        revived = structuredClone(state);
        if (revived.currentDispatch) revived.dispatches = [...(revived.dispatches || []), {
          ...revived.currentDispatch, status: "failed", error: "orphaned after runner restart", completedAt: at,
        }];
        delete revived.currentDispatch;
        if (revived.currentStage) revived.stages[revived.currentStage] = { status: "pending" };
        revived.updatedAt = at;
        revived.events.push({ at, type: "task-resumed", stage: revived.currentStage, actor: "system" });
        reason = "restart-orphaned";
      } else {
        skipped.push({ id: nodeId, reason: `task is ${state.status}, not resumable` });
        continue;
      }
      revived.autoRetries = state.autoRetries || 0;
      mutateTransactionalState(node.statePath, { commandId: `resume:${nodeId}:${randomUUID()}`, replayable: false, mutate: () => revived });

      mutate(objectivePath, (s) => {
        const target = s.nodes[nodeId] || (s.integration?.id === nodeId ? s.integration : null);
        if (!target) return;
        target.status = "pending";
        target.blocker = null;
        target.finishedAt = null;
        s.events.push({ at, type: "objective-node-retry", node: nodeId, reason });
      });

      resumed.push({
        id: nodeId,
        role: node.role || (obj.integration?.id === nodeId ? "integration" : null),
        title: node.contract?.outcome || node.objective || node.role || nodeId,
        reason,
      });
    } catch (error) {
      skipped.push({ id: nodeId, reason: `cannot resume: ${error.message || error}` });
    }
  }

  if (resumed.length) {
    mutate(objectivePath, (s) => {
      const live = new Set(Object.values(s.nodes).filter((n) => n.status !== "blocked" && n.status !== "failed").map((n) => n.id));
      for (const node of Object.values(s.nodes)) {
        if (node.status === "blocked-by-dep" && (node.dependsOn || []).every((d) => live.has(d))) {
          node.status = "pending";
          s.events.push({ at, type: "node-unblocked", node: node.id });
        }
      }
      const prev = s.recovery || {};
      s.recovery = {
        ...prev,
        requestedAt: at,
        by,
        nodes: resumed.map((r) => r.id),
        attempts: (prev.attempts || 0) + 1,
      };
      s.events.push({ at, type: "objective-recovery-requested", by, nodes: resumed.map((r) => r.id) });
      if (s.status !== "active") s.status = "active";
    });
  }

  return { resumed, skipped };
}

export function setObjectiveRecoveryInFlight(objectivePath, inFlight) {
  mutate(objectivePath, (s) => {
    s.recovery = { ...(s.recovery || {}) };
    if (inFlight) s.recovery.inFlight = inFlight;
    else delete s.recovery.inFlight;
  });
}

// ── founder cancel ──────────────────────────────────────────────────────────
// A terminal status the founder writes by hand. Archiving only changes where an
// objective is shown; cancelling says the work itself is over: the loop below
// refuses to schedule a cancelled objective, recovery refuses to resume one,
// and it stops counting as active work anywhere in Headquarters. Node statuses
// are deliberately left alone — what each part had already reached is the record
// of what the run actually did, and cancelling is not a claim about that.
export const CANCELLED = "cancelled";

export function cancelObjective(objectivePath, {
  reason = "",
  at = new Date().toISOString(),
  hqRoot = null,
  learningTrigger = triggerObjectiveLearningRun,
} = {}) {
  const before = readObjState(objectivePath);
  if (before.status === CANCELLED) {
    return {
      objectiveId: before.objectiveId,
      status: CANCELLED,
      cancelledAt: before.cancelledAt || null,
      alreadyCancelled: true,
    };
  }
  if (before.status === "complete") {
    const error = new Error("This objective already finished — there is nothing left to cancel.");
    error.statusCode = 409;
    throw error;
  }
  const detail = String(reason || "").slice(0, 500);
  const next = mutate(objectivePath, (s) => {
    s.status = CANCELLED;
    s.cancelledAt = at;
    if (detail) s.cancelReason = detail;
    s.events.push({ at, type: "objective-cancelled", by: "founder", detail: detail || "cancelled by the founder" });
  });
  fireLearningTrigger(learningTrigger, {
    hqRoot, objectivePath, objectiveId: next.objectiveId, project: next.project, reason: "objective-cancelled:cancelled",
  });
  return {
    objectiveId: next.objectiveId,
    status: CANCELLED,
    cancelledAt: at,
    previousStatus: before.status,
    alreadyCancelled: false,
  };
}

// ── the loop ─────────────────────────────────────────────────────────────────

// Every run records which process owns it, and clears the record when it ends.
// See runner-lease.mjs: without this, a run killed by a restart is
// indistinguishable from one another process is still driving.
export async function runObjective(args) {
  const { objectivePath } = args;
  let current = null;
  try { current = readObjState(objectivePath); } catch { /* driveObjective reports it */ }
  if (!current || current.status === CANCELLED) return driveObjective(args);

  const lease = runnerIdentity();
  beginRun(objectivePath);
  try { mutate(objectivePath, (s) => { s.runner = lease; }); } catch { /* ownership is advisory; never block the run on it */ }
  try {
    return await driveObjective(args);
  } finally {
    if (endRun(objectivePath)) {
      try { mutate(objectivePath, (s) => { if (isOurs(s.runner)) delete s.runner; }); } catch { /* a stale record reads as "gone" to the reconciler anyway */ }
    }
  }
}

async function driveObjective({ hqRoot, objectivePath, maxConcurrent = 3, execute = executeOpenClaw, agentIds = {}, maxAttemptsPerStage = 3, concurrentGroups, publish, stateRoot, learningTrigger = triggerObjectiveLearningRun }) {
  // Scheduling an objective's nodes is checked before anything is read or
  // written, because everything below it — publishing a stalled node, resuming
  // descendants, dispatching stages — follows from this one decision.
  checkObjectiveCapability({ hqRoot, objectivePath, capability: "objective.run", action: "run the objective" });

  let obj = readObjState(objectivePath);
  // The founder cancelled this objective. Return before anything is resumed or
  // rewritten — including the `s.status = "active"` resume below, which would
  // otherwise quietly undo the cancel on the next retry or wakeup.
  if (obj.status === CANCELLED) {
    return { status: CANCELLED, objective: obj, metrics: null, integrationResp: null, observation: null, cancelled: true };
  }
  assertAcyclic(obj.nodes);
  const nodeStateRoot = stateRoot || join(dirname(objectivePath), "..", "..");
  // Snapshot the graph before scheduling so the exit can tell which nodes
  // became runnable during this run and therefore need a durable wakeup.
  const graphAtStart = structuredClone(obj);
  mkdirSync(dirname(objectivePath), { recursive: true });

  // A publication failure happens after all seven stages reached merge-ready.
  // Retry only that guarded external step on resume; never rerun the gates or
  // rebuild the already-completed branch.
  for (const node of Object.values(obj.nodes)) {
    if (node.status !== "blocked" || node.blocker?.stage !== "publish" || !node.statePath || !existsSync(node.statePath)) continue;
    const state = readState(node.statePath);
    if (state.status !== "merge-ready") continue;
    const githubPublish = publishAndRecord({ hqRoot, statePath: node.statePath, publish });
    recordNodePublish(objectivePath, node.id, githubPublish, (state.dispatches || []).length);
  }

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
    const p = runNode({ hqRoot, objectivePath, nodeId, execute, agentIds, maxAttemptsPerStage, concurrentGroups, stateRoot: nodeStateRoot, publish })
      .catch((error) => {
        const message = String(error?.message || error);
        // A founder-setup failure that slipped past runNode's own guard still
        // belongs with the founder, not on a dead "failed" card.
        if (isFounderApprovalSetupFailure(message)) {
          const blocker = founderApprovalSetupBlocker({ at: new Date().toISOString() });
          patchNode(objectivePath, nodeId, { status: "blocked", finishedAt: new Date().toISOString(), blocker }, { type: "node-blocked", detail: blocker.summary });
          blockDescendants(objectivePath, nodeId);
          return;
        }
        const classification = classifyFailure({ error: message, source: "factory" });
        patchNode(objectivePath, nodeId, {
          status: "blocked",
          blocker: {
            stage: "orchestrator", outcome: "decision-required", founderAction: true, classification,
            whatFailed: `The factory could not continue objective node ${nodeId}.`,
            why: message,
            whatFactoryTried: "Recorded the orchestration error and stopped before advancing dependent work.",
            whatItNeedsFromFounder: "Review the factory error and approve or direct the repair if it is safe to continue.",
            whatHappensAfterApproval: "The original objective node will resume from its last durable state.",
            summary: `Factory error (${classification}): ${message}`,
          },
        }, { type: "node-blocked", detail: message });
      })
      .finally(() => inFlight.delete(nodeId));
    inFlight.set(nodeId, p);
  };

  while (true) {
    obj = readObjState(objectivePath);
    // Cancelled while this run was in flight: stop launching new nodes. Whatever
    // is already dispatched is awaited below rather than orphaned.
    if (obj.status === CANCELLED) break;
    if (buildNodesComplete(obj)) break;
    if (isDeadlocked(obj) && inFlight.size === 0) break;
    const ready = readyNodes(obj).filter((id) => !inFlight.has(id));
    while (ready.length && inFlight.size < maxConcurrent) launch(ready.shift());
    if (inFlight.size === 0) break; // nothing running, nothing ready
    await Promise.race(inFlight.values());
  }
  await Promise.allSettled(inFlight.values());

  obj = readObjState(objectivePath);
  const cancelled = obj.status === CANCELLED;
  let integrationResp = null;
  // `skipped` is a settled integration: the founder recorded that its work
  // already landed another way. Running it again would redo the merge — and on
  // obj-c58897c0 the integration being redone is the one whose task store grew
  // to 403 GiB on 2026-09-14.
  if (!cancelled && buildNodesComplete(obj) && obj.integration?.status !== INTEGRATION_SKIPPED) {
    integrationResp = await runIntegration({ hqRoot, objectivePath, execute, agentIds, maxAttemptsPerStage, concurrentGroups, publish, stateRoot: nodeStateRoot });
  }

  obj = readObjState(objectivePath);
  const finalStatus = cancelled ? CANCELLED
    : obj.integration.status === GATE_SATISFIED ? "complete"
    : obj.integration.status === INTEGRATION_SKIPPED && buildNodesComplete(obj) ? "complete"
    : buildNodesComplete(obj) ? "integration-blocked"
    : isDeadlocked(obj) ? "blocked" : "incomplete";
  if (!cancelled) {
    const next = mutate(objectivePath, (s) => { s.status = finalStatus; s.events.push({ at: new Date().toISOString(), type: "objective-finished", detail: finalStatus }); });
    fireLearningTrigger(learningTrigger, {
      hqRoot, objectivePath, objectiveId: next.objectiveId, project: next.project, reason: `objective-finished:${finalStatus}`,
    });
  }

  // Record graph health and enqueue a durable wakeup for anything that became
  // runnable but was not started, so a parked objective can be resumed by the
  // wakeup worker instead of waiting for someone to notice it. Best-effort by
  // construction: an observation failure must never change the outcome above.
  // A cancelled objective gets no wakeups: enqueuing one for a node that became
  // runnable is exactly how cancelled work would come back to life overnight.
  const observation = cancelled ? null : observeObjectiveGraph({
    hqRoot,
    objectivePath,
    nodeStateRoot,
    before: graphAtStart,
    after: readObjState(objectivePath),
    agentForNode: (nodeId, node) => agentIds[node?.role] || node?.role || "openclaw-factory",
  });

  const metrics = collectMetrics(objectivePath);
  writeFileSync(join(dirname(objectivePath), "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
  writeFileSync(join(dirname(objectivePath), "report.md"), buildObjectiveReport(readObjState(objectivePath), metrics), "utf8");

  return { status: finalStatus, objective: readObjState(objectivePath), metrics, integrationResp, observation };
}
