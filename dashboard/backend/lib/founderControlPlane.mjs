import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { homedir } from "os";
import { readState, resumeState, writeState } from "../../../factory/lib/task-workflow.mjs";
import { writeHandoff } from "../../../factory/lib/handoff.mjs";
import { listProjectBriefs } from "../../../factory/lib/intel/project-brief.mjs";
import { buildCompanyBriefing } from "../../../factory/lib/intel/founder-briefing.mjs";
import { toTaskRecord } from "../../../factory/lib/learning/evidence.mjs";
import { classifyBlocker, classifyObjectiveNodeBlocker } from "../../../factory/lib/hq/blocker-class.mjs";
import { resumeObjectiveNodes, setObjectiveRecoveryInFlight, readObjState } from "../../../factory/lib/objective/orchestrator.mjs";
import { defaultStateRoot } from "../../../factory/lib/natural-language-intake.mjs";

const CONTROL_FILE = "control-plane.json";

// ── project + model-policy readers (read-only, guarded) ───────────────────────

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// Normalize a repo path the founder supplied explicitly (e.g. request body
// `repo` / `repoPath`) into an absolute path: "~" expansion, then "." / "" and
// any relative value resolved against `root` (the HQ root) — NOT the process
// cwd — so it matches resolveProjectRepo. Returns null for an empty input.
export function resolveRepoInput(root, repoInput) {
  const repo = expandHome(String(repoInput ?? "").trim());
  if (!repo) return null;
  return repo === "." ? resolve(root) : resolve(root, repo);
}

// Absolute path to a factory task's state.json by task id, or null. Used by the
// manual "retry this stuck task" action.
export function findTaskStatePath(root, taskId) {
  for (const statePath of walkStateFiles(factoryRoot(root))) {
    try {
      if (readState(statePath)?.task?.id === taskId) return statePath;
    } catch { /* skip unreadable */ }
  }
  return null;
}

// Absolute repo path for a registered project (factory/projects.json), or null.
// Lets the founder launch work by project name without typing a path.
export function resolveProjectRepo(root, projectId) {
  const reg = readJsonSafe(join(root, "factory", "projects.json"));
  const project = (reg?.projects || []).find((p) => p.key === projectId);
  if (!project?.repo) return null;
  const repo = expandHome(project.repo);
  return repo === "." || repo === "" ? resolve(root) : resolve(root, repo);
}

// role -> { runtimeAgentId, harness, harnessAvailable, harnessFallback, model:{primary,fallbacks} }
// The single honest answer to "which harness/model actually runs each role."
export function buildRolePolicy(root) {
  const registry = readJsonSafe(join(root, "factory", "agents.json"));
  const oc = readJsonSafe(join(homedir(), ".openclaw", "openclaw.json"));
  const defaultModel = oc?.agents?.defaults?.model || null;
  const norm = (m) => {
    if (!m) return null;
    if (typeof m === "string") return { primary: m.split("@")[0], fallbacks: [] };
    return { primary: String(m.primary || "").split("@")[0], fallbacks: (m.fallbacks || []).map((f) => String(f).split("@")[0]) };
  };
  const out = {};
  for (const a of registry?.agents || []) {
    const rid = a.runtimeAgentId || a.id;
    const entry = oc?.agents?.entries?.[rid];
    out[a.id] = {
      name: a.name,
      runtimeAgentId: rid,
      harness: a.harness || null,
      harnessAvailable: a.harnessAvailable !== false,
      harnessFallback: a.harnessFallback || null,
      model: norm(entry?.model) || (norm(defaultModel) && { ...norm(defaultModel), inherited: true }) || null,
    };
  }
  return out;
}

function factoryRoot(root) {
  return join(root, "dashboard", "backend", "data", "factory");
}

function walkStateFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkStateFiles(path, out);
    else if (entry.isFile() && entry.name === "state.json") out.push(path);
  }
  return out;
}

function readControl(root) {
  const path = join(factoryRoot(root), CONTROL_FILE);
  if (!existsSync(path)) return { version: 1, projects: {}, questions: [], jobs: [] };
  const value = JSON.parse(readFileSync(path, "utf8"));
  return { version: 1, projects: {}, questions: [], jobs: [], ...value };
}

