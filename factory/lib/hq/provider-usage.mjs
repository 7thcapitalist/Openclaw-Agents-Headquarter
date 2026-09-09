// Normalized provider usage contracts. This module deliberately distinguishes
// provider-reported capacity from locally recorded runtime activity.

export const USAGE_CONFIDENCE = Object.freeze({
  AUTHORITATIVE: "authoritative",
  RECORDED: "recorded",
  CALCULATED: "calculated",
  ESTIMATED: "estimated",
  UNAVAILABLE: "unavailable",
});

export function normalizeUsageWindow(input, defaults = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const limit = numberOrNull(source.limit);
  const used = numberOrNull(source.used);
  const remaining = numberOrNull(source.remaining);
  const derivedUsed = used ?? (limit != null && remaining != null ? Math.max(0, limit - remaining) : null);
  const derivedRemaining = remaining ?? (limit != null && used != null ? Math.max(0, limit - used) : null);
  const percentRemaining = source.percentRemaining != null
    ? numberOrNull(source.percentRemaining)
    : (limit != null && derivedRemaining != null && limit > 0 ? (derivedRemaining / limit) * 100 : null);
  return {
    name: stringOr(source.name, defaults.name || "Current window"),
    unit: stringOr(source.unit, defaults.unit || "unknown"),
    limit,
    used: derivedUsed,
    remaining: derivedRemaining,
    percentRemaining: percentRemaining == null ? null : clamp(percentRemaining, 0, 100),
    resetAt: stringOrNull(source.resetAt),
    startsAt: stringOrNull(source.startsAt),
    source: stringOr(source.source, defaults.source || "unavailable"),
    confidence: stringOr(source.confidence, defaults.confidence || USAGE_CONFIDENCE.UNAVAILABLE),
    note: stringOrNull(source.note),
  };
}

export function normalizeProviderSnapshot(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const provider = stringOr(source.provider, "unknown");
  const windows = Array.isArray(source.windows)
    ? source.windows.map((window) => normalizeUsageWindow(window)).filter(Boolean)
    : [];
  return {
    provider,
    label: stringOr(source.label, provider),
    account: stringOrNull(source.account),
    windows,
    status: stringOr(source.status, windows.some((w) => w.confidence === USAGE_CONFIDENCE.AUTHORITATIVE) ? "healthy" : "unavailable"),
    source: stringOr(source.source, "unavailable"),
    confidence: stringOr(source.confidence, windows[0]?.confidence || USAGE_CONFIDENCE.UNAVAILABLE),
    updatedAt: stringOrNull(source.updatedAt),
    stale: source.stale === true,
    reason: stringOrNull(source.reason),
  };
}

export function normalizeProviderSnapshots(value) {
  return (Array.isArray(value) ? value : []).map(normalizeProviderSnapshot);
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
