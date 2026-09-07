// "Is the factory actually doing anything on its own — and what's just
// configured but not running?" Read-only. Honest by construction: scheduled
// work comes from `openclaw cron list`, live work is passed in by the caller,
// and configured-not-running is a static check of factory.config.json against
// what's scheduled.

import { execFile } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

function defaultExec(args, { timeoutMs = 12000 } = {}) {
  return new Promise((resolvePromise) => {
    execFile("openclaw", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolvePromise({ stdout: String(stdout || ""), code: error ? 1 : 0 });
    });
  });
}

function scheduleLabel(schedule) {
  if (!schedule) return "unknown";
  if (schedule.kind === "every" && schedule.everyMs) {
    const m = Math.round(schedule.everyMs / 60000);
    if (m === 10080) return "weekly";
    if (m === 1440) return "daily";
    if (m % 1440 === 0 && m >= 2880) return `every ${m / 1440}d`;
    if (m % 60 === 0 && m >= 60) return `every ${m / 60}h`;
    return `every ${m}m`;
  }
  if (schedule.kind === "cron") {
    const expr = schedule.expr || schedule.expression;
    return expr ? `cron ${expr}` : "cron";
  }
  return schedule.kind || "unknown";
}

/**
 * @param {object}  input
 * @param {string}  input.hqRoot
 * @param {Function}[input.exec]      injected `openclaw` runner (tests)
 * @param {object} [input.running]    { objectives, tasks, jobs } live counts from the caller
 * @returns {Promise<{ scheduled, running, configuredNotRunning, checkedAt }>}
 */
export async function readAutonomy({ hqRoot, exec = defaultExec, running = {} }) {
  const checkedAt = new Date().toISOString();

  // 1. scheduled work
  let scheduled = [];
  let cronError = null;
  try {
    const res = await exec(["cron", "list", "--json"]);
    if (res.code === 0) {
      const parsed = JSON.parse(res.stdout || "{}");
      const jobs = Array.isArray(parsed) ? parsed : parsed.jobs || [];
      scheduled = jobs.map((j) => ({
        key: j.declarationKey || j.name || j.id,
        displayName: j.displayName || j.name || j.declarationKey || j.id,
        agentId: j.agentId || null,
        schedule: scheduleLabel(j.schedule),
        enabled: j.enabled !== false,
        nextRunAt: j.state?.nextRunAtMs ? new Date(j.state.nextRunAtMs).toISOString() : null,
        lastRunAt: j.state?.lastRunAtMs ? new Date(j.state.lastRunAtMs).toISOString() : null,
        lastStatus: j.state?.lastStatus || j.state?.lastRunStatus || null,
        consecutiveErrors: j.state?.consecutiveErrors || 0,
      }));
    } else {
      cronError = "openclaw cron list unavailable";
    }
  } catch (error) {
    cronError = error.message || String(error);
  }

  // 2. configured-but-not-running — a static gap check against factory.config.json
  const configuredNotRunning = [];
  let config = {};
  try { config = JSON.parse(readFileSync(join(hqRoot, "factory", "factory.config.json"), "utf8")); } catch { /* defaults */ }
  const scheduledKeys = new Set(scheduled.map((s) => s.key));
  const hasCron = (frag) => [...scheduledKeys].some((k) => String(k).includes(frag));

  if (config?.learning?.autonomy?.enabled && !hasCron("learning") && !hasCron("factory-learn")) {
    configuredNotRunning.push({
      feature: "Learning autonomy cycle",
      why: "factory.config.json learning.autonomy.enabled is true, but no `factory-learn`/`learning` cron is scheduled — it will not run on its own.",
    });
  }
  if (!scheduled.some((s) => /heartbeat/i.test(s.key)) && !cronError) {
    configuredNotRunning.push({ feature: "Heartbeat", why: "no heartbeat cron found — nothing wakes the orchestrator between founder actions." });
  }

  return {
    scheduled,
    scheduleError: cronError,
    running: {
      objectives: Number(running.objectives) || 0,
      tasks: Number(running.tasks) || 0,
      jobs: Number(running.jobs) || 0,
      anythingLive: (Number(running.objectives) || 0) + (Number(running.tasks) || 0) + (Number(running.jobs) || 0) > 0,
    },
    configuredNotRunning,
    checkedAt,
  };
}
