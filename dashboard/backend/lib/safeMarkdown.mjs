// Rendering untrusted Markdown to HTML for Headquarters.
//
// Everything the dashboard renders as HTML is written by something we do not
// control: agent result files, completion reports, evidence artifacts, and
// Markdown checked into whatever project the factory is working on. Handing
// `marked.parse()` output straight to `innerHTML` means any of those authors can
// execute JavaScript in the founder's authenticated session — and that session
// controls approvals, retries, and process control (FCT-P0-04).
//
// Two independent layers, so a mistake in either one is not exploitable alone:
//
//   1. Generation — marked is configured to never emit author-supplied HTML.
//      Raw HTML blocks and inline HTML become visible escaped text instead of
//      live markup, and every URL is scheme-checked.
//   2. Serialization — the generated HTML is then re-parsed against a strict
//      tag/attribute allowlist. Anything not on the list is dropped, including
//      every `on*` handler, `style`, and unknown attribute.
//
// This is deliberately dependency-free: adding a sanitizer library would mean a
// new third-party artifact in factory/third-party/provenance.json, and the tag
// surface we actually need is small enough to state exactly.

import { createRequire } from "node:module";

// `marked` is a dashboard dependency, not a repository-root one, and CI runs the
// factory suite with no install step (see .github/workflows). Loading it lazily
// through createRequire keeps this module importable — and its security-critical
// allowlist layer fully testable — in an environment where marked is absent.
const requireFromHere = createRequire(import.meta.url);
let markedModule;
function getMarked() {
  if (markedModule === undefined) {
    try {
      markedModule = requireFromHere("marked");
    } catch {
      markedModule = null;
    }
  }
  return markedModule;
}

// True when full Markdown rendering is available. When false, callers still get
// safe output — just escaped text rather than formatted HTML.
export function markdownRenderingAvailable() {
  return Boolean(getMarked());
}

// Tags that may appear in the output. Everything marked generates for standard
// Markdown, and nothing that can execute, load, or frame anything.
const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "span", "div",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "em", "b", "i", "u", "s", "del", "ins", "mark", "sub", "sup", "small",
  "ul", "ol", "li",
  "blockquote", "pre", "code",
  "a",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  "img",
  "dl", "dt", "dd",
]);

// Attributes allowed per tag. No `style` (CSS can exfiltrate and overlay), no
// `on*` (obviously), no `target` without a matching rel — added below.
const ALLOWED_ATTRS = {
  a: new Set(["href", "title"]),
  img: new Set(["src", "alt", "title", "width", "height"]),
  td: new Set(["colspan", "rowspan", "align"]),
  th: new Set(["colspan", "rowspan", "align", "scope"]),
  code: new Set(["class"]),
  span: new Set(["class"]),
  div: new Set(["class"]),
  ol: new Set(["start"]),
};

// Only these classes survive on code/span/div — enough for syntax highlighting
// hooks without letting an author borrow the dashboard's own UI classes to
// forge interface chrome (a fake "Approve" button, for example).
const CLASS_PREFIX_ALLOWLIST = [/^language-[\w-]+$/, /^hljs(-[\w-]+)?$/];

const VOID_TAGS = new Set(["br", "hr", "img"]);

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: "\u00a0",
};

