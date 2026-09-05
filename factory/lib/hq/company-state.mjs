// The company state — the single object that answers
// "what is happening in my company?"
//
// It is composition, not a new system. Projects come from the unified registry
// (which already folds in the intelligence brief). The company roll-up reuses
// intel/founder-briefing.mjs. Agent activity reuses hq/activity.mjs. External
// reality is read-only GitHub awareness. Real OpenClaw runtime state is
// read-only awareness over the actual OpenClaw install. Nothing here writes
// anything.

import { basename } from "path";
import { buildCompanyBriefing } from "../intel/founder-briefing.mjs";
import { listCompanyProjects } from "./registry.mjs";
import { listAgents } from "./agents.mjs";
import { buildAgentActivity, buildActivityFeed } from "./activity.mjs";
import { readHqConfig } from "./config.mjs";
import { readRepoAwareness, summariseRepoAwareness } from "./github.mjs";
import { readOpenclawRuntime, readOpenclawActivity, reconcileRoster } from "./runtime.mjs";
import { discoverProjects } from "./discovery.mjs";

const FOUNDER = { name: "João Vitor", headquarters: "OpenClaw Agents Headquarter" };

/**
 * @param {object}   input
 * @param {string}   input.hqRoot
 * @param {Array}   [input.tasks]          normalised factory task views (see hq/activity.mjs)
 * @param {Array}   [input.hqProjects]     dashboard HQ project rows (optional enrichment)
 * @param {Array}   [input.taskDecisions]  pre-computed founder decisions (optional; else derived from tasks)
 * @param {boolean} [input.withGithub=false]  fetch read-only GitHub awareness for projects that declare it
 * @param {boolean} [input.withRuntime=false] fetch real OpenClaw runtime roster + activity (openclaw CLI)
 * @param {Function}[input.exec]           gh runner, injected for tests
 * @param {Function}[input.runtimeExec]    openclaw runner, injected for tests
 * @param {Date}    [input.now]
 * @returns {Promise<object>}
 */
