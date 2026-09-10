// Adapted from Paperclip budget policy evaluation at pinned commit
// 6abeb67334348dcb6fde2d591a27ffc7efc7118d (MIT). HQ V1 is alert-only.
import { summarizeCostLedger } from "./cost-ledger.mjs";
const SCOPES = new Set(["company", "project", "agent"]); const WINDOWS = new Set(["lifetime", "calendar-month-utc"]); const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;

export function evaluateBudgetAlerts({ policies, events, now = new Date().toISOString() }) {
  if (!Array.isArray(policies)) throw new Error("policies must be an array");
  const rows = policies.map(validatePolicy); const month = now.slice(0, 7);
  const alerts = rows.map((policy) => {
    const applicable = events.filter((event) => inScope(event, policy) && (policy.window === "lifetime" || String(event.occurredAt).slice(0, 7) === month));
    const summary = summarizeCostLedger(applicable); const observedMicros = summary.totals.costMicros; const unpricedEvents = summary.totals.unpricedEvents;
    const threshold = Math.ceil(policy.limitMicros * policy.warnPercent / 100);
    const status = unpricedEvents && !summary.totals.events ? "unavailable" : observedMicros >= policy.limitMicros ? "exceeded" : observedMicros >= threshold ? "warning" : "ok";
    return { version: 1, policyId: policy.id, scopeType: policy.scopeType, scopeId: policy.scopeId, window: policy.window, status,
      observedMicros, limitMicros: policy.limitMicros, remainingMicros: Math.max(0, policy.limitMicros - observedMicros), percent: policy.limitMicros ? Math.round(observedMicros / policy.limitMicros * 1000) / 10 : 0,
      unpricedEvents, evaluatedAt: now, action: "alert-only", message: message(status, policy, observedMicros, unpricedEvents) };
  });
  return { version: 1, evaluatedAt: now, enforcement: "alert-only", alerts, summary: { ok: alerts.filter((a) => a.status === "ok").length, warning: alerts.filter((a) => a.status === "warning").length, exceeded: alerts.filter((a) => a.status === "exceeded").length, unavailable: alerts.filter((a) => a.status === "unavailable").length } };
}
function validatePolicy(policy) { if (!SAFE.test(String(policy?.id || ""))) throw new Error("policy.id is invalid"); if (!SCOPES.has(policy.scopeType)) throw new Error(`policy '${policy.id}' scopeType is invalid`); if (!SAFE.test(String(policy.scopeId || ""))) throw new Error(`policy '${policy.id}' scopeId is invalid`); if (!WINDOWS.has(policy.window)) throw new Error(`policy '${policy.id}' window is invalid`); if (!Number.isInteger(policy.limitMicros) || policy.limitMicros <= 0) throw new Error(`policy '${policy.id}' limitMicros is invalid`); const warnPercent = policy.warnPercent ?? 80; if (!Number.isInteger(warnPercent) || warnPercent < 1 || warnPercent > 100) throw new Error(`policy '${policy.id}' warnPercent is invalid`); return { ...policy, warnPercent }; }
function inScope(event, policy) { if (policy.scopeType === "company") return true; return policy.scopeType === "project" ? event.projectId === policy.scopeId : event.agentId === policy.scopeId; }
function message(status, policy, observed, unpriced) { if (status === "exceeded") return `${policy.scopeType} budget exceeded; operator review required`; if (status === "warning") return `${policy.scopeType} budget reached ${policy.warnPercent}% warning threshold`; if (status === "unavailable") return "Budget cannot be evaluated from unpriced usage"; return unpriced ? `Within priced budget with ${unpriced} unpriced event(s)` : `Within budget (${observed} of ${policy.limitMicros} micros)`; }