function writeControl(root, value) {
  const path = join(factoryRoot(root), CONTROL_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

const TERMINAL_TASK_STATUSES = new Set(["merge-ready", "merged"]);
const RESULT_EVENT_OUTCOME = {
  "stage-pass": "pass",
  "stage-fail": "fail",
  "stage-decision-required": "decision-required",
  "dispatch-failed": "fail",
};

// Derived progress signals for one task, computed from the full state (not the
// truncated event slice the task view exposes): wall time since the task was
// created, the most recent handoff into a stage, and the most recent stage
// result. All read-only projections — nothing here is a new sensor.
function summariseTaskProgress(state, now = Date.now()) {
  const events = Array.isArray(state.events) ? state.events : [];
  const createdMs = Date.parse(state.createdAt || "");
  const lastEventMs = events.length ? Date.parse(events[events.length - 1].at || "") : NaN;
  const terminal = TERMINAL_TASK_STATUSES.has(state.status);
  const endMs = terminal && Number.isFinite(lastEventMs) ? lastEventMs : now;
  const elapsedMs = Number.isFinite(createdMs) ? Math.max(0, endMs - createdMs) : null;

  let lastHandoff = null;
  let lastResult = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!lastHandoff && (event.type === "handoff-ready" || event.type === "dispatch-ready")) {
      lastHandoff = { stage: event.stage || null, at: event.at || null };
    }
    if (!lastResult && RESULT_EVENT_OUTCOME[event.type]) {
      const stage = event.stage || null;
      lastResult = {
        stage,
        outcome: RESULT_EVENT_OUTCOME[event.type],
        at: event.at || null,
        summary: (stage && state.stages?.[stage]?.summary) || state.blocker?.summary || null,
      };
    }
    if (lastHandoff && lastResult) break;
  }
  return { elapsedMs, lastHandoff, lastResult };
}

function taskView(path) {
  const state = readState(path);
  const updatedAt = state.updatedAt || statSync(path).mtime.toISOString();
  const dispatch = state.currentDispatch || null;
  const progress = summariseTaskProgress(state);
  return {
    id: state.task.id,
    objective: state.task.outcome,
    project: state.task.project || basename(state.repo),
    repo: state.repo,
    statePath: path,
    status: state.status,
    stage: state.currentStage,
    agent: dispatch?.actor || (state.currentStage ? state.assignments?.[state.currentStage] : null),
    agentStatus: dispatch?.status || (state.status === "active" ? "waiting" : state.status),
    blocker: state.blocker || null,
    blockerClass: classifyBlocker(state.blocker),
    autoRetries: state.autoRetries || 0,
    updatedAt,
    createdAt: state.createdAt,
    branch: state.branch,
    risk: state.task.risk,
    elapsedMs: progress.elapsedMs,
    lastHandoff: progress.lastHandoff,
    lastResult: progress.lastResult,
    completionReport: state.completionReport
      ? { generatedAt: state.completionReport.generatedAt || null, status: state.completionReport.status || state.status }
      : null,
    events: (state.events || []).slice(-5).reverse(),
    founderApprovalRequest: state.founderApprovalRequest || null,
    decisionCard: readDecisionCard(state),
  };
}

// Return the rendered completion-report markdown for one task id, read from the
// factory state tree. Never returns a path outside that tree.
export function readTaskCompletionReport(root, taskId) {
  const allowedRoot = resolve(factoryRoot(root));
  for (const statePath of walkStateFiles(factoryRoot(root))) {
    let state;
    try { state = readState(statePath); } catch { continue; }
    if (state?.task?.id !== taskId) continue;
    const reportPath = resolve(dirname(statePath), "completion-report.md");
    if (!reportPath.startsWith(`${allowedRoot}/`) || !existsSync(reportPath)) {
      return { taskId, markdown: null, generatedAt: state.completionReport?.generatedAt || null, status: state.status };
    }
    return {
      taskId,
      markdown: readFileSync(reportPath, "utf8"),
      generatedAt: state.completionReport?.generatedAt || null,
      status: state.completionReport?.status || state.status,
    };
  }
  return null;
}

