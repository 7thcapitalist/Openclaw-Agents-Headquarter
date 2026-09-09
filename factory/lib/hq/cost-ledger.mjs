// Adapted from Paperclip cost_events at commit
// 6abeb67334348dcb6fde2d591a27ffc7efc7118d (MIT).
import { randomUUID } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";

const TYPES = new Set(["usage", "correction", "reversal"]);
const CONFIDENCE = new Set(["provider-reported", "calculated", "estimated", "unavailable"]);
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;

export function createCostEvent(input, { now = () => new Date().toISOString(), id = randomUUID } = {}) {
  const event = { version: 1, eventId: input?.eventId || id(), eventType: input?.eventType || "usage", source: input?.source,
    sourceEventId: input?.sourceEventId, replacesEventId: input?.replacesEventId || null, occurredAt: input?.occurredAt || now(), recordedAt: now(),
    provider: input?.provider, model: input?.model, inputTokens: integer(input?.inputTokens), cachedInputTokens: integer(input?.cachedInputTokens), outputTokens: integer(input?.outputTokens),
    costMicros: input?.costMicros == null ? null : integer(input.costMicros), currency: input?.currency || "USD", pricingVersion: input?.pricingVersion || null,
    usageConfidence: input?.usageConfidence || "provider-reported", costConfidence: input?.costConfidence || (input?.costMicros == null ? "unavailable" : "provider-reported"),
    agentId: input?.agentId || null, projectId: input?.projectId || null, objectiveId: input?.objectiveId || null, taskId: input?.taskId || null,
    stage: input?.stage || null, runId: input?.runId || null, dispatchId: input?.dispatchId || null };
  return validateCostEvent(event);
}

export function appendCostEvent(path, event) {
  const valid = validateCostEvent(event); const prior = readCostEvents(path);
  if (prior.some((row) => row.eventId === valid.eventId || (row.source === valid.source && row.sourceEventId === valid.sourceEventId))) return { accepted: false, duplicate: true, event: prior.find((row) => row.eventId === valid.eventId || (row.source === valid.source && row.sourceEventId === valid.sourceEventId)) };
  if (valid.eventType !== "usage" && !prior.some((row) => row.eventId === valid.replacesEventId)) throw new Error("Correction/reversal references an unknown event");
  mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 }); appendFileSync(path, `${JSON.stringify(valid)}\n`, { mode: 0o600 }); return { accepted: true, duplicate: false, event: valid };
}

export function readCostEvents(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line, index) => { try { return validateCostEvent(JSON.parse(line)); } catch (error) { throw new Error(`Invalid cost ledger line ${index + 1}: ${error.message}`); } });
}

export function summarizeCostLedger(events) {
  const valid = events.map(validateCostEvent); const superseded = new Set(valid.filter((x) => x.replacesEventId).map((x) => x.replacesEventId));
  const effective = valid.filter((x) => !superseded.has(x.eventId) && x.eventType !== "reversal");
  const total = bucket(); const dimensions = { byProvider: {}, byModel: {}, byAgent: {}, byProject: {}, byTask: {}, byStage: {} };
  for (const event of effective) { add(total, event); for (const [name, key] of [["byProvider", event.provider], ["byModel", event.model], ["byAgent", event.agentId], ["byProject", event.projectId], ["byTask", event.taskId], ["byStage", event.stage]]) if (key) add(dimensions[name][key] ||= bucket(), event); }
  return { version: 1, totals: total, ...dimensions, effectiveEvents: effective.length, recordedEvents: valid.length };
}

export function validateCostEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Invalid cost event");
  if (event.version !== 1 || !TYPES.has(event.eventType)) throw new Error("Invalid cost event version/type");
  for (const key of ["eventId", "source", "sourceEventId", "provider", "model"]) safe(event[key], key);
  if (!Number.isFinite(Date.parse(event.occurredAt)) || !Number.isFinite(Date.parse(event.recordedAt))) throw new Error("Invalid cost event time");
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens"]) if (!Number.isInteger(event[key]) || event[key] < 0) throw new Error(`${key} must be a non-negative integer`);
  if (event.costMicros != null && (!Number.isInteger(event.costMicros) || event.costMicros < 0)) throw new Error("costMicros must be non-negative or null");
  if (!/^[A-Z]{3}$/.test(event.currency || "")) throw new Error("currency must be an ISO-style code");
  if (!CONFIDENCE.has(event.usageConfidence) || !CONFIDENCE.has(event.costConfidence)) throw new Error("Invalid confidence");
  if (event.eventType !== "usage") safe(event.replacesEventId, "replacesEventId");
  for (const key of ["agentId", "projectId", "objectiveId", "taskId", "stage", "runId", "dispatchId", "pricingVersion"]) if (event[key] != null) safe(event[key], key);
  return event;
}
function bucket() { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costMicros: 0, unpricedEvents: 0, events: 0 }; }
function add(out, event) { out.inputTokens += event.inputTokens; out.cachedInputTokens += event.cachedInputTokens; out.outputTokens += event.outputTokens; out.events += 1; if (event.costMicros == null) out.unpricedEvents += 1; else out.costMicros += event.costMicros; }
function integer(value) { const number = Number(value || 0); return Number.isInteger(number) && number >= 0 ? number : -1; }
function safe(value, label) { if (!SAFE.test(String(value || ""))) throw new Error(`${label} is invalid`); }
