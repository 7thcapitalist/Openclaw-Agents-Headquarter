// Agent activity awareness — "what are my workers doing?"
//
// Pure. It joins the committed agent registry to the live factory task views
// (already discovered by the Founder Control Plane) and, when supplied, real
// OpenClaw runtime activity (hq/runtime.mjs `readOpenclawActivity`) so the
// founder can see, per worker: current project, current task, whether the
// underlying OpenClaw run is actually alive right now, when it was created
// versus when it last did anything, and whether it is blocked, waiting on the
// founder, or simply stale. It invents no sensor system and scrapes no
// processes — every signal is either a structured task-state event or a real
// OpenClaw audit record that already exists.
//
// Task age is deliberately NOT treated as evidence of active work: a task
// created 21 hours ago whose last real event was 16 hours ago is reported as
// STALE, not "working for 21 hours" (see `stale` / `staleAfterMinutes`).

const TERMINAL_STATUSES = new Set(["merge-ready", "merged"]);

/**
 * @param {object} input
 * @param {Array}  input.agents  normalised agent rows (from hq/agents.mjs listAgents().agents)
 * @param {Array} [input.tasks]  normalised factory task views
 *   ({ id, objective, project, stage, agent, agentStatus, status, blocker, createdAt, updatedAt, branch })
 * @param {Date}  [input.now]
 * @param {object}[input.runtime]  hq/runtime.mjs readOpenclawActivity() result (byAgent map), optional
 * @param {number}[input.staleAfterMinutes=120]  non-terminal task/agent with no activity past this is STALE
 * @returns {{ agents: Array, unassignedTasks: Array, summary: object }}
 */
export function buildAgentActivity({ agents = [], tasks = [], now = new Date(), runtime = null, staleAfterMinutes = 120 }) {
  const taskList = Array.isArray(tasks) ? tasks.filter(Boolean) : [];
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const staleMs = Math.max(1, Number(staleAfterMinutes) || 120) * 60 * 1000;
  const runtimeByAgent = (runtime && runtime.byAgent) || {};

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
    // A blocker specifically awaiting a founder decision is the most urgent
    // shape of "blocked" — surfaced as its own flag so the dashboard can show
    // "NEEDS FOUNDER" without changing what `status` has always meant.
    const needsFounder = Boolean(blockedTask?.blocker?.outcome === "decision-required");

    const runtimeAgentId = agent.runtimeAgentId || agent.harnessAgentIds?.[0] || null;
    const rt = runtimeAgentId ? runtimeByAgent[runtimeAgentId] || null : null;
    // Two independent, both-real signals of "is this agent actually doing
    // something right now": the task dispatch's own in-flight marker, and the
    // real OpenClaw audit log. Either is sufficient.
    const dispatchRunning = activeTask?.agentStatus === "running";
    const runtimeRunning = Boolean(rt?.running);
    const workingNow = dispatchRunning || runtimeRunning;
    const waiting = Boolean(activeTask && ["waiting", "running", "dispatched"].includes(activeTask.agentStatus));

    // "Last real activity" is the more recent of the task-state timestamp and
    // the real OpenClaw runtime timestamp — never the task's creation time.
    const taskActivityMs = parseTime(activeTask?.updatedAt);
    const runtimeActivityMs = parseTime(rt?.lastActivityAt);
    const lastActivityMs = maxOf(taskActivityMs, runtimeActivityMs);
    const lastActivityAt = lastActivityMs != null ? new Date(lastActivityMs).toISOString() : null;
    const nonTerminal = Boolean(activeTask && !TERMINAL_STATUSES.has(activeTask.status));
    const stale = Boolean(nonTerminal && !workingNow && lastActivityMs != null && nowMs - lastActivityMs > staleMs);

    let status;
    if (blockedTask) status = "blocked";
    else if (workingNow) status = "working";
    else if (stale) status = "stale";
    else if (nonTerminal) status = "waiting";
    else if (rt && !rt.running && rt.lastRun?.status === "failed") status = "failed";
    else if (agentTasks.length && agentTasks.every((t) => TERMINAL_STATUSES.has(t.status))) status = "completed";
    else status = agent.status && agent.status !== "working" ? agent.status : "idle";

    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      kind: agent.kind,
      harness: agent.harness || null,
      harnessAvailable: agent.harnessAvailable !== false,
      harnessFallback: agent.harnessFallback || null,
      runtimeAgentId,
      runtimeResolved: Boolean(rt),
      capabilities: agent.capabilities,
      registryStatus: agent.status || "idle",
      status,
      currentProject: activeTask?.project || agent.currentProject || null,
      currentTask: activeTask
        ? {
            id: activeTask.id,
            objective: activeTask.objective || null,
            stage: activeTask.stage || null,
            project: activeTask.project || null,
            status: activeTask.status || null,
            createdAt: activeTask.createdAt || null,
          }
        : null,
      running: workingNow,
      waiting,
      blocked: Boolean(blockedTask),
      needsFounder,
      stale,
      blocker: blockedTask ? blockerText(blockedTask.blocker) : null,
      taskCreatedAt: activeTask?.createdAt || null,
      lastActivityAt,
      lastRun: rt?.lastRun || null,
      tasks: agentTasks.map(slimTask),
    };
  });

  const summary = {
    total: enrichedAgents.length,
    working: enrichedAgents.filter((a) => a.status === "working").length,
    blocked: enrichedAgents.filter((a) => a.status === "blocked").length,
    needsFounder: enrichedAgents.filter((a) => a.needsFounder).length,
    waiting: enrichedAgents.filter((a) => a.waiting).length,
    waitingStatus: enrichedAgents.filter((a) => a.status === "waiting").length,
    stale: enrichedAgents.filter((a) => a.status === "stale").length,
    failed: enrichedAgents.filter((a) => a.status === "failed").length,
    completed: enrichedAgents.filter((a) => a.status === "completed").length,
    idle: enrichedAgents.filter((a) => a.status === "idle").length,
    offline: enrichedAgents.filter((a) => a.status === "offline" || a.status === "disabled").length,
    unassignedTasks: unassignedTasks.length,
  };

  return { agents: enrichedAgents, unassignedTasks, summary };
}

// A real "recent activity" stream — every task passed in already carries its
// own last-N structured workflow events (Founder Control Plane's `taskView()`
// / `discoverFactoryTasks()`). This only flattens and sorts what is already
// there; it senses nothing new and returns an empty list when no task has
// ever produced an event.
export function buildActivityFeed(tasks = [], { limit = 30 } = {}) {
  const items = [];
  for (const task of tasks || []) {
    for (const event of task?.events || []) {
      if (!event?.at) continue;
      items.push({
        at: event.at,
        type: event.type || "event",
        stage: event.stage || task.stage || null,
        actor: event.actor || task.agent || null,
        outcome: event.outcome || null,
        direction: event.direction || null,
        taskId: task.id,
        project: task.project || null,
        objective: task.objective || null,
      });
    }
  }
  return items.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}

function slimTask(task) {
  return {
    id: task.id,
    project: task.project || null,
    stage: task.stage || null,
    status: task.status || null,
    branch: task.branch || null,
    createdAt: task.createdAt || null,
    updatedAt: task.updatedAt || null,
  };
}

function blockerText(blocker) {
  if (!blocker) return null;
  if (typeof blocker === "string") return blocker;
  return blocker.summary || blocker.outcome || blocker.reason || "blocked";
}

function parseTime(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function maxOf(...values) {
  const finite = values.filter((v) => Number.isFinite(v));
  return finite.length ? Math.max(...finite) : null;
}
