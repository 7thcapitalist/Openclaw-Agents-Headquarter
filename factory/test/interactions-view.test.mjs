import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { interactionsSection } from "../../dashboard/backend/public/lib/interactionsView.mjs";

const item = (over = {}) => ({
  version: 1, interactionId: "i1", idempotencyKey: "k1", taskId: "obj-abc-node", objectiveId: "obj-abc",
  kind: "comment", author: { type: "human", id: "founder" }, occurredAt: "2026-09-10T00:00:00Z",
  body: "Looks good to me.", mentions: [], redactions: [], trust: "untrusted-input", ...over,
});

const thread = (over = {}) => ({
  version: 1, available: true, total: 1, truncated: false, redactedCount: 0, interactions: [item()], ...over,
});

test("a missing thread is stated, not blank", () => {
  assert.match(interactionsSection(null), /Comments are not available/);
});

test("an unreadable thread names the reason instead of showing an empty thread", () => {
  const html = interactionsSection({ available: false, reason: "Invalid interaction line 3" });
  assert.match(html, /could not be read/);
  assert.match(html, /Invalid interaction line 3/);
  assert.doesNotMatch(html, /No comments on this run yet/);
});

test("comments render newest first with author and time", () => {
  const html = interactionsSection(thread({
    total: 2,
    interactions: [item(), item({ interactionId: "i2", body: "Second thought.", occurredAt: "2026-09-10T01:00:00Z" })],
  }));
  assert.ok(html.indexOf("Second thought.") < html.indexOf("Looks good to me."), "newest first");
  assert.match(html, /founder/);
});

test("an empty thread says so", () => {
  assert.match(interactionsSection(thread({ total: 0, interactions: [] })), /No comments on this run yet/);
});

test("truncation and redaction are disclosed", () => {
  const html = interactionsSection(thread({ total: 40, truncated: true, redactedCount: 2 }));
  assert.match(html, /Showing the 1 most recent of 40/);
  assert.match(html, /2 comment\(s\) had secret-shaped text removed/);
});

test("mentions and redactions are listed on the comment", () => {
  const html = interactionsSection(thread({ interactions: [item({ mentions: ["reviewer", "qa"], redactions: ["openai-sk"] })] }));
  assert.match(html, /mentions reviewer, qa/);
  assert.match(html, /redacted: openai-sk/);
});

// --- the boundary, restated where the founder can see it ---------------------

test("the panel says what a comment can and cannot do", () => {
  // A founder who believes a comment instructs an agent will write instructions
  // into it. Saying otherwise, in the UI, is part of the control.
  const html = interactionsSection(thread());
  assert.match(html, /A comment is a record, not an instruction/);
  assert.match(html, /never given to an agent as a command/);
});

// --- escaping: this is the panel that renders attacker-controlled text -------

test("hostile comment bodies are escaped, never rendered as markup", () => {
  const html = interactionsSection(thread({
    interactions: [item({ body: '<img src=x onerror=alert(1)><script>alert(2)</script>"><b>bold</b>' })],
  }));
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<b>bold<\/b>/);
  assert.match(html, /&lt;img src=x/);
});

test("author ids, mentions, kinds and redaction names are escaped too", () => {
  const html = interactionsSection(thread({
    interactions: [item({
      author: { type: "agent", id: "<script>a</script>" },
      kind: "comment", mentions: ["<img src=x>"], redactions: ["<b>x</b>"],
    })],
  }));
  assert.doesNotMatch(html, /<script>a<\/script>/);
  assert.doesNotMatch(html, /<img src=x>/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
});

test("an unknown kind cannot inject a label", () => {
  const html = interactionsSection(thread({ interactions: [item({ kind: "<script>evil</script>" })] }));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /comment/, "an unrecognised kind falls back to a safe label");
});

test("nothing in a comment becomes a link or anything clickable", () => {
  const html = interactionsSection(thread({
    interactions: [item({ body: "see https://evil.example/steal and javascript:alert(1)" })],
  }));
  assert.doesNotMatch(html, /<a\s/);
  assert.doesNotMatch(html, /href=/);
});

test("the compose form is labelled and bounded, and can be suppressed", () => {
  const html = interactionsSection(thread());
  assert.match(html, /maxlength="4000"/);
  assert.match(html, /class="sr-only" for="interaction-body"/);
  assert.match(html, /aria-labelledby="run-interactions-title"/);
  assert.doesNotMatch(interactionsSection(thread(), { canPost: false }), /<form/);
});

// --- the client must not echo what it submitted ------------------------------

test("posting re-reads the thread from the server rather than echoing the input", () => {
  // What is stored is redacted and normalised; echoing the typed text would
  // show the founder something other than what was recorded.
  const app = readFileSync(new URL("../../dashboard/backend/public/app.js", import.meta.url), "utf8");
  const handler = app.slice(app.indexOf("function wireInteractionForm"), app.indexOf("async function openTaskExecutionView"));
  assert.match(handler, /method: "POST"/);
  assert.match(handler, /interactionsSection\(thread/, "the thread is re-rendered from a fresh read");
  assert.doesNotMatch(handler, /insertAdjacentHTML\([^)]*body/, "the submitted body is never written into the DOM");
});
