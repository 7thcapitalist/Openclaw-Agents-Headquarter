// Asking the factory a question, from a page on the internet.
//
// This is the only genuinely new capability in the console campaign, and the
// only one where founder text reaches an agent. The tests are arranged around
// the three things that would make it unsafe or dishonest:
//
//   1. THE TEXT IS NEVER A COMMAND. It is passed to `openclaw` as one argv
//      element through execFile, which spawns no shell. If that ever became a
//      string concatenated into a command line, this file should fail.
//   2. WHICH AGENT ANSWERS IS NOT THE CALLER'S CHOICE. The allowlist carries
//      no agent id, so a question arriving from the network cannot select who
//      reads it.
//   3. A FAILURE IS RECORDED, NOT LOST. The answer arrives on a later publish;
//      a question that failed must say so rather than waiting forever.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  askFounderQuestion, answerFounderQuestion, founderQuestionError,
  isValidAgentId, listRecentQuestions,
} from "../../dashboard/backend/lib/founderControlPlane.mjs";
import { INTENT_KINDS, validateIntent } from "../lib/integrations/intent-protocol.mjs";
import { buildQuestionsPanel, QUESTIONS_CONTRACT } from "../lib/hq/questions.mjs";

function hq() {
  const root = mkdtempSync(join(tmpdir(), "hq-questions-"));
  const dataDir = join(root, "dashboard", "backend", "data", "factory");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "control-plane.json"), JSON.stringify({}));
  return root;
}

const envelope = (textOut) => JSON.stringify({ result: { payloads: [{ text: textOut }] } });

// ── 1. the text is never a command ───────────────────────────────────────────

test("the question is one argv element, and no shell is involved", async () => {
  const root = hq();
  const calls = [];
  const record = askFounderQuestion(root, { question: "What is blocking LifeMax?" });

  await answerFounderQuestion(root, record, {
    execFile: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: envelope("Two tasks are blocked on review.") };
    },
  });

  assert.equal(calls.length, 1);
  const { file, args } = calls[0];
  assert.equal(file, "openclaw", "the binary is named, never a shell");

  // The question must appear as its own element, immediately after --message,
  // and must not have been spliced into any other argument.
  const at = args.indexOf("--message");
  assert.ok(at >= 0, "--message must be present");
  assert.equal(args[at + 1], "What is blocking LifeMax?");
  assert.equal(args.filter((a) => a.includes("What is blocking")).length, 1,
    "the text appears exactly once, as its own argument");

  // And there is no `shell` option, which is what would reintroduce a command line.
  assert.ok(!calls[0].options?.shell, "execFile must never be given a shell");
});

test("a question carrying shell syntax is rejected by the protocol before it is ever run", () => {
  // The intent never reaches a handler: COMMAND_SHAPES refuses it at the door.
  for (const hostile of ["what is $(whoami)", "status; rm -rf /", "read ../../etc/passwd", "https://evil.test/x", "/etc/shadow"]) {
    const verdict = validateIntent({ kind: "question.ask", args: { question: hostile } });
    assert.equal(verdict.ok, false, `${hostile} must not validate`);
  }

  // Ordinary questions are unaffected — including ones that merely MENTION a
  // path or a URL. The absolute-path and scheme rules are ANCHORED: they refuse
  // a value that *is* a path or a URL, not one that talks about one. That is
  // the right line, because a question is not a command line — nothing here is
  // ever parsed, only passed as one argv element.
  for (const fine of [
    "What is blocking LifeMax?",
    "What is in /etc/hosts on the factory machine?",
    "Did the deploy to https://lifemax-umber.vercel.app succeed?",
    "Which agent owns the release stage",
  ]) {
    assert.equal(validateIntent({ kind: "question.ask", args: { question: fine } }).ok, true, fine);
  }
});

// ── 2. who answers is not the caller's choice ────────────────────────────────

test("the allowlist carries no agent id", () => {
  assert.deepEqual(INTENT_KINDS["question.ask"].args, ["question"],
    "an agent id here would let the network choose who reads the question");
  assert.equal(INTENT_KINDS["question.ask"].maxLen.question, 2000);

  // And an intent that tries to smuggle one is rejected rather than trimmed.
  const verdict = validateIntent({ kind: "question.ask", args: { question: "hello", agentId: "security" } });
  assert.equal(verdict.ok, false);
});