export async function buildCompanyState({
  hqRoot,
  tasks = [],
  hqProjects = [],
  taskDecisions = null,
  withGithub = false,
  withRuntime = false,
  exec = undefined,
  runtimeExec = undefined,
  now = new Date(),
}) {
  const warnings = [];
  const config = readHqConfig(hqRoot);
  const taskList = Array.isArray(tasks) ? tasks.filter(Boolean) : [];

  // ---- projects (unified registry + intelligence) ----
  const { projects: unifiedProjects, warnings: registryWarnings } = listCompanyProjects({ hqRoot, hqProjects, now });
  warnings.push(...registryWarnings);

  // The Headquarters repo itself is infrastructure the company runs on, not a
  // company project — it never appears in the founder's project portfolio,
  // health roll-up, risks, or recommended actions. It is still tracked (tasks,
  // GitHub) and surfaced separately as `headquarters`.
  const headquartersEntry = unifiedProjects.find((p) => p.kind === "headquarters") || null;
  const companyProjects = unifiedProjects.filter((p) => p.kind !== "headquarters");

  const tasksByProject = groupTasksByProject(taskList, unifiedProjects);
  const decisions = taskDecisions || deriveTaskDecisions(taskList);

  // Shape projects for the company briefing (id/name/tasks/status).
  const briefingProjectRows = companyProjects.map((p) => ({
    id: p.key,
    name: p.name,
    mission: p.mission,
    status: p.status,
    tasks: tasksByProject.get(p.key) || [],
    taskCount: (tasksByProject.get(p.key) || []).length,
    stage: (tasksByProject.get(p.key) || []).find((t) => t.status === "active")?.stage || null,
    currentPhase: p.dashboard?.currentPhase || null,
  }));
  const briefs = companyProjects.map((p) => p.intelligence).filter(Boolean);

  let company;
  try {
    company = buildCompanyBriefing({ briefs, projects: briefingProjectRows, taskDecisions: decisions, now });
  } catch (error) {
    warnings.push({ code: "company-briefing-failed", message: error.message });
    company = { projects: [], openDecisions: decisions, risks: [], opportunities: [], recommendedActions: [], summary: null };
  }
  const healthByKey = new Map((company.projects || []).map((p) => [p.id, p.health]));

  // ---- external world (read-only GitHub) — computed for every registered
  // project, including the Headquarters entry, so infra context can carry it.
  const external = [];
  if (withGithub && config.github?.enabled !== false) {
    for (const project of unifiedProjects) {
      if (!project.github) continue;
      const awareness = await readRepoAwareness({
        owner: project.github.owner,
        repo: project.github.repo,
        exec,
        enabled: config.github.enabled !== false,
        limits: { commits: config.github.commitLimit, prs: config.github.prLimit, issues: config.github.issueLimit },
      });
      external.push({ project: project.key, ...awareness, summary: summariseRepoAwareness(awareness) });
    }
  }
  const externalByKey = new Map(external.map((e) => [e.project, e]));
  const companyExternal = external.filter((e) => e.project !== headquartersEntry?.key);

  // ---- final project rows (company projects only — never the Headquarters) ----
  const projects = companyProjects.map((p) => {
    const projectTasks = tasksByProject.get(p.key) || [];
    return {
      key: p.key,
      name: p.name,
      status: p.status,
      owner: p.owner,
      mission: p.mission,
      repo: p.repo,
      repoExists: p.repoExists,
      github: p.github,
      responsibleAgents: p.responsibleAgents,
      registered: p.registered,
      hasContext: p.hasContext,
      health: healthByKey.get(p.key) || null,
      risks: p.risks,
      openDecisions: p.openDecisions,
      contextFindings: p.contextFindings,
      intelligencePriorities: (p.intelligence?.ownership?.currentPriorities || []).map((x) => x.title).filter(Boolean),
      activeTasks: projectTasks.filter((t) => t.status === "active").map(slimTask),
      blockedTasks: projectTasks.filter((t) => t.status === "blocked").map(slimTask),
      taskCount: projectTasks.length,
      externalSummary: externalByKey.get(p.key)?.summary || null,
      intelligenceWarnings: p.intelligence?.warnings || [],
      // Full detail for a single-project view — the same data already
      // resolved above, not a second fetch or a second source of truth.
      intelligence: p.intelligence || null,
      external: externalByKey.get(p.key) || null,
    };
  });

  // ---- the Headquarters itself, as infrastructure context, never a project ----
  const headquarters = headquartersEntry
    ? {
        key: headquartersEntry.key,
        name: headquartersEntry.name,
        mission: headquartersEntry.mission,
        repo: headquartersEntry.repo,
        github: headquartersEntry.github,
        status: headquartersEntry.status,
        hasContext: headquartersEntry.hasContext,
        activeTasks: (tasksByProject.get(headquartersEntry.key) || []).filter((t) => t.status === "active").map(slimTask),
        externalSummary: externalByKey.get(headquartersEntry.key)?.summary || null,
      }
    : null;

  // ---- real OpenClaw runtime: roster + real per-agent activity ----
  let runtime = null;
  let runtimeActivity = null;
  let rosterReconciliation = null;
  if (withRuntime && config.runtime?.enabled !== false) {
    runtime = await readOpenclawRuntime({ exec: runtimeExec, enabled: true });
    runtimeActivity = await readOpenclawActivity({
      exec: runtimeExec,
      enabled: true,
      limit: config.runtime.auditLimit,
    });
    if (!runtime.available) warnings.push({ code: "openclaw-runtime-unavailable", message: runtime.error || "openclaw runtime unreachable" });
    if (!runtimeActivity.available) warnings.push({ code: "openclaw-activity-unavailable", message: runtimeActivity.error || "openclaw audit unreachable" });
  }

  // ---- agents (committed roster + real task state + real runtime activity) ----
  const { agents: agentRows, warnings: agentWarnings } = listAgents(hqRoot);
  warnings.push(...agentWarnings);
  const activity = buildAgentActivity({
    agents: agentRows,
    tasks: taskList,
    now,
    runtime: runtimeActivity,
    staleAfterMinutes: config.activity?.staleAfterMinutes,
  });
  if (runtime?.available) {
    rosterReconciliation = reconcileRoster(agentRows, runtime);
    for (const role of rosterReconciliation.roles) {
      if (role.runtimeAgentId && !role.resolved) {
        warnings.push({
          code: `agent-role-unresolved:${role.agentId}`,
          message: `Role "${role.agentId}" names OpenClaw agent "${role.runtimeAgentId}", which does not currently exist in this machine's OpenClaw install.`,
        });
      }
    }
  }

  // ---- a real, non-invented "what happened recently" feed — flattened from
  // structured task events already carried on `tasks[]`. Empty until a task
  // actually produces one.
  const activityFeed = buildActivityFeed(taskList, { limit: 30 });

  // ---- unregistered repositories the founder hasn't told the system about
  // yet (cheap, local, read-only filesystem scan; never writes) ----
  let discovery = null;
  try {
    discovery = discoverProjects({ hqRoot, now });
  } catch (error) {
    warnings.push({ code: "discovery-failed", message: error.message });
  }

  // ---- summary ----
  const summary = {
    generatedAt: now.toISOString(),
    projects: projects.length,
    activeProjects: projects.filter((p) => p.status === "active").length,
    projectsNeedingAttention: (company.summary?.needsAttention || 0) + (company.summary?.atRisk || 0),
    agents: activity.summary.total,
    workingAgents: activity.summary.working,
    blockedAgents: activity.summary.blocked,
    needsFounderAgents: activity.summary.needsFounder,
    staleAgents: activity.summary.stale,
    idleAgents: activity.summary.idle,
    openDecisions: (company.openDecisions || decisions).length,
    unmitigatedRisks: company.summary?.unmitigatedRisks ?? (company.risks || []).filter((r) => r.unmitigated).length,
    openPullRequests: companyExternal.reduce((n, e) => n + (e.pullRequests?.length || 0), 0),
    openIssues: companyExternal.reduce((n, e) => n + (e.issues?.length || 0), 0),
    discoveredUnregistered: discovery?.proposals?.length || 0,
  };

  return {
    generatedAt: now.toISOString(),
    founder: FOUNDER,
    headquarters,
    summary,
    projects,
    agents: activity,
    decisions: company.openDecisions || decisions,
    risks: company.risks || [],
    opportunities: company.opportunities || [],
    recommendedActions: company.recommendedActions || [],
    activityFeed,
    external: companyExternal,
    company,
    runtime,
    rosterReconciliation,
    discovery,
    warnings,
  };
}

