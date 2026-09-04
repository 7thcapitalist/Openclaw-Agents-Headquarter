// The company state — the single object that answers
// "what is happening in my company?"
//
// It is composition, not a new system. Projects come from the unified registry
// (which already folds in the intelligence brief). The company roll-up reuses
// intel/founder-briefing.mjs. Agent activity reuses hq/activity.mjs. External
// reality is read-only GitHub awareness. Nothing here writes anything.

import { basename } from "path";
import { buildCompanyBriefing } from "../intel/founder-briefing.mjs";
import { listCompanyProjects } from "./registry.mjs";
import { listAgents } from "./agents.mjs";
import { buildAgentActivity } from "./activity.mjs";
import { readHqConfig } from "./config.mjs";
import { readRepoAwareness, summariseRepoAwareness } from "./github.mjs";

const FOUNDER = { name: "João Vitor", headquarters: "OpenClaw Agents Headquarter" };

/**
 * @param {object}   input
 * @param {string}   input.hqRoot
 * @param {Array}   [input.tasks]          normalised factory task views (see hq/activity.mjs)
 * @param {Array}   [input.hqProjects]     dashboard HQ project rows (optional enrichment)
 * @param {Array}   [input.taskDecisions]  pre-computed founder decisions (optional; else derived from tasks)
 * @param {boolean} [input.withGithub=false] fetch read-only GitHub awareness for projects that declare it
 * @param {Function}[input.exec]           gh runner, injected for tests
 * @param {Date}    [input.now]
 * @returns {Promise<object>}
 */
export async function buildCompanyState({
  hqRoot,
  tasks = [],
  hqProjects = [],
  taskDecisions = null,
  withGithub = false,
  exec = undefined,
  now = new Date(),
}) {
  const warnings = [];
  const config = readHqConfig(hqRoot);
  const taskList = Array.isArray(tasks) ? tasks.filter(Boolean) : [];

  // ---- projects (unified registry + intelligence) ----
  const { projects: unifiedProjects, warnings: registryWarnings } = listCompanyProjects({ hqRoot, hqProjects, now });
  warnings.push(...registryWarnings);

  const tasksByProject = groupTasksByProject(taskList, unifiedProjects);
  const decisions = taskDecisions || deriveTaskDecisions(taskList);

  // Shape projects for the company briefing (id/name/tasks/status).
  const briefingProjectRows = unifiedProjects.map((p) => ({
    id: p.key,
    name: p.name,
    mission: p.mission,
    status: p.status,
    tasks: tasksByProject.get(p.key) || [],
    taskCount: (tasksByProject.get(p.key) || []).length,
    stage: (tasksByProject.get(p.key) || []).find((t) => t.status === "active")?.stage || null,
    currentPhase: p.dashboard?.currentPhase || null,
  }));
  const briefs = unifiedProjects.map((p) => p.intelligence).filter(Boolean);

  let company;
  try {
    company = buildCompanyBriefing({ briefs, projects: briefingProjectRows, taskDecisions: decisions, now });
  } catch (error) {
    warnings.push({ code: "company-briefing-failed", message: error.message });
    company = { projects: [], openDecisions: decisions, risks: [], opportunities: [], recommendedActions: [], summary: null };
  }
  const healthByKey = new Map((company.projects || []).map((p) => [p.id, p.health]));

  // ---- external world (read-only GitHub) ----
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

  // ---- final project rows ----
  const projects = unifiedProjects.map((p) => {
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
    };
  });

  // ---- agents ----
  const { agents: agentRows, warnings: agentWarnings } = listAgents(hqRoot);
  warnings.push(...agentWarnings);
  const activity = buildAgentActivity({ agents: agentRows, tasks: taskList, now });

  // ---- summary ----
  const summary = {
    generatedAt: now.toISOString(),
    projects: projects.length,
    activeProjects: projects.filter((p) => p.status === "active").length,
    projectsNeedingAttention: (company.summary?.needsAttention || 0) + (company.summary?.atRisk || 0),
    agents: activity.summary.total,
    workingAgents: activity.summary.working,
    blockedAgents: activity.summary.blocked,
    idleAgents: activity.summary.idle,
    openDecisions: (company.openDecisions || decisions).length,
    unmitigatedRisks: company.summary?.unmitigatedRisks ?? (company.risks || []).filter((r) => r.unmitigated).length,
    openPullRequests: external.reduce((n, e) => n + (e.pullRequests?.length || 0), 0),
    openIssues: external.reduce((n, e) => n + (e.issues?.length || 0), 0),
  };

  return {
    generatedAt: now.toISOString(),
    founder: FOUNDER,
    summary,
    projects,
    agents: activity,
    decisions: company.openDecisions || decisions,
    risks: company.risks || [],
    opportunities: company.opportunities || [],
    recommendedActions: company.recommendedActions || [],
    external,
    company,
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
    updatedAt: task.updatedAt || null,
  };
}
