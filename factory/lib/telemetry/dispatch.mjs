// Operational adapter for the Paperclip-derived audit, liveness, and cost
// primitives. Canonical workflow state remains state.json; telemetry is a
// best-effort projection and can always be rebuilt from that state.
import { existsSync, mkdirSync, renameSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { appendAuditEvent, createAuditEvent, readAuditEvents } from "../audit/envelope.mjs";
import { createCostEvent, appendCostEvent } from "../hq/cost-ledger.mjs";
import { loadPricing, priceUsage } from "../hq/cost.mjs";
import { createRunLiveness } from "../liveness/run-liveness.mjs";
import { readState } from "../task-workflow.mjs";

export function telemetryPaths({ hqRoot, statePath }) {
  const taskDir = dirname(resolve(statePath));
  return {
    audit: join(taskDir, "audit.ndjson"),
    liveness: join(taskDir, "liveness.json"),
    costs: join(resolve(hqRoot), ".openclaw-factory", "telemetry", "cost-events.ndjson"),
  };
}

export function observeDispatchState({ hqRoot, statePath, phase, dispatchId = null, agentMeta = null, error = null, now = () => new Date().toISOString() }) {
  try {
    const state = readState(statePath);
    const dispatch = findDispatch(state, dispatchId);
    if (!dispatch) return { recorded: false, reason: "dispatch unavailable" };
    const paths = telemetryPaths({ hqRoot, statePath });
    const occurredAt = timestampFor(dispatch, phase, now);
    const eventId = `dispatch:${dispatch.id}:${phase}`;
    const prior = readAuditEvents(paths.audit);
    if (!prior.some((event) => event.eventId === eventId)) {
      appendAuditEvent(paths.audit, createAuditEvent({
        eventId,
        occurredAt,
        actor: { type: "agent", id: dispatch.agentId || dispatch.actor || "unknown-agent" },
        action: `dispatch.${phase}`,
        subject: { type: "task", id: state.task.id },
        correlation: { taskId: state.task.id, dispatchId: dispatch.id, stage: dispatch.stage },
        data: { outcome: dispatch.outcome || null, error: error || dispatch.error || null, kind: dispatch.kind || "stage" },
      }, { now }));
    }

    const liveness = createRunLiveness({
      runId: dispatch.id,
      taskId: state.task.id,
      state: livenessState(phase, state.status, dispatch),
      reason: livenessReason(phase, state, dispatch, error),
      nextAction: nextAction(phase, state),
      recoveryAttempt: state.recovery?.attempt || 0,
    }, { now });
    atomicJson(paths.liveness, liveness);

    const usage = agentMeta || dispatch.usage;
    if (usage?.provider && usage?.model && Number.isFinite(Number(usage.tokensIn)) && Number.isFinite(Number(usage.tokensOut))) {
      // Price here, at write time, with the pricer that already exists.
      //
      // Nothing ever priced on this path: `costMicros: usage.costMicros ?? null`
      // was always null because sanitizeUsage dropped the field and no lookup
      // ran. Read-time pricing still backfills older events, but an event that
      // knows its own cost when it is written is the one that cannot drift.
      //
      // Cached input is billable input, so it is included in the quote. A model
      // with no entry in factory/pricing.json stays null and is marked
      // `unpriced` — never zero, because a missing price must not read as free.
      const cachedIn = Number(usage.cachedInputTokens || 0);
      let costMicros = usage.costMicros ?? null;
      let costConfidence = costMicros == null ? "unpriced" : "provider-reported";
      let pricingVersion = null;
      if (costMicros == null) {
        const pricing = loadPricing(hqRoot);
        const quote = priceUsage({
          provider: usage.provider,
          model: usage.model,
          tokensIn: Number(usage.tokensIn || 0) + cachedIn,
          tokensOut: usage.tokensOut,
        }, pricing);
        if (quote && quote.costUsd != null) {
          costMicros = Math.round(quote.costUsd * 1_000_000);
          costConfidence = "calculated";
          pricingVersion = pricing?.updatedAt || null;
        }
      }
      appendCostEvent(paths.costs, createCostEvent({
        eventId: `cost:${dispatch.id}`,
        source: "openclaw-factory",
        sourceEventId: dispatch.id,
        occurredAt,
        provider: usage.provider,
        model: usage.model,
        inputTokens: usage.tokensIn,
        cachedInputTokens: cachedIn,
        outputTokens: usage.tokensOut,
        costMicros,
        pricingVersion,
        usageConfidence: "provider-reported",
        costConfidence,
        agentId: dispatch.agentId || dispatch.actor,
        projectId: state.task.project || state.task.projectId || null,
        objectiveId: state.task.objectiveId || null,
        taskId: state.task.id,
        stage: dispatch.stage,
        runId: dispatch.id,
        dispatchId: dispatch.id,
      }, { now, id: () => `cost:${dispatch.id}` }));
    }
    return { recorded: true, paths, liveness };
  } catch (caught) {
    return { recorded: false, reason: caught?.message || String(caught) };
  }
}

function findDispatch(state, dispatchId) {
  if (state.currentDispatch && (!dispatchId || state.currentDispatch.id === dispatchId)) return state.currentDispatch;
  const rows = state.dispatches || [];
  return dispatchId ? rows.find((row) => row.id === dispatchId) : rows.at(-1);
}

function timestampFor(dispatch, phase, now) {
  if (phase === "ready") return dispatch.createdAt || now();
  if (phase === "running") return dispatch.startedAt || now();
  return dispatch.completedAt || now();
}

function livenessState(phase, taskStatus, dispatch) {
  if (phase === "failed" || dispatch.status === "failed") return taskStatus === "blocked" ? "blocked" : "failed";
  if (["ready", "running", "yielded"].includes(phase)) return "needs-followup";
  if (taskStatus === "merge-ready" || taskStatus === "completed") return "completed";
  if (taskStatus === "blocked") return "blocked";
  return "advanced";
}

function livenessReason(phase, state, dispatch, error) {
  if (error || dispatch.error) return String(error || dispatch.error);
  if (phase === "yielded") return "OpenClaw retained ownership and is expected to resume this dispatch.";
  if (phase === "running") return "OpenClaw is executing the assigned factory stage.";
  if (phase === "ready") return "Factory dispatch is ready for its assigned OpenClaw agent.";
  return dispatch.summary || `Dispatch ${phase}; task is ${state.status}.`;
}

function nextAction(phase, state) {
  if (phase === "yielded") return "Resume the owned dispatch and write its result artifact.";
  if (state.status === "blocked") return "Inspect the task blocker and recovery evidence.";
  if (state.status === "active") return `Continue with ${state.currentStage}.`;
  return null;
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
