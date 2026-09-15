// Conversations with an agent, and the work they propose.
//
// The founder wanted what the OpenClaw Control UI gives him — many threads with
// the Chief of Staff — but inside this dashboard, where the factory is. The
// difference that matters is the last clause: a thread here can propose work.
//
// WHAT WAS ALREADY THERE. `answerFounderQuestion` has run a chat turn since
// #262: one `openclaw agent` call against the session key
// `agent:main:founder-control-plane`. OpenClaw keeps the full multi-turn
// history for that key in its own SQLite store, so the conversation has existed
// all along — hard-coded to one thread, with only the last answer kept. This
// module is that turn with a thread identifier in front of it and a transcript
// behind it.
//
// THE RULE THAT SHAPES THE REST. An agent's reply is model output, which makes
// it the least trusted text in this system. `interactions.mjs` states the
// standard for founder-authored text; agent-authored text is held higher, not
// lower. So a reply cannot act. It can only PROPOSE, and it proposes by naming
// a kind from the one closed allowlist the console already uses:
//
//     factory/lib/integrations/intent-protocol.mjs — INTENT_KINDS
//
// A proposal is validated by `validateIntent`, the same function, against the
// same list. If the Chief of Staff names something the founder cannot already
// click in this dashboard, it is rejected and recorded as rejected. It never
// becomes a new capability, and the allowlist stays the single enumeration of
// what can happen here.
//
// What a proposal produces is a BUTTON. The founder's click is the authority —
// and on that click the intent takes the ordinary path, through
// `checkCapability`, the escalation gate, and the signed founder-approval gate
// for anything high-risk. Nothing here is a way around a gate.
//
// So the blast radius of a prompt injection that reaches the Chief of Staff is:
// a button appears. It cannot click it. That is asserted by test.

import { validateIntent } from "../integrations/intent-protocol.mjs";

export const THREADS_CONTRACT = "hq.threads/1";

// Bounds, stated here so they are a decision rather than an accident. A chat is
// the easiest unbounded growth in this system: every turn appends, nothing ever
// compacts, and the control store is read whole on every request.
export const LIMITS = Object.freeze({
  threads: 20,
  turnsPerThread: 100,
  turnChars: 8_000,
  titleChars: 80,
  proposalsPerTurn: 3,
  // A per-thread daily ceiling. Each turn is a full model call carrying the
  // factory context, and the cost ledger under-reports by ~1,150x, so the
  // spend will not show up where the founder looks for it. A cap he can see
  // beats a bill he cannot.
  turnsPerDay: 40,
});

const THREAD_ID = /^thread-[a-z0-9]+-[a-f0-9]{8}$/;

/**
 * The OpenClaw session key for a thread. DERIVED, never accepted from a caller.
 *
 * This is the same rule `question.ask` follows by refusing to carry an agent id
 * from the network: a session key selects which conversation an agent resumes,
 * so letting a request name one would let it read or poison another thread.
 */
export function deriveSessionKey(agentId, threadId) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(agentId || ""))) throw new Error("invalid agentId");
  if (!THREAD_ID.test(String(threadId || ""))) throw new Error("invalid threadId");
  return `agent:${agentId}:founder-${threadId}`;
}

export function isThreadId(value) {
  return THREAD_ID.test(String(value || ""));
}

function clip(value, max) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return { value: null, truncated: false };
  return s.length > max ? { value: s.slice(0, max), truncated: true } : { value: s, truncated: false };
}

/** A thread's title: its first founder turn, on one line. */
export function titleFrom(text) {
  const oneLine = String(text || "").replace(/\s+/g, " ").trim();
  if (!oneLine) return "Untitled";
  return oneLine.length > LIMITS.titleChars ? `${oneLine.slice(0, LIMITS.titleChars - 1)}…` : oneLine;
}

// ── the proposal seam ────────────────────────────────────────────────────────

// One fenced block, parsed as JSON. A fence is used rather than a bare JSON
// reply because the founder asked for a conversation: the agent has to be able
// to explain itself in prose and still name an action unambiguously.
const PROPOSAL_BLOCK = /```hq-proposal\s*\n([\s\S]*?)\n?```/g;

/**
 * Split an agent reply into the prose the founder reads and the proposals the
 * dashboard renders as buttons.
 *
 * Never throws. A malformed proposal is recorded as rejected and the prose
 * still renders — a reply must never be lost because its proposal was bad.
 *
 * @returns {{ text: string, proposals: Array<{kind, args, status, reason}> }}
 */
export function extractProposals(reply) {
  const raw = String(reply || "");
  const proposals = [];

  const text = raw.replace(PROPOSAL_BLOCK, (_match, body) => {
    if (proposals.length >= LIMITS.proposalsPerTurn) {
      proposals.push(reject(null, null, `more than ${LIMITS.proposalsPerTurn} proposals in one reply`));
      return "";
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      proposals.push(reject(null, null, "proposal is not valid JSON"));
      return "";
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      proposals.push(reject(null, null, "proposal must be an object"));
      return "";
    }

    const kind = typeof parsed.kind === "string" ? parsed.kind : null;
    const args = parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args) ? parsed.args : {};

    // The same validator, the same closed allowlist, the same rejection of
    // shell metacharacters, paths, URLs and module specifiers that an intent
    // arriving from the internet gets. An agent is not more trusted than the
    // network; on this path it is less.
    const verdict = validateIntent({ kind, args });
    if (!verdict.ok) {
      proposals.push(reject(kind, args, verdict.reason));
      return "";
    }
    proposals.push({ kind, args, status: "proposed", reason: null });
    return "";
  }).trim();

  return { text, proposals };
}

