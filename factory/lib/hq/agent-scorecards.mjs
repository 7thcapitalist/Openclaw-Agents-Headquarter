// Outcome-based agent reliability scorecards.
//
// Adapted from Paperclip's `tool-runtime-metrics` and `agent-task-run-telemetry`
// services at pinned commit 6abeb67334348dcb6fde2d591a27ffc7efc7118d (MIT).
// Issue #123.
//
// What this deliberately does NOT measure: message count, dispatch count, raw
// activity, wall-clock speed, or cheapness. Every one of those is trivially
// gamed by an agent doing more, faster, worse work, and rewarding them is how a
// factory ends up optimising for looking busy. The unit here is the ACCEPTED
// OUTCOME — a stage a downstream independent gate actually passed — and cost is
// only ever reported per accepted outcome, never as a number to minimise.
//
// Scorecards inform routing. They must never silently override it: factory
// routing lives in factory.config.json and nothing here writes to it. A
// scorecard is evidence for a human changing routing, not a router.

import { existsSync, readFileSync, readdirSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { readCostEvents, summarizeCostLedger } from "./cost-ledger.mjs";
import { loadPricing, priceUsage } from "./cost.mjs";
import { defaultStateRoot } from "./tasks.mjs";

// Below this many accepted-or-rejected outcomes, a rate is noise. The number is
// reported either way; `confidence` is what stops a founder acting on 1/1.
const LOW_CONFIDENCE = 5;
const MEDIUM_CONFIDENCE = 20;

const GATE_STAGES = new Set(["reviewer", "qa", "security"]);

export function buildAgentScorecards({ hqRoot, stateRoot = null, ledgerPath = null, now = new Date().toISOString() } = {}) {
  const warnings = [];
  const root = resolve(stateRoot || defaultStateRoot(hqRoot));
  const agents = new Map();

  for (const statePath of stateFiles(root)) {
    const taskId = basename(dirname(statePath));
    try {
      collectTask(JSON.parse(readFileSync(statePath, "utf8")), agents);
    } catch (error) {
      warnings.push(`task ${taskId} scorecard input unavailable: ${error.message}`);
    }
  }

  const { byAgent, unpricedByAgent, pricingVersion } = agentCosts({ hqRoot, ledgerPath, warnings });

  const scorecards = [...agents.entries()]
    .map(([agentId, tally]) => scorecard(agentId, tally, byAgent.get(agentId) || null, unpricedByAgent.get(agentId) || 0))
    .sort((a, b) => b.sampleSize - a.sampleSize || a.agentId.localeCompare(b.agentId));

  return {
    version: 1,
    asOf: now,
    available: warnings.length === 0,
    warnings,
    pricingVersion,
    // Stated in the payload so a consumer cannot mistake this for a router.
    usage: "advisory-only",
    summary: {
      agents: scorecards.length,
      lowConfidence: scorecards.filter((card) => card.confidence === "low").length,
      missingCostData: scorecards.filter((card) => card.cost.unpricedEvents > 0 || card.cost.micros === null).length,
    },
    scorecards,
  };
}

// ------------------------------------------------------------------ internals

function collectTask(state, agents) {
  const assignments = state.assignments || {};
  const dispatches = Array.isArray(state.dispatches) ? state.dispatches : [];
  const events = Array.isArray(state.events) ? state.events : [];
  const stages = state.stages || {};

  for (const dispatch of dispatches) {
    const agentId = dispatch.actor || assignments[dispatch.stage];
    if (!agentId || !dispatch.stage) continue;
    const tally = ensure(agents, agentId);
    tally.dispatches += 1;
    if (dispatch.attempt > 1) tally.retries += 1;

    const duration = durationMs(dispatch);
    if (duration != null) tally.latencies.push(duration);

    if (dispatch.outcome === "pass") tally.passed += 1;
    else if (dispatch.outcome === "fail") tally.failed += 1;
    else if (dispatch.outcome === "decision-required") tally.escalated += 1;

    // An outcome is ACCEPTED when the stage it produced ended up passing in
    // canonical state — not merely when the agent said it was done.
    if (dispatch.outcome === "pass" && stages[dispatch.stage]?.status === "pass") tally.accepted += 1;

    if (GATE_STAGES.has(dispatch.stage)) {
      tally.gateRuns += 1;
      if (dispatch.outcome === "fail") tally.gateFailuresRaised += 1;
    }
  }

  // A gate failing is a finding AGAINST whoever built the thing, and evidence
  // FOR the gate that caught it. Both facts belong on different scorecards.
  const builder = assignments.builder;
  for (const stage of GATE_STAGES) {
    if (stages[stage]?.status !== "fail" || !builder) continue;
    ensure(agents, builder).findingsAgainst += 1;
  }

  // Recovery events carry the RECOVERY agent as `actor` — it is the one doing
  // the diagnosing. Attributing them there credited the recovery agent with
  // every recovery in the factory (11 against a sample of 3, on live state),
  // which reads as "this agent needs a lot of recovery" and means the exact
  // opposite. A recovery is a fact about the agent whose stage failed, so these
  // are always attributed to the owner of `event.stage`.
  const CAUSED_BY_STAGE_OWNER = new Set(["recovery-diagnosing", "recovery-escalated"]);

  for (const event of events) {
    const agentId = CAUSED_BY_STAGE_OWNER.has(event.type)
      ? assignments[event.stage]
      : (event.actor && event.actor !== "system" && event.actor !== "factory" ? event.actor : assignments[event.stage]);
    if (!agentId) continue;
    const tally = ensure(agents, agentId);
    if (event.type === "failure-routed" || event.type === "auto-retry" || event.type === "manual-retry") tally.retryEvents += 1;
    if (event.type === "recovery-diagnosing") tally.recoveries += 1;
    if (event.type === "recovery-escalated") tally.escalations += 1;
  }
}

function scorecard(agentId, tally, costs, unpricedEvents) {
  const decided = tally.accepted + tally.failed;
  const acceptedOutcomes = tally.accepted;
  const micros = costs ? costs.costMicros : null;

  return {
    agentId,
    sampleSize: decided,
    confidence: decided >= MEDIUM_CONFIDENCE ? "high" : decided >= LOW_CONFIDENCE ? "medium" : "low",
    outcomes: {
      accepted: acceptedOutcomes,
      failed: tally.failed,
      escalated: tally.escalated,
      // Null rather than 0 when there is nothing to divide: an agent with no
      // decided outcomes has no acceptance rate, and 0% is a different claim.
      acceptanceRate: decided ? round(acceptedOutcomes / decided) : null,
    },
    quality: {
      // Findings raised against this agent's builds by an independent gate.
      findingsAgainst: tally.findingsAgainst,
      // Failures this agent raised while acting AS a gate. High is good here.
      gateFailuresRaised: tally.gateFailuresRaised,
      gateRuns: tally.gateRuns,
      recoveries: tally.recoveries,
      founderEscalations: tally.escalations,
      retryRate: tally.dispatches ? round(tally.retryEvents / tally.dispatches) : null,
    },
    latency: {
      medianMs: median(tally.latencies),
      samples: tally.latencies.length,
    },
    cost: {
      micros,
      unpricedEvents,
      // The only cost figure worth comparing. Cost alone rewards an agent that
      // gives up early; cost per accepted outcome does not.
      microsPerAcceptedOutcome: micros != null && acceptedOutcomes ? Math.round(micros / acceptedOutcomes) : null,
      complete: micros != null && unpricedEvents === 0,
    },
    dataQuality: {
      dispatches: tally.dispatches,
      latencySamples: tally.latencies.length,
      missingCost: micros == null || unpricedEvents > 0,
      note: decided < LOW_CONFIDENCE ? "Too few decided outcomes to read as a rate." : null,
    },
  };
}

function agentCosts({ hqRoot, ledgerPath, warnings }) {
  const path = ledgerPath || join(resolve(hqRoot), ".openclaw-factory", "telemetry", "cost-events.ndjson");
  const byAgent = new Map();
  const unpricedByAgent = new Map();
  const pricing = loadPricing(hqRoot);

  let events = [];
  try {
    events = readCostEvents(path);
  } catch (error) {
    warnings.push(`cost ledger unavailable: ${error.message}`);
    return { byAgent, unpricedByAgent, pricingVersion: pricing?.updatedAt || null };
  }

  // Same read-time pricing as the budget snapshot: the ledger is append-only and
  // is never rewritten, and a model with no entry stays unpriced rather than
  // being counted as free.
  const priced = events.map((event) => {
    if (event.costMicros != null) return event;
    const quote = priceUsage({ provider: event.provider, model: event.model, tokensIn: event.inputTokens, tokensOut: event.outputTokens }, pricing);
    if (!quote || quote.costUsd == null) {
      if (event.agentId) unpricedByAgent.set(event.agentId, (unpricedByAgent.get(event.agentId) || 0) + 1);
      return event;
    }
    return { ...event, costMicros: Math.round(quote.costUsd * 1_000_000), costConfidence: "calculated" };
  });

  for (const [agentId, bucket] of Object.entries(summarizeCostLedger(priced).byAgent)) byAgent.set(agentId, bucket);
  return { byAgent, unpricedByAgent, pricingVersion: pricing?.updatedAt || null };
}

function ensure(agents, agentId) {
  if (!agents.has(agentId)) {
    agents.set(agentId, {
      dispatches: 0, accepted: 0, passed: 0, failed: 0, escalated: 0, retries: 0, retryEvents: 0,
      recoveries: 0, escalations: 0, findingsAgainst: 0, gateRuns: 0, gateFailuresRaised: 0, latencies: [],
    });
  }
  return agents.get(agentId);
}

function durationMs(dispatch) {
  const start = Date.parse(dispatch.startedAt || dispatch.createdAt || "");
  const end = Date.parse(dispatch.completedAt || "");
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function stateFiles(root, out = []) {
  if (!existsSync(root)) return out;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) stateFiles(path, out);
    else if (entry.isFile() && entry.name === "state.json") out.push(path);
  }
  return out;
}
