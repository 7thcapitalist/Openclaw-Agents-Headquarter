// Founder-facing translation of the Founder Inbox.
//
// `buildFounderInbox` (dashboard/backend/lib/founderControlPlane.mjs) produces
// items that are faithful to factory state: stage names, retry diagnoses, raw
// objective prompts, task ids, option lists. That is the right payload for an
// operator and the wrong one for the founder, who must be able to open the
// inbox and answer four questions about every item in ten seconds:
//
//   1. What do you need from me?   2. Why?
//   3. What happens if I do it?    4. What should I click?
//
// This module is a pure projection onto those four questions. It creates no
// state, resolves nothing, and never drops information: every raw field stays
// on the item and is collected under `technical` for the "View details" fold.
// The factory's vocabulary stays inside the factory; the inbox speaks the
// founder's.
//
// Node builtins only. Imported by the control plane (server) and mirrored for
// rendering by dashboard/backend/public/lib/founderInbox.mjs (browser).

import { stageVerb } from "./presenter.mjs";

// ── the five founder-facing item types ──────────────────────────────────────
export const FOUNDER_INBOX_TYPES = {
  approval: { label: "Needs your approval", tone: "warn" },
  decision: { label: "Needs your decision", tone: "warn" },
  blocker: { label: "Blocked", tone: "bad" },
  question: { label: "Needs your input", tone: "info" },
  recovery: { label: "Factory needs your help", tone: "bad" },
};

// Priority tiers. Sorting is by what the founder is actually holding up, never
// by updatedAt / stage / severity string.
export const PRIORITY = {
  APPROVAL_GATE: 0,      // work is stopped at a gate only the founder can open
  BLOCKING_ACTIVE: 1,    // a live objective cannot move until this is answered
  RECOVERY: 2,           // the factory tried and could not fix it itself
  HIGH_IMPACT: 3,        // a real choice, but nothing is stalled behind it
  OTHER_ACTIONABLE: 4,
  INFORMATIONAL: 5,      // nothing to click here
};

// ── text helpers ────────────────────────────────────────────────────────────

const MISSION_PREFIX = /^\s*(?:mission|objective|goal|task|deliverable|context|summary)\s*[—\-:]\s*/i;

// Engineering adjectives that carry no meaning for the founder.
const JARGON_WORDS = new Set([
  "first-class", "provider-extensible", "standardized", "standardised", "typed",
  "end-to-end", "production-grade", "well-tested", "idiomatic", "deterministic",
  "canonical", "comprehensive", "robust", "read-only", "provider-agnostic",
  "extensible", "pluggable", "scaffolded", "durable",
]);

const TRAILING_CONNECTORS = /^(with|from|that|which|and|or|of|in|on|to|for|by|so|as|per|the|a|an|at|into|onto|its|it|plus)$/i;

// Where the useful part of an objective sentence ends. A comma counts, but only
// once enough of the sentence has been said — many objectives open with a short
// comma series and cutting at the first one leaves a fragment.
const CLAUSE_BREAKS = [
  ": ", ", ", " so that ", " so the ", " so we ", " so you ", " in order to ",
  " with a ", " with an ", " with the ", " that ", " which ", " while ",
  " plus ", " — ", " – ", " (",
];

// Words a clause must have before a break marker is allowed to end it.
const MIN_CLAUSE_WORDS = 4;

