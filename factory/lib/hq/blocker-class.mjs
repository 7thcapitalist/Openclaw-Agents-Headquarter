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

export function classifyBlocker(blocker) {
  if (!blocker) return null;
  if (blocker.outcome === "decision-required") return "decision";
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

export function isInfraFailure(blocker) {
  return classifyBlocker(blocker) === "infra";
}

export function isFounderDecision(blocker) {
  return classifyBlocker(blocker) === "decision";
}
