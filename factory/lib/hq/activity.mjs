// Agent activity awareness — "what are my workers doing?"
//
// Pure. It joins the committed agent registry to the live factory task views
// (already discovered by the Founder Control Plane) so the founder can see, per
// worker: current project, current task, last activity, and whether it is
// blocked or waiting. It invents no sensor system and scrapes no processes —
// every signal is a structured task-state event that already exists.

/**
 * @param {object} input
 * @param {Array}  input.agents  normalised agent rows (from hq/agents.mjs listAgents().agents)
 * @param {Array} [input.tasks]  normalised factory task views
 *   ({ id, objective, project, stage, agent, agentStatus, status, blocker, updatedAt, branch })
 * @param {Date} [input.now]
 * @returns {{ agents: Array, unassignedTasks: Array, summary: object }}
 */
export function buildAgentActivity({ agents = [], tasks = [], now = new Date() }) {
  const taskList = Array.isArray(tasks) ? tasks.filter(Boolean) : [];

  // Match a task's actor to a registry agent by id or by harness agent id(s).
  const byId = new Map(agents.map((a) => [a.id, a]));
  const byHarness = new Map();
  for (const a of agents) {
    for (const hid of a.harnessAgentIds || (a.harnessAgentId ? [a.harnessAgentId] : [])) {
      if (!byHarness.has(hid)) byHarness.set(hid, a);
    }
  }
  const matchAgent = (actor) => (actor ? byId.get(actor) || byHarness.get(actor) || null : null);

  const tasksByAgent = new Map();
  const unassignedTasks = [];
  for (const task of taskList) {
    const agent = matchAgent(task.agent);
    if (!agent) {
      if (task.agent) unassignedTasks.push({ ...slimTask(task), actor: task.agent });
      continue;
    }
    if (!tasksByAgent.has(agent.id)) tasksByAgent.set(agent.id, []);
    tasksByAgent.get(agent.id).push(task);
  }

  const enrichedAgents = agents.map((agent) => {
    const agentTasks = (tasksByAgent.get(agent.id) || [])
      .slice()
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

    const activeTask = agentTasks.find((t) => t.status === "active") || agentTasks[0] || null;
    const blockedTask = agentTasks.find((t) => t.status === "blocked" || t.blocker);
    const waiting = Boolean(activeTask && ["waiting", "running", "dispatched"].includes(activeTask.agentStatus));

    let status = agent.status || "idle";
    if (blockedTask) status = "blocked";
    else if (activeTask) status = "working";
    else if (agentTasks.length === 0 && status === "working") status = "idle";

    return {
      id: agent.id,
      name: agent.name,
      kind: agent.kind,
      role: agent.role,
      capabilities: agent.capabilities,
      registryStatus: agent.status || "idle",
      status,
      currentProject: activeTask?.project || agent.currentProject || null,
      currentTask: activeTask
        ? { id: activeTask.id, objective: activeTask.objective || null, stage: activeTask.stage || null, project: activeTask.project || null }
        : null,
      waiting,
      blocked: Boolean(blockedTask),
      blocker: blockedTask ? blockerText(blockedTask.blocker) : null,
      lastActivityAt: agentTasks[0]?.updatedAt || null,
      tasks: agentTasks.map(slimTask),
    };
  });

  const summary = {
    total: enrichedAgents.length,
    working: enrichedAgents.filter((a) => a.status === "working").length,
    blocked: enrichedAgents.filter((a) => a.status === "blocked").length,
    idle: enrichedAgents.filter((a) => a.status === "idle").length,
    offline: enrichedAgents.filter((a) => a.status === "offline" || a.status === "disabled").length,
    waiting: enrichedAgents.filter((a) => a.waiting).length,
    unassignedTasks: unassignedTasks.length,
  };

  return { agents: enrichedAgents, unassignedTasks, summary };
}

function slimTask(task) {
  return {
    id: task.id,
    project: task.project || null,
    stage: task.stage || null,
    status: task.status || null,
    branch: task.branch || null,
    updatedAt: task.updatedAt || null,
  };
}

function blockerText(blocker) {
  if (!blocker) return null;
  if (typeof blocker === "string") return blocker;
  return blocker.summary || blocker.outcome || blocker.reason || "blocked";
}