function flatten(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function firstSentence(text, max = 160) {
  const clean = flatten(text);
  if (!clean) return "";
  const match = clean.match(/^.*?[.!?](?:\s|$)/);
  let sentence = (match ? match[0] : clean).trim();
  if (sentence.length > max) sentence = `${sentence.slice(0, max).replace(/\s+\S*$/, "")}…`;
  return sentence;
}

// The founder's own question, when the factory recorded one. A decision card
// question is the single best inbox title there is — it is already written for
// a human — but only when it is short enough to read at a glance.
export function questionSentence(text, { max = 120 } = {}) {
  const clean = flatten(text);
  if (!clean) return "";
  const sentences = clean.match(/[^.!?]+[.!?]?/g) || [];
  const asked = sentences.map((s) => s.trim()).filter((s) => s.endsWith("?"));
  const short = asked.find((s) => s.length <= max);
  if (short) return short;
  const first = (sentences[0] || "").trim();
  return first && first.length <= max ? first : "";
}

// A short, human name for the work, derived from the objective prompt itself.
// Deterministic, no model call: strip the prompt scaffolding, keep the first
// clause, drop engineering adjectives, cap the length.
export function workTitle(objective, { maxWords = 8, fallback = "" } = {}) {
  let text = flatten(objective).replace(/^["'“”]+/, "").replace(MISSION_PREFIX, "").trim();
  if (!text) return fallback;

  const sentence = (text.match(/^.*?[.!?](?:\s|$)/)?.[0] || text).trim();
  const lower = sentence.toLowerCase();
  let cut = sentence.length;
  for (const marker of CLAUSE_BREAKS) {
    // Scan every occurrence: the first one may still be inside the opening
    // phrase ("Capture dispatch usage, calculate ..."), a later one is the
    // real end of the clause.
    for (let index = lower.indexOf(marker); index > 0; index = lower.indexOf(marker, index + 1)) {
      if (index >= cut) break;
      if (sentence.slice(0, index).split(/\s+/).filter(Boolean).length < MIN_CLAUSE_WORDS) continue;
      cut = index;
      break;
    }
  }

  const words = sentence.slice(0, cut).split(/\s+/).filter(Boolean);
  const kept = [];
  let truncated = false;
  for (const word of words) {
    if (kept.length >= maxWords) { truncated = true; break; }
    const bare = word.replace(/[.,;:]+$/, "").toLowerCase();
    if (JARGON_WORDS.has(bare)) continue;
    kept.push(word);
  }
  while (kept.length > 1 && TRAILING_CONNECTORS.test(kept[kept.length - 1].replace(/[.,;:]+$/, ""))) {
    kept.pop();
    truncated = true;
  }
  let title = kept.join(" ").replace(/[.,;:]+$/, "").trim();
  if (!title) return fallback;
  if (truncated) title += "…";
  return title.charAt(0).toUpperCase() + title.slice(1);
}

// ── cause translation ───────────────────────────────────────────────────────
//
// A one-line, jargon-free cause for a blocked or unrecoverable item. Matched
// against the raw blocker text the factory already writes; the unmatched case
// falls back to the first sentence rather than inventing an explanation.
const CAUSE_RULES = [
  [/session limit|usage limit|allowance|rate.?limit|\b429\b|quota|out of credits|credit balance|cooldown/i,
    "An agent ran out of its usage allowance for now."],
  [/no runtime agent is configured|unroutable|not a configured route|no such agent|agent .* not configured/i,
    "The work is assigned to an agent the factory no longer has."],
  [/merge conflict|CONFLICTING|rebase|fell behind|origin\/main advanced/i,
    "The branch fell behind the main line and no longer merges cleanly."],
  [/missing .*(credential|secret|token|api key)|credential.* (missing|not set)|not configured.*(key|secret|token)|FACTORY_FOUNDER_PUBLIC_KEY/i,
    "Something it needs to run — a credential or setting — isn't configured yet."],
  [/acceptance criteri|\bAC #?\d|criteri(?:on|a) .*(fail|not met)/i,
    "The finished work misses one of the things it was asked to do."],
  [/timed out|timeout|ETIMEDOUT|ECONNREFUSED|unavailable|5\d\d\b/i,
    "A step timed out or the service behind it was unreachable."],
  [/security .*(finding|CRITICAL|HIGH)|secret.*(isolation|leak|exposure)/i,
    "The security check found something that has to be fixed first."],
  [/test(?:s)? failed|\bFAIL\b|assertion/i,
    "A check on the built change did not pass."],
  [/already (?:shipped|merged|delivered)|superseded|never pushed/i,
    "The work was already delivered another way, so this pipeline is stale."],
];

export function plainCause(text, { max = 150 } = {}) {
  const raw = flatten(text);
  if (!raw) return "";
  for (const [pattern, plain] of CAUSE_RULES) {
    if (pattern.test(raw)) return plain;
  }
  return firstSentence(raw, max);
}

// "Recovery could not continue after 3 bounded attempt(s): <diagnosis>" — the
// orchestrator's own wording for "I tried and I am out of safe moves".
const RECOVERY_PREFIX = /^\s*recovery (?:could not|couldn't|cannot) continue(?:\s+after\s+(\d+)\s+bounded attempts?\(?s?\)?)?\s*:?\s*/i;

export function readRecovery(title) {
  const raw = String(title || "");
  const match = raw.match(RECOVERY_PREFIX);
  if (!match) return null;
  return { attempts: Number(match[1]) || null, diagnosis: raw.slice(match[0].length).trim() };
}

function attemptsPhrase(attempts) {
  if (!attempts) return "The factory retried this on its own and could not get past it.";
  return `The factory retried this ${attempts === 1 ? "once" : `${attempts} times`} on its own and could not get past it.`;
}

function waitingLabel(requestedAt, now) {
  const at = Date.parse(requestedAt || "");
  if (!at) return "";
  const mins = Math.max(0, Math.round((now - at) / 60000));
  if (mins < 60) return `waiting ${mins || 1}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `waiting ${hours}h`;
  return `waiting ${Math.round(hours / 24)}d`;
}

// Options that are not real one-click answers — they are placeholders the
// factory writes when a stage has no concrete alternatives to offer.
const PLACEHOLDER_OPTION = /^(provide direction|keep paused|approve and resume|submit signed approval|other\b)/i;

function realChoices(options) {
  return (options || [])
    .map((option) => String(option || "").trim())
    .filter((option) => option && !PLACEHOLDER_OPTION.test(option));
}

// A long option string ("A. Close as already-delivered: mark obj-… complete on
// the strength of merged PR #33 …") is a button label AND an explanation. Keep
// the label short; the full text stays in `technical.options`.
export function choiceLabel(option, { max = 64 } = {}) {
  const clean = flatten(option).replace(/\s*\(Recommended\)\s*$/i, "");
  const head = clean.split(/\s+[—–-]\s+|:\s+/)[0].trim() || clean;
  const label = head.length <= max ? head : `${head.slice(0, max).replace(/\s+\S*$/, "")}…`;
  return label || "This option";
}

function isRecommended(option) {
  return /\(recommended\)/i.test(String(option || ""));
}

// ── the translation ─────────────────────────────────────────────────────────

const PIPELINE_AFTER_APPROVAL = "Builder → Review → QA → Security → Release, then a pull request for you to merge.";

function approvalCard(item, work) {
  const setup = item.action === "configure-founder-approval";
  if (setup) {
    return {
      type: "blocker",
      title: "Set up your approval key before this can start",
      context: "This work is high-risk, so it can only start with your signature — and this machine has no founder signing key configured yet.",
      why: "Only you can approve high-risk work, and the factory has no way to check that it is really you.",
      next: "Once the key is in place, the work comes straight back here for a one-click approval.",
      actions: [],
      priority: PRIORITY.APPROVAL_GATE,
    };
  }
  return {
    type: "approval",
    title: work || "Approve a high-risk build",
    context: "The factory has finished planning this and is holding before it writes a single line of code.",
    why: "It is rated high-risk — it can touch deployment, credentials, or something hard to undo — so it cannot start without you.",
    next: PIPELINE_AFTER_APPROVAL,
    actions: [
      { intent: "approve", label: "Approve", tone: "primary" },
      { intent: "reject", label: "Reject", tone: "secondary" },
    ],
    priority: PRIORITY.APPROVAL_GATE,
  };
}

function choiceActions(item) {
  const choices = realChoices(item.options);
  const actions = choices.map((option) => ({
    intent: "choose",
    value: option,
    label: choiceLabel(option),
    tone: isRecommended(option) ? "primary" : "secondary",
  }));
  if (!actions.some((action) => action.tone === "primary") && actions.length) actions[0].tone = "primary";
  actions.push({
    intent: "direct",
    label: actions.length ? "Something else…" : "Tell the team what to do",
    tone: actions.length ? "secondary" : "primary",
  });
  return item.statePath ? actions : [];
}

// A stalled recovery has no real options of its own — the factory offers only
// its placeholders. Give the founder the two moves that actually exist: say
// what to do, or let it run again unchanged.
function recoveryActions(item) {
  const actions = choiceActions(item);
  if (!item.statePath) return actions;
  const canResume = (item.options || []).some((option) => /^approve and resume/i.test(String(option || "").trim()));
  if (!canResume) return actions;
  return [...actions, { intent: "choose", value: "Approve and resume", label: "Resume it anyway", tone: "secondary" }];
}

function recoveryCard(item, work, recovery) {
  return {
    type: "recovery",
    // The type label already says the factory is stuck; the title says which
    // piece of work is stuck, so a founder with three of these can tell them
    // apart in one pass.
    title: work || "The factory could not fix this on its own",
    context: `${attemptsPhrase(recovery.attempts)} ${plainCause(recovery.diagnosis)}`.trim(),
    // No separate "why you" line: the context already says the factory is out
    // of safe moves, and a second boilerplate line repeats on every card.
    why: "",
    next: "Say what should happen and the team picks the work back up exactly where it stopped.",
    actions: recoveryActions(item),
    priority: PRIORITY.RECOVERY,
  };
}

function decisionCard(item, work) {
  const postTask = item.kind === "post-task-decision" || item.deferred === true;
  const asked = questionSentence(item.title) || questionSentence(item.detail);
  const stage = item.stage || "";
  return {
    type: "decision",
    title: asked || (postTask ? "Decide how to close this out" : "Decide how this work should continue"),
    context: postTask
      ? "The work is already finished and safe. This is a call about how to close it out, and nothing is running while you decide."
      : `The team paused ${stage ? `while ${stageVerb(stage)}` : "partway through"} and needs your answer before it can go on.`,
    why: postTask
      ? "It changes what the finished work counts as, so the factory records your intent instead of guessing."
      : "This choice changes what actually gets built, so the factory will not decide it for you.",
    next: postTask
      ? "Your answer is recorded against the finished work. Nothing restarts."
      : "Your answer is recorded and the work resumes from where it stopped.",
    actions: choiceActions(item),
    priority: postTask ? PRIORITY.HIGH_IMPACT : PRIORITY.BLOCKING_ACTIVE,
  };
}

function blockedCard(item, work) {
  const cause = plainCause(item.detail || item.title);
  const missingSetup = /credential or setting|no longer has/.test(cause);
  return {
    type: "blocker",
    title: work || (missingSetup ? "Set up what this work is missing" : "This work cannot continue"),
    context: `${cause} The factory has used up the retries it can make safely, so nothing moves until you decide.`.trim(),
    why: "",
    next: missingSetup
      ? "Once the missing piece is in place, retry and the work carries on from the same step."
      : "Retry runs the same step again from the top. Nothing else about the work changes.",
    actions: item.taskId
      ? [
          { intent: "retry-task", label: "Retry", tone: "primary" },
          { intent: "report", label: "See what happened", tone: "secondary" },
        ]
      : [],
    priority: PRIORITY.BLOCKING_ACTIVE,
  };
}

function questionCard(item) {
  return {
    type: "question",
    title: questionSentence(item.detail) || firstSentence(item.detail, 120) || "An agent asked you something",
    context: "An agent asked this while working. It is already answered synchronously in Ask an agent — this is only a record.",
    why: "",
    next: "",
    actions: [],
    priority: PRIORITY.INFORMATIONAL,
  };
}

function failedJobCard(item, work) {
  const outcome = item.outcome || {};
  const decision = item.kind === "decision";
  return {
    type: decision ? "decision" : "blocker",
    title: decision
      ? (questionSentence(outcome.whatFounderMustDecide) || "Decide what to do with this request")
      : "This request stopped before it built anything",
    context: plainCause(outcome.detail || item.detail || item.title),
    why: "The request never got far enough to produce work anyone can review, so there is nothing for the factory to continue.",
    next: "Send the request again — adjusted if you want a different result — and it starts from scratch.",
    actions: [],
    priority: decision ? PRIORITY.HIGH_IMPACT : PRIORITY.OTHER_ACTIONABLE,
  };
}

function overnightCard(item, work) {
  return {
    type: "blocker",
    title: "An overnight request did not finish",
    context: `${plainCause(item.detail)} The rest of the overnight queue carried on.`.trim(),
    why: "Overnight work is never retried behind your back, so this one waits for you.",
    next: "Send it again when you want it, or leave it — nothing else is waiting on it.",
    actions: item.taskId ? [{ intent: "retry-task", label: "Retry", tone: "primary" }] : [],
    priority: PRIORITY.OTHER_ACTIONABLE,
  };
}

// Everything the operator view needs, collected in one place so the founder
// card can stay short and the "View details" fold can stay complete.
function technicalOf(item) {
  return {
    kind: item.kind || null,
    action: item.action || null,
    project: item.project || null,
    taskId: item.taskId || null,
    objectiveId: item.objectiveId || null,
    stage: item.stage || null,
    risk: item.risk || null,
    requestedAt: item.requestedAt || null,
    statePath: item.statePath || null,
    objective: item.objective || null,
    rawTitle: item.title || null,
    rawDetail: item.detail || null,
    recommendation: item.recommendation || null,
    options: item.options || [],
    outcome: item.outcome || null,
  };
}

/**
 * Translate one raw inbox item into the founder-facing card, keeping every raw
 * field intact. Returns a new object; never mutates the input.
 */
export function presentInboxItem(item, { now = Date.now() } = {}) {
  if (!item || typeof item !== "object") return item;
  const work = workTitle(item.objective, { fallback: "" });
  const recovery = readRecovery(item.title);

  let card;
  if (item.action === "review-failed-job") card = failedJobCard(item, work);
  else if (item.action === "review-overnight") card = overnightCard(item, work);
  else if (item.kind === "approval") card = approvalCard(item, work);
  else if (item.kind === "question") card = questionCard(item);
  else if (item.kind === "blocked") card = blockedCard(item, work);
  else if (recovery) card = recoveryCard(item, work, recovery);
  else card = decisionCard(item, work);

  // An item nobody can act on from here is never allowed to outrank one the
  // founder can actually resolve with a click.
  const priority = card.actions.length ? card.priority : Math.max(card.priority, PRIORITY.OTHER_ACTIONABLE);
  const typeMeta = FOUNDER_INBOX_TYPES[card.type] || FOUNDER_INBOX_TYPES.decision;

  return {
    ...item,
    founder: {
      type: card.type,
      typeLabel: typeMeta.label,
      tone: typeMeta.tone,
      title: card.title,
      subject: work,
      context: card.context,
      why: card.why,
      next: card.next,
      actions: card.actions,
      priority,
      waiting: waitingLabel(item.requestedAt, now),
    },
    technical: technicalOf(item),
  };
}

/**
 * Translate and order the whole inbox. Ordering is founder-first: what is
 * holding up work, then what the factory cannot fix, then real choices, then
 * everything else. Within a tier, high risk first, then the item that has been
 * waiting longest — never raw updatedAt across the whole list.
 */
export function presentFounderInbox(items = [], { now = Date.now() } = {}) {
  const riskRank = { high: 0, medium: 1, low: 2 };
  return (items || [])
    .map((item) => presentInboxItem(item, { now }))
    .sort((a, b) => {
      const byPriority = (a.founder?.priority ?? 9) - (b.founder?.priority ?? 9);
      if (byPriority) return byPriority;
      const byRisk = (riskRank[a.risk] ?? 3) - (riskRank[b.risk] ?? 3);
      if (byRisk) return byRisk;
      return String(a.requestedAt || "").localeCompare(String(b.requestedAt || ""));
    });
}