// ---- helpers ----

function groupTasksByProject(tasks, unifiedProjects) {
  const keyByRepoBase = new Map();
  for (const p of unifiedProjects) {
    if (p.repo) keyByRepoBase.set(basename(p.repo), p.key);
  }
  const known = new Set(unifiedProjects.map((p) => p.key));
  const map = new Map();
  for (const task of tasks) {
    let key = task.project;
    if (!known.has(key)) {
      key = keyByRepoBase.get(task.project) || (task.repo ? keyByRepoBase.get(basename(task.repo)) : null) || task.project;
    }
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(task);
  }
  return map;
}

function deriveTaskDecisions(tasks) {
  return tasks
    .filter((t) => t.blocker?.outcome === "decision-required" || t.decisionCard)
    .map((t) => ({
      kind: "task-blocker",
      id: `${t.id}:${t.blocker?.stage || t.stage || "stage"}`,
      taskId: t.id,
      project: t.project || null,
      statePath: t.statePath || null,
      question: t.decisionCard?.question || t.blocker?.summary || "Founder decision required",
      why: t.decisionCard?.why || `The ${t.blocker?.stage || t.stage || "current"} stage cannot continue without founder direction.`,
      recommendation: t.decisionCard?.recommendation || "Approve the recommended path or provide a concise direction.",
      options: t.decisionCard?.options?.length ? t.decisionCard.options : ["Approve and resume", "Provide direction", "Keep paused"],
      risk: t.risk || null,
      requestedAt: t.blocker?.at || null,
      resumable: Boolean(t.statePath),
    }));
}

function slimTask(task) {
  return {
    id: task.id,
    objective: task.objective || null,
    stage: task.stage || null,
    agent: task.agent || null,
    status: task.status || null,
    branch: task.branch || null,
    createdAt: task.createdAt || null,
    updatedAt: task.updatedAt || null,
  };
}
