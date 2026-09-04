import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { readState, resumeState, writeState } from "../../../factory/lib/task-workflow.mjs";
import { writeHandoff } from "../../../factory/lib/handoff.mjs";
import { listProjectBriefs } from "../../../factory/lib/intel/project-brief.mjs";
import { buildCompanyBriefing } from "../../../factory/lib/intel/founder-briefing.mjs";

const CONTROL_FILE = "control-plane.json";

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

function taskView(path) {
  const state = readState(path);
  const updatedAt = state.updatedAt || statSync(path).mtime.toISOString();
  const dispatch = state.currentDispatch || null;
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
    updatedAt,
    createdAt: state.createdAt,
    branch: state.branch,
    risk: state.task.risk,
    events: (state.events || []).slice(-5).reverse(),
    founderApprovalRequest: state.founderApprovalRequest || null,
    decisionCard: readDecisionCard(state),
  };
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

  const intel = attachProjectIntelligence(root, projects, decisions);
  return {
    projects: intel.projects,
    tasks,
    decisions,
    openDecisions: intel.company?.openDecisions || decisions,
    company: intel.company,
    questions: control.questions.slice(-20).reverse(),
    activity,
  };
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
