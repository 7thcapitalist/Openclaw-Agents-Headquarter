// Adapted from Paperclip's activity_log model at commit
// 6abeb67334348dcb6fde2d591a27ffc7efc7118d. Paperclip is MIT licensed;
// see docs/software-factory/PAPERCLIP_AUDIT_ATTRIBUTION.md.
import { randomUUID } from "crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "fs";
import { assertSupportedVersion } from "../store/durable-version.mjs";
import { dirname, resolve } from "path";
import { sanitizeExcerpt } from "../common/redact.mjs";

export const AUDIT_VERSION = 1;
export const ACTOR_TYPES = Object.freeze(["human", "agent", "system"]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const ACTION_RE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;

export function createAuditEvent(input, { now = () => new Date().toISOString(), id = randomUUID } = {}) {
  const event = {
    version: AUDIT_VERSION,
    eventId: input?.eventId || id(),
    occurredAt: input?.occurredAt || now(),
    actor: input?.actor,
    action: input?.action,
    subject: input?.subject,
    correlation: input?.correlation || {},
    data: sanitizeValue(input?.data || {}),
  };
  return validateAuditEvent(event);
}

export function validateAuditEvent(event) {
  const errors = [];
  if (!isRecord(event)) throw new Error("Invalid audit event: event must be an object");
  const allowed = new Set(["version", "eventId", "occurredAt", "actor", "action", "subject", "correlation", "data"]);
  for (const key of Object.keys(event)) if (!allowed.has(key)) errors.push(`${key} is not allowed`);
  if (event.version !== AUDIT_VERSION) errors.push(`version must be ${AUDIT_VERSION}`);
  checkId(event.eventId, "eventId", errors);
  if (!Number.isFinite(Date.parse(event.occurredAt || ""))) errors.push("occurredAt must be an ISO timestamp");
  checkParty(event.actor, "actor", errors, true);
  if (!ACTION_RE.test(event.action || "")) errors.push("action must be a dotted or hyphenated lowercase name");
  checkParty(event.subject, "subject", errors, false);
  if (!isRecord(event.correlation)) errors.push("correlation must be an object");
  else for (const [key, value] of Object.entries(event.correlation)) {
    if (!ID_RE.test(key) || !ID_RE.test(String(value || ""))) errors.push(`correlation.${key} must be a safe identifier`);
  }
  if (!isRecord(event.data)) errors.push("data must be an object");
  if (errors.length) throw new Error(`Invalid audit event:\n- ${errors.join("\n- ")}`);
  return event;
}

export function appendAuditEvent(path, event) {
  const valid = validateAuditEvent(event);
  mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(valid)}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
  chmodSync(path, 0o600);
  return valid;
}

export function readAuditEvents(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line, index) => {
    let parsed;
    try { parsed = JSON.parse(line); }
    catch (error) { throw new Error(`Invalid audit ledger line ${index + 1}: ${error.message}`); }
    assertSupportedVersion(parsed?.version, { format: "audit-event", path });
    try { return validateAuditEvent(parsed); }
    catch (error) { throw new Error(`Invalid audit ledger line ${index + 1}: ${error.message}`); }
  });
}

export function projectTaskEvents(state, { now = () => new Date().toISOString() } = {}) {
  const taskId = String(state?.task?.id || "unknown-task");
  return (Array.isArray(state?.events) ? state.events : []).map((legacy, index) => createAuditEvent({
    eventId: stableLegacyId(taskId, index),
    occurredAt: Number.isFinite(Date.parse(legacy.at || "")) ? legacy.at : now(),
    actor: normalizeLegacyActor(legacy.actor),
    action: normalizeAction(legacy.type),
    subject: { type: "task", id: taskId },
    correlation: {
      taskId,
      ...(legacy.dispatchId ? { dispatchId: String(legacy.dispatchId) } : {}),
      ...(legacy.stage ? { stage: String(legacy.stage) } : {}),
    },
    data: Object.fromEntries(Object.entries(legacy).filter(([key]) => !["at", "actor", "type", "dispatchId", "stage"].includes(key))),
  }, { now, id: () => stableLegacyId(taskId, index) }));
}

export function projectAuditEvents(events) {
  return [...events].map(validateAuditEvent).sort((a, b) =>
    a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId));
}

function sanitizeValue(value, depth = 0) {
  if (depth > 8) return "[redacted: depth-limit]";
  if (typeof value === "string") return sanitizeExcerpt(value, { maxLength: 1000 }).text;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeValue(item, depth + 1));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, sanitizeValue(item, depth + 1)]));
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  return String(value ?? "");
}

function checkParty(value, label, errors, actor) {
  if (!isRecord(value)) { errors.push(`${label} must be an object`); return; }
  const types = actor ? ACTOR_TYPES : ["task", "objective", "project", "agent", "run", "decision", "system"];
  if (!types.includes(value.type)) errors.push(`${label}.type is invalid`);
  checkId(value.id, `${label}.id`, errors);
}
function checkId(value, label, errors) { if (!ID_RE.test(String(value || ""))) errors.push(`${label} must be a safe identifier`); }
function normalizeLegacyActor(actor) {
  const id = String(actor || "system");
  return { type: id === "founder" ? "human" : id === "system" ? "system" : "agent", id };
}
function normalizeAction(type) {
  const clean = String(type || "event").toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
  return clean.includes(".") ? clean : `task.${clean || "event"}`;
}
function stableLegacyId(taskId, index) { return `legacy:${taskId}:${index}`; }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
