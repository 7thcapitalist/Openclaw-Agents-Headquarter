// Shared redaction guard for the intelligence and learning layers.
//
// Anything that could enter a durable knowledge file, a finding body, a founder
// digest, a research note, or a handoff context block passes through here first.
// The rule from SFD-2026-004: no secrets, no bulk private data, no model
// chain-of-thought or raw transcripts ever reach a repository or HQ output.
//
// Pure. Node builtins only. Conservative by design: a few false positives are
// acceptable, a leaked credential is not.

import { resolve } from "path";

export const SECRET_FILENAME_PATTERNS = [
  /^\.env(\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa/i,
  /(^|[._-])credentials?([._-]|$)/i,
  /(^|[._-])secrets?([._-]|$)/i,
];

export const SECRET_VALUE_PATTERNS = [
  { name: "aws-akia", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "openai-sk", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "gh-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { name: "pem-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "db-url", re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^\s/@]+:[^\s/@]+@/g },
];

// Blocks shaped like a raw reasoning trace or a pasted transcript. The learning
// layer works from summaries and outcomes, never from deliberation.
const REASONING_BLOCK_PATTERNS = [
  /<thinking>[\s\S]*?<\/thinking>/gi,
  /<reasoning>[\s\S]*?<\/reasoning>/gi,
  /<thinking[\s\S]*?<\/antml:thinking>/gi,
  /(^|\n)\s*(?:chain[- ]of[- ]thought|scratchpad|inner monologue)\s*:[\s\S]*?(?=\n\s*\n|$)/gi,
];

export function isSecretFilename(name) {
  const base = String(name || "").split("/").pop();
  return SECRET_FILENAME_PATTERNS.some((re) => re.test(base));
}

// Replace every secret-shaped match with "[redacted: <name>]". Returns the
// scrubbed text plus a per-pattern hit report.
export function scrubText(text) {
  let out = String(text ?? "");
  const hits = [];
  for (const { name, re } of SECRET_VALUE_PATTERNS) {
    let count = 0;
    out = out.replace(new RegExp(re.source, re.flags), () => {
      count += 1;
      return `[redacted: ${name}]`;
    });
    if (count) hits.push({ name, count });
  }
  return { text: out, hits };
}

// Strip anything shaped like a raw reasoning trace / transcript block.
export function stripReasoningBlocks(text) {
  let out = String(text ?? "");
  let stripped = 0;
  for (const re of REASONING_BLOCK_PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags), () => {
      stripped += 1;
      return "[redacted: reasoning-trace]";
    });
  }
  return { text: out, stripped };
}

// Full guard for a free-text fragment: strip reasoning, scrub secrets, collapse
// runaway whitespace, and cap length so no single excerpt can smuggle a table
// of private data into an output.
export function sanitizeExcerpt(text, { maxLength = 500 } = {}) {
  const reasoning = stripReasoningBlocks(text);
  const scrubbed = scrubText(reasoning.text);
  let out = scrubbed.text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  let truncated = false;
  if (out.length > maxLength) {
    out = `${out.slice(0, maxLength).trimEnd()} …`;
    truncated = true;
  }
  return {
    text: out,
    hits: scrubbed.hits,
    reasoningStripped: reasoning.stripped,
    truncated,
  };
}

// Resolve `candidate` and assert it stays inside `baseDir`. Defends "../.." and
// absolute-path escapes. Returns the resolved absolute path or throws.
export function assertInsideDir(baseDir, candidate) {
  const base = resolve(baseDir);
  const target = resolve(base, candidate);
  if (target !== base && !target.startsWith(`${base}/`)) {
    throw new Error(`path escapes ${base}: ${candidate}`);
  }
  return target;
}
