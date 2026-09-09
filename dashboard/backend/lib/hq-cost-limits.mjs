import { existsSync, readdirSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { defaultStateRoot } from "../../../factory/lib/hq/tasks.mjs";
import { readState } from "../../../factory/lib/task-workflow.mjs";
import { loadPricing, summarizeCosts } from "../../../factory/lib/hq/cost.mjs";
import { readPlanLimits } from "../../../factory/lib/hq/plan-limits.mjs";
import { normalizeProviderSnapshot, normalizeUsageWindow, USAGE_CONFIDENCE } from "../../../factory/lib/hq/provider-usage.mjs";

const execFileAsync = promisify(execFile);
const SESSION_CACHE_TTL_MS = 60_000;
const sessionCache = new Map();

const RATE_LIMIT_RE = /rate.?limit|cooldown|quota|usage limit|429|temporarily unavailable|provider .* unavailable/i;
const COOLDOWN_RE = /cooldown|cooldown.*\(|cooldown\s*\d/i;

export async function buildHqCostsPayload({
  hqRoot,
  repo = hqRoot,
  stateRoot = null,
  pricing = null,
  now = new Date().toISOString(),
  authoritativeSource = null,
  runtimeSource = null,
} = {}) {
  const resolvedPricing = pricing || loadPricing(hqRoot);
  const resolvedStateRoot = stateRoot || defaultStateRoot(hqRoot);
  const raw = summarizeCosts({ hqRoot, stateRoot: resolvedStateRoot, pricing: resolvedPricing, now });
  const runtime = await readOpenClawSessionUsage({ source: runtimeSource, now });
  return toDashboardCosts(raw, now, buildAiUsage({ raw, runtime, authoritativeSource, now }));
}

// Keep the calculation API rich, but expose the view-model contract consumed by
// dashboard/backend/public/cost-limits.mjs. This adapter also makes the live
// endpoint useful when a bucket has tokens but no billable price.
function toDashboardCosts(raw, now, aiUsage) {
  const day = String(now).slice(0, 10);
  const recentTasks = Object.entries(raw.byTask || {}).map(([taskId, bucket]) => ({
    records: (raw.usageRecords || []).filter((record) => record.taskId === taskId),
    taskId,
    project: bucket.projects?.[0] || "Global HQ",
    objective: (raw.usageRecords || []).find((record) => record.taskId === taskId)?.objective || null,
    totalTokens: bucket.tokensIn + bucket.tokensOut,
    estimatedUsd: bucket.costUsd,
    hasUnknownPricing: bucket.dispatchesUnpriced > 0 || bucket.dispatchesMissingUsage > 0,
    stages: stageRows((raw.usageRecords || []).filter((record) => record.taskId === taskId), bucket.stages || []),
    _latest: bucket.days?.at(-1) || "",
  })).sort((a, b) => b._latest.localeCompare(a._latest) || a.taskId.localeCompare(b.taskId))
    .map(({ _latest, records, ...task }) => task);
  const today = raw.byDay?.[day] || emptyDashboardBucket();
  const last7Days = Object.entries(raw.byDay || {})
    .filter(([key]) => key >= dayOffset(day, -6))
    .map(([, bucket]) => bucket)
    .reduce(mergeBuckets, emptyDashboardBucket());
  return {
    ...raw,
    aiUsage,
    recentTasks,
    totals: {
      ...raw.totals,
      today: dashboardBucket(today),
      last7Days: dashboardBucket(last7Days),
      byProject: Object.entries(raw.byProject || {}).map(([project, bucket]) => ({ project, ...dashboardBucket(bucket) })),
    },
  };
}

function stageRows(records, fallbackStages) {
  if (!records.length) return fallbackStages.map((stage) => ({ stage }));
  const groups = new Map();
  for (const record of records) {
    const key = `${record.stage}\u0000${record.provider}\u0000${record.model}`;
    const row = groups.get(key) || { stage: record.stage, provider: record.provider, model: record.model, totalTokens: 0, estimatedUsd: 0, estimateApprox: false };
    row.totalTokens += record.totalTokens;
    if (record.estimatedUsd == null) row.estimateApprox = true;
    else row.estimatedUsd += record.estimatedUsd;
    groups.set(key, row);
  }
  return [...groups.values()].map((row) => ({ ...row, estimatedUsd: row.estimateApprox && row.estimatedUsd === 0 ? null : row.estimatedUsd }));
}

// OpenClaw's supported sessions command reports local session token activity,
// provider, model, and agent. It does not report provider quota, so this adapter
// never turns those tokens into a remaining-capacity percentage.
export async function readOpenClawSessionUsage({ source = null, now = new Date().toISOString(), ttlMs = SESSION_CACHE_TTL_MS } = {}) {
  const key = "openclaw-sessions";
  const cached = sessionCache.get(key);
  if (!source && cached && Date.parse(now) - cached.readAt < ttlMs) return { ...cached.value, cache: "fresh" };
  try {
    const raw = source ? await source({ now }) : (await execFileAsync("openclaw", ["sessions", "--all-agents", "--json", "--limit", "all"], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 })).stdout;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    const value = summarizeSessions(sessions, now);
    if (!source) sessionCache.set(key, { readAt: Date.parse(now), value });
    return { ...value, cache: "fresh" };
  } catch (error) {
    if (cached) return { ...cached.value, cache: "stale", stale: true, error: String(error.message || error) };
    return { available: false, stale: false, sessions: [], byProviderModel: [], totalTokens: null, error: String(error.message || error), updatedAt: now };
  }
}

function summarizeSessions(sessions, now) {
  const rows = [];
  for (const session of sessions) {
    const input = nonNegative(session?.inputTokens);
    const output = nonNegative(session?.outputTokens);
    if (input == null && output == null) continue;
    rows.push({
      provider: String(session.modelProvider || "unknown"),
      model: String(session.model || "unknown"),
      agent: String(session.agentId || "unknown"),
      sessionKey: String(session.key || ""),
      tokensIn: input || 0,
      tokensOut: output || 0,
      totalTokens: (input || 0) + (output || 0),
      updatedAt: session.updatedAt ? new Date(session.updatedAt).toISOString() : null,
      scope: isFactorySession(session) ? "factory" : "other-local",
      usageConfidence: "recorded",
    });
  }
  return {
    available: true,
    stale: false,
    updatedAt: now,
    sessions: rows,
    totalTokens: rows.reduce((sum, row) => sum + row.totalTokens, 0),
    byProviderModel: rollupRows(rows, ["provider", "model"]),
    byAgent: rollupRows(rows, ["agent"]),
  };
}

function isFactorySession(session) {
  return /:factory-(?:task|objective)-/i.test(String(session?.key || ""));
}

function rollupRows(rows, dimensions) {
  const groups = new Map();
  for (const row of rows) {
    const key = dimensions.map((dimension) => row[dimension]).join("\u0000");
    const existing = groups.get(key) || { ...Object.fromEntries(dimensions.map((d) => [d, row[d]])), totalTokens: 0, sessions: 0, usageConfidence: "recorded" };
    existing.totalTokens += row.totalTokens;
    existing.sessions += 1;
    groups.set(key, existing);
  }
  return [...groups.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

function buildAiUsage({ raw, runtime, authoritativeSource, now }) {
  const providers = new Set([
    ...Object.keys(raw.byProvider || {}),
    ...runtime.byProviderModel.map((row) => row.provider),
    "openai", "anthropic", "github-copilot",
  ]);
  const capacity = [...providers].sort().map((provider) => capacitySnapshot(provider, authoritativeSource, now));
  const factoryRows = (raw.usageRecords || []).map((row) => ({ ...row, source: "factory task state" }));
  const otherLocalRows = runtime.sessions.filter((row) => row.scope === "other-local");
  return {
    version: 1,
    asOf: now,
    capacity,
    runtime: {
      status: runtime.available ? "healthy" : "unavailable",
      source: "OpenClaw sessions command",
      updatedAt: runtime.updatedAt || null,
      stale: runtime.stale === true,
      reason: runtime.error || null,
    },
    factory: usageSummary(factoryRows),
    otherLocal: {
      available: runtime.available,
      stale: runtime.stale === true,
      updatedAt: runtime.updatedAt || null,
      sessions: otherLocalRows,
      summary: usageSummary(otherLocalRows),
      source: "OpenClaw sessions",
      confidence: "recorded",
      error: runtime.error || null,
    },
    dataQuality: [
      { label: "Provider remaining capacity", confidence: capacity.some((p) => p.confidence === USAGE_CONFIDENCE.AUTHORITATIVE) ? "authoritative" : "unavailable", detail: capacity.some((p) => p.confidence === USAGE_CONFIDENCE.AUTHORITATIVE) ? "Provider-reported snapshot" : "No supported provider quota source is configured." },
      { label: "Factory usage", confidence: "recorded", detail: "Agent-reported usage persisted on factory dispatches." },
      { label: "Agent / project / task attribution", confidence: "recorded", detail: "Attribution is available only when the dispatch returns usage metadata." },
      { label: "Other local usage", confidence: runtime.available ? "recorded" : "unavailable", detail: runtime.available ? "OpenClaw sessions not identified as factory sessions." : "OpenClaw session listing unavailable." },
    ],
  };
}

function capacitySnapshot(provider, authoritativeSource, now) {
  const source = authoritativeSource?.providers?.[provider] || authoritativeSource?.[provider] || null;
  const sourceWindows = Array.isArray(source?.windows) ? source.windows : source ? [source] : [];
  const windows = sourceWindows.map((window) => normalizeUsageWindow(window, {
    source: "provider-configured-authoritative-source",
    confidence: USAGE_CONFIDENCE.AUTHORITATIVE,
  }));
  return normalizeProviderSnapshot({
    provider,
    label: providerLabel(provider),
    windows,
    status: windows.length ? "healthy" : "unavailable",
    source: windows.length ? "configured authoritative source" : "none",
    confidence: windows.length ? USAGE_CONFIDENCE.AUTHORITATIVE : USAGE_CONFIDENCE.UNAVAILABLE,
    updatedAt: now,
    reason: windows.length ? null : "No authoritative remaining-capacity source is available.",
  });
}

function usageSummary(rows) {
  const totalTokens = rows.reduce((sum, row) => sum + (row.totalTokens || 0), 0);
  return {
    totalTokens,
    records: rows.length,
    usageConfidence: rows.length ? "recorded" : "unavailable",
    byProvider: rollupRows(rows, ["provider"]),
    byModel: rollupRows(rows, ["model"]),
    byAgent: rollupRows(rows, ["agent"]),
    byProject: rollupRows(rows, ["project"]),
    byObjective: rollupRows(rows, ["objective"]),
    byTask: rollupRows(rows, ["taskId"]),
    byStage: rollupRows(rows, ["stage"]),
  };
}

function providerLabel(provider) {
  return { openai: "Codex / OpenAI", anthropic: "Claude / Anthropic", "github-copilot": "GitHub Copilot" }[provider] || provider;
}

function nonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
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
  const resolvedStateRoot = stateRoot || defaultStateRoot(hqRoot);
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
