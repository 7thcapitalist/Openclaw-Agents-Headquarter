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

// Kept deliberately in step with blocker-class.mjs's INFRA_FAIL_RE and the
// objective orchestrator's INFRA_FAILURE_RE. When these three disagree the same
// failure is infrastructure to one layer and the project's fault to another —
// which is how "[openclaw] Could not start the CLI" was classified PROJECT_ERROR
// and handed to recovery as if the code were broken.
//
// Every alternative here must be a phrase the ENVIRONMENT produces and a code
// review cannot. That constraint is not cosmetic: an INFRASTRUCTURE_ERROR is
// repaired against the factory rather than the project, and is picked up
// unattended by the resume sweep, so a real defect misfiled here is retried in
// silence and never reaches the founder — precisely the "it fails and I never
// get told" this overhaul set out to end.
//
// Bare English verbs were the trap. `could not run`, `cannot start`, `orphaned`,
// `usage limit`, `quota` and a lone `5\d\d` all matched ordinary review prose:
// "the retry helper could not run to completion", "523 assertions failed",
// "orphaned promise leaks a handle", "usage limit banner renders twice". Each
// alternative is therefore anchored to a subject that can only be the harness
// (an agent, a CLI, a provider, a seat) or to an explicit exhaustion verb.
// `failure-classification.test.mjs` pins both directions.
const INFRA = new RegExp([
  // Transport and OS-level faults — unambiguous on their own.
  "timeout", "timed out", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND",
  "EAI_AGAIN", "EPIPE", "socket hang up",
  // Provider throttling and seat exhaustion.
  "rate.?limit", "\\b429\\b", "cooldown", "all models failed",
  "(?:quota|usage limit|credits?|capacity|headroom)\\s*(?:is|was|has been)?\\s*(?:exceeded|exhausted|reached|hit|depleted|unavailable)",
  "(?:exceeded|exhausted|ran out of|out of)\\s+(?:quota|usage limit|credits?|capacity|headroom)",
  "temporarily unavailable", "overloaded",
  // HTTP 5xx, but only where an explicit status label makes it a transport
  // status rather than a count or a number under discussion. A bare "500 error"
  // stays PROJECT_ERROR: "500 error is returned instead of 400 for malformed
  // input" is a review finding about the product.
  "\\b(?:status|code|http|responded with|returned|response)\\s*:?\\s*5\\d\\d\\b",
  // The agent never produced a verdict at all.
  "no result file", "did not write", "wrote no result",
  // The harness itself could not be launched or kept alive. Anchored to the
  // thing that failed, so review prose about product code cannot match.
  "(?:could not|couldn't|cannot|can't|failed to|unable to)\\s+(?:start|run|launch|spawn|reach|resume)\\s+(?:the\\s+)?(?:cli|agent|harness|runtime|session|provider|model|openclaw|acpx|claude|codex|cursor)",
  "start the cli",
  "(?:provider|model|seat|profile)\\s+\\S*\\s*(?:is\\s+)?unavailable",
  "auth profile\\s+\\S*\\s*(?:missing|unavailable|not found|indeterminate|expired|invalid)",
  "orphaned\\s+(?:session|run|dispatch|worktree|process|lease)",
  "host restart",
].join("|"), "i");

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
