import test from "node:test";
import assert from "node:assert/strict";
import {
  OUTCOME_CLASSES, buildOutcome, founderHeadline, isCreditExhaustion,
  needsFounder, redactDispatchError, errorDetail,
} from "../lib/failure-outcome.mjs";

// The real shape that reached the founder as an opaque wall of text: execFile
// embeds the whole command, including the multi-kilobyte prompt, in .message.
const REAL_DISPATCH_ERROR = `Command failed: openclaw agent --agent main --session-key agent:main:factory-decompose-obj-ae05b596 --message You are the Chief of Staff for a software factory. Split ONE founder objective into
the SMALLEST set of build sub-tasks that can be implemented in parallel where safe.

Rules:
- 1 to 4 nodes. Prefer 2 (e.g. one backend, one frontend) when the objective spans both.
- Only these roles: backend-builder, frontend-builder.
${"filler prompt line\n".repeat(80)}
Founder objective:
Make this software factory materially better at its job. --json --timeout 900
`;

test("the dispatch prompt is stripped but the command shape survives", () => {
  const out = redactDispatchError(REAL_DISPATCH_ERROR);
  assert.match(out, /openclaw agent --agent main failed/);
  assert.doesNotMatch(out, /Chief of Staff/);
  assert.doesNotMatch(out, /filler prompt line/);
  assert.doesNotMatch(out, /Founder objective/);
  assert.ok(out.length < 700, `expected a short excerpt, got ${out.length} chars`);
});

test("redaction keeps the actual cause when the prompt is passed as a file", () => {
  const out = redactDispatchError(
    "Command failed: openclaw agent --agent architect --message-file /tmp/x/prompt.txt --json --timeout 900\nusage limit reached for this seat",
  );
  assert.doesNotMatch(out, /prompt\.txt/);
  assert.match(out, /usage limit reached/);
});

test("redaction is a no-op for an ordinary error string", () => {
  assert.equal(redactDispatchError("QA: 3 tests fail in factory/test/foo.test.mjs"),
    "QA: 3 tests fail in factory/test/foo.test.mjs");
});

test("errorDetail prefers stderr, then stdout, then the message", () => {
  assert.equal(errorDetail({ stderr: " boom ", stdout: "x", message: "y" }), "boom");
  assert.equal(errorDetail({ stdout: " out ", message: "y" }), "out");
  assert.equal(errorDetail({ message: "plain" }), "plain");
  assert.equal(errorDetail({ killed: true, signal: "SIGTERM" }), "process killed (SIGTERM)");
});

test("credit exhaustion is distinguished from ordinary infrastructure trouble", () => {
  for (const text of [
    "429 Too Many Requests", "usage limit reached", "quota exceeded",
    "auth profile temporarily unavailable", "provider overloaded",
  ]) assert.equal(isCreditExhaustion(text), true, text);

  for (const text of [
    "socket hang up", "ECONNRESET", "agent did not write its result file",
  ]) assert.equal(isCreditExhaustion(text), false, text);
});

test("an exhausted seat pauses with a resume time instead of failing", () => {
  const resumeAfter = "2026-09-09T04:21:00.000Z";
  const outcome = buildOutcome({
    error: Object.assign(new Error("usage limit reached for this seat"), { transient: true }),
    whatFailed: "Objective decomposition",
    resumeAfter,
  });
  assert.equal(outcome.outcomeClass, "paused-credits");
  assert.equal(outcome.resumeAfter, resumeAfter);
  assert.equal(outcome.needsFounder, false);
  assert.equal(needsFounder(outcome.outcomeClass), false);
  assert.match(outcome.headline, /paused/i);
  assert.match(outcome.headline, /resumes automatically/i);
  assert.equal(outcome.whatFounderMustDecide, null);
});

test("a transient non-credit failure retries rather than paging the founder", () => {
  const outcome = buildOutcome({
    error: new Error("socket hang up"),
    whatFailed: "The builder stage",
  });
  assert.equal(outcome.outcomeClass, "infra-retrying");
  assert.equal(outcome.needsFounder, false);
  assert.equal(outcome.resumeAfter, null);
  assert.match(outcome.headline, /retrying automatically/i);
});

test("a real failure is hard-failed and does reach the founder", () => {
  const outcome = buildOutcome({
    error: new Error("decomposition returned invalid JSON: Unexpected token }"),
    whatFailed: "Objective decomposition",
  });
  assert.equal(outcome.outcomeClass, "hard-failed");
  assert.equal(outcome.needsFounder, true);
  assert.match(outcome.headline, /could not recover/i);
});

test("a decision blocker becomes a founder decision carrying the question", () => {
  const outcome = buildOutcome({
    blocker: { outcome: "decision-required", stage: "architect", summary: "Postgres or SQLite?" },
    whatFailed: "The architect stage",
  });
  assert.equal(outcome.outcomeClass, "needs-founder-decision");
  assert.equal(outcome.needsFounder, true);
  assert.match(outcome.whatFounderMustDecide, /Postgres or SQLite/);
});

test("an infra blocker never becomes a founder decision", () => {
  const outcome = buildOutcome({
    blocker: { outcome: "fail", stage: "builder", summary: "builder dispatch wrote no result file" },
    whatFailed: "The builder stage",
  });
  assert.equal(outcome.outcomeClass, "infra-retrying");
  assert.equal(outcome.needsFounder, false);
  assert.equal(outcome.whatFounderMustDecide, null);
});

test("every outcome carries a non-empty plain-language headline", () => {
  for (const outcomeClass of OUTCOME_CLASSES) {
    const headline = founderHeadline({ outcomeClass, whatFailed: "The release stage" });
    assert.ok(headline.length > 20, outcomeClass);
    assert.match(headline, /^The release stage/, outcomeClass);
    // No raw identifiers or stack noise in founder-facing copy.
    assert.doesNotMatch(headline, /undefined|null|\[object/i, outcomeClass);
  }
});

test("the outcome never stores a raw error string as the whole record", () => {
  const outcome = buildOutcome({ error: new Error(REAL_DISPATCH_ERROR), whatFailed: "Decomposition" });
  assert.doesNotMatch(outcome.detail, /Chief of Staff/);
  assert.ok(outcome.classification, "an audit classification is always recorded");
  assert.ok(OUTCOME_CLASSES.includes(outcome.outcomeClass));
  assert.ok(outcome.at, "every outcome is timestamped");
});

test("an unknown or missing signal degrades to hard-failed, never to silence", () => {
  const outcome = buildOutcome({ whatFailed: "A task" });
  assert.equal(outcome.outcomeClass, "hard-failed");
  assert.equal(outcome.needsFounder, true);
});
