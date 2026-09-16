// The Chief of Staff's replies rendered as Markdown.
//
// A reply is model output. Formatting it means putting its HTML into the
// founder's authenticated session — the session that approves builds, retries
// work and starts objectives from this very panel. So the tests lead with what
// must NOT survive, and only then check that bold is bold.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { withRenderedReplies } from "../../dashboard/backend/lib/threadMarkdown.mjs";
import { markdownRenderingAvailable } from "../../dashboard/backend/lib/safeMarkdown.mjs";
import { transcriptPanel } from "../../dashboard/backend/public/lib/chatView.mjs";

const panel = (turns) => ({ threads: [{ id: "thread-a-deadbeef", title: "t", agentId: "main", status: "idle", turnsToday: 1, turns }] });
const agent = (text, extra = {}) => ({ id: "turn-2", role: "agent", text, at: "2026-09-16T00:00:00Z", proposals: [], ...extra });
const founder = (text, extra = {}) => ({ id: "turn-1", role: "founder", text, at: "2026-09-16T00:00:00Z", proposals: [], ...extra });

// ── what must not survive ────────────────────────────────────────────────────

test("a reply cannot run script or carry handlers into the founder's session", () => {
  const hostile = [
    "Here is the status.",
    "<script>fetch('/api/founder/threads')</script>",
    '<img src=x onerror="alert(1)">',
    "[retry everything](javascript:alert(1))",
    "[also](JaVaScRiPt:alert(1))",
    '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    '<iframe src="https://evil.example"></iframe>',
    '<div onclick="alert(1)" style="position:fixed">overlay</div>',
  ].join("\n\n");
  const html = withRenderedReplies(panel([agent(hostile)])).threads[0].turns[0].html;

  assert.ok(html, "the reply must still render");
  // Checked against real tags only. Escaped text that merely spells out an
  // attack ("&lt;img onerror=…&gt;") is inert and is allowed to be visible.
  const tags = html.match(/<[a-z][^>]*>/gi) || [];
  assert.equal(tags.filter((t) => /^<(script|iframe|object|embed|style|form|input)/i.test(t)).length, 0, `executable tag survived: ${tags.join(" ")}`);
  assert.equal(tags.filter((t) => /\son\w+\s*=/i.test(t)).length, 0, "no event handler attribute may survive on a tag");
  assert.equal(tags.filter((t) => /\s(href|src)\s*=\s*"?\s*(javascript|data|vbscript):/i.test(t)).length, 0, "no executable URL may survive");
  assert.equal(tags.filter((t) => /\sstyle\s*=/i.test(t)).length, 0, "no inline style may survive");
  assert.match(html, /Here is the status/, "the prose around the attack is kept");
});

test("only agent replies are rendered — the founder's words stay exactly what he typed", () => {
  const out = withRenderedReplies(panel([
    founder("**not bold** <b>not html</b>"),
    agent("**bold**"),
    agent("", { error: "OpenClaw could not reply." }),
  ])).threads[0].turns;

  assert.equal(out[0].html, undefined, "a founder turn is never rendered");
  assert.ok(out[1].html, "an agent turn is rendered");
  assert.equal(out[2].html, undefined, "an error is shown as text, not rendered");
});

test("the view inserts HTML only for an agent turn, even if a founder turn arrives carrying some", () => {
  const markup = transcriptPanel({
    id: "thread-a-deadbeef", title: "t", agentId: "main", status: "idle", turnsToday: 1,
    turns: [founder("hi", { html: "<img src=x onerror=alert(1)>" })],
  });
  assert.doesNotMatch(markup, /<img/i);
  assert.match(markup, /hi/);
});

test("the conversation route renders through the shared untrusted-Markdown renderer", () => {
  const server = readFileSync(new URL("../../dashboard/backend/server.mjs", import.meta.url), "utf8");
  const route = server.slice(server.indexOf('app.get("/api/founder/threads/:id"'));
  assert.match(route.slice(0, 400), /withRenderedReplies\(buildThreadsPanel\(/,
    "the transcript route must hand the page rendered, sanitised replies");
  const lib = readFileSync(new URL("../../dashboard/backend/lib/threadMarkdown.mjs", import.meta.url), "utf8");
  assert.match(lib, /import \{ renderUntrustedMarkdown \} from "\.\/safeMarkdown\.mjs"/,
    "replies must use the FCT-P0-04 renderer, not a second one");
});

// ── and then, that formatting actually formats ──────────────────────────────

test("his headings, bold and lists become formatting instead of raw symbols", { skip: !markdownRenderingAvailable() && "marked is not installed here" }, () => {
  const reply = "The factory is **operational**.\n\n### Main problems today\n\n1. **State** drifts\n   - merged work shows as `merge-ready`\n2. Retries duplicate work";
  const html = withRenderedReplies(panel([agent(reply)])).threads[0].turns[0].html;
  assert.match(html, /<strong>operational<\/strong>/);
  assert.match(html, /<h3[^>]*>Main problems today<\/h3>/);
  assert.match(html, /<ol>/);
  assert.match(html, /<code>merge-ready<\/code>/);
  assert.doesNotMatch(html, /\*\*|###/, "no raw Markdown symbols left behind");

  const markup = transcriptPanel({ id: "thread-a-deadbeef", title: "t", agentId: "main", status: "idle", turnsToday: 1,
    turns: withRenderedReplies(panel([agent(reply)])).threads[0].turns });
  assert.match(markup, /chat-bubble chat-markdown/);
});
