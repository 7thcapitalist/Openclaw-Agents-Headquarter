// Not every blocked task needs the founder. Three kinds:
//
//   "decision" — a stage explicitly asked the founder a question
//                (outcome "decision-required"). This is the ONLY kind that
//                belongs in the Founder Inbox / "Needs you".
//   "infra"    — the agent process failed for a transient/environmental reason
//                (no result file, timeout, rate limit, provider 5xx, socket
//                reset). An agent should just try again — the founder should
//                never see this.
//   "hard"     — a genuine failure the founder may want to look at (a stage
//                returned FAIL for a real reason, retry budget exhausted).
//
// Pure. Node builtins only.

const INFRA_FAIL_RE = new RegExp(
  [
    "did not write its result file",
    "no result file",
    "produced no result",
    "result file",
    "timed out", "timeout", "ETIMEDOUT", "ESOCKETTIMEDOUT",
    "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE",
    "socket hang up",
    "rate.?limit", "\\b429\\b", "\\b50[0-9]\\b",
    "quota", "overloaded", "temporarily unavailable", "capacity",
    "model .*unavailable", "provider", "upstream",
    "spawn .*ENOENT", "killed", "SIGTERM", "SIGKILL",
    // agent process never got off the ground / was lost with the host
    "could not run", "could not start", "cannot start", "failed to start",
    "start the cli", "unable to launch", "launch the cli",
    "orphaned", "host restart", "no longer running",
    "process (exited|died|was killed)",
  ].join("|"),
  "i",
);

// A high-risk task cannot even initialize until the founder's approval authority
// is configured (FACTORY_FOUNDER_PUBLIC_KEY). That is a founder setup action, not
// a code failure and not an infra hiccup — it must reach the Founder Inbox.
const FOUNDER_APPROVAL_SETUP_RE = new RegExp(
  [
    "founder public key",
    "high-risk task initialization requires",
    "FACTORY_FOUNDER_PUBLIC_KEY",
    "founder approval authority",
    "signed founder approval",
  ].join("|"),
  "i",
);

export function isFounderApprovalSetupFailure(text) {
  return FOUNDER_APPROVAL_SETUP_RE.test(String(text || ""));
}

// The canonical blocker for "this needs the founder before any work can start".
// Shared by the objective orchestrator (init-time) and the objective submission
// endpoint (preflight) so both surface it identically.
export function founderApprovalSetupBlocker({ stage = "init", at = new Date().toISOString() } = {}) {
  return {
    stage,
    outcome: "decision-required",
    founderAction: true,
    summary:
      "This objective was assessed high-risk, so it needs your signed approval before any code is written — "
      + "but the factory has no founder approval key configured. Set FACTORY_FOUNDER_PUBLIC_KEY to your Ed25519 "
      + "public key (see docs/software-factory/SETUP.md), restart Headquarters, then continue this objective. "
      + "It will pause once more for your signature before the builder stage.",
    at,
  };
}

export function classifyBlocker(blocker) {
  if (!blocker) return null;
  if (blocker.outcome === "decision-required") return "decision";
  // A blocker explicitly tagged as needing the founder is a decision even if a
  // generic catch-all never set `outcome`.
  if (blocker.founderAction === true) return "decision";
  if (blocker.outcome === "fail") {
    const text = String(blocker.summary || blocker.detail || blocker.reason || "");
    return INFRA_FAIL_RE.test(text) ? "infra" : "hard";
  }
  // Any other non-empty blocker outcome: treat as needing a look, not infra.
  return "hard";
}

// Classify a decomposed-objective NODE blocker. Unlike classifyBlocker(), this
// understands that the objective orchestrator relabels an infrastructure failure
// as `decision-required` (see objective/orchestrator.mjs). "infra" here means
// "safe for the system to retry without the founder".
export function classifyObjectiveNodeBlocker(blocker) {
  if (!blocker) return null;
  // 1. Explicit tag written by the orchestrator on newly-synthesized blockers.
  if (blocker.infra === true) return "infra";
  // 2. Backfill for objective-state.json written before the tag existed: match
  //    the orchestrator's exact synthesized sentence (specific enough to be safe).
  if (blocker.outcome === "decision-required"
      && /could not run/i.test(blocker.summary || "")
      && /retry the objective later|adjust model routing/i.test(blocker.summary || "")) {
    return "infra";
  }
  // 3. A genuine stage decision or a merge conflict stays with the founder.
  if (blocker.outcome === "decision-required") return "decision";
  // 4. fail → infra|hard via the existing regex; anything else → hard.
  return classifyBlocker(blocker);
}

// Is this blocker safe for the SYSTEM to retry on its own?
//
// Distinct from classifyBlocker(), which answers "who owns this now". Recovery
// escalation wraps an exhausted infrastructure failure as `decision-required`
// with `founderAction: true` so it appears in the Founder Inbox and cannot
// disappear silently — correct, but it also made every resume path treat a
// rate-limited seat as a decision only a human could clear. The two questions
// are different: the founder may well need to KNOW, while the work is still
// perfectly safe for the sweep to pick up once the window resets.
//
// The machine classification recorded at escalation time is authoritative.
export function isRetriableInfraBlocker(blocker) {
  if (!blocker) return false;
  if (classifyBlocker(blocker) === "infra") return true;
  if (blocker.classification === "INFRASTRUCTURE_ERROR") return true;
  // Recovery escalation keeps the ORIGINAL error in `why` and prefixes
  // `summary` with "Recovery could not continue after N bounded attempt(s)".
  // Judge the underlying cause, not the wrapper — otherwise an agent that
  // could not start the CLI reads as a project failure once recovery has
  // wrapped it, and the sweep will not pick it up when the seat returns.
  return INFRA_FAIL_RE.test(String(blocker.why || ""));
}

export function isInfraFailure(blocker) {
  return classifyBlocker(blocker) === "infra";
}

export function isFounderDecision(blocker) {
  return classifyBlocker(blocker) === "decision";
}