function reject(kind, args, reason) {
  return { kind: kind ? String(kind).slice(0, 60) : null, args: args || {}, status: "rejected", reason };
}

// ── shaping ──────────────────────────────────────────────────────────────────

/** One turn, bounded and attributed. Pure. */
export function shapeTurn(turn, index = 0) {
  const body = clip(turn?.text, LIMITS.turnChars);
  const role = turn?.role === "agent" ? "agent" : "founder";
  return {
    id: String(turn?.id || `turn-${index}`),
    role,
    text: body.value || (role === "agent" ? "(no reply recorded)" : "(empty)"),
    truncated: body.truncated,
    at: iso(turn?.at),
    // Proposals belong to agent turns only. A founder turn carrying one would
    // mean the founder's own text had been parsed for actions, which is a
    // different feature with a different argument.
    proposals: role === "agent" ? shapeProposals(turn?.proposals) : [],
    error: clip(turn?.error, 500).value,
  };
}

function shapeProposals(proposals) {
  if (!Array.isArray(proposals)) return [];
  return proposals.slice(0, LIMITS.proposalsPerTurn).map((p, i) => ({
    id: String(p?.id || `proposal-${i}`),
    kind: p?.kind ? String(p.kind).slice(0, 60) : null,
    args: p?.args && typeof p.args === "object" ? p.args : {},
    status: ["proposed", "rejected", "accepted", "failed"].includes(p?.status) ? p.status : "rejected",
    reason: clip(p?.reason, 300).value,
    // What happened after the founder clicked. Null until he does.
    detail: clip(p?.detail, 500).value,
    acceptedAt: iso(p?.acceptedAt),
  }));
}

function iso(value) {
  const t = Date.parse(value || "");
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Shape threads for a surface. Never throws.
 *
 * `detail` selects one thread's full transcript; without it every thread is
 * returned with its turns omitted, because the list view needs titles and the
 * transcript of twenty threads is not a payload anyone asked for.
 */
export function buildThreadsPanel(threads, { now = new Date(), detailId = null } = {}) {
  const asOf = (now instanceof Date ? now : new Date(now)).toISOString();

  if (!Array.isArray(threads)) {
    return {
      version: 1, contract: THREADS_CONTRACT, asOf, available: false,
      reason: "The conversation record could not be read.",
      threads: [], summary: { total: 0, running: 0 },
    };
  }

  const shaped = threads.slice(0, LIMITS.threads).map((thread) => {
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    const base = {
      id: String(thread?.id || ""),
      agentId: String(thread?.agentId || "main"),
      title: titleFrom(thread?.title),
      status: ["idle", "running", "failed"].includes(thread?.status) ? thread.status : "idle",
      createdAt: iso(thread?.createdAt),
      updatedAt: iso(thread?.updatedAt),
      turnCount: turns.length,
      turnsToday: countToday(turns, asOf),
    };
    if (detailId && base.id === detailId) {
      base.turns = turns.slice(-LIMITS.turnsPerThread).map(shapeTurn);
    }
    return base;
  });

  return {
    version: 1, contract: THREADS_CONTRACT, asOf, available: true,
    limits: LIMITS,
    threads: shaped,
    summary: {
      total: shaped.length,
      running: shaped.filter((t) => t.status === "running").length,
    },
  };
}

/** Founder turns started today, against the day of `asOf`. */
export function countToday(turns, asOf = new Date().toISOString()) {
  const day = String(asOf).slice(0, 10);
  return (Array.isArray(turns) ? turns : [])
    .filter((t) => t?.role === "founder" && String(t?.at || "").slice(0, 10) === day).length;
}

// ── teaching the agent how to propose ────────────────────────────────────────
//
// An agent cannot propose work in a format nobody told it about. This is that
// briefing, and it is sent ONCE, prepended to the first founder message of a
// thread — after which OpenClaw's own session memory carries it, which is the
// same mechanism that carries the rest of the conversation.
//
// It is generated from `INTENT_KINDS` rather than written out, so the list the
// agent is told about cannot drift from the list the validator enforces. If a
// kind is added to the allowlist, the next new thread knows about it; if one is
// removed, no thread can be told it still exists.
//
// This string is OURS. Nothing founder-authored or agent-authored is
// interpolated into it — it is a constant assembled from a frozen allowlist,
// which is what keeps "the agent's instructions" from becoming another place
// untrusted text can reach.
export function proposalProtocol(kinds) {
  const list = Object.entries(kinds)
    .map(([kind, spec]) => `- ${kind} — args: ${spec.args.length ? spec.args.join(", ") : "(none)"}`)
    .join("\n");

  return [
    "You are being spoken to from the founder's Headquarters dashboard, not a terminal.",
    "",
    "You can propose work, and the founder starts it with one click. To propose,",
    "end your reply with a fenced block exactly like this:",
    "",
    "```hq-proposal",
    '{"kind": "objective.start", "args": {"objective": "...", "projectId": "..."}}',
    "```",
    "",
    "The only actions that exist are these:",
    list,
    "",
    "Rules:",
    "- Explain your reasoning in plain prose first. The block is the last thing in the reply.",
    "- At most one proposal per reply unless the founder asked for several.",
    "- Propose nothing when you are answering a question. A conversation is not a work order.",
    "- Anything outside that list will be rejected, so do not invent a kind or an argument.",
    "- You cannot run these yourself. The founder clicks; that is deliberate.",
  ].join("\n");
}
