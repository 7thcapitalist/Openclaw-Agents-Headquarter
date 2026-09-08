function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeOfficialProvider(name, value) {
  const source = asObject(value);
  if (!source) return null;
  const limit = numeric(source.limit ?? source.max ?? source.capacity ?? source.cap);
  const used = numeric(source.used ?? source.usage ?? source.consumed ?? source.tokensUsed);
  const remaining = numeric(source.remaining ?? source.available ?? source.headroom);
  const resetAt = text(source.resetAt ?? source.reset_at ?? source.resetsAt ?? source.windowResetAt);
  const label = text(source.label ?? source.name) || name;
  if (limit == null && used == null && remaining == null && !resetAt) return null;
  const out = { label };
  if (limit != null) out.limit = limit;
  if (used != null) out.used = used;
  if (remaining != null) out.remaining = remaining;
  if (resetAt) out.resetAt = resetAt;
  return out;
}

function normalizeOfficialSource(source) {
  const candidate = asObject(source);
  if (!candidate) return null;
  const providers = asObject(candidate.providers)
    || asObject(candidate.limits)
    || asObject(candidate.official)
    || candidate;
  const out = {};
  for (const [name, value] of Object.entries(providers)) {
    const normalized = normalizeOfficialProvider(name, value);
    if (normalized) out[name] = normalized;
  }
  return Object.keys(out).length ? out : null;
}

function normalizeUsageWindows(value) {
  if (!Array.isArray(value)) return [];
  return value.map((window) => {
    const source = asObject(window);
    if (!source) return null;
    const provider = text(source.provider) || "unknown";
    const label = text(source.label) || `observed ${provider}`;
    const start = text(source.start ?? source.windowStart ?? source.from);
    const end = text(source.end ?? source.windowEnd ?? source.to);
    const tokensIn = numeric(source.tokensIn ?? source.inputTokens);
    const tokensOut = numeric(source.tokensOut ?? source.outputTokens);
    const dispatches = numeric(source.dispatches ?? source.count ?? source.samples);
    const cooldowns = numeric(source.cooldowns ?? source.cooldownEvents);
    const out = { provider, label };
    if (start) out.start = start;
    if (end) out.end = end;
    if (tokensIn != null) out.tokensIn = tokensIn;
    if (tokensOut != null) out.tokensOut = tokensOut;
    if (dispatches != null) out.dispatches = dispatches;
    if (cooldowns != null) out.cooldowns = cooldowns;
    return out;
  }).filter(Boolean);
}

function normalizeCooldownHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const source = asObject(item);
    if (!source) return null;
    const at = text(source.at ?? source.time ?? source.when);
    const label = text(source.label) || "cooldown";
    const stage = text(source.stage);
    const provider = text(source.provider);
    const out = { label };
    if (at) out.at = at;
    if (stage) out.stage = stage;
    if (provider) out.provider = provider;
    return out;
  }).filter(Boolean);
}

export async function readPlanLimits({
  authoritativeSource = null,
  usageWindows = [],
  cooldownHistory = [],
  asOf = new Date().toISOString(),
} = {}) {
  const source = typeof authoritativeSource === "function"
    ? await authoritativeSource({ asOf })
    : authoritativeSource;
  const official = normalizeOfficialSource(source);
  if (official) {
    return {
      version: 1,
      asOf,
      available: true,
      source: "official",
      providers: official,
    };
  }

  const windows = normalizeUsageWindows(usageWindows);
  const cooldowns = normalizeCooldownHistory(cooldownHistory);
  if (windows.length || cooldowns.length) {
    return {
      version: 1,
      asOf,
      available: true,
      source: "inferred",
      usageWindows: windows,
      cooldownHistory: cooldowns,
    };
  }

  return {
    version: 1,
    asOf,
    available: false,
    reason: "No authoritative plan-limit source or usable inferred usage/cooldown data was available.",
  };
}
