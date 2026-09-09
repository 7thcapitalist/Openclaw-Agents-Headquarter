import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { defaultStateRoot } from "../../../factory/lib/natural-language-intake.mjs";
import { readState } from "../../../factory/lib/task-workflow.mjs";
import { loadPricing, summarizeCosts } from "../../../factory/lib/hq/cost.mjs";
import { readPlanLimits } from "../../../factory/lib/hq/plan-limits.mjs";

const RATE_LIMIT_RE = /rate.?limit|cooldown|quota|usage limit|429|temporarily unavailable|provider .* unavailable/i;
const COOLDOWN_RE = /cooldown|cooldown.*\(|cooldown\s*\d/i;

export async function buildHqCostsPayload({
  hqRoot,
  repo = hqRoot,
  stateRoot = null,
  pricing = null,
  now = new Date().toISOString(),
} = {}) {
  const resolvedPricing = pricing || loadPricing(hqRoot);
  const raw = summarizeCosts({ hqRoot, stateRoot: stateRoot || defaultStateRoot(hqRoot, repo), pricing: resolvedPricing, now });
  return toDashboardCosts(raw, now);
}

// Keep the calculation API rich, but expose the view-model contract consumed by
// dashboard/backend/public/cost-limits.mjs. This adapter also makes the live
// endpoint useful when a bucket has tokens but no billable price.
function toDashboardCosts(raw, now) {
  const day = String(now).slice(0, 10);
  const recentTasks = Object.entries(raw.byTask || {}).map(([taskId, bucket]) => ({
    taskId,
    project: bucket.projects?.[0] || "Global HQ",
    totalTokens: bucket.tokensIn + bucket.tokensOut,
    estimatedUsd: bucket.costUsd,
    hasUnknownPricing: bucket.dispatchesUnpriced > 0 || bucket.dispatchesMissingUsage > 0,
    stages: (bucket.stages || []).map((stage) => ({ stage })),
    _latest: bucket.days?.at(-1) || "",
  })).sort((a, b) => b._latest.localeCompare(a._latest) || a.taskId.localeCompare(b.taskId))
    .map(({ _latest, ...task }) => task);
  const today = raw.byDay?.[day] || emptyDashboardBucket();
  const last7Days = Object.entries(raw.byDay || {})
    .filter(([key]) => key >= dayOffset(day, -6))
    .map(([, bucket]) => bucket)
    .reduce(mergeBuckets, emptyDashboardBucket());
  return {
    ...raw,
    recentTasks,
    totals: {
      ...raw.totals,
      today: dashboardBucket(today),
      last7Days: dashboardBucket(last7Days),
      byProject: Object.entries(raw.byProject || {}).map(([project, bucket]) => ({ project, ...dashboardBucket(bucket) })),
    },
  };
}

function dashboardBucket(bucket) {
  return {
    totalTokens: (bucket.tokensIn || 0) + (bucket.tokensOut || 0),
    estimatedUsd: bucket.costUsd ?? null,
    taskCount: bucket.tasks?.length || 0,
  };
}

function emptyDashboardBucket() {
  return { tokensIn: 0, tokensOut: 0, costUsd: null, tasks: [] };
}

function mergeBuckets(total, bucket) {
  total.tokensIn += bucket.tokensIn || 0;
  total.tokensOut += bucket.tokensOut || 0;
  total.tasks = [...new Set([...total.tasks, ...(bucket.tasks || [])])];
  if (bucket.costUsd != null) total.costUsd = (total.costUsd || 0) + bucket.costUsd;
  return total;
}

function dayOffset(day, offset) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

export async function buildHqPlanLimitsPayload({
  hqRoot,
  repo = hqRoot,
  stateRoot = null,
  authoritativeSource = null,
  now = new Date().toISOString(),
  lookbackHours = 24,
} = {}) {
  const resolvedStateRoot = stateRoot || defaultStateRoot(hqRoot, repo);
  const { usageWindows, cooldownHistory } = collectInferredHeadroom({ hqRoot, stateRoot: resolvedStateRoot, now, lookbackHours });
  return readPlanLimits({ authoritativeSource, usageWindows, cooldownHistory, asOf: now });
}

function collectInferredHeadroom({ hqRoot, stateRoot, now, lookbackHours }) {
  const cutoff = Date.parse(now) - Math.max(1, lookbackHours) * 60 * 60 * 1000;
  const providers = new Map();
  const cooldownHistory = [];
  for (const path of walkStateFiles(stateRoot)) {
    let state;
    try {
      state = readState(path);
    } catch {
      continue;
    }
    for (const dispatch of Array.isArray(state.dispatches) ? state.dispatches : []) {
      const usage = dispatch?.usage && typeof dispatch.usage === "object" ? dispatch.usage : null;
      if (usage && Date.parse(dispatch.completedAt || state.updatedAt || now) >= cutoff) {
        const provider = String(usage.provider || "unknown").trim() || "unknown";
        const window = providers.get(provider) || blankWindow(provider, now);
        window.dispatches += 1;
        window.tokensIn += Number(usage.tokensIn) || 0;
        window.tokensOut += Number(usage.tokensOut) || 0;
        window.cooldowns += rateLimitSignal(dispatch) ? 1 : 0;
        window.end = maxIso(window.end, dispatch.completedAt || state.updatedAt || now);
        window.start = minIso(window.start, dispatch.completedAt || state.updatedAt || now);
        providers.set(provider, window);
      }
      if (rateLimitSignal(dispatch)) {
        cooldownHistory.push(buildCooldownEvent(dispatch, state));
      }
    }
    if (rateLimitSignal(state.blocker)) {
      cooldownHistory.push(buildCooldownEvent(state.blocker, state));
    }
  }

  return {
    usageWindows: [...providers.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
    cooldownHistory: dedupeCooldowns(cooldownHistory),
  };
}

function blankWindow(provider, now) {
  return {
    provider,
    label: `observed rolling ${provider} usage`,
    start: now,
    end: now,
    dispatches: 0,
    tokensIn: 0,
    tokensOut: 0,
    cooldowns: 0,
  };
}

function buildCooldownEvent(entry, state) {
  const at = String(entry?.completedAt || entry?.at || state.updatedAt || new Date().toISOString());
  return {
    at,
    stage: String(entry?.stage || state.currentStage || "unknown").trim() || "unknown",
    provider: String(entry?.usage?.provider || entry?.provider || "unknown").trim() || "unknown",
    label: "cooldown",
  };
}

function rateLimitSignal(entry) {
  const text = String(entry?.error || entry?.summary || "");
  return RATE_LIMIT_RE.test(text) || COOLDOWN_RE.test(text);
}

function dedupeCooldowns(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = `${item.at}|${item.stage}|${item.provider}|${item.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

function walkStateFiles(root, out = []) {
  if (!existsSync(root)) return out;
  for (const entry of readDirEntries(root)) {
    if (entry.type === "file" && entry.name === "state.json") {
      out.push(join(entry.path, entry.name));
    } else if (entry.type === "dir") {
      walkStateFiles(join(entry.path, entry.name), out);
    }
  }
  return out;
}

function readDirEntries(root) {
  try {
    return readdirSync(root, { withFileTypes: true }).map((entry) => ({ path: root, name: entry.name, type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other" }));
  } catch {
    return [];
  }
}

function maxIso(a, b) {
  return String(a || "") > String(b || "") ? String(a) : String(b || "");
}

function minIso(a, b) {
  const aa = String(a || "");
  const bb = String(b || "");
  if (!aa) return bb;
  if (!bb) return aa;
  return aa < bb ? aa : bb;
}
