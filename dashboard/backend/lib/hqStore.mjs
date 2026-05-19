import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { basename, join } from "path";

const PROJECT_ORDER = [
  "personal-automation",
  "campus-cart",
  "escola-do-real",
  "saas-studio",
  "openclaw-infrastructure",
];

function hqRoot(root) {
  return join(root, "dashboard", "backend", "data", "hq");
}

function projectsRoot(root) {
  return join(hqRoot(root), "projects");
}

function ensureHqDirs(root) {
  mkdirSync(projectsRoot(root), { recursive: true });
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function simpleSlug(value) {
  return /^[a-z0-9][a-z0-9-]*$/.test(String(value || ""));
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function sortByOrder(items) {
  return [...items].sort((a, b) => {
    const ai = PROJECT_ORDER.indexOf(a.id);
    const bi = PROJECT_ORDER.indexOf(b.id);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return String(a.name || a.id).localeCompare(String(b.name || b.id));
  });
}

export function hqPaths(root) {
  const base = hqRoot(root);
  return {
    base,
    projects: projectsRoot(root),
    agents: join(base, "agents.json"),
    tasks: join(base, "tasks.json"),
    sops: join(base, "sops.json"),
    reports: join(base, "reports.json"),
    logs: join(base, "logs.json"),
  };
}

export function readProjects(root) {
  ensureHqDirs(root);
  const dir = projectsRoot(root);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const projects = files.map((file) => {
    const id = basename(file, ".json");
    return { id, ...readJson(join(dir, file), { id }) };
  });
  return sortByOrder(projects);
}

export function readProject(root, id) {
  if (!simpleSlug(id)) throw new Error("Invalid project id");
  const project = readJson(join(projectsRoot(root), `${id}.json`), null);
  if (!project) return null;
  return { id, ...project };
}

export function writeProject(root, id, project) {
  if (!simpleSlug(id)) throw new Error("Invalid project id");
  ensureHqDirs(root);
  const value = { ...project, id };
  writeJson(join(projectsRoot(root), `${id}.json`), value);
  return value;
}

export function readHqCollection(root, name) {
  const paths = hqPaths(root);
  const fallback = name === "tasks" || name === "agents" || name === "sops" || name === "reports" || name === "logs" ? [] : {};
  return readJson(paths[name], fallback);
}

export function writeHqCollection(root, name, value) {
  const paths = hqPaths(root);
  if (!paths[name]) throw new Error("Unknown HQ collection");
  ensureHqDirs(root);
  writeJson(paths[name], ensureArray(value));
  return value;
}

export function buildAgentTree(agents) {
  const byId = new Map(agents.map((a) => [a.id, { ...a, directReports: [] }]));
  for (const agent of byId.values()) {
    if (agent.reportsTo && byId.has(agent.reportsTo)) {
      byId.get(agent.reportsTo).directReports.push(agent.id);
    }
  }
  return [...byId.values()];
}

export function buildCommandCenter({ projects, agents, tasks, reports, logs }) {
  const blockedTasks = tasks.filter((t) => t.status === "Blocked");
  const needsJoao = tasks.filter((t) => t.approvalRequired || t.status === "Review");
  const activeTasks = tasks.filter((t) => !["Done", "Blocked"].includes(t.status));
  const latestReports = reports
    .filter((r) => r.type === "project-ceo-report" || r.type === "daily-brief")
    .slice()
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 6);
  const topPriorities = activeTasks
    .slice()
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
    .slice(0, 8);
  const projectSnapshots = projects.map((project) => ({
    ...project,
    agents: agents.filter((a) => a.projectId === project.id || a.division === project.name),
    tasks: tasks.filter((t) => t.projectId === project.id),
  }));
  const charlesRecommendation =
    blockedTasks.length > 0
      ? "Clear blockers before adding new worker agents. Start with the highest-priority blocked task and decide whether Joao approval or Builder/Nova support is needed."
      : needsJoao.length > 0
        ? "Review the items waiting on Joao, then let Atlas rebalance the task board."
        : "Keep the HQ layer simple today: validate project profiles, assign owners, then run Email Manager as the first real integrated agent.";

  return {
    topPriorities,
    needsJoao,
    blockedTasks,
    latestReports,
    projectSnapshots,
    charlesRecommendation,
    stats: {
      projects: projects.length,
      agents: agents.length,
      tasks: tasks.length,
      needsJoao: needsJoao.length,
      blocked: blockedTasks.length,
      recentLogs: logs.slice(0, 8),
    },
  };
}

function priorityRank(priority) {
  const p = String(priority || "").toLowerCase();
  if (p === "urgent") return 0;
  if (p === "high") return 1;
  if (p === "medium") return 2;
  return 3;
}

export function readHqState(root) {
  const projects = readProjects(root);
  const agents = readHqCollection(root, "agents");
  const tasks = readHqCollection(root, "tasks");
  const sops = readHqCollection(root, "sops");
  const reports = readHqCollection(root, "reports");
  const logs = readHqCollection(root, "logs");
  return {
    projects,
    agents: buildAgentTree(agents),
    tasks,
    sops,
    reports,
    logs,
    commandCenter: buildCommandCenter({ projects, agents, tasks, reports, logs }),
  };
}
