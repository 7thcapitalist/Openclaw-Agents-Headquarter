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

// How much history crosses to the console. Exported so a view can say
// "the most recent N" rather than implying it is everything.
export const ACTIVITY_FEED_LIMIT = 200;
import { readHqConfig } from "./config.mjs";
import { readRepoAwareness, summariseRepoAwareness } from "./github.mjs";
import { readOpenclawRuntime, readOpenclawActivity, reconcileRoster } from "./runtime.mjs";
import { discoverProjects } from "./discovery.mjs";
import { readDeploymentStatus } from "../deploy/status.mjs";
import { readCostEvents, summarizeCostLedger } from "./cost-ledger.mjs";
import { loadPricing, priceCostEvents } from "./cost.mjs";
import { costLedgerPath } from "./budget-snapshot.mjs";

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

  // The two optional enrichments are the whole cost of this function: measured
  // on 2026-09-15, the local build is 17ms, `?runtime=1` adds 3,679ms and
  // `?github=1` adds 3,728ms. The dashboard asks for both, so it was paying
  // 7,544ms — and they ran one after the other despite being unrelated: GitHub
  // is network I/O, the runtime is the openclaw CLI.
  //
  // Kick the runtime read off here and await it where its results are first
  // needed, so it overlaps the GitHub round trips instead of queueing behind
  // them. Nothing between here and there touches `runtime`.
  const runtimePending =
    withRuntime && config.runtime?.enabled !== false
      ? Promise.all([
          readOpenclawRuntime({ exec: runtimeExec, enabled: true }),
          readOpenclawActivity({ exec: runtimeExec, enabled: true, limit: config.runtime.auditLimit }),
        ])
      : null;

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
  // One round trip per project, and they were sequential — two projects meant
  // two waits for no reason. Promise.all preserves order, so `external` reads
  // exactly as it did before.
  let external = [];
  if (withGithub && config.github?.enabled !== false) {
    const withRepo = unifiedProjects.filter((project) => project.github);
    external = await Promise.all(
      withRepo.map(async (project) => {
        const awareness = await readRepoAwareness({
          owner: project.github.owner,
          repo: project.github.repo,
          exec,
          enabled: config.github.enabled !== false,
          limits: { commits: config.github.commitLimit, prs: config.github.prLimit, issues: config.github.issueLimit },
        });
        return { project: project.key, ...awareness, summary: summariseRepoAwareness(awareness) };
      })
    );
  }
  const externalByKey = new Map(external.map((e) => [e.project, e]));
  const companyExternal = external.filter((e) => e.project !== headquartersEntry?.key);

  // Per-project spend, from the same priced ledger operations and budgets read,
  // so all three agree by construction rather than by coincidence.
  const spendByProject = new Map();
  try {
    const ledger = summarizeCostLedger(priceCostEvents(readCostEvents(costLedgerPath(hqRoot)), loadPricing(hqRoot)).events);
    for (const [key, bucket] of Object.entries(ledger.byProject || {})) {
      spendByProject.set(key, { costMicros: bucket.costMicros, unpricedEvents: bucket.unpricedEvents, events: bucket.events });
    }
  } catch (error) {
    warnings.push({ code: "project-spend-unavailable", message: String(error?.message || error).slice(0, 200) });
  }

  // ---- final project rows (company projects only — never the Headquarters) ----
  const projects = companyProjects.map((p) => {
    const projectTasks = tasksByProject.get(p.key) || [];
    const deployment = readDeploymentStatus({
      hqRoot,
      projectKey: p.key,
      onError: (error) => warnings.push({ code: `deployment-status-failed:${p.key}`, message: error.message }),
    });
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
      // The FULL status vocabulary, not just the two statuses that happen to
      // have their own arrays.
      //
      // `activeTasks` and `blockedTasks` cover `active` and `blocked` only, so
      // lifemaxing rendered as "0 active, 0 blocked, 3 tasks" — reading as an
      // idle project when in fact two had shipped and one had failed. Nothing
      // was wrong with the join; the vocabulary was simply incomplete, and a
      // console cannot show counts it is never given.
      taskCounts: countByStatus(projectTasks),
      // What this project has cost, joined from the same ledger the budgets and
      // operations panels read. A project row with no spend on it forced the
      // console to either omit cost per project or re-derive it.
      spend: spendByProject.get(p.key) || null,
      externalSummary: externalByKey.get(p.key)?.summary || null,
      intelligenceWarnings: p.intelligence?.warnings || [],
      deployment,
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
  if (runtimePending) {
    // Started before the GitHub reads above, so by now it has usually resolved.
    [runtime, runtimeActivity] = await runtimePending;
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
  // The most recent 200. Thirty was a third of one screen of history for a
  // factory with 1,272 recorded events, and the console had no way to see
  // further back. At ~492 bytes a record this is ~98 KB, 2.3% of the 4 MiB cap.
  const activityFeed = buildActivityFeed(taskList, { limit: ACTIVITY_FEED_LIMIT });

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

// Statuses from which no founder answer can change anything. `merge-ready` is
// deliberately absent: those carry deferred decisions, handled below.
const TERMINAL_TASK = new Set(["failed", "merged", "complete", "completed"]);

function deriveTaskDecisions(tasks) {
  // A decision on a task that has already stopped is not a decision, it is a
  // record. task-ca3c3cdf was closed on 2026-09-15 and kept its blocker, so the
  // console went on offering its two options; the founder clicked one, the
  // intent was enqueued and claimed, and the worker correctly refused with
  // "Task is not waiting for a founder decision." The button looked live
  // because this filter only ever looked at the blocker, never at whether the
  // task was still running.
  const blocked = tasks
    .filter((t) => !TERMINAL_TASK.has(String(t.status || "")))
    // Cancelling an objective leaves its nodes holding their blockers; see
    // cancelledObjectiveTaskIds in founderControlPlane.mjs.
    .filter((t) => !t.objectiveCancelled)
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
  // An answered deferred decision is settled, not pending: `founderResponse`
  // takes it out of the published inbox the same way it leaves the dashboard's.
  const deferred = tasks
    .filter((t) => !t.objectiveCancelled && ["merge-ready", "merged"].includes(t.status) && Array.isArray(t.deferredDecisions))
    .flatMap((t) => t.deferredDecisions.filter((d) => !d.founderResponse && d.escalate === true).map((d) => ({
      kind: "post-task-decision",
      id: `${t.id}:${d.id}`,
      taskId: t.id,
      project: t.project || null,
      statePath: t.statePath || null,
      question: d.question,
      why: d.why,
      recommendation: d.recommendation || "The agents completed the safe work; choose the option that best matches your intent.",
      options: d.options,
      risk: t.risk || null,
      requestedAt: d.requestedAt || null,
      resumable: false,
    })));
  return [...blocked, ...deferred];
}

// Every status the factory can put a task in, counted. Statuses the workflow
// never emits stay absent rather than being reported as zero, so a new status
// shows up as itself instead of being silently dropped.
export function countByStatus(tasks) {
  const counts = {};
  for (const task of tasks) {
    const status = String(task?.status || "unknown");
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
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
    elapsedMs: Number.isFinite(task.elapsedMs) ? task.elapsedMs : null,
    lastHandoff: task.lastHandoff || null,
    lastResult: task.lastResult || null,
  };
}
