// Adapted from Paperclip issue checkout/run ownership semantics at commit
// 6abeb67334348dcb6fde2d591a27ffc7efc7118d (MIT). See attribution doc.
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class LeaseConflictError extends Error {
  constructor(lease) { super(`Task '${lease.taskId}' is leased by another run`); this.name = "LeaseConflictError"; this.code = "LEASE_CONFLICT"; this.lease = lease; }
}

export function acquireTaskLease({ root, taskId, actorId, runId, ttlMs = 60_000, now = Date.now, id = randomUUID, audit = () => {} }) {
  checkInputs({ root, taskId, actorId, runId, ttlMs });
  const dir = leaseDir(root, taskId);
  const existing = readLease(root, taskId);
  if (existing && existing.runId === runId && existing.actorId === actorId && !isExpired(existing, now())) return existing;
  if (existing && !isExpired(existing, now())) { auditEvent(audit, "lease.conflict", existing, { claimantActorId: actorId, claimantRunId: runId }); throw new LeaseConflictError(existing); }
  if (existing) retireExpired(dir, existing.leaseId);
  try { mkdirSync(dir, { recursive: false, mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new LeaseConflictError(readLease(root, taskId) || { taskId, actorId: "unknown", runId: "unknown" });
    throw error;
  }
  const acquiredAt = new Date(now()).toISOString();
  const lease = { version: 1, leaseId: id(), taskId, actorId, runId, acquiredAt, renewedAt: acquiredAt, expiresAt: new Date(Date.parse(acquiredAt) + ttlMs).toISOString() };
  writeLease(dir, lease);
  auditEvent(audit, existing ? "lease.recovered" : "lease.acquired", lease, existing ? { expiredLeaseId: existing.leaseId } : {});
  return lease;
}

export function renewTaskLease({ root, taskId, actorId, runId, ttlMs = 60_000, now = Date.now, audit = () => {} }) {
  checkInputs({ root, taskId, actorId, runId, ttlMs });
  const lease = requireOwner(readLease(root, taskId), { taskId, actorId, runId, now });
  const renewedAt = new Date(now()).toISOString();
  const renewed = { ...lease, renewedAt, expiresAt: new Date(Date.parse(renewedAt) + ttlMs).toISOString() };
  writeLease(leaseDir(root, taskId), renewed); auditEvent(audit, "lease.renewed", renewed); return renewed;
}

export function releaseTaskLease({ root, taskId, actorId, runId, now = Date.now, audit = () => {} }) {
  const lease = requireOwner(readLease(root, taskId), { taskId, actorId, runId, now, allowExpired: true });
  rmSync(leaseDir(root, taskId), { recursive: true }); auditEvent(audit, "lease.released", lease); return lease;
}

export function forceReleaseTaskLease({ root, taskId, operatorId, reason, audit = () => {} }) {
  if (!SAFE_ID.test(String(operatorId || ""))) throw new Error("operatorId is required for force release");
  if (typeof reason !== "string" || !reason.trim()) throw new Error("reason is required for force release");
  const lease = readLease(root, taskId); if (!lease) return null;
  rmSync(leaseDir(root, taskId), { recursive: true });
  auditEvent(audit, "lease.force-released", lease, { operatorId, reason: reason.trim().slice(0, 500) }); return lease;
}

export function readLease(root, taskId) {
  const path = join(leaseDir(root, taskId), "lease.json");
  if (!existsSync(path)) return null;
  try { return validateLease(JSON.parse(readFileSync(path, "utf8"))); }
  catch (error) { throw new Error(`Invalid task lease '${taskId}': ${error.message}`); }
}

function requireOwner(lease, { taskId, actorId, runId, now, allowExpired = false }) {
  if (!lease) throw new Error(`Task '${taskId}' has no lease`);
  if (lease.actorId !== actorId || lease.runId !== runId) throw new LeaseConflictError(lease);
  if (!allowExpired && isExpired(lease, now())) throw new Error(`Task '${taskId}' lease has expired`);
  return lease;
}
function validateLease(lease) {
  for (const key of ["leaseId", "taskId", "actorId", "runId"]) if (!SAFE_ID.test(String(lease?.[key] || ""))) throw new Error(`${key} is invalid`);
  for (const key of ["acquiredAt", "renewedAt", "expiresAt"]) if (!Number.isFinite(Date.parse(lease[key] || ""))) throw new Error(`${key} is invalid`);
  if (lease.version !== 1) throw new Error("version is invalid"); return lease;
}
function checkInputs({ root, taskId, actorId, runId, ttlMs }) {
  if (!root) throw new Error("root is required");
  for (const [key, value] of Object.entries({ taskId, actorId, runId })) if (!SAFE_ID.test(String(value || ""))) throw new Error(`${key} is invalid`);
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 86_400_000) throw new Error("ttlMs must be between 1000 and 86400000");
}
function leaseDir(root, taskId) { if (!SAFE_ID.test(String(taskId || ""))) throw new Error("taskId is invalid"); return resolve(root, `${taskId}.lease`); }
function isExpired(lease, now) { return Date.parse(lease.expiresAt) <= now; }
function retireExpired(dir, leaseId) { try { renameSync(dir, join(dirname(dir), `.${basename(dir)}.expired-${leaseId}-${randomUUID()}`)); } catch (error) { if (error.code !== "ENOENT") throw error; } }
function writeLease(dir, lease) { writeFileSync(join(dir, "lease.json"), `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 }); }
function auditEvent(audit, action, lease, data = {}) { audit({ action, actor: { type: "system", id: "lease-store" }, subject: { type: "task", id: lease.taskId }, correlation: { leaseId: lease.leaseId, runId: lease.runId }, data }); }
