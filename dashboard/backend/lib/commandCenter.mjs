import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { scanAgents, preferredMarkdownOutput, tailLog } from "./scan.mjs";
import { agentDir, agentKey, pm2Name } from "./paths.mjs";
import { pm2StatusMap } from "./pm2.mjs";
import { computeAgentHealth, splitAgentKey } from "./health.mjs";
import { parseArtifactsJson } from "./runArtifacts.mjs";

const QUICK_ACTIONS_TEMPLATE = [
  {
    id: "run-briefing",
    label: "Run email briefing",
    description: "Trigger the email manager wrapper (OpenClaw cron job).",
    action: "run",
    project: "personal-automation",
    agentId: "email-manager",
    supportsWait: true,
  },
  {
    id: "health",
    label: "OpenClaw health",
    description: "Runs openclaw health on the mini PC (needs CLI + gateway).",
    action: "health",
  },
  {
    id: "create-agent",
    label: "Create new agent",
    description: "Use the scaffold script on the mini PC.",
    action: "create",
    shell: "cd ~/agent-lab && ./scripts/create-agent.sh <project-key> <agent-id>",
  },
];

/**
 * @param {string} started
 * @param {string | null} ended
 */
export function runDurationMs(started, ended) {
  const a = Date.parse(started);
  const b = ended ? Date.parse(ended) : NaN;
  if (!Number.isFinite(a)) return null;
  if (!Number.isFinite(b)) return null;
  return Math.max(0, b - a);
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} root
 */
export async function buildEnrichedAgents(db, root) {
  const rows = scanAgents(root);
  const pm2 = await pm2StatusMap();
  const lastRuns = db
    .prepare(
      `SELECT ar.agent_key AS agent_key, ar.status AS status, ar.started_at AS started_at,
              ar.ended_at AS ended_at, ar.error_message AS error_message, ar.summary AS summary,
              ar.id AS run_id, ar.output_file AS output_file, ar.artifacts_json AS artifacts_json
       FROM agent_runs ar
       INNER JOIN (
         SELECT agent_key, MAX(id) AS mid FROM agent_runs GROUP BY agent_key
       ) last ON ar.agent_key = last.agent_key AND ar.id = last.mid`
    )
    .all();
  const lastByKey = Object.fromEntries(lastRuns.map((r) => [r.agent_key, r]));

  return rows.map((r) => {
    const key = agentKey(r.project, r.id);
    const pm = pm2[pm2Name(r.project, r.id)];
    const lr = lastByKey[key] || null;
    const lastArtifacts = lr ? parseArtifactsJson(lr.artifacts_json) : [];
    const dir = r.path;
    const mdOut = preferredMarkdownOutput(dir);
    let outputPreview = null;
    if (mdOut && existsSync(mdOut.path)) {
      try {
        const chunk = readFileSync(mdOut.path, "utf8").slice(0, 400);
        const firstLine = chunk.split("\n").find((l) => l.trim()) || "";
        outputPreview = {
          fileName: mdOut.name,
          title: firstLine.replace(/^#+\s*/, "").slice(0, 120),
          snippet: chunk.slice(0, 220),
        };
      } catch {
        outputPreview = { fileName: mdOut.name, title: mdOut.name, snippet: "" };
      }
    }
    const health = computeAgentHealth({
      config: r.config,
      lastRun: lr,
      pm2: pm || null,
    });
    return {
      project: r.project,
      id: r.id,
      agentKey: key,
      config: r.config,
      pm2: pm ? { status: pm.status, pm_uptime: pm.pm_uptime } : null,
      lastRun: lr
        ? {
            status: lr.status,
            started_at: lr.started_at,
            ended_at: lr.ended_at,
            error_message: lr.error_message,
            summary: lr.summary,
            run_id: lr.run_id,
            output_file: lr.output_file,
            duration_ms: runDurationMs(lr.started_at, lr.ended_at),
            artifacts: lastArtifacts,
            artifactsPreview:
              lastArtifacts.length > 0
                ? lastArtifacts.map((x) => x.title).join(" · ")
                : null,
          }
        : null,
      health,
      lastMarkdownOutput: mdOut
        ? { name: mdOut.name, mtime: mdOut.mtime, preview: outputPreview }
        : null,
    };
  });
}

/**
 * @param {Awaited<ReturnType<typeof buildEnrichedAgents>>} agents
 */
export function buildNeedsAttention(agents) {
  const items = [];
  for (const a of agents) {
    if (a.health.health === "failed") {
      items.push({
        kind: "failed",
        project: a.project,
        id: a.id,
        name: a.config.name || a.id,
        message: a.health.details,
        agentKey: a.agentKey,
      });
    } else if (a.health.health === "warning" && a.health.stale) {
      items.push({
        kind: a.lastRun ? "stale" : "never-run",
        project: a.project,
        id: a.id,
        name: a.config.name || a.id,
        message: a.health.details,
        agentKey: a.agentKey,
      });
    }
  }
  return items.slice(0, 20);
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {number} limit
 */
export function recentRunsRows(db, limit = 25) {
  const rows = db
    .prepare(
      `SELECT id, agent_key, status, started_at, ended_at, summary, output_file, error_message, artifacts_json
       FROM agent_runs ORDER BY id DESC LIMIT ?`
    )
    .all(limit);
  return rows.map((r) => {
    const parts = splitAgentKey(r.agent_key);
    const artifacts = parseArtifactsJson(r.artifacts_json);
    return {
      id: r.id,
      agent_key: r.agent_key,
      project: parts?.project,
      agentId: parts?.id,
      status: r.status,
      started_at: r.started_at,
      ended_at: r.ended_at,
      summary: r.summary,
      output_file: r.output_file,
      error_message: r.error_message,
      duration_ms: runDurationMs(r.started_at, r.ended_at),
      artifacts,
      artifactsPreview:
        artifacts.length > 0
          ? artifacts.map((x) => x.title).join(" · ")
          : null,
    };
  });
}

/**
 * @param {Awaited<ReturnType<typeof buildEnrichedAgents>>} agents
 */
export function buildProjectSummary(agents) {
  const map = new Map();
  for (const a of agents) {
    if (!map.has(a.project)) {
      map.set(a.project, {
        key: a.project,
        count: 0,
        healthy: 0,
        warning: 0,
        failed: 0,
        inactive: 0,
      });
    }
    const s = map.get(a.project);
    s.count += 1;
    if (a.health.health === "healthy") s.healthy += 1;
    else if (a.health.health === "failed") s.failed += 1;
    else if (a.health.health === "inactive") s.inactive += 1;
    else s.warning += 1;
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * @param {Awaited<ReturnType<typeof buildEnrichedAgents>>} agents
 * @param {ReturnType<typeof recentRunsRows>} recent
 */
export function buildHomeCards(agents, recent) {
  const total = agents.length;
  const runningPm2 = agents.filter((a) => a.pm2?.status === "online").length;
  const failedAgents = agents.filter((a) => a.health.health === "failed").length;
  let lastRunAt = null;
  for (const r of recent) {
    if (r.ended_at && r.status !== "running") {
      lastRunAt = r.ended_at;
      break;
    }
  }
  return { totalAgents: total, runningPm2, failedAgents, lastRunAt };
}

/**
 * @param {Awaited<ReturnType<typeof buildEnrichedAgents>>} agents
 */
export function buildQuickActions(agents) {
  return QUICK_ACTIONS_TEMPLATE.map((a) => {
    if (a.action === "run") {
      const exists = agents.some(
        (x) => x.project === a.project && x.id === a.agentId
      );
      return { ...a, disabled: !exists };
    }
    return { ...a, disabled: false };
  });
}
