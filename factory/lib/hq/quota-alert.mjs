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

// Tokens of a run = every effective event of the task (same rule as summarizeCostLedger):
// superseded events and reversals are dropped, corrections count. Cached input included.
export function runQuotaShare(events, taskId, quotaTokens) {
  const superseded = new Set(events.filter((e) => e.replacesEventId).map((e) => e.replacesEventId));
  const tokens = events.filter((e) => e.taskId === taskId && e.eventType !== "reversal" && !superseded.has(e.eventId))
    .reduce((sum, e) => sum + e.inputTokens + e.cachedInputTokens + e.outputTokens, 0);
  return { tokens, pct: (tokens / quotaTokens) * 100 };
}