test("an invalid agent id is refused at the library boundary too", () => {
  const root = hq();
  assert.equal(isValidAgentId("main"), true);
  assert.equal(isValidAgentId("../evil"), false);
  assert.throws(() => askFounderQuestion(root, { question: "hi", agentId: "../evil" }), /valid agentId/);
  assert.throws(() => askFounderQuestion(root, { question: "   " }), /question is required/);
});

// ── 3. failures are recorded ─────────────────────────────────────────────────

test("a timeout is recorded on the question as a sentence the founder can read", async () => {
  const root = hq();
  const record = askFounderQuestion(root, { question: "What is slow?" });
  const answered = await answerFounderQuestion(root, record, {
    execFile: async () => { const e = new Error("timeout"); e.killed = true; throw e; },
    timeoutMs: 90_000,
  });
  assert.equal(answered.status, "failed");
  assert.match(answered.error, /did not answer within 90 seconds/);
});

test("unparseable output fails the question rather than the process", async () => {
  const root = hq();
  const record = askFounderQuestion(root, { question: "What?" });
  const answered = await answerFounderQuestion(root, record, {
    execFile: async () => ({ stdout: "not json" }),
  });
  assert.equal(answered.status, "failed");
  assert.ok(answered.error.length > 10);
});

test("the error mapper never leaks the underlying message", () => {
  const leaky = founderQuestionError(Object.assign(new Error("/home/joao-vitor/.secrets/token bad"), { code: 3 }));
  assert.ok(!leaky.includes("/home/"), "a host path must not reach the founder-facing sentence");
  assert.match(leaky, /process code 3/);
});

// ── the published panel ──────────────────────────────────────────────────────

test("the panel publishes the answer, bounded and attributed", async () => {
  const root = hq();
  const record = askFounderQuestion(root, { question: "What is blocking LifeMax?" });
  await answerFounderQuestion(root, record, { execFile: async () => ({ stdout: envelope("Two tasks await review.") }) });

  const panel = buildQuestionsPanel(listRecentQuestions(root));
  assert.equal(panel.contract, QUESTIONS_CONTRACT);
  assert.equal(panel.available, true);
  assert.equal(panel.questions[0].status, "answered");
  assert.equal(panel.questions[0].answer, "Two tasks await review.");
  assert.equal(panel.questions[0].agentId, "main", "attribution: who answered");
  assert.equal(panel.summary.pending, 0);
});

test("a long answer is truncated here, and says that it was", () => {
  const panel = buildQuestionsPanel([{
    id: "question-1", question: "x", status: "answered", agentId: "main",
    answer: "y".repeat(9000), askedAt: new Date().toISOString(),
  }]);
  assert.equal(panel.questions[0].answer.length, 4000);
  assert.equal(panel.questions[0].answerTruncated, true,
    "the mirror would truncate it silently; deciding it here means it can be reported");
});

test("a pending question is published as pending, so the page can say it is waiting", () => {
  const panel = buildQuestionsPanel([
    { id: "q1", question: "a", status: "running", askedAt: "2026-09-15T01:00:00Z" },
    { id: "q2", question: "b", status: "failed", error: "no answer", askedAt: "2026-09-15T00:00:00Z" },
  ]);
  assert.equal(panel.summary.pending, 1);
  assert.equal(panel.summary.failed, 1);
});

test("an unreadable question record is unavailable with a reason, never a throw", () => {
  for (const bad of [null, undefined, "nope", 7]) {
    const panel = buildQuestionsPanel(bad);
    assert.equal(panel.available, false);
    assert.ok(panel.reason.length > 10);
    assert.deepEqual(panel.questions, []);
  }
});

test("an unknown status is normalised rather than echoed to the page", () => {
  const panel = buildQuestionsPanel([{ id: "q1", question: "a", status: "<script>", askedAt: "2026-09-15T01:00:00Z" }]);
  assert.equal(panel.questions[0].status, "queued");
});
