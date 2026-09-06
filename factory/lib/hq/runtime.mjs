// OpenClaw runtime awareness — the real source of truth for "which agents exist
// and what powers them".
//
// `openclaw agents list --json` reports the isolated agent workspaces the
// runtime actually has (id, identity name, underlying model). The Integration
// Layer joins that to the committed workforce roster (factory/agents.json) so
// the dashboard shows real employees, not invented ones.
//
// Read-only. Guarded exactly like hq/github.mjs: an offline or missing `openclaw`
// CLI degrades this one section, never the whole company view. `exec` is
// injectable for tests.

import { execFile } from "child_process";

function defaultExec(args, { timeoutMs = 12000 } = {}) {
  return new Promise((resolvePromise) => {
    execFile("openclaw", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolvePromise({
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
      });
    });
  });
}

/**
 * @param {object}   [input]
 * @param {Function} [input.exec]      (args:string[]) => Promise<{stdout,stderr,code}>
 * @param {boolean}  [input.enabled=true]
 * @returns {Promise<{ available:boolean, agents:Array, error:(string|null), checkedAt:string }>}
 *   agents: [{ id, identity, model, workspace }]
 */
export async function readOpenclawRuntime({ exec = defaultExec, enabled = true } = {}) {
  const checkedAt = new Date().toISOString();
  if (!enabled) return { available: false, agents: [], error: "runtime awareness disabled", checkedAt };

  let res;
  try {
    res = await exec(["agents", "list", "--json"]);
  } catch (error) {
    return { available: false, agents: [], error: error.message || String(error), checkedAt };
  }
  if (!res || res.code !== 0) {
    return {
      available: false,
      agents: [],
      error: trim(res?.stderr) || `openclaw exited ${res?.code ?? "?"}`,
      checkedAt,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(res.stdout || "[]");
  } catch (error) {
    return { available: false, agents: [], error: `unparseable output: ${error.message}`, checkedAt };
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.agents) ? parsed.agents : [];

  const agents = list
    .filter((a) => a && typeof a === "object" && a.id)
    .map((a) => ({
      id: String(a.id),
      identity: a.identityName || a.name || String(a.id),
      model: cleanModel(a.model),
      workspace: a.workspace || null,
    }));

  return { available: true, agents, error: null, checkedAt };
}

// Strip the "@<credential-profile>" suffix the CLI appends: keeps
// "openai/gpt-5.6-sol", drops "@openai:setup-...".
export function cleanModel(model) {
  if (!model || typeof model !== "string") return null;
  return model.split("@")[0].trim() || null;
}

// Index the runtime agents by id for O(1) lookup from the roster.
export function runtimeIndex(runtime) {
  const map = new Map();
  for (const a of runtime?.agents || []) map.set(a.id, a);
  return map;
}

// Reconcile the committed workforce roster against the live OpenClaw agent
// list: which roles resolve to a real, currently-configured OpenClaw agent,
// which don't (a role names a runtimeAgentId OpenClaw has never heard of),
// and which live OpenClaw agents have no organizational role at all. This is
// read-only reconciliation — it changes neither file.
export function reconcileRoster(agents, runtime) {
  const index = runtimeIndex(runtime);
  const claimed = new Set();
  const roles = (agents || []).map((agent) => {
    const id = agent.runtimeAgentId;
    const match = id ? index.get(id) || null : null;
    if (match) claimed.add(id);
    return { agentId: agent.id, role: agent.role, runtimeAgentId: id || null, resolved: Boolean(match), runtime: match };
  });
  const unmapped = (runtime?.agents || []).filter((a) => !claimed.has(a.id));
  return { roles, unmapped, available: Boolean(runtime?.available) };
}

/**
 * Real, per-agent activity derived from OpenClaw's own audit log
 * (`openclaw audit --json --kind agent_run`) — the authoritative record of
 * every agent run OpenClaw itself executed, with real timestamps and real
 * outcomes. This is not invented: it is a read of OpenClaw's own execution
 * history, keyed by the same agent ids `openclaw agents list` reports.
 *
 * @param {object}   [input]
 * @param {Function} [input.exec]
 * @param {boolean}  [input.enabled=true]
 * @param {number}   [input.limit=200]  how many recent agent_run events to read
 * @returns {Promise<{available:boolean, events:Array, byAgent:object, error:(string|null), checkedAt:string}>}
 */
export async function readOpenclawActivity({ exec = defaultExec, enabled = true, limit = 200 } = {}) {
  const checkedAt = new Date().toISOString();
  if (!enabled) return { available: false, events: [], byAgent: {}, error: "runtime activity disabled", checkedAt };

  let res;
  try {
    res = await exec(["audit", "--json", "--kind", "agent_run", "--limit", String(Math.max(1, Math.min(500, limit)))]);
  } catch (error) {
    return { available: false, events: [], byAgent: {}, error: error.message || String(error), checkedAt };
  }
  if (!res || res.code !== 0) {
    return { available: false, events: [], byAgent: {}, error: trim(res?.stderr) || `openclaw exited ${res?.code ?? "?"}`, checkedAt };
  }

  let parsed;
  try {
    parsed = JSON.parse(res.stdout || "{}");
  } catch (error) {
    return { available: false, events: [], byAgent: {}, error: `unparseable output: ${error.message}`, checkedAt };
  }
  const raw = Array.isArray(parsed?.events) ? parsed.events : [];
  const events = raw.map(normalizeAuditEvent).filter(Boolean).sort((a, b) => b.at - a.at);
  return { available: true, events, byAgent: deriveAgentActivity(events), error: null, checkedAt };
}

export function normalizeAuditEvent(e) {
  if (!e || typeof e !== "object" || !e.agentId || typeof e.occurredAt !== "number") return null;
  return {
    at: e.occurredAt,
    agentId: String(e.agentId),
    runId: e.runId || e.eventId || null,
    action: e.action || null,
    status: e.status || null,
    errorCode: e.errorCode || null,
    sessionKey: e.sessionKey || null,
  };
}

// Group normalized agent_run events by agent, then by run: a run with a
// "started" event and no later "finished" event for the same runId is
// treated as currently running. This is the one place "is this agent working
// right now" gets decided from real data instead of task-state inference.
export function deriveAgentActivity(events) {
  const byAgent = new Map();
  for (const e of events || []) {
    if (!byAgent.has(e.agentId)) byAgent.set(e.agentId, []);
    byAgent.get(e.agentId).push(e);
  }
  const result = {};
  for (const [agentId, agentEvents] of byAgent) {
    const byRun = new Map();
    for (const e of agentEvents) {
      const key = e.runId || `no-run:${e.at}`;
      if (!byRun.has(key)) byRun.set(key, []);
      byRun.get(key).push(e);
    }
    const runs = [...byRun.entries()]
      .map(([runId, runEvents]) => {
        const sorted = runEvents.slice().sort((a, b) => a.at - b.at);
        const started = sorted.find((e) => e.action === "agent.run.started");
        const finished = sorted.slice().reverse().find((e) => e.action === "agent.run.finished");
        const last = sorted[sorted.length - 1];
        return {
          runId,
          startedAt: started ? new Date(started.at).toISOString() : null,
          finishedAt: finished ? new Date(finished.at).toISOString() : null,
          status: finished ? finished.status : "running",
          errorCode: finished?.errorCode || null,
          lastAt: last.at,
        };
      })
      .sort((a, b) => b.lastAt - a.lastAt);
    const current = runs[0] || null;
    result[agentId] = {
      running: current ? current.status === "running" : false,
      lastRun: current,
      lastActivityAt: current ? new Date(current.lastAt).toISOString() : null,
      recentRuns: runs.slice(0, 5),
    };
  }
  return result;
}

function trim(text) {
  return String(text || "").split("\n").filter(Boolean).slice(0, 2).join(" ").slice(0, 300);
}
