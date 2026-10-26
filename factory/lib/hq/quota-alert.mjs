// Warns when one run (task) has spent more than a configured share of the
// quota. Limit lives in factory.config.json `quotaAlert`; no limit, no alert.
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export function loadQuotaAlert(hqRoot) {
  const path = join(hqRoot, "factory", "factory.config.json");
  if (!existsSync(path)) return null;
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8")).quotaAlert;
    const quota = Number(cfg?.quotaTokens); const pct = Number(cfg?.runWarnPct);
    return quota > 0 && pct > 0 ? { quotaTokens: quota, runWarnPct: pct } : null;
  } catch { return null; }
}

// Tokens of a run = every non-superseded usage event of the task, cached input included.
export function runQuotaShare(events, taskId, quotaTokens) {
  const tokens = events.filter((e) => e.taskId === taskId && e.eventType === "usage")
    .reduce((sum, e) => sum + e.inputTokens + e.cachedInputTokens + e.outputTokens, 0);
  return { tokens, pct: (tokens / quotaTokens) * 100 };
}
