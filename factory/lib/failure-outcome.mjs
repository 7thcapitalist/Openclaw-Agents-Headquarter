// The single terminal-outcome contract every factory entry path must produce.
//
// Before this module, a detached job that threw was recorded only as
// `{ status: "error", error: "<raw string>" }` and never reached the Founder
// Inbox, so the founder saw nothing at all. Every entry path — interactive task,
// interactive objective, decomposition, overnight loop, recovery, retry — now
// ends in ONE typed record carrying a plain-language headline, so no run can
// finish invisibly.
//
// This module decides nothing new about severity: it reuses the existing
// taxonomies (`failure-classification.mjs` for errors, `blocker-class.mjs` for
// stage blockers) and projects them onto the five outcomes the founder's views
// actually distinguish. A raw error string is never stored as the whole outcome.
//
// Pure. Node builtins only.

import { classifyFailure } from "./failure-classification.mjs";
import { classifyBlocker } from "./hq/blocker-class.mjs";
import { sanitizeExcerpt } from "./common/redact.mjs";

export const OUTCOME_CLASSES = Object.freeze([
  "merge-ready",             // finished; waiting only on the founder's merge
  "needs-founder-decision",  // a real question only the founder can answer
  "paused-credits",          // every usable seat is exhausted; resumes on its own
  "infra-retrying",          // transient environment failure; the factory retries
  "hard-failed",             // a genuine failure that recovery could not clear
]);

// Outcomes that must reach the Founder Inbox. `paused-credits` and
// `infra-retrying` are deliberately excluded: the founder asked never to be
// paged for infrastructure.
const FOUNDER_FACING = new Set(["needs-founder-decision", "hard-failed"]);

export function needsFounder(outcomeClass) {
  return FOUNDER_FACING.has(String(outcomeClass || ""));
}

// Credit/quota exhaustion specifically — NOT every infrastructure failure. A
// timeout or a reset socket is `infra-retrying` (retry now); an exhausted seat
// is `paused-credits` (wait for the window, then resume). Keeping these apart is
// what stops the factory burning its retry budget against a wall.
const CREDIT_EXHAUSTION_RE = new RegExp(
  [
    "rate.?limit", "\\b429\\b", "quota", "usage limit", "usage_limit",
    "temporarily unavailable", "cooldown", "insufficient .*credit",
    "out of credit", "credit balance", "billing", "overloaded",
    "auth profile .*unavailable", "capacity",
  ].join("|"),
  "i",
);

export function isCreditExhaustion(text) {
  return CREDIT_EXHAUSTION_RE.test(String(text || ""));
}

// ── error text redaction ─────────────────────────────────────────────────────

// execFile embeds the ENTIRE command in `error.message`, and the factory passes
// multi-kilobyte prompts as `--message <prompt>`. The founder-visible result was
// a 2KB wall of prompt text with the actual cause buried at the end — one of the
// concrete reasons failures read as "silent". Strip the prompt payload, keep the
// command shape and the cause.
export function redactDispatchError(text, { maxLength = 600 } = {}) {
  let out = String(text ?? "");

  // `--message <prompt>` / `--message-file <path>` run to the trailing flags.
  // Locate them positionally rather than with a greedy regex: the prompt itself
  // can contain anything, including sequences that look like flags.
  const messageIdx = out.search(/--message(?:-file)?\b/);
  if (messageIdx >= 0) {
    const tailIdx = out.lastIndexOf("--json");
    out = tailIdx > messageIdx
      ? `${out.slice(0, messageIdx)}--message <prompt redacted> ${out.slice(tailIdx)}`
      : `${out.slice(0, messageIdx)}--message <prompt redacted>`;
  }

  // Collapse the "Command failed: <cmd>" preamble to the agent it dispatched, so
  // the cause is not pushed off the end of the excerpt.
  out = out.replace(
    /Command failed:\s*openclaw\s+agent\s+--agent\s+(\S+)[\s\S]*?(?=\n|$)/,
    (_match, agent) => `openclaw agent --agent ${agent} failed`,
  );

  return sanitizeExcerpt(out, { maxLength }).text;
}

// The most informative text an execFile-style rejection carries. Mirrors
// decompose.mjs's `decompositionError`, which already got this right locally.
export function errorDetail(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  return String(
    error.stderr?.trim?.() || error.stdout?.trim?.()
    || (error.killed ? `process killed (${error.signal || "timeout"})` : "")
    || error.message || String(error),
  );
}

