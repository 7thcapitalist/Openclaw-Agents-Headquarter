import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { defaultStateRoot, discoverTaskViews } from "./tasks.mjs";
import { readState } from "../task-workflow.mjs";

const DEFAULT_PRICING = Object.freeze({
  version: 1,
  currency: "USD",
  updatedAt: "2026-09-08",
  models: {},
  aliases: {},
  unknownModel: {
    strategy: "null-cost",
    label: "unpriced",
  },
});

export function pricingPath(hqRoot) {
  return join(resolve(hqRoot), "factory", "pricing.json");
}

export function normalizePricing(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const models = asRecord(source.models);
  const aliases = asRecord(source.aliases);
  return {
    version: 1,
    currency: typeof source.currency === "string" && source.currency.trim() ? source.currency.trim() : DEFAULT_PRICING.currency,
    updatedAt: typeof source.updatedAt === "string" && source.updatedAt.trim() ? source.updatedAt.trim() : DEFAULT_PRICING.updatedAt,
    models,
    aliases,
    unknownModel: normalizeUnknownModel(source.unknownModel),
  };
}

export function loadPricing(hqRoot) {
  const path = pricingPath(hqRoot);
  if (!existsSync(path)) return { ...DEFAULT_PRICING, models: {}, aliases: {} };
  try {
    return normalizePricing(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ...DEFAULT_PRICING, models: {}, aliases: {} };
  }
}

export function priceUsage(usage, pricing) {
  const record = sanitizeUsage(usage);
  if (!record) return null;
  const resolved = resolvePricingEntry(record, pricing);
  if (!resolved) {
    return {
      provider: record.provider,
      model: record.model,
      pricingKey: buildPricingKey(record.provider, record.model),
      tokensIn: record.tokensIn,
      tokensOut: record.tokensOut,
      durationMs: record.durationMs ?? null,
      inputUsdPerMillion: null,
      outputUsdPerMillion: null,
      costUsd: null,
      pricingSource: "unknown-model",
      pricingLabel: pricing?.unknownModel?.label || "unpriced",
    };
  }
  const costUsd = ((record.tokensIn * resolved.inputUsdPerMillion) + (record.tokensOut * resolved.outputUsdPerMillion)) / 1_000_000;
  return {
    provider: record.provider,
    model: record.model,
    pricingKey: resolved.pricingKey,
    tokensIn: record.tokensIn,
    tokensOut: record.tokensOut,
    durationMs: record.durationMs ?? null,
    inputUsdPerMillion: resolved.inputUsdPerMillion,
    outputUsdPerMillion: resolved.outputUsdPerMillion,
    costUsd,
    pricingSource: "pricing-file",
    pricingLabel: resolved.label,
  };
}

/**
 * Fill in costMicros for ledger events that were written without one.
 *
 * Lives here, beside the pricer, rather than in budget-snapshot.mjs where it
 * used to: `operations` and `budgets` read the SAME ledger, but only budgets
 * called this, so the same snapshot reported costMicros 0 with 48 unpriced
 * events in one panel and 85,068 with 2 in another. Same source, same function,
 * one answer.
 *
 * Cached input is priced at the input rate. factory/pricing.json carries no
 * cache-specific rates, and inventing them here would be the "build a second
 * pricer" mistake — so this is explicitly an approximation, marked `calculated`
 * rather than `provider-reported`, and it is still enormously closer than
 * ignoring a 162k-token context entirely.
 *
 * An event with no price stays null and is marked `unpriced`. It is never
 * zeroed: a missing price must not read as free.
 */
export function priceCostEvents(events, pricing) {
  let derived = 0;
  let stillUnpriced = 0;
  const priced = (events || []).map((event) => {
    if (event.costMicros != null) return event;
    const billableInput = (event.inputTokens || 0) + (event.cachedInputTokens || 0);
    const quote = priceUsage({
      provider: event.provider,
      model: event.model,
      tokensIn: billableInput,
      tokensOut: event.outputTokens,
    }, pricing);
    if (!quote || quote.costUsd == null) {
      stillUnpriced += 1;
      return { ...event, costConfidence: "unpriced" };
    }
    derived += 1;
    return {
      ...event,
      costMicros: Math.round(quote.costUsd * 1_000_000),
      costConfidence: "calculated",
      pricingVersion: event.pricingVersion || pricing?.updatedAt || null,
    };
  });
  return { events: priced, derived, stillUnpriced };
}

