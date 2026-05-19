/** Hours after last successful end before a scheduled agent is "stale". */
const STALE_HOURS = 36;
/** Runs stuck in "running" longer than this (ms) need attention. */
const STUCK_RUNNING_MS = 2 * 60 * 60 * 1000;

/**
 * @param {string | null | undefined} iso
 */
function parseMs(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * @param {{ config: object, lastRun: object | null | undefined, pm2: { status?: string } | null | undefined }} input
 * @returns {{ health: string, label: string, stale: boolean, details: string }}
 */
export function computeAgentHealth({ config, lastRun, pm2 }) {
  const type = String(config.type || "manual").toLowerCase();
  const cfgStatus = String(config.status || "active").toLowerCase();
  const inactive = cfgStatus === "inactive";

  if (inactive) {
    return {
      health: "inactive",
      label: "Inactive",
      stale: false,
      details: "Marked inactive in config.",
    };
  }

  if (lastRun?.status === "running") {
    const started = parseMs(lastRun.started_at);
    if (started && Date.now() - started > STUCK_RUNNING_MS) {
      return {
        health: "failed",
        label: "Stuck run",
        stale: false,
        details: "A dashboard run never finished; check logs or clear DB row.",
      };
    }
    return {
      health: "running",
      label: "Running",
      stale: false,
      details: "A run is in progress.",
    };
  }

  if (lastRun?.status === "failed") {
    return {
      health: "failed",
      label: "Last run failed",
      stale: false,
      details: lastRun.error_message || "See logs for details.",
    };
  }

  if (!lastRun || !lastRun.ended_at) {
    if (type === "scheduled") {
      return {
        health: "warning",
        label: "Never run",
        stale: true,
        details: "No completed run recorded yet.",
      };
    }
    return {
      health: "warning",
      label: "No runs yet",
      stale: false,
      details: "Trigger a manual run when ready.",
    };
  }

  if (lastRun.status === "success") {
    const ended = parseMs(lastRun.ended_at);
    if (type === "scheduled" && ended) {
      const ageH = (Date.now() - ended) / (3600 * 1000);
      if (ageH > STALE_HOURS) {
        return {
          health: "warning",
          label: "Stale",
          stale: true,
          details: `Last success was ${Math.round(ageH)}h ago (>${STALE_HOURS}h).`,
        };
      }
    }

    if (type === "always-on") {
      const st = pm2?.status;
      if (st && st !== "online") {
        return {
          health: "warning",
          label: "PM2 not online",
          stale: false,
          details: `PM2 status: ${st}`,
        };
      }
    }

    return {
      health: "healthy",
      label: "Healthy",
      stale: false,
      details: "Last run completed successfully.",
    };
  }

  return {
    health: "warning",
    label: "Unknown",
    stale: false,
    details: `Unexpected status: ${lastRun.status}`,
  };
}

/**
 * @param {string} agentKey
 */
export function splitAgentKey(agentKey) {
  const i = String(agentKey).indexOf("/");
  if (i <= 0) return null;
  return { project: agentKey.slice(0, i), id: agentKey.slice(i + 1) };
}
