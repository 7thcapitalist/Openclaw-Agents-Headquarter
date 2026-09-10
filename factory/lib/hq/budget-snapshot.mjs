// The operator-facing budget view: tracked policies, evaluated against the
// append-only cost ledger.
//
// The problem this solves. `telemetry/dispatch.mjs` records a cost event per
// dispatch, but only carries `costMicros` when the agent itself reported one.
// No OpenClaw adapter does, so every event in the live ledger has
// `costMicros: null` and `costConfidence: "unavailable"`. Budget evaluation
// over that ledger can only ever answer "unavailable" — the feature reports
// nothing about real spend. Meanwhile HQ already ships a pricing table at
// `factory/pricing.json` and a `priceUsage()` that reads it, used by the older
// cost view but never by the ledger.
//
// This joins the two. Events are priced AT READ TIME, never by rewriting the
// ledger: the ledger stays append-only and keeps saying exactly what the
// provider reported, while the projection marks each derived price
// `costConfidence: "calculated"` — an existing value in the ledger's own
// vocabulary. A provider-reported price is always preferred over a derived one,
// and a model missing from the pricing table stays unpriced rather than being
// guessed at zero.

import { join, resolve } from "path";
import { evaluateBudgetAlerts } from "./budget-alerts.mjs";
import { readCostEvents, summarizeCostLedger } from "./cost-ledger.mjs";
import { loadPricing, priceUsage } from "./cost.mjs";
import { readPolicyRegistry } from "./budget-policies.mjs";

export function costLedgerPath(hqRoot) {
  return join(resolve(hqRoot), ".openclaw-factory", "telemetry", "cost-events.ndjson");
}

// Apply the tracked pricing table to any event the provider did not price.
// Returns the events unchanged apart from `costMicros`/`costConfidence`, so the
// result is still a valid cost-event list for every existing consumer.
export function priceCostEvents(events, pricing) {
  let derived = 0;
  let stillUnpriced = 0;
  const priced = events.map((event) => {
    if (event.costMicros != null) return event;
    const quote = priceUsage({
      provider: event.provider,
      model: event.model,
      tokensIn: event.inputTokens,
      tokensOut: event.outputTokens,
    }, pricing);
    if (!quote || quote.costUsd == null) {
      stillUnpriced += 1;
      return event;
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

// Never throws. Budgets are alert-only and read-only; a missing ledger,
// unreadable registry, or unknown model must degrade the view, not the factory.
export function buildBudgetSnapshot({ hqRoot, ledgerPath = null, now = new Date().toISOString() } = {}) {
  const warnings = [];

  let registry = { version: 1, policies: [], present: false, path: null };
  try {
    registry = readPolicyRegistry(hqRoot);
  } catch (error) {
    warnings.push(`budget policy registry unavailable: ${error.message}`);
  }

  let raw = [];
  try {
    raw = readCostEvents(ledgerPath || costLedgerPath(hqRoot));
  } catch (error) {
    warnings.push(`cost ledger unavailable: ${error.message}`);
  }

  const pricing = loadPricing(hqRoot);
  const { events, derived, stillUnpriced } = priceCostEvents(raw, pricing);
  if (stillUnpriced) {
    warnings.push(`${stillUnpriced} cost event(s) have no provider price and no entry in factory/pricing.json`);
  }

  let evaluation = { version: 1, evaluatedAt: now, enforcement: "alert-only", alerts: [], summary: { ok: 0, warning: 0, exceeded: 0, unavailable: 0 } };
  try {
    evaluation = evaluateBudgetAlerts({ policies: registry.policies, events, now });
  } catch (error) {
    warnings.push(`budget evaluation unavailable: ${error.message}`);
  }

  const ledger = summarizeCostLedger(events);
  return {
    version: 1,
    asOf: now,
    available: warnings.length === 0,
    configured: registry.present && registry.policies.length > 0,
    enforcement: "alert-only",
    warnings,
    pricing: {
      version: pricing?.updatedAt || null,
      derivedPrices: derived,
      providerReportedPrices: raw.filter((event) => event.costMicros != null).length,
      unpricedEvents: stillUnpriced,
    },
    totals: ledger.totals,
    alerts: evaluation.alerts,
    summary: evaluation.summary,
  };
}
