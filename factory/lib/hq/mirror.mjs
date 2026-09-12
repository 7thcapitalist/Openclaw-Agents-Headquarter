// The publish boundary.
//
// SFD-2026-012 puts the Headquarters control plane on Vercel and makes the
// factory machine outbound-only. This module builds the one object that crosses
// that boundary, and is the only place in the codebase allowed to decide what
// leaves the machine.
//
// The founder set the scope: everything the dashboard shows. That is a wide
// scope, which is exactly why the exclusions have to be mechanical rather than
// careful. `sanitize()` walks the whole projection and strips four classes on
// every string it finds, at any depth, whatever key it sits under:
//
//   1. secret-shaped values      (scrubText, the shared SFD-2026-004 patterns)
//   2. host absolute paths       (/home/<user>/... reveals the machine's layout)
//   3. reasoning / transcripts   (stripReasoningBlocks)
//   4. anything over a length    (a file body pasted into a summary field)
//
// Nothing is trusted to have been clean on the way in. A new panel added later
// cannot widen the boundary by accident, because it never gets to choose: its
// data passes through the same walk as everything else.
//
// This module performs no network I/O. It builds a snapshot and returns it; a
// caller delivers it. Keeping the decision about *what* may leave separate from
// the act of sending is the same split connector-outbox.mjs makes.

import { resolve } from "node:path";

import { scrubText, stripReasoningBlocks } from "../common/redact.mjs";

export const MIRROR_CONTRACT = "hq.mirror/1";

// A field long enough to be a file body rather than a label. Evidence bodies,
// diffs and pasted logs are out of scope; their paths are not.
const MAX_FIELD = 4000;

// Keys whose values are never published whatever they contain. Belt to
// sanitize()'s braces: the walk would scrub a recognisable secret, but a value
// under one of these names should not travel even if it looks harmless.
const FORBIDDEN_KEYS = new Set([
  "token", "accessToken", "refreshToken", "apiKey", "api_key", "secret",
  "password", "passphrase", "privateKey", "private_key", "credential",
  "credentials", "authorization", "auth", "cookie", "sessionSecret",
  "env", "dotenv", "diff", "patch", "fileContents", "content", "body",
]);

// `source` is deliberately NOT on that list. Across this codebase it carries a
// provenance label — "goal projection (factory/lib/hq/goals.mjs)" — and dropping
// it stripped the proposer's evidence of the very thing that makes a proposal
// checkable. File bodies arrive under content/body/diff/patch/fileContents,
// which stay forbidden, and any long value is truncated regardless of its key.

// An absolute path under a user's home, a system root, or a Windows drive.
// Publishing these leaks the machine's layout and the operator's username.
const ABSOLUTE_PATH = /(?:\/(?:home|Users|root|var|etc|opt|srv|tmp)\/[^\s"'`,;:)\]}]*|[A-Za-z]:\\[^\s"'`,;:)\]}]*)/g;

/**
 * Strip everything that must not cross the boundary, from any string at any
 * depth. Returns the sanitized value plus a report of what was removed, so a
 * publisher can log that redaction happened without logging what was redacted.
 */
export function sanitize(value, { hqRoot = null, report = { secrets: [], paths: 0, truncated: 0, dropped: [], reasoning: 0 }, key = null } = {}) {
  if (value === null || value === undefined) return { value, report };

  if (typeof value === "string") {
    let out = value;

    // Host paths first: a repo-relative path is useful and safe, an absolute one
    // is neither. Where the value sits under the HQ root, relativise it rather
    // than blanking it, so "factory/lib/x.mjs" survives as a useful reference.
    if (hqRoot) {
      const root = resolve(hqRoot);
      if (out.includes(root)) out = out.split(root + "/").join("").split(root).join(".");
    }
    const beforePaths = out;
    out = out.replace(ABSOLUTE_PATH, "[path]");
    if (out !== beforePaths) report.paths += 1;

    const reasoning = stripReasoningBlocks(out);
    out = reasoning.text;
    report.reasoning += reasoning.stripped;

    const scrubbed = scrubText(out);
    out = scrubbed.text;
    for (const hit of scrubbed.hits) report.secrets.push(hit.name);

    if (out.length > MAX_FIELD) {
      out = `${out.slice(0, MAX_FIELD)}… [truncated]`;
      report.truncated += 1;
    }
    return { value: out, report };
  }

  if (Array.isArray(value)) {
    const out = value.map((item) => sanitize(item, { hqRoot, report }).value);
    return { value: out, report };
  }

  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k)) { report.dropped.push(k); continue; }
      out[k] = sanitize(v, { hqRoot, report, key: k }).value;
    }
    return { value: out, report };
  }

  // number, boolean, bigint — nothing to strip.
  return { value, report };
}

/**
 * Assemble the published projection.
 *
 * Every source is a projection the dashboard already renders, passed in by the
 * caller rather than imported here. That keeps this module free of the HQ read
 * path — it is a boundary, not a second way to read state — and makes the
 * boundary testable against fixtures containing deliberately planted secrets.
 */
export function buildMirrorSnapshot({ hqRoot = null, sources = {}, now = new Date().toISOString(), publisher = null } = {}) {
  const report = { secrets: [], paths: 0, truncated: 0, dropped: [], reasoning: 0 };
  const clean = {};
  for (const [name, source] of Object.entries(sources)) {
    clean[name] = sanitize(source, { hqRoot, report }).value;
  }

  return {
    version: 1,
    contract: MIRROR_CONTRACT,
    publishedAt: now,
    publisher: publisher ? String(publisher) : null,
    // A consumer must be able to tell a stale mirror from a live one without
    // guessing, so the snapshot states when it was built and the viewer decides.
    panels: clean,
    redaction: {
      // What was removed, never what it was. A publisher logging this must not
      // become the place the secret finally gets written down.
      secretsRedacted: report.secrets.length,
      secretKinds: [...new Set(report.secrets)].sort(),
      pathsRewritten: report.paths,
      fieldsTruncated: report.truncated,
      reasoningBlocksStripped: report.reasoning,
      keysDropped: [...new Set(report.dropped)].sort(),
      maxFieldLength: MAX_FIELD,
    },
  };
}

export { FORBIDDEN_KEYS, MAX_FIELD, ABSOLUTE_PATH };
