import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  scrubText, stripReasoningBlocks, sanitizeExcerpt, isSecretFilename, assertInsideDir,
} from "../lib/common/redact.mjs";
import { fingerprint, slugify } from "../lib/common/fingerprint.mjs";

test("scrubText replaces secret-shaped values and reports hits", () => {
  const input = "key sk-abcdefghijklmnopqrstuvwxyz012345 and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 and postgres://u:p@db/x";
  const { text, hits } = scrubText(input);
  assert.ok(!text.includes("sk-abcdefghijklmnop"));
  assert.ok(text.includes("[redacted: openai-sk]"));
  assert.ok(text.includes("[redacted: gh-token]"));
  assert.ok(text.includes("[redacted: db-url]"));
  assert.deepEqual(hits.map((h) => h.name).sort(), ["db-url", "gh-token", "openai-sk"]);
});

test("scrubText leaves ordinary prose untouched", () => {
  const prose = "The builder failed because the acceptance criteria were not testable.";
  assert.equal(scrubText(prose).text, prose);
});

test("stripReasoningBlocks removes transcript / chain-of-thought shapes", () => {
  const withTrace = "before <thinking>secret plan step 1 step 2</thinking> after\nChain of thought: musing\n\nkeep";
  const { text, stripped } = stripReasoningBlocks(withTrace);
  assert.ok(!text.includes("secret plan"));
  assert.ok(!/musing/.test(text));
  assert.ok(text.includes("keep"));
  assert.ok(stripped >= 2);
});

test("sanitizeExcerpt strips reasoning, scrubs secrets, and caps length", () => {
  const raw = `${"x".repeat(400)} sk-abcdefghijklmnopqrstuvwxyz012345 <thinking>no</thinking>`;
  const out = sanitizeExcerpt(raw, { maxLength: 100 });
  assert.ok(out.text.length <= 102);
  assert.ok(out.truncated);
});

test("isSecretFilename flags credential-shaped names only", () => {
  for (const n of [".env", ".env.local", "id_rsa", "server.pem", "app.key", "aws-credentials.json", "secrets.yaml"]) {
    assert.equal(isSecretFilename(n), true, n);
  }
  for (const n of ["TECH_CONTEXT.md", "state.json", "handoff-builder.md"]) {
    assert.equal(isSecretFilename(n), false, n);
  }
});

test("assertInsideDir blocks traversal and absolute escapes", () => {
  const base = mkdtempSync(join(tmpdir(), "redact-"));
  assert.equal(assertInsideDir(base, "sub/file.md"), join(base, "sub/file.md"));
  assert.throws(() => assertInsideDir(base, "../../etc/passwd"), /escapes/);
  assert.throws(() => assertInsideDir(base, "/etc/passwd"), /escapes/);
});

test("fingerprint is a readable slug when parts are slug-safe, deterministic otherwise", () => {
  assert.equal(fingerprint(["builder-fail", "backend", "ambiguous-acceptance-criteria"]), "builder-fail:backend:ambiguous-acceptance-criteria");
  const a = fingerprint(["review-reject", "some long free text with spaces!"]);
  const b = fingerprint(["review-reject", "some long free text with spaces!"]);
  assert.equal(a, b);
  assert.match(a, /^review-reject:[a-z0-9-]+:[0-9a-f]{8}$/);
});

test("slugify normalizes arbitrary text", () => {
  assert.equal(slugify("  Backend / UI Work! "), "backend-ui-work");
  assert.equal(slugify(""), "none");
});