export function summarizeCosts({ hqRoot, stateRoot = null, pricing = null, now = new Date().toISOString() } = {}) {
  const resolvedPricing = pricing ? normalizePricing(pricing) : loadPricing(hqRoot);
  const views = discoverTaskViews({ hqRoot, stateRoot: stateRoot || defaultStateRoot(hqRoot) });
  const totals = blankBucket();
  const buckets = {
    byTask: new Map(),
    byStage: new Map(),
    byDay: new Map(),
    byProject: new Map(),
    byProviderModel: new Map(),
    byProvider: new Map(),
    byModel: new Map(),
    byAgent: new Map(),
    byObjective: new Map(),
  };
  const usageRecords = [];
  const knownModels = new Set();
  const unpricedModels = new Set();

  for (const view of views) {
    if (!view.statePath) continue;
    let state;
    try {
      state = readState(view.statePath);
    } catch {
      continue;
    }
    const taskId = String(state.task?.id || view.id || "unknown").trim() || "unknown";
    const project = String(state.task?.project || view.project || "unknown").trim() || "unknown";
    for (const dispatch of Array.isArray(state.dispatches) ? state.dispatches : []) {
      const completedAt = String(dispatch.completedAt || state.updatedAt || view.updatedAt || now);
      const day = toDay(completedAt);
    const stage = String(dispatch.stage || state.currentStage || "unknown").trim() || "unknown";
    const agent = String(dispatch.actor || state.assignments?.[stage] || "unknown").trim() || "unknown";
    const objective = String(state.task?.outcome || "unknown").trim() || "unknown";
      const usage = sanitizeUsage(dispatch.usage);
      const priced = usage ? priceUsage(usage, resolvedPricing) : null;
      const providerModel = usage ? buildPricingKey(usage.provider, usage.model) : "unknown/unknown";

      addToBucket(totals, { taskId, stage, day, project, providerModel, completedAt }, priced, usage);
      addToMap(buckets.byTask, taskId, { taskId, stage, day, project, providerModel, completedAt }, priced, usage);
      addToMap(buckets.byStage, stage, { taskId, stage, day, project, providerModel, completedAt }, priced, usage);
      addToMap(buckets.byDay, day, { taskId, stage, day, project, providerModel, completedAt }, priced, usage);
      addToMap(buckets.byProject, project, { taskId, stage, day, project, providerModel, completedAt }, priced, usage);
      addToMap(buckets.byProviderModel, providerModel, { taskId, stage, day, project, providerModel, completedAt }, priced, usage);
      addToMap(buckets.byProvider, usage?.provider || "unknown", { taskId, stage, day, project, providerModel, completedAt }, priced, usage);
      addToMap(buckets.byModel, usage?.model || "unknown", { taskId, stage, day, project, providerModel, completedAt }, priced, usage);
      addToMap(buckets.byAgent, agent, { taskId, stage, day, project, providerModel, completedAt }, priced, usage);
      addToMap(buckets.byObjective, objective, { taskId, stage, day, project, providerModel, completedAt }, priced, usage);

      if (usage) usageRecords.push({
        provider: usage.provider,
        model: usage.model,
        agent,
        project,
        objective,
        taskId,
        stage,
        completedAt,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        totalTokens: usage.tokensIn + usage.tokensOut,
        durationMs: usage.durationMs ?? null,
        estimatedUsd: priced?.costUsd ?? null,
        usageConfidence: "recorded",
        costConfidence: priced?.costUsd == null ? "unavailable" : "calculated-from-recorded-tokens-and-pricing",
      });

      if (usage) {
        if (priced?.pricingSource === "pricing-file") knownModels.add(providerModel);
        else unpricedModels.add(providerModel);
      }
    }
  }

  return {
    version: 1,
    currency: resolvedPricing.currency,
    asOf: now,
    pricing: {
      updatedAt: resolvedPricing.updatedAt,
      unknownModel: resolvedPricing.unknownModel,
    },
    totals: finalizeBucket(totals, {
      knownModels: [...knownModels].sort(),
      unpricedModels: [...unpricedModels].sort(),
    }),
    byTask: finalizeMap(buckets.byTask),
    byStage: finalizeMap(buckets.byStage),
    byDay: finalizeMap(buckets.byDay),
    byProject: finalizeMap(buckets.byProject),
    byProviderModel: finalizeMap(buckets.byProviderModel),
    byProvider: finalizeMap(buckets.byProvider),
    byModel: finalizeMap(buckets.byModel),
    byAgent: finalizeMap(buckets.byAgent),
    byObjective: finalizeMap(buckets.byObjective),
    usageRecords: usageRecords.sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt))),
  };
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

function normalizeUnknownModel(value) {
  const source = asRecord(value);
  return {
    strategy: typeof source.strategy === "string" && source.strategy.trim() ? source.strategy.trim() : DEFAULT_PRICING.unknownModel.strategy,
    label: typeof source.label === "string" && source.label.trim() ? source.label.trim() : DEFAULT_PRICING.unknownModel.label,
  };
}

