// Founder-facing presentation of objective / task / node state.
//
// Pure. It reads the state the factory already records (objective-state.json,
// task state.json, blocker text) and derives the small set of human-legible
// fields the command center needs: a short title, one normalized status word,
// a one- or two-sentence blocker explanation, progress, and the single next
// action. It creates no new state and senses nothing new — every field traces
// to something already in the state files.
//
// Node builtins only.

import { classifyBlocker, isFounderApprovalSetupFailure } from "./blocker-class.mjs";

// ── the founder-facing statuses ──────────────────────────────────────────────
export const STATUS = {
  RUNNING: "RUNNING",
  RECOVERING: "RECOVERING",
  COMPLETE: "COMPLETE",
  BLOCKED: "BLOCKED",
  FAILED: "FAILED",
  WAITING_FOR_FOUNDER: "WAITING_FOR_FOUNDER",
  PENDING: "PENDING",
  CANCELLED: "CANCELLED",
};

const STATUS_META = {
  RUNNING: { label: "Running", tone: "info", icon: "▶" },
  RECOVERING: { label: "Recovering", tone: "warn", icon: "↻" },
  COMPLETE: { label: "Complete", tone: "good", icon: "✓" },
  BLOCKED: { label: "Blocked", tone: "warn", icon: "‖" },
  FAILED: { label: "Failed", tone: "bad", icon: "✕" },
  WAITING_FOR_FOUNDER: { label: "Waiting for you", tone: "warn", icon: "◆" },
  PENDING: { label: "Pending", tone: "neutral", icon: "·" },
  CANCELLED: { label: "Cancelled", tone: "neutral", icon: "⊘" },
};

export function statusMeta(status) {
  return STATUS_META[status] || STATUS_META.PENDING;
}

// ── seed / example data ─────────────────────────────────────────────────────
// Objectives under these project keys are demo/smoke fixtures, never the
// founder's real work. Kept explicit so the portfolio can separate them.
export const SEED_PROJECT_KEYS = new Set(["demo", "lm-demo", "hq-e2e-demo", "hq-e2e", "tiny-project"]);

export function isSeedProject(key) {
  const k = String(key || "").toLowerCase();
  if (SEED_PROJECT_KEYS.has(k)) return true;
  return /(^|[-_])demo($|[-_])|(^|[-_])smoke($|[-_])|(^|[-_])example($|[-_])|(^|[-_])fixture($|[-_])/.test(k);
}

// ── title derivation ────────────────────────────────────────────────────────

const ACRONYMS = new Set([
  "hq", "pr", "prs", "qa", "ui", "ux", "api", "apis", "cli", "ci", "cd", "sdk",
  "id", "ids", "url", "urls", "json", "yaml", "html", "css", "js", "es", "npm", "http",
  "https", "e2e", "mvp", "kpi", "kpis", "sql", "db", "os", "io", "ai", "llm",
  "github", "openclaw", "openai", "gpt", "claude",
]);

const STOP_AFTER_VERB = new Set([
  "a", "an", "the", "this", "that", "these", "those", "our", "your", "my", "its",
  "some", "any", "all", "one", "new", "small", "simple", "basic",
]);
const DROP_ANYWHERE = new Set(["the", "a", "an"]);
const TRAILING_CONNECTORS = /^(with|from|that|which|and|or|of|in|on|to|for|by|so|as|per|the|a|an|at|into|onto|its|it)$/i;

// Substrings that mark the end of the useful part of an objective sentence.
const BREAK_MARKERS = [
  ": ", ", ", " - ", " — ", " – ", " (", " so that ", " so the ", " so a ", " so it ",
  " so we ", " so you ", " so i ", " for the founder", " that lets ", " that will ",
  " that shows ", " that exports ", " which lets ", " which will ", " in order to ",
  " without ", " across ", " per task", " per stage",
];