// ── headline ─────────────────────────────────────────────────────────────────

function formatResumeAfter(resumeAfter) {
  const ms = Date.parse(String(resumeAfter || ""));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short", hour: "numeric", minute: "2-digit",
  });
}

// One plain sentence a founder can act on without opening anything else.
export function founderHeadline({ outcomeClass, whatFailed, resumeAfter = null }) {
  const what = String(whatFailed || "This work").trim();
  switch (outcomeClass) {
    case "merge-ready":
      return `${what} is ready for you to review and merge.`;
    case "needs-founder-decision":
      return `${what} needs a decision from you before it can continue.`;
    case "paused-credits": {
      const when = formatResumeAfter(resumeAfter);
      return when
        ? `${what} is paused — every model seat is out of credit. It resumes automatically around ${when}.`
        : `${what} is paused — every model seat is out of credit. It resumes automatically when a seat frees up.`;
    }
    case "infra-retrying":
      return `${what} hit a temporary infrastructure problem. The factory is retrying automatically — no action needed.`;
    case "hard-failed":
    default:
      return `${what} failed and could not recover on its own.`;
  }
}

// ── the contract ─────────────────────────────────────────────────────────────

function classFromBlocker(blocker, detail) {
  // Parked by the runner on an exhausted seat (seat-exhaustion.mjs) — already
  // known, with its own reset time, so no prose match is needed.
  if (blocker?.outcome === "paused-credits") return "paused-credits";
  switch (classifyBlocker(blocker)) {
    case "decision": return "needs-founder-decision";
    case "infra": return isCreditExhaustion(detail) ? "paused-credits" : "infra-retrying";
    case "hard": return "hard-failed";
    default: return null;
  }
}

function classFromError(error, detail, source) {
  const classification = classifyFailure({ error: detail, source });
  if (classification === "FOUNDER_DECISION_REQUIRED") return "needs-founder-decision";
  if (classification === "INFRASTRUCTURE_ERROR" || error?.transient === true) {
    return isCreditExhaustion(detail) ? "paused-credits" : "infra-retrying";
  }
  return "hard-failed";
}

/**
 * Build the terminal-outcome record for one run.
 *
 * Exactly one of `error`, `blocker`, or `outcomeClass` drives the class:
 *   - `outcomeClass` — caller already knows (e.g. a successful merge-ready run)
 *   - `blocker`      — a stage returned a blocker; reuse blocker-class.mjs
 *   - `error`        — something threw; reuse failure-classification.mjs
 */
export function buildOutcome({
  error = null,
  blocker = null,
  outcomeClass = null,
  whatFailed = "This work",
  whatTheFactoryTried = null,
  whatFounderMustDecide = null,
  resumeAfter = null,
  evidencePaths = [],
  source = "execution",
  detail: detailOverride = null,
  now = () => new Date().toISOString(),
} = {}) {
  const rawDetail = detailOverride ?? (blocker
    ? String(blocker.summary || blocker.detail || blocker.reason || "")
    : errorDetail(error));
  const detail = redactDispatchError(rawDetail);

  let resolvedClass = outcomeClass;
  if (!resolvedClass && blocker) resolvedClass = classFromBlocker(blocker, detail);
  if (!resolvedClass && error) resolvedClass = classFromError(error, detail, source);
  if (!OUTCOME_CLASSES.includes(resolvedClass)) resolvedClass = "hard-failed";

  const classification = blocker
    ? classifyFailure({ outcome: blocker.outcome, error: detail, source })
    : classifyFailure({ error: detail, source });

  return {
    outcomeClass: resolvedClass,
    headline: founderHeadline({ outcomeClass: resolvedClass, whatFailed, resumeAfter: resumeAfter || blocker?.resumeAfter || null }),
    detail,
    whatFailed: String(whatFailed || "This work"),
    whatTheFactoryTried: whatTheFactoryTried || null,
    // Only a genuine decision carries a question; never invent one for infra.
    whatFounderMustDecide: resolvedClass === "needs-founder-decision"
      ? (whatFounderMustDecide || detail || "Review the blocker and give direction.")
      : null,
    resumeAfter: resolvedClass === "paused-credits" ? (resumeAfter || blocker?.resumeAfter || null) : null,
    evidencePaths: Array.isArray(evidencePaths) ? evidencePaths.filter(Boolean) : [],
    classification,
    needsFounder: needsFounder(resolvedClass),
    at: now(),
  };
}
