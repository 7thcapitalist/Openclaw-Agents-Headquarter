// What the founder asked the factory, and what it said back.
//
// The console can ask a question through the `question.ask` intent, but an
// intent's acknowledgement is a single line in a queue. The answer has to live
// somewhere the page can re-read on the next publish, which means it has to be
// published — hence this panel.
//
// INJECTED, NOT READ. The question store is `control-plane.json`, reached
// through dashboard/backend/lib/founderControlPlane.mjs, and factory/ must not
// import from dashboard/. The publisher script reads and hands the records
// here, exactly as it does for `tasks` and the overnight plan.
//
// THE ANSWER IS UNTRUSTED. It is an agent's output. It is stored, bounded and
// attributed here, and rendered as text by the console — never interpolated
// into a prompt, a handoff, or a command. factory/lib/hq/interactions.mjs
// states that rule for agent interactions; this panel is the same class of
// data and is held to it.

export const QUESTIONS_CONTRACT = "hq.questions/1";

// Bounded well under the mirror's own field cap so truncation is decided here,
// where it can be reported, rather than silently by the walk on the way out.
const MAX_ANSWER = 4_000;
const MAX_QUESTION = 2_000;

const STATUSES = ["queued", "running", "answered", "failed"];

function text(value, fallback = null) {
  const s = typeof value === "string" ? value.trim() : "";
  return s ? s : fallback;
}

function iso(value) {
  const t = Date.parse(value || "");
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function clip(value, max) {
  const s = text(value, null);
  if (s === null) return { value: null, truncated: false };
  return s.length > max
    ? { value: s.slice(0, max), truncated: true }
    : { value: s, truncated: false };
}

/**
 * Shape recent questions into a panel. Never throws.
 *
 * @param {Array|null} questions  records from listRecentQuestions(), or null
 */
export function buildQuestionsPanel(questions, { now = new Date(), limit = 10, reason = null } = {}) {
  const asOf = (now instanceof Date ? now : new Date(now)).toISOString();

  if (!Array.isArray(questions)) {
    return {
      version: 1,
      contract: QUESTIONS_CONTRACT,
      asOf,
      available: false,
      reason: reason || "The question record could not be read on the factory machine.",
      questions: [],
      summary: { total: 0, pending: 0, failed: 0 },
    };
  }

  const shaped = questions.slice(0, limit).map((record, index) => {
    const question = clip(record?.question, MAX_QUESTION);
    const answer = clip(record?.answer, MAX_ANSWER);
    const status = STATUSES.includes(record?.status) ? record.status : "queued";
    return {
      id: text(record?.id, `question-${index}`),
      question: question.value || "(no question recorded)",
      questionTruncated: question.truncated,
      // Which agent answered is attribution, and the founder should see it.
      agentId: text(record?.agentId, null),
      status,
      askedAt: iso(record?.askedAt),
      answeredAt: iso(record?.answeredAt),
      answer: answer.value,
      answerTruncated: answer.truncated,
      error: text(record?.error, null),
    };
  });

  return {
    version: 1,
    contract: QUESTIONS_CONTRACT,
    asOf,
    available: true,
    limit,
    questions: shaped,
    summary: {
      total: shaped.length,
      // "Still waiting" is the state the console polls on.
      pending: shaped.filter((q) => q.status === "queued" || q.status === "running").length,
      failed: shaped.filter((q) => q.status === "failed").length,
    },
  };
}