const LEAD_VERBS = new Set([
  "build", "add", "implement", "create", "make", "fix", "improve", "refactor",
  "redesign", "rework", "wire", "move", "ship", "enable", "introduce", "remove",
  "replace", "update", "support", "expose", "surface", "give", "turn", "split",
  "connect", "design", "harden", "document", "investigate", "review", "analyze",
  "analyse", "audit", "extend", "migrate", "port", "consolidate", "unify",
  "simplify", "restore", "recover", "handle", "prevent", "stop", "let", "show",
  "render", "display", "generate", "compute", "track", "record", "log", "cache",
]);

const MISSION_PREFIX = /^\s*(?:mission|objective|goal|task|deliverable|context|summary)\s*[—\-:]\s*/i;

function stripLead(text) {
  let t = String(text || "").trim();
  t = t.replace(/^["'“”`]+/, "").replace(/["'“”`]+$/, "");
  t = t.replace(/^#+\s*/, "");
  t = t.replace(MISSION_PREFIX, "");
  return t.trim();
}

// The first useful clause of an objective: strip the lead, keep the first
// sentence / line, then cut at the first "so that / : / ( / that shows …" break.
function firstClause(text) {
  const t = stripLead(text);
  const sentenceMatch = t.match(/^[\s\S]*?[.!?](?:\s|$)/);
  let s = (sentenceMatch ? sentenceMatch[0] : (t.split(/\r?\n/)[0] || t)).trim();
  let cut = s.length;
  for (const marker of BREAK_MARKERS) {
    const i = s.toLowerCase().indexOf(marker);
    if (i > 0 && i < cut) cut = i;
  }
  return s.slice(0, cut).replace(/[.!?,;:]+$/, "").trim();
}

// tokenize a clause into title words: keep a leading imperative verb, drop the
// filler determiner right after it, drop bare articles anywhere, stop at a file
// path, cap at maxWords, and never end on a dangling connector.
function titleWords(clause, maxWords) {
  const words = clause.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out = [];
  const firstLower = words[0].toLowerCase().replace(/[^a-z-]/g, "");
  let i = 0;
  if (LEAD_VERBS.has(firstLower)) {
    out.push(words[0]);
    i = 1;
    while (i < words.length && STOP_AFTER_VERB.has(words[i].toLowerCase().replace(/[^a-z-]/g, ""))) i += 1;
  }
  for (; i < words.length && out.length < maxWords; i += 1) {
    const clean = words[i].replace(/[.,;:]+$/, "");
    if (!clean) continue;
    if (looksLikePath(clean)) break;
    if (DROP_ANYWHERE.has(clean.toLowerCase())) continue;
    out.push(clean);
  }
  while (out.length > 1 && TRAILING_CONNECTORS.test(out[out.length - 1])) out.pop();
  return out;
}

function looksLikePath(word) {
  return /[\/\\:@]/.test(word) || /\.(mjs|jsx?|tsx?|json|md|css|html|sh|py)$/.test(word);
}

function titleCaseWord(word) {
  if (!word) return word;
  const lower = word.toLowerCase();
  if (ACRONYMS.has(lower)) {
    return lower === "github" ? "GitHub" : lower === "openclaw" ? "OpenClaw" : lower === "openai" ? "OpenAI" : word.toUpperCase();
  }
  // keep hyphenated compounds readable: "dependency-free" -> "Dependency-free"
  if (word.includes("-")) {
    const [head, ...rest] = word.split("-");
    return [titleCaseWord(head), ...rest].join("-");
  }
  // preserve an already-camelCased identifier
  if (/[a-z][A-Z]/.test(word)) return word;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function titleCase(text) {
  return String(text || "")
    .split(/\s+/)
    .filter(Boolean)
    .map(titleCaseWord)
    .join(" ");
}

// A concise, human title for a founder objective, derived from its own text.
// Deterministic: no model call. Falls back gracefully for odd inputs.
export function deriveObjectiveTitle(text, { maxWords = 6, fallback = "Untitled objective" } = {}) {
  const clause = firstClause(text);
  if (!clause) return fallback;
  const picked = titleWords(clause, maxWords);
  const title = titleCase(picked.join(" ")).trim();
  if (title.length >= 3) return title;
  const alt = titleCase(clause.split(/\s+/).slice(0, maxWords).join(" ")).trim();
  return alt.length >= 3 ? alt : fallback;
}

// A short phrase for a node / task, from its one-sentence contract outcome.
export function shortPhrase(text, { maxWords = 9 } = {}) {
  const clause = firstClause(text);
  if (!clause) return "";
  const words = clause.split(/\s+/).filter(Boolean);
  const picked = [];
  for (const w of words) {
    if (picked.length >= maxWords) break;
    const clean = w.replace(/[.,;:]+$/, "");
    if (looksLikePath(clean)) break;
    picked.push(clean);
  }
  while (picked.length > 1 && TRAILING_CONNECTORS.test(picked[picked.length - 1])) picked.pop();
  const s = picked.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── blocker explanation ─────────────────────────────────────────────────────

const RE = {
  rebase: /merge conflict|CONFLICT \(content\)|mergeable\s*=\s*CONFLICTING|CONFLICTING\s*\/\s*DIRTY|does not merge into main|not rebased|has not been rebased|origin\/main advanced|merge-base is .* but origin\/main|git merge-tree .* (?:exits 1|confirms)/i,
  notMergeReady: /NOT MERGE READY/i,
  infra: /could not (?:start|run)|start the cli|cannot start the cli|no result file|did not write (?:its|the) result|dispatch wrote no result|rate.?limit|\b429\b|cooldown|quota|temporarily unavailable|provider .* unavailable|ECONNREFUSED|ETIMEDOUT|timed out|host restart|orphaned/i,
  testFail: /\btest(?:s)? (?:failed|fail)\b|npm run test.* (?:fail|\b[1-9]\d* failed)|assertion (?:error|failed)|\bFAIL\b .*\.test\./i,
  reviewReject: /reviewer\b.*(?:reject|BLOCKING|NOT? APPROVE|changes requested)|review\b.*\bfail/i,
  qaReject: /\bqa\b.*(?:reject|fail|falsif)/i,
  securityReject: /security\b.*(?:CRITICAL|HIGH|reject|fail|finding)/i,
  mergeConflictWord: /merge conflict integrating/i,
};

function firstMeaningfulSentence(text, max = 160) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const m = clean.match(/^.*?[.!?](?:\s|$)/);
  let s = (m ? m[0] : clean).trim();
  if (s.length > max) s = `${s.slice(0, max).replace(/\s+\S*$/, "")}…`;
  return s;
}

// blocker: the raw { stage, outcome, summary, at } object off a node/task.
// decisionQuestion: an already-parsed founder-decision-card question, if any.
export function briefBlocker(blocker, { decisionQuestion = null } = {}) {
  if (!blocker) return null;
  const summary = String(blocker.summary || blocker.detail || blocker.reason || "");
  const cls = classifyBlocker(blocker);
  const raw = summary;

  if (blocker.whatFailed || blocker.whatFactoryTried || blocker.whatItNeedsFromFounder) {
    return {
      kind: "decision",
      needsFounder: true,
      headline: blocker.whatFailed || "Recovery could not continue",
      detail: [
        `Why: ${blocker.why || summary || "unknown"}`,
        `Factory tried: ${blocker.whatFactoryTried || "not recorded"}`,
        `Needs from you: ${blocker.whatItNeedsFromFounder || "a decision to continue"}`,
        `After approval: ${blocker.whatHappensAfterApproval || "the original task will resume when safe"}`,
      ].join(" "),
      raw,
    };
  }

  // Infra text wins even if the orchestrator relabeled the outcome as
  // decision-required — the founder should see "recovering", not "answer me".
  if (RE.infra.test(summary) || cls === "infra") {
    return {
      kind: "infra",
      autoRecovering: true,
      headline: "An agent couldn't start — the system is retrying this automatically.",
      detail: "This is an infrastructure hiccup, not a problem with the work. No action needed unless it keeps happening.",
      raw,
    };
  }

  // A high-risk objective that can't start until the founder's approval key is
  // configured. Its own decision-required branch would work, but give it a clean
  // headline and keep it robust even if a catch-all forgot to set `outcome`.
  if (blocker.founderAction === true || isFounderApprovalSetupFailure(summary)) {
    return {
      kind: "decision",
      needsFounder: true,
      headline: "This objective needs your approval before any work can start.",
      detail: "It was assessed high-risk. Configure the founder approval key (FACTORY_FOUNDER_PUBLIC_KEY, see docs/software-factory/SETUP.md), then continue it — it will pause once more for your signature.",
      raw,
    };
  }

  if (blocker.outcome === "decision-required" || cls === "decision") {
    const q = decisionQuestion || firstMeaningfulSentence(summary, 120) || "A stage needs your direction to continue.";
    return {
      kind: "decision",
      needsFounder: true,
      headline: q,
      detail: "Answer this to unblock the work — one click, or a sentence in your own words.",
      raw,
    };
  }

  if (RE.rebase.test(summary) || RE.mergeConflictWord.test(summary)) {
    return {
      kind: "rebase-needed",
      headline: "The branch fell behind `main` and needs a rebase before it can merge.",
      detail: "Every gate passed on the work itself — this is a merge-mechanics issue. Continuing the objective re-runs the affected part against the current `main`.",
      raw,
    };
  }
  if (RE.testFail.test(summary)) {
    return { kind: "test-failure", headline: "A check failed on the built change.", detail: firstMeaningfulSentence(summary), raw };
  }
  if (RE.securityReject.test(summary)) {
    return { kind: "security-reject", headline: "Security review raised a finding that must be addressed.", detail: firstMeaningfulSentence(summary), raw };
  }
  if (RE.reviewReject.test(summary)) {
    return { kind: "review-reject", headline: "Independent review asked for changes before this can merge.", detail: firstMeaningfulSentence(summary), raw };
  }
  if (RE.qaReject.test(summary)) {
    return { kind: "qa-reject", headline: "QA could not verify the acceptance criteria.", detail: firstMeaningfulSentence(summary), raw };
  }
  if (RE.notMergeReady.test(summary)) {
    return { kind: "not-mergeable", headline: "The work passed its gates but isn't merge-ready yet.", detail: firstMeaningfulSentence(summary), raw };
  }

  return {
    kind: "hard",
    headline: firstMeaningfulSentence(summary) || `The ${blocker.stage || "current"} stage stopped and needs a look.`,
    detail: "",
    raw,
  };
}

// ── node + objective normalization ──────────────────────────────────────────

// node: a shaped node row ({ status, blocker, dependsOn, ... }).
export function normalizeNodeStatus(node) {
  const s = String(node?.status || "");
  if (s === "gate-satisfied") return STATUS.COMPLETE;
  if (s === "running") return STATUS.RUNNING;
  if (s === "pending") return STATUS.PENDING;
  if (s === "blocked-by-dep") return STATUS.PENDING;
  if (s === "cancelled") return STATUS.CANCELLED;
  if (s === "blocked" || s === "failed") {
    const brief = briefBlocker(node?.blocker);
    if (brief?.autoRecovering) return STATUS.RECOVERING;
    if (brief?.needsFounder) return STATUS.WAITING_FOR_FOUNDER;
    return s === "failed" ? STATUS.FAILED : STATUS.BLOCKED;
  }
  return STATUS.PENDING;
}

const ROLE_LABEL = {
  product: "Product", architect: "Architect",
  "backend-builder": "Backend Builder", "frontend-builder": "Frontend Builder",
  builder: "Builder", reviewer: "Reviewer", qa: "QA", security: "Security",
  release: "Release", integration: "Integration",
};

export function roleLabel(role) {
  return ROLE_LABEL[String(role || "").toLowerCase()] || titleCase(String(role || "").replace(/-/g, " ")) || "—";
}

export function stageVerb(stage) {
  return ({
    product: "shaping the spec", architect: "designing the approach", builder: "writing the code",
    reviewer: "reviewing the change", qa: "testing it", security: "checking security",
    release: "checking merge-readiness", integration: "merging the parts",
  })[String(stage || "").toLowerCase()] || (stage ? `working on ${stage}` : "working");
}

// obj: a shaped objective from buildObjectivesView (nodes[], integration, status).
export function presentObjective(obj) {
  const description = String(obj?.objective || "");
  const title = deriveObjectiveTitle(description) || obj?.objectiveId || "Objective";
  const allNodes = [...(obj?.nodes || []), obj?.integration].filter(Boolean);
  const nodeStatuses = allNodes.map((n) => ({ node: n, status: normalizeNodeStatus(n) }));

  const total = allNodes.length;
  const done = nodeStatuses.filter((x) => x.status === STATUS.COMPLETE).length;
  const running = nodeStatuses.filter((x) => x.status === STATUS.RUNNING).length;
  const recovering = nodeStatuses.filter((x) => x.status === STATUS.RECOVERING).length;
  const failedNodes = nodeStatuses.filter((x) => x.status === STATUS.FAILED);
  const waitingNodes = nodeStatuses.filter((x) => x.status === STATUS.WAITING_FOR_FOUNDER);
  const plainBlocked = nodeStatuses.filter((x) => x.status === STATUS.BLOCKED);

  let status;
  switch (obj?.status) {
    case "complete": status = STATUS.COMPLETE; break;
    // Terminal and founder-declared: node evidence cannot argue a cancelled
    // objective back into Running, which is the whole point of cancelling.
    case "cancelled": status = STATUS.CANCELLED; break;
    case "active":
      // The objective flag means the orchestrator has not reached a terminal
      // state; it does not prove an agent is currently executing. Derive the
      // Founder status from node evidence so stale/failed dispatches cannot be
      // presented as live work.
      if (waitingNodes.length) status = STATUS.WAITING_FOR_FOUNDER;
      else if (failedNodes.length) status = STATUS.FAILED;
      else if (plainBlocked.length) status = STATUS.BLOCKED;
      else if (running) status = STATUS.RUNNING;
      else if (recovering) status = STATUS.RECOVERING;
      else status = STATUS.PENDING;
      break;
    case "invalid": status = STATUS.FAILED; break;
    default: {
      // blocked / integration-blocked / incomplete: let the nodes decide.
      if (waitingNodes.length) status = STATUS.WAITING_FOR_FOUNDER;
      else if (failedNodes.length) status = STATUS.FAILED;
      else if (plainBlocked.length) status = STATUS.BLOCKED;
      else if (running) status = STATUS.RUNNING;
      else if (recovering) status = STATUS.RECOVERING;
      else if (done < total) status = STATUS.PENDING;
      else status = STATUS.BLOCKED;
    }
  }
  if (status === STATUS.RUNNING && total > 0 && done === 0 && running === 0) status = recovering ? STATUS.RECOVERING : STATUS.PENDING;

  const meta = statusMeta(status);

  // the single most relevant blocker to explain, if any
  const focusEntry = waitingNodes[0] || failedNodes[0] || plainBlocked[0]
    || nodeStatuses.find((x) => x.status === STATUS.RUNNING && x.node?.blocker) || null;
  const blockerBrief = focusEntry?.node?.blocker
    ? briefBlocker(focusEntry.node.blocker, { decisionQuestion: focusEntry.node.decisionCard?.question || obj?.decisionQuestion || null })
    : null;

  const progress = {
    done, total, running,
    blocked: failedNodes.length + waitingNodes.length + plainBlocked.length,
    label: total === 0
      ? "waiting to start"
      : done === total
        ? "all parts done"
        : `${done} of ${total} part${total === 1 ? "" : "s"} done`,
  };

  const builders = [...new Set((obj?.nodes || []).map((n) => n.role).filter(Boolean))].map(roleLabel);

  const nextAction = deriveNextAction({
    status, blockerBrief, running,
    hasReport: Boolean(obj?.hasReport ?? obj?.reportAvailable),
    prUrl: obj?.prUrl,
  });

  // headline: what the founder should take away in one line
  let headline;
  if (status === STATUS.CANCELLED) headline = "Cancelled by you — no further work will run on it.";
  else if (status === STATUS.COMPLETE) headline = obj?.prUrl ? "Done — a PR is open for your review." : "Done — delivered on its branch.";
  else if (status === STATUS.WAITING_FOR_FOUNDER) headline = blockerBrief?.headline || "Needs a decision from you.";
  else if (status === STATUS.FAILED) headline = blockerBrief?.headline || "A part failed and can't continue on its own.";
  else if (status === STATUS.BLOCKED) headline = blockerBrief?.headline || "Stuck — needs a look.";
  else if (status === STATUS.RUNNING) headline = `${running} part${running === 1 ? "" : "s"} working now · ${progress.label}`;
  else if (status === STATUS.RECOVERING) headline = recovering ? `${recovering} part${recovering === 1 ? "" : "s"} recovering automatically · ${progress.label}` : `${progress.label} · recovery pending`;
  else headline = "Queued — not started yet.";

  return {
    objectiveId: obj?.objectiveId || null,
    title,
    description,
    status,
    statusLabel: meta.label,
    statusTone: meta.tone,
    statusIcon: meta.icon,
    headline,
    progress,
    blockerBrief,
    nextAction,
    builders,
    isSeed: isSeedProject(obj?.project),
    nodeStatuses: nodeStatuses.map(({ node, status: ns }) => ({
      id: node.id,
      title: node.title ? shortPhrase(node.title) : shortPhrase(node.contract?.outcome || node.id),
      role: roleLabel(node.role || "integration"),
      status: ns,
      statusLabel: statusMeta(ns).label,
      statusTone: statusMeta(ns).tone,
      stage: node.stage || null,
      elapsedMs: node.elapsedMs ?? null,
      retries: node.retries || node.attempts || 0,
      waitingOn: node.status === "blocked-by-dep" ? (node.dependsOn || []).map((d) => String(d).replace(/^obj-[0-9a-f]{8}-/, "")) : [],
      blocker: node.blocker ? briefBlocker(node.blocker, { decisionQuestion: node.decisionCard?.question || null }) : null,
      hasReport: Boolean(node.hasReport),
    })),
  };
}

function deriveNextAction({ status, blockerBrief, running, hasReport, prUrl }) {
  // Nothing is owed on cancelled work; the report stays reachable as the record.
  if (status === STATUS.CANCELLED) {
    return hasReport
      ? { kind: "view-report", label: "View report", primary: false }
      : { kind: "none", label: null, primary: false };
  }
  if (status === STATUS.WAITING_FOR_FOUNDER) {
    return { kind: "resolve-decision", label: "Resolve decision", primary: true };
  }
  if (status === STATUS.FAILED || status === STATUS.BLOCKED) {
    return { kind: "continue-objective", label: "Continue objective", primary: true };
  }
  if (status === STATUS.COMPLETE) {
    return prUrl
      ? { kind: "open-pr", label: "Open PR", href: prUrl, primary: true }
      : { kind: "view-report", label: "View report", primary: false };
  }
  if (status === STATUS.RUNNING) {
    // "running" with nothing actually executing means every remaining part is
    // waiting on an infra retry — give the founder a manual nudge.
    if (!running) return { kind: "continue-objective", label: "Retry now", primary: false };
    return hasReport
      ? { kind: "view-report", label: "View progress report", primary: false }
      : { kind: "none", label: null, primary: false };
  }
  return { kind: "none", label: null, primary: false };
}