function sanitizeUsage(usage) {
  const source = usage && typeof usage === "object" && !Array.isArray(usage) ? usage : null;
  if (!source) return null;
  const provider = stringOrNull(source.provider);
  const model = stringOrNull(source.model);
  const tokensIn = intOrNull(source.tokensIn);
  const tokensOut = intOrNull(source.tokensOut);
  if (!provider || !model || tokensIn == null || tokensOut == null) return null;
  const record = { provider, model, tokensIn, tokensOut };
  const durationMs = intOrNull(source.durationMs);
  if (durationMs != null) record.durationMs = durationMs;
  return record;
}

function resolvePricingEntry(usage, pricing) {
  const models = asRecord(pricing?.models);
  const aliases = asRecord(pricing?.aliases);
  const key = buildPricingKey(usage.provider, usage.model);
  const candidates = [usage.model, key, aliases[key], aliases[usage.model], aliases[usage.provider]];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const resolved = models[candidate.trim()];
    if (!resolved) continue;
    const inputUsdPerMillion = numberOrNull(resolved.inputUsdPerMillion ?? resolved.inputUsd ?? resolved.input);
    const outputUsdPerMillion = numberOrNull(resolved.outputUsdPerMillion ?? resolved.outputUsd ?? resolved.output);
    if (inputUsdPerMillion == null || outputUsdPerMillion == null) continue;
    return {
      pricingKey: candidate.trim(),
      label: stringOrNull(resolved.label) || candidate.trim(),
      inputUsdPerMillion,
      outputUsdPerMillion,
    };
  }
  return null;
}

function addToMap(map, key, dims, priced, usage) {
  const existing = map.get(key) || blankBucket();
  addToBucket(existing, dims, priced, usage);
  map.set(key, existing);
}

function addToBucket(bucket, dims, priced, usage) {
  bucket.dispatches += 1;
  bucket.tokensIn += usage?.tokensIn || 0;
  bucket.tokensOut += usage?.tokensOut || 0;
  bucket.durationMs += usage?.durationMs || 0;
  bucket.tasks.add(dims.taskId);
  bucket.stages.add(dims.stage);
  bucket.days.add(dims.day);
  bucket.projects.add(dims.project);
  bucket.providerModels.add(dims.providerModel);
  if (!usage) {
    bucket.dispatchesMissingUsage += 1;
    return;
  }
  bucket.dispatchesWithUsage += 1;
  if (priced?.costUsd == null) {
    bucket.dispatchesUnpriced += 1;
    bucket.unpricedModels.add(dims.providerModel);
    return;
  }
  bucket.costUsd += priced.costUsd;
  bucket.pricedDispatches += 1;
}

function finalizeMap(map) {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, bucket]) => [key, finalizeBucket(bucket)]));
}

function finalizeBucket(bucket, extra = {}) {
  const costUsd = bucket.pricedDispatches > 0 ? roundUsd(bucket.costUsd) : null;
  return {
    dispatches: bucket.dispatches,
    dispatchesWithUsage: bucket.dispatchesWithUsage,
    dispatchesMissingUsage: bucket.dispatchesMissingUsage,
    dispatchesUnpriced: bucket.dispatchesUnpriced,
    pricedDispatches: bucket.pricedDispatches,
    tokensIn: bucket.tokensIn,
    tokensOut: bucket.tokensOut,
    durationMs: bucket.durationMs,
    costUsd,
    unpricedModels: [...bucket.unpricedModels].sort(),
    tasks: [...bucket.tasks].sort(),
    stages: [...bucket.stages].sort(),
    days: [...bucket.days].sort(),
    projects: [...bucket.projects].sort(),
    providerModels: [...bucket.providerModels].sort(),
    ...extra,
  };
}

function blankBucket() {
  return {
    dispatches: 0,
    dispatchesWithUsage: 0,
    dispatchesMissingUsage: 0,
    dispatchesUnpriced: 0,
    pricedDispatches: 0,
    tokensIn: 0,
    tokensOut: 0,
    durationMs: 0,
    costUsd: 0,
    unpricedModels: new Set(),
    tasks: new Set(),
    stages: new Set(),
    days: new Set(),
    projects: new Set(),
    providerModels: new Set(),
  };
}

function buildPricingKey(provider, model) {
  const p = stringOrNull(provider) || "unknown";
  const m = stringOrNull(model) || "unknown";
  return m.includes("/") ? m : `${p}/${m}`;
}

function toDay(value) {
  const text = String(value || "");
  return text.length >= 10 ? text.slice(0, 10) : "unknown";
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function intOrNull(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.trunc(parsed);
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function roundUsd(value) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}