// Decode HTML entities in an attribute value taken out of already-generated
// HTML. Two reasons this matters:
//   1. Correctness — layer 2 re-escapes on output, so without decoding first a
//      legitimate "?a=1&b=2" would drift to "&amp;amp;" on every pass.
//   2. Security — the browser decodes entities before resolving a URL scheme, so
//      the scheme check has to run on the decoded value or "&#106;avascript:"
//      slips past it.
export function decodeEntities(value) {
  return String(value ?? "").replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (match, body) => {
    if (body[0] === "#") {
      const codePoint = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

// A URL is safe when we can prove its scheme is inert. Anything we cannot parse
// or do not recognise is rejected rather than passed through hopefully.
//
// Rejects: javascript:, data:, vbscript:, file:, and obfuscations of them
// ("java\tscript:", "JaVaScRiPt:", leading control characters, entity tricks).
export function safeUrl(raw, { allowRelative = true } = {}) {
  const value = String(raw ?? "");
  // Decode entities first, then strip characters browsers ignore when resolving
  // a scheme. Doing both before the scheme test is what defeats
  // "java\nscript:alert(1)" and "&#106;avascript:alert(1)".
  const stripped = decodeEntities(value).replace(/[\u0000-\u0020\u007f-\u009f\u2000-\u200f\ufeff]/g, "");
  if (!stripped) return null;

  // Protocol-relative ("//evil.com") loads from another origin under our CSP;
  // treat it as absolute and require an explicit scheme instead.
  if (stripped.startsWith("//")) return null;

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(stripped);
  if (!schemeMatch) {
    if (!allowRelative) return null;
    // Relative path or fragment. Reject anything that could break out of an
    // attribute or smuggle a scheme later.
    if (/[<>"'`]/.test(stripped)) return null;
    return value;
  }
  const scheme = schemeMatch[1].toLowerCase();
  if (scheme === "http" || scheme === "https" || scheme === "mailto") return value;
  return null;
}

function safeClassAttr(value) {
  const kept = String(value || "")
    .split(/\s+/)
    .filter((cls) => cls && CLASS_PREFIX_ALLOWLIST.some((re) => re.test(cls)));
  return kept.length ? kept.join(" ") : null;
}

// ── layer 1: generation ──────────────────────────────────────────────────────

// A marked instance that cannot emit author-supplied HTML. Kept module-local so
// callers cannot reconfigure it, and separate from any global marked.setOptions
// the server does for other purposes.
// Render a token's children through the parser, falling back to escaped text
// when no parser is attached. Never returns raw author HTML.
function renderInline(rendererThis, token) {
  const parser = rendererThis?.parser;
  if (parser && Array.isArray(token?.tokens) && token.tokens.length) {
    try {
      return parser.parseInline(token.tokens);
    } catch {
      /* fall through to escaping */
    }
  }
  return escapeHtml(token?.text ?? "");
}

function buildRenderer(marked) {
  const renderer = new marked.Renderer();

  // Raw HTML in the source becomes visible text, never live markup. This is the
  // single most important line in the file.
  renderer.html = (token) => escapeHtml(typeof token === "string" ? token : token?.raw ?? token?.text ?? "");

  renderer.link = function link(token) {
    const href = safeUrl(token?.href);
    // Render the link's INNER TOKENS rather than its raw text. Interpolating
    // token.text would put author-supplied HTML into the output as live markup
    // — which broke this layer's whole promise and left the allowlist as the
    // only thing between agent HTML and the founder's session. Parsing inline
    // also means nested markup (a linked image, bold text) renders correctly
    // instead of leaking its literal Markdown source.
    const body = renderInline(this, token);
    // A link we refuse to trust still shows its text — dropping it silently
    // would hide content from the founder.
    if (!href) return body;
    const title = token?.title ? ` title="${escapeHtml(token.title)}"` : "";
    // noopener/noreferrer: an opened tab must not get a handle on the dashboard.
    return `<a href="${escapeHtml(href)}"${title} target="_blank" rel="noopener noreferrer nofollow">${body}</a>`;
  };

  renderer.image = (token) => {
    const src = safeUrl(token?.href);
    const alt = escapeHtml(token?.text ?? "");
    if (!src) return alt;
    const title = token?.title ? ` title="${escapeHtml(token.title)}"` : "";
    return `<img src="${escapeHtml(src)}" alt="${alt}"${title} loading="lazy">`;
  };

  return renderer;
}

// ── layer 2: allowlist serialization ─────────────────────────────────────────

// Re-scan generated HTML and keep only allowlisted structure. Runs over output
// we produced ourselves, so it is a backstop against a marked change or a
// renderer gap rather than the primary defense.
export function sanitizeHtml(html) {
  const input = String(html ?? "");
  let out = "";
  let i = 0;
  const openStack = [];

  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      out += input.slice(i);
      break;
    }
    out += input.slice(i, lt);

    // Comments and CDATA are dropped whole; conditional comments have been an
    // execution vector historically.
    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<!", lt) || input.startsWith("<?", lt)) {
      const end = input.indexOf(">", lt);
      i = end === -1 ? input.length : end + 1;
      continue;
    }

    const tagMatch = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(input.slice(lt));
    if (!tagMatch) {
      // A stray "<" that is not a tag: emit it escaped so it renders literally
      // instead of being re-parsed as markup by the browser.
      out += "&lt;";
      i = lt + 1;
      continue;
    }

    const [full, closing, rawName, rawAttrs] = tagMatch;
    const name = rawName.toLowerCase();
    i = lt + full.length;

    if (!ALLOWED_TAGS.has(name)) continue; // drop the tag, keep its text content

    if (closing) {
      const idx = openStack.lastIndexOf(name);
      if (idx === -1) continue; // unbalanced close we never opened
      openStack.splice(idx, 1);
      out += `</${name}>`;
      continue;
    }

    const attrs = sanitizeAttributes(name, rawAttrs);
    if (VOID_TAGS.has(name)) {
      out += `<${name}${attrs}>`;
    } else {
      openStack.push(name);
      out += `<${name}${attrs}>`;
    }
  }

  // Close anything left open so a truncated artifact cannot swallow the rest of
  // the page into an unterminated element.
  while (openStack.length) out += `</${openStack.pop()}>`;
  return out;
}

function sanitizeAttributes(tag, rawAttrs) {
  const allowed = ALLOWED_ATTRS[tag];
  if (!allowed || !rawAttrs) return "";
  const emitted = new Set();
  let result = "";
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(rawAttrs))) {
    const name = m[1].toLowerCase();
    // Decode before inspecting: the browser would, so the checks below must too.
    const value = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
    if (!allowed.has(name)) continue;

    if (name === "href" || name === "src") {
      const safe = safeUrl(value);
      if (!safe) continue;
      result += ` ${name}="${escapeHtml(safe)}"`;
      emitted.add(name);
      continue;
    }
    if (name === "class") {
      const safe = safeClassAttr(value);
      if (!safe) continue;
      result += ` class="${escapeHtml(safe)}"`;
      emitted.add("class");
      continue;
    }
    if (name === "width" || name === "height" || name === "colspan" || name === "rowspan" || name === "start") {
      if (!/^\d{1,5}$/.test(value)) continue;
      result += ` ${name}="${value}"`;
      emitted.add(name);
      continue;
    }
    if (name === "align" || name === "scope") {
      if (!/^[a-z]{1,10}$/i.test(value)) continue;
      result += ` ${name}="${value.toLowerCase()}"`;
      emitted.add(name);
      continue;
    }
    result += ` ${name}="${escapeHtml(value)}"`;
    emitted.add(name);
  }
  // Links always leave with a safe rel, even if the renderer was bypassed.
  //
  // This tests the attribute NAMES actually emitted, not the serialized string:
  // matching /rel=/ against the output let a link whose *title* contained the
  // text "rel=" suppress its own hardening.
  if (tag === "a" && emitted.has("href")) {
    result += ' target="_blank" rel="noopener noreferrer nofollow"';
  }
  return result;
}

// ── public entry point ───────────────────────────────────────────────────────

let cachedRenderer = null;

// Render untrusted Markdown to HTML that is safe to assign to innerHTML.
// This is the ONLY function the server should use to turn agent/report/evidence
// Markdown into HTML.
export function renderUntrustedMarkdown(markdown) {
  const source = typeof markdown === "string" ? markdown : "";
  if (!source.trim()) return "";

  const mod = getMarked();
  // No Markdown renderer available: show the document as escaped text. Inert by
  // construction, and never a silent blank panel.
  if (!mod) return `<pre>${escapeHtml(source)}</pre>`;
  const marked = mod.marked || mod;

  if (!cachedRenderer) cachedRenderer = buildRenderer(marked);
  let generated;
  try {
    generated = marked.parse(source, {
      gfm: true,
      breaks: true,
      renderer: cachedRenderer,
      async: false,
    });
  } catch {
    // A Markdown document we cannot parse is shown as escaped text rather than
    // failing the whole panel.
    return `<pre>${escapeHtml(source)}</pre>`;
  }
  return sanitizeHtml(generated);
}