// Absolute path to an objective-state.json by objective id, or null.
export function findObjectiveStatePath(root, objectiveId) {
  const factoryDir = factoryRoot(root);
  const allowedRoot = resolve(factoryDir);
  if (!existsSync(factoryDir) || !/^obj-[a-z0-9-]+$/i.test(objectiveId)) return null;
  for (const project of readdirSync(factoryDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const statePath = resolve(factoryDir, project.name, "objectives", objectiveId, "objective-state.json");
    if (!statePath.startsWith(`${allowedRoot}/`)) continue;
    if (existsSync(statePath)) return statePath;
  }
  return null;
}

const STALE_ACTIVE_MS_DEFAULT = 90 * 60 * 1000;
const RECOVERY_LOCK_MS = 15 * 60 * 1000;

function recoveryReasonFromBlocker(blocker) {
  const text = String(blocker?.summary || blocker?.detail || "");
  if (/rate.?limit|429|quota|overloaded|capacity/i.test(text)) return "model provider was rate-limited";
  if (/could not (start|run)|provider|unavailable|ECONN|ETIMEDOUT|socket/i.test(text)) return "model provider was unavailable";
  if (/result file|timed out|timeout/i.test(text)) return "agent did not finish cleanly";
  return "infrastructure hiccup";
}

/**
 * Pure plan of which objective nodes are safely retryable (infra-failed or
 * restart-orphaned). Never includes genuine decisions, hard fails, high-risk
 * approvals awaiting signature, or freshly-running tasks.
 */
export function buildRecoveryPlan(objState, { now = Date.now(), staleActiveMs = STALE_ACTIVE_MS_DEFAULT } = {}) {
  const nodes = [];
  const nowMs = typeof now === "number" ? now : Date.parse(now) || Date.now();
  const candidates = [
    ...Object.values(objState.nodes || {}),
    ...(objState.integration ? [objState.integration] : []),
  ];

  for (const node of candidates) {
    if (!node?.id) continue;
    if (node.status === "blocked-by-dep") continue; // clears automatically when deps live

    let task = null;
    if (node.statePath && existsSync(node.statePath)) {
      try { task = readState(node.statePath); } catch { task = null; }
    }

    const kind = classifyObjectiveNodeBlocker(node.blocker);
    const orphan = Boolean(
      node.status === "running"
      && task?.status === "active"
      && task.updatedAt
      && (nowMs - (Date.parse(task.updatedAt) || nowMs)) > staleActiveMs,
    );

    if (kind === "decision" || kind === "hard") continue;
    if (!(kind === "infra" || orphan)) continue;

    // High-risk build awaiting signed approval — never auto-recover.
    if (
      task?.task?.risk === "high"
      && (node.blocker?.stage === "builder" || task.blocker?.stage === "builder")
      && task.founderApprovalRequest
      && !task.founderApproval
    ) continue;

    // Live runner owns a fresh active task — leave it alone (unless orphan above).
    if (task?.status === "active" && !orphan) {
      const age = nowMs - (Date.parse(task.updatedAt) || nowMs);
      if (age <= staleActiveMs) continue;
    }
    if (node.status === "running" && task?.status === "active" && !orphan) continue;

    const title = node.contract?.outcome || node.objective || node.role || "step";
    nodes.push({
      id: node.id,
      role: node.role || (objState.integration?.id === node.id ? "integration" : null),
      title,
      reason: orphan ? "interrupted by a restart" : recoveryReasonFromBlocker(node.blocker),
    });
  }

  return { nodes };
}

/**
 * Founder one-click: resume every safely-retryable node and restart the
 * objective orchestrator in the background. Injectable `runObjective` for tests.
 */
export async function handleObjectiveRetry({
  root,
  hqRoot,
  objectiveId,
  runObjective,
  now = Date.now(),
  readConfig = () => {
    try { return JSON.parse(readFileSync(join(hqRoot || root, "factory", "factory.config.json"), "utf8")); }
    catch { return {}; }
  },
}) {
  const statePath = findObjectiveStatePath(root, objectiveId);
  if (!statePath) {
    const err = new Error("No such objective.");
    err.statusCode = 404;
    throw err;
  }

  const nowMs = typeof now === "number" ? now : Date.parse(now) || Date.now();
  const nowISO = new Date(nowMs).toISOString();
  let obj = readObjState(statePath);

  if (obj.recovery?.inFlight?.at) {
    const lockAge = nowMs - (Date.parse(obj.recovery.inFlight.at) || 0);
    if (lockAge < RECOVERY_LOCK_MS) {
      const err = new Error("Recovery already in progress for this objective.");
      err.statusCode = 409;
      throw err;
    }
  }
  const liveJob = listFounderJobs(root).find(
    (j) => j.kind === "objective-recovery" && j.objectiveId === objectiveId && j.status === "recovering",
  );
  if (liveJob) {
    const err = new Error("Recovery already in progress for this objective.");
    err.statusCode = 409;
    throw err;
  }

  const plan = buildRecoveryPlan(obj, { now: nowMs });
  if (!plan.nodes.length) {
    const err = new Error("Nothing to recover — the remaining blockers need you.");
    err.statusCode = 409;
    throw err;
  }

  const { resumed, skipped } = resumeObjectiveNodes({
    objectivePath: statePath,
    nodeIds: plan.nodes.map((n) => n.id),
    now: nowISO,
  });
  if (!resumed.length) {
    const err = new Error("Nothing to recover — the remaining blockers need you.");
    err.statusCode = 409;
    throw err;
  }

  const jobId = `founder-recovery-${Date.now().toString(36)}`;
  setObjectiveRecoveryInFlight(statePath, { at: nowISO, jobId });
  const job = {
    id: jobId,
    kind: "objective-recovery",
    projectId: obj.project,
    objectiveId,
    objective: obj.objective,
    repo: obj.repo,
    nodeCount: resumed.length,
    status: "recovering",
    createdAt: nowISO,
    updatedAt: nowISO,
  };
  saveFounderJob(root, job);

  const cfg = readConfig();
  const hq = hqRoot || root;
  Promise.resolve()
    .then(() => runObjective({
      hqRoot: hq,
      objectivePath: statePath,
      agentIds: cfg.openclawIntegration?.agentIds || {},
      maxAttemptsPerStage: cfg.openclawIntegration?.maxAttemptsPerStage || 3,
      concurrentGroups: cfg.openclawIntegration?.concurrentGroups,
      stateRoot: defaultStateRoot(hq, obj.repo),
    }))
    .then((r) => {
      saveFounderJob(root, Object.assign(job, { status: r?.status || "complete", updatedAt: new Date().toISOString() }));
    })
    .catch((error) => {
      saveFounderJob(root, Object.assign(job, { status: "error", error: error.message || String(error), updatedAt: new Date().toISOString() }));
    })
    .finally(() => {
      try { setObjectiveRecoveryInFlight(statePath, null); } catch { /* ignore */ }
    });

  return {
    objectiveId,
    status: "recovering",
    nodes: resumed.map(({ role, title }) => ({ role, title })),
    skipped: skipped.map(({ id, reason }) => ({ reason })), // omit raw ids from founder-facing skipped if preferred — tests check no auto-answer
    jobId,
  };
}

// The founder-readable objective summary the orchestrator writes to
// objectives/<id>/report.md. Path-guarded to the factory state tree.
export function readObjectiveReport(root, objectiveId) {
  const factoryDir = factoryRoot(root);
  const allowedRoot = resolve(factoryDir);
  if (!existsSync(factoryDir) || !/^obj-[a-z0-9-]+$/i.test(objectiveId)) return null;
  for (const project of readdirSync(factoryDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = join(factoryDir, project.name, "objectives", objectiveId);
    const reportPath = resolve(dir, "report.md");
    if (!reportPath.startsWith(`${allowedRoot}/`)) continue;
    if (existsSync(reportPath)) return { objectiveId, markdown: readFileSync(reportPath, "utf8") };
    if (existsSync(join(dir, "objective-state.json"))) {
      let status = "active";
      try { status = JSON.parse(readFileSync(join(dir, "objective-state.json"), "utf8")).status; } catch { /* ignore */ }
      return { objectiveId, markdown: null, status };
    }
  }
  return null;
}

// One task's evidence + timeline, for the report drill-down. Reuses the Learning
// system's already-redacted, verdict-tagged extractor — read-only, never a path
// outside the worktree (that guard is inside toTaskRecord's evidence reader).
export function readTaskEvidence(root, taskId) {
  for (const statePath of walkStateFiles(factoryRoot(root))) {
    let state;
    try { state = readState(statePath); } catch { continue; }
    if (state?.task?.id !== taskId) continue;
    const record = toTaskRecord(state, statePath, { attachEvidence: true });
    return {
      taskId,
      status: state.status,
      branch: state.branch || null,
      blocker: record.blocker,
      githubPublish: state.githubPublish || null,
      stageOutcomes: record.stageOutcomes,
      failedDispatches: record.failedDispatches,
      retryByStage: record.retryByStage,
      evidenceByStage: record.evidenceByStage,
      events: (state.events || []).map((e) => ({ at: e.at, type: e.type, stage: e.stage || null, actor: e.actor || null, outcome: e.outcome || null })).reverse(),
    };
  }
  return null;
}

function readDecisionCard(state) {
  if (state.blocker?.outcome !== "decision-required") return null;
  const evidence = state.stages?.[state.blocker.stage]?.evidence || [];
  for (const item of evidence) {
    const path = resolve(state.worktree, item.path || "");
    if (!path.startsWith(`${resolve(state.worktree)}/`) || !existsSync(path)) continue;
    const text = readFileSync(path, "utf8").slice(0, 100000);
    const section = (names) => {
      const match = text.match(new RegExp(`(?:^|\\n)#{2,4}\\s+(?:${names})\\s*\\n([\\s\\S]*?)(?=\\n#{1,4}\\s|$)`, "i"));
      return match?.[1]?.trim() || "";
    };
    const optionMatches = [...text.matchAll(/(?:^|\n)#{1,4}\s+Option\s+([^\n]+)\n([\s\S]*?)(?=\n#{1,4}\s|$)/gi)];
    const options = optionMatches.map((match) => {
      const detail = match[2].split("\n").map((line) => line.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean).join(" · ");
      return `Option ${match[1].trim()}${detail ? ` — ${detail}` : ""}`;
    });
    if (!options.length) {
      const optionsText = section("options?|recommended options?");
      options.push(...optionsText.split("\n").map((line) => line.replace(/^\s*[-*\d.)]+\s*/, "").trim()).filter(Boolean));
    }
    const card = {
      question: section("decision|question|decision required"),
      why: section("why this needs the founder|why it matters|context|impact"),
      recommendation: section("recommendation|recommended option"),
      options,
    };
    if (card.question || card.why || card.recommendation || card.options.length) return card;
  }
  return null;
}

// Read-only view of every decomposed objective (factory/lib/objective/) and its
// live task graph, for the Headquarters dashboard/API. Joins each node to its
// underlying factory task (already discovered above) so stage / status /
// elapsed / blocker / retries / last result come for free.
export function buildObjectivesView(root) {
  const factoryDir = factoryRoot(root);
  const objectives = [];
  if (existsSync(factoryDir)) {
    for (const project of readdirSync(factoryDir, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const objDir = join(factoryDir, project.name, "objectives");
      if (!existsSync(objDir)) continue;
      for (const entry of readdirSync(objDir, { withFileTypes: true })) {
        const path = join(objDir, entry.name, "objective-state.json");
        if (!existsSync(path)) continue;
        try { objectives.push(shapeObjective(root, JSON.parse(readFileSync(path, "utf8")), join(objDir, entry.name))); }
        catch (error) { objectives.push({ objectiveId: entry.name, status: "invalid", error: error.message }); }
      }
    }
  }
  const tasksById = new Map(discoverFactoryTasks(root).map((t) => [t.id, t]));
  const rolePolicy = buildRolePolicy(root);
  const modelForRole = (role) => {
    const entry = rolePolicy[role] || rolePolicy[`${role.replace(/-builder$/, "")}-builder`] || null;
    return entry?.model?.primary || null;
  };
  for (const obj of objectives) {
    const allNodes = [...(obj.nodes || []), obj.integration].filter(Boolean);
    for (const node of allNodes) {
      const task = tasksById.get(node.id);
      node.model = modelForRole(node.role || "integration");
      if (task) Object.assign(node, {
        title: task.objective || node.title || null,
        stage: task.stage, taskStatus: task.status, elapsedMs: task.elapsedMs,
        lastResult: task.lastResult, blocker: node.blocker || task.blocker,
        decisionRequired: classifyObjectiveNodeBlocker(node.blocker || task.blocker) === "decision",
        retries: (task.events || []).filter((e) => e.type === "failure-routed").length,
        statePath: task.statePath,
        hasReport: Boolean(task.completionReport),
      });
      node.completedStages = task
        ? (task.events || []).filter((e) => e.type === "stage-pass").map((e) => e.stage)
        : [];
    }
    obj.prUrl = obj.integration?.githubPublish?.prUrl || null;
    // Only genuine founder decisions / non-infra blocks — infra goes to recovery.
    obj.blockedOn = allNodes.find((n) => {
      const kind = classifyObjectiveNodeBlocker(n.blocker);
      if (kind === "decision") return true;
      if (n.status === "blocked" && kind !== "infra") return true;
      return false;
    })?.id || null;
    obj.nextUp = (obj.nodes || [])
      .filter((n) => n.status === "pending" && (n.dependsOn || []).every((d) => (obj.nodes || []).find((x) => x.id === d)?.status === "gate-satisfied"))
      .map((n) => n.id);
  }
  // Attach recovery plans from raw objective-state (needs statePath on nodes).
  for (const obj of objectives) {
    if (obj.status === "invalid") continue;
    const statePath = findObjectiveStatePath(root, obj.objectiveId);
    if (!statePath) {
      obj.recovery = { count: 0, nodes: [] };
      continue;
    }
    try {
      const raw = readObjState(statePath);
      const plan = buildRecoveryPlan(raw);
      obj.recovery = {
        count: plan.nodes.length,
        nodes: plan.nodes.map(({ role, title, reason }) => ({ role, title, reason })),
        attempts: raw.recovery?.attempts || 0,
      };
    } catch {
      obj.recovery = { count: 0, nodes: [] };
    }
  }
  return {
    objectives: objectives.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))),
    rolePolicy,
    summary: {
      total: objectives.length,
      running: objectives.filter((o) => o.status === "active").length,
      complete: objectives.filter((o) => o.status === "complete").length,
      blocked: objectives.filter((o) => ["blocked", "integration-blocked"].includes(o.status)).length,
      needsFounder: objectives.filter((o) => o.blockedOn).length,
    },
  };
}

function shapeObjective(root, obj, dir) {
  let metrics = null;
  try { metrics = JSON.parse(readFileSync(join(dir, "metrics.json"), "utf8")); } catch { /* not finished yet */ }
  const nodeRow = (n) => ({
    id: n.id, role: n.role || "integration", harness: n.harness || null, dependsOn: n.dependsOn || [],
    // Human one-liner from the decomposition contract, so the UI can show a
    // real title instead of the slug id. Falls back to the task outcome later.
    title: n.contract?.outcome || n.objective || null,
    status: n.status, branch: n.branch || null, worktree: n.worktree || null,
    startedAt: n.startedAt || null, finishedAt: n.finishedAt || null, attempts: n.attempts || 0,
    blocker: n.blocker || null,
    statePath: n.statePath || null,
    githubPublish: n.githubPublish || null,
    mergeLog: Array.isArray(n.mergeLog) ? n.mergeLog.map((m) => ({ branch: m.branch, ok: m.ok })) : null,
  });
  return {
    objectiveId: obj.objectiveId,
    objective: obj.objective,
    project: obj.project,
    repo: obj.repo,
    status: obj.status,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
    nodes: Object.values(obj.nodes || {}).map(nodeRow),
    integration: nodeRow(obj.integration || {}),
    events: (obj.events || []).slice(-40),
    metrics,
    recoveryAttempts: obj.recovery?.attempts || 0,
  };
}

export function discoverFactoryTasks(root) {
  return walkStateFiles(factoryRoot(root))
    .map((path) => {
      try { return taskView(path); }
      catch (error) { return { id: basename(dirname(path)), statePath: path, status: "invalid", error: error.message }; }
    })
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

export function buildFounderOverview(root, hqProjects = []) {
  const control = readControl(root);
  const tasks = discoverFactoryTasks(root);
  const projectMap = new Map(hqProjects.map((project) => [project.id, {
    id: project.id,
    name: project.name,
    mission: project.mission || project.description || "",
    repo: project.repoPath || null,
    status: control.projects[project.id]?.status || project.status || "active",
    tasks: [],
  }]));
  for (const task of tasks) {
    const id = task.project || basename(task.repo || "project");
    if (!projectMap.has(id)) projectMap.set(id, { id, name: id, mission: "", repo: task.repo, status: control.projects[id]?.status || "active", tasks: [] });
    projectMap.get(id).tasks.push(task);
  }
  const projects = [...projectMap.values()].map((project) => {
    const active = project.tasks.find((task) => task.status === "active") || project.tasks[0];
    const blocker = project.tasks.find((task) => task.blocker)?.blocker || null;
    return {
      ...project,
      stage: active?.stage || null,
      agent: active?.agent || null,
      blocker,
      lastActivity: project.tasks[0]?.updatedAt || null,
      taskCount: project.tasks.length,
    };
  });
  const decisions = tasks.filter((task) => task.blocker?.outcome === "decision-required").map((task) => ({
    id: `${task.id}:${task.blocker.stage}`,
    taskId: task.id,
    project: task.project,
    statePath: task.statePath,
    question: task.decisionCard?.question || task.blocker.summary,
    why: task.decisionCard?.why || `The ${task.blocker.stage} stage cannot continue without founder direction.`,
    recommendation: task.decisionCard?.recommendation || (task.risk === "high" ? "Review and submit the signed high-risk approval." : "Approve the recommended path or provide a concise direction."),
    options: task.decisionCard?.options?.length ? task.decisionCard.options : (task.risk === "high" ? ["Submit signed approval", "Keep paused"] : ["Approve and resume", "Provide direction", "Keep paused"]),
    risk: task.risk,
    requestedAt: task.blocker.at,
  }));
  const activity = tasks.flatMap((task) => task.events.map((event) => ({ ...event, taskId: task.id, project: task.project, objective: task.objective })))
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 30);

  const inbox = buildFounderInbox({ tasks, decisions, questions: control.questions });

  // Tasks the system is (or should be) recovering from on its own — shown to
  // the founder as progress, NOT as something that needs them. Two cases:
  // infra-blocked, and "active" but untouched long enough that its in-process
  // runner clearly died with a restart (the auto-retry sweep revives both).
  const STALE_ACTIVE_MS = 90 * 60 * 1000;
  const autoRecovering = tasks
    .filter((task) => {
      if (task.status === "blocked") return (task.blockerClass || classifyBlocker(task.blocker)) === "infra";
      if (task.status === "active") return Date.now() - (Date.parse(task.updatedAt) || Date.now()) > STALE_ACTIVE_MS;
      return false;
    })
    .map((task) => ({
      taskId: task.id,
      objective: task.objective || null,
      project: task.project || null,
      stage: task.status === "blocked" ? (task.blocker?.stage || null) : (task.stage || null),
      detail: task.status === "blocked" ? (task.blocker?.summary || "") : "in-progress work interrupted by a restart — resuming",
      statePath: task.statePath || null,
      autoRetries: task.autoRetries || 0,
      since: task.status === "blocked" ? (task.blocker?.at || null) : (task.updatedAt || null),
    }));

  const intel = attachProjectIntelligence(root, projects, decisions);
  return {
    projects: intel.projects,
    tasks,
    decisions,
    openDecisions: intel.company?.openDecisions || decisions,
    inbox,
    autoRecovering,
    company: intel.company,
    questions: control.questions.slice(-20).reverse(),
    activity,
  };
}

// The Founder Inbox — a single ordered list of everything that actually needs
// the founder: high-risk approvals, decisions a stage raised, terminally
// blocked tasks, and any unanswered question. It is a projection of task state
// + the control file; it adds no new state and no new workflow.
function buildFounderInbox({ tasks, decisions, questions }) {
  const items = [];
  const byId = new Map(tasks.map((t) => [t.id, t]));

  for (const d of decisions) {
    const task = byId.get(d.taskId);
    const isApproval = d.risk === "high" && Boolean(task?.founderApprovalRequest);
    items.push({
      kind: isApproval ? "approval" : "decision",
      id: d.id,
      taskId: d.taskId,
      objective: task?.objective || null,
      project: d.project || null,
      statePath: d.statePath || null,
      title: d.question,
      detail: d.why,
      recommendation: d.recommendation,
      options: d.options,
      risk: d.risk || null,
      requestedAt: d.requestedAt || null,
      action: isApproval ? "submit-signed-approval" : "respond-and-resume",
    });
  }

  // `routeStageFailure` keeps a still-retriable task `active`; a task found
  // `blocked` with a `fail` outcome has exhausted its retry budget. Only a
  // HARD failure (a real FAIL reason) belongs here — an INFRA failure (no
  // result file, timeout, provider 5xx) is handled by the auto-retry sweep and
  // must never page the founder.
  for (const task of tasks) {
    if (task.status !== "blocked" || task.blocker?.outcome !== "fail") continue;
    if ((task.blockerClass || classifyBlocker(task.blocker)) === "infra") continue;
    items.push({
      kind: "blocked",
      id: `${task.id}:${task.blocker.stage || "stage"}`,
      taskId: task.id,
      objective: task.objective || null,
      project: task.project || null,
      statePath: task.statePath || null,
      title: `${task.blocker.stage || "A stage"} failed — needs a look`,
      detail: task.blocker.summary || "The task cannot proceed without founder attention.",
      risk: task.risk || null,
      requestedAt: task.blocker.at || null,
      action: "review-blocked-task",
    });
  }

  for (const q of questions || []) {
    if (q.answer) continue;
    items.push({
      kind: "question",
      id: q.id,
      taskId: null,
      project: null,
      statePath: null,
      title: `Question to ${q.agentId}`,
      detail: q.question,
      requestedAt: q.askedAt || null,
      action: "none",
    });
  }

  const rank = { approval: 0, decision: 1, blocked: 2, question: 3 };
  return items.sort((a, b) =>
    (rank[a.kind] - rank[b.kind]) || String(b.requestedAt || "").localeCompare(String(a.requestedAt || "")));
}

// Enrich each project with its intelligence-layer brief + health, and produce a
// company-level view (risks, opportunities, recommended actions). Fully guarded:
// a missing registry or unreadable context leaves the overview intact.
function attachProjectIntelligence(root, projects, decisions) {
  let briefs = [];
  let briefsError = null;
  try {
    const result = listProjectBriefs({ hqRoot: root });
    briefs = result.briefs || [];
    briefsError = result.error || null;
  } catch (error) {
    briefsError = error.message || String(error);
  }

  const briefByKey = new Map(briefs.filter((b) => b && b.key).map((b) => [b.key, b]));
  const enrichedProjects = projects.map((project) => {
    const brief = briefByKey.get(project.id) || null;
    return { ...project, intelligence: brief, intelligenceError: brief ? null : briefsError };
  });

  let company = null;
  try {
    company = buildCompanyBriefing({ briefs, projects: enrichedProjects, taskDecisions: decisions });
  } catch (error) {
    company = { error: error.message || String(error), projects: [], openDecisions: decisions, risks: [], opportunities: [], recommendedActions: [], summary: null };
  }

  // Fold health back onto the project rows the dashboard already renders.
  const healthByProject = new Map((company?.projects || []).map((p) => [p.id, p.health]));
  for (const project of enrichedProjects) {
    project.health = healthByProject.get(project.id) || null;
  }

  return { projects: enrichedProjects, company };
}

export function setProjectPaused(root, projectId, paused) {
  const control = readControl(root);
  control.projects[projectId] = { ...(control.projects[projectId] || {}), status: paused ? "paused" : "active", updatedAt: new Date().toISOString() };
  writeControl(root, control);
  return control.projects[projectId];
}

export function isProjectPaused(root, projectId) {
  return readControl(root).projects[projectId]?.status === "paused";
}

export function recordQuestion(root, question) {
  const control = readControl(root);
  control.questions.push(question);
  control.questions = control.questions.slice(-100);
  writeControl(root, control);
  return question;
}

export function listFounderJobs(root) {
  return readControl(root).jobs.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function saveFounderJob(root, job) {
  const control = readControl(root);
  const index = control.jobs.findIndex((item) => item.id === job.id);
  if (index >= 0) control.jobs[index] = structuredClone(job);
  else control.jobs.push(structuredClone(job));
  control.jobs = control.jobs.slice(-100);
  writeControl(root, control);
  return job;
}

export function resolveFounderDecision({ root, hqRoot, statePath, direction }) {
  const path = resolve(statePath);
  const allowedRoot = resolve(factoryRoot(root));
  if (!path.startsWith(`${allowedRoot}/`)) throw new Error("Task state is outside the factory state directory.");
  const state = readState(path);
  if (state.status !== "blocked" || state.blocker?.outcome !== "decision-required") throw new Error("Task is not waiting for a founder decision.");
  if (state.task.risk === "high" && state.blocker?.stage === "builder") throw new Error("High-risk build approval requires the signed approval flow.");
  const at = new Date().toISOString();
  state.founderDecisions = [...(state.founderDecisions || []), { at, direction: String(direction).trim(), blocker: state.blocker }];
  state.events.push({ at, type: "founder-decision-recorded", stage: state.currentStage, actor: "founder", direction: String(direction).trim() });
  writeState(path, state);
  const next = resumeState(state, at);
  writeState(path, next);
  writeHandoff({ hqRoot, statePath: path, state: next });
  return taskView(path);
}
