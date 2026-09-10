// Canonical failure taxonomy for the factory. Classification is deliberately
// deterministic: a failed run must never disappear behind a generic blocker.

export const FAILURE_CLASSES = Object.freeze([
  "AGENT_ERROR",
  "FACTORY_ERROR",
  "PROJECT_ERROR",
  "INFRASTRUCTURE_ERROR",
  "FOUNDER_DECISION_REQUIRED",
  "UNKNOWN",
]);

const INFRA = /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|rate.?limit|\b429\b|\b5\d\d\b|quota|overloaded|capacity|temporarily unavailable|no result file|did not write/i;
const FACTORY = /factory|orchestrator|workflow|state\.json|dispatch|protocol|invalid .*result|unsupported .*version|cannot advance|expected stage/i;

export function classifyFailure({ error = "", outcome = "fail", source = "execution", founderDecision = false } = {}) {
  const text = String(error || "");
  if (founderDecision || outcome === "decision-required") return "FOUNDER_DECISION_REQUIRED";
  if (INFRA.test(text)) return "INFRASTRUCTURE_ERROR";
  if (source === "factory" || FACTORY.test(text)) return "FACTORY_ERROR";
  if (source === "agent" || source === "harness") return "AGENT_ERROR";
  if (source === "project" || outcome === "fail") return "PROJECT_ERROR";
  return "UNKNOWN";
}

// What a recovery attempt should try to repair. Only a genuine project defect
// puts the project's code in scope; a dropped model call, an exhausted seat or
// a broken orchestrator leaves the deliverable untouched, so recovery must not
// treat the worktree as suspect — and the stages that already passed against
// that untouched code stay valid. UNKNOWN is deliberately conservative: an
// unclassified failure is inspected as a project defect rather than retried
// blindly in place.
export function repairTargetFor(kind) {
  if (kind === "PROJECT_ERROR" || kind === "UNKNOWN") return "project";
  return "factory";
}

export function isRecoverableFailure(kind) {
  return ["AGENT_ERROR", "FACTORY_ERROR", "PROJECT_ERROR", "INFRASTRUCTURE_ERROR", "UNKNOWN"].includes(kind);
}

export function recoveryStrategy(attempt) {
  return ["retry-recover", "deeper-diagnosis", "independent-review"][Math.max(0, Number(attempt || 1) - 1)] || "founder-escalation";
}
