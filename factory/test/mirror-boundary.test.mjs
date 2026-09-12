import test from "node:test";
import assert from "node:assert/strict";

import { buildMirrorSnapshot, sanitize, FORBIDDEN_KEYS, MAX_FIELD } from "../lib/hq/mirror.mjs";

const HQ = "/home/founder/Openclaw-Agents-Headquarter";
const publish = (sources) => buildMirrorSnapshot({ hqRoot: HQ, sources, now: "2026-09-12T00:00:00Z" });
// Serialise the way a publisher would, so a secret hiding in a nested key or an
// array index is still caught. Asserting on the wire form is the point.
const wire = (snapshot) => JSON.stringify(snapshot);

// ── the exclusions, tested adversarially ──────────────────────────────────

test("secret-shaped values never cross, wherever they are buried", () => {
  const out = wire(publish({
    tasks: [{ title: "deploy", notes: "use sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 to call it" }],
    nested: { deep: { deeper: [{ v: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" }] } },
    inbox: { text: "aws AKIAIOSFODNN7EXAMPLE rotates monday" },
    db: { note: "postgres://user:hunter2@db.internal:5432/hq" },
  }));
  assert.doesNotMatch(out, /sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345/);
  assert.doesNotMatch(out, /ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/);
  assert.doesNotMatch(out, /AKIAIOSFODNN7EXAMPLE/);
  assert.doesNotMatch(out, /hunter2/);
  assert.match(out, /\[redacted: openai-sk\]/);
});

test("a private key block never crosses", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
  const out = wire(publish({ approval: { evidence: pem } }));
  assert.doesNotMatch(out, /BEGIN RSA PRIVATE KEY/);
  assert.doesNotMatch(out, /MIIEowIBAAKCAQEA/);
});

test("host absolute paths never cross, and HQ-relative paths survive", () => {
  const out = publish({
    evidence: { path: `${HQ}/evidence/qa.md`, other: "/home/someone-else/.ssh/id_rsa" },
    system: { note: "ran from /var/lib/factory/run" },
  });
  const s = wire(out);
  // The operator's username and layout must not be published.
  assert.doesNotMatch(s, /\/home\/founder/);
  assert.doesNotMatch(s, /someone-else/);
  assert.doesNotMatch(s, /\/var\/lib\/factory/);
  // ...but a repo-relative path is useful and safe, so it is kept.
  assert.equal(out.panels.evidence.path, "evidence/qa.md");
});

test("forbidden keys are dropped even when the value looks harmless", () => {
  const out = publish({ conn: { host: "vercel", token: "plausible-looking-value", apiKey: "abc" } });
  assert.equal(out.panels.conn.token, undefined);
  assert.equal(out.panels.conn.apiKey, undefined);
  assert.equal(out.panels.conn.host, "vercel");
  assert.ok(out.redaction.keysDropped.includes("token"));
});

test("a file body pasted into a field is truncated, not published whole", () => {
  const body = "x".repeat(MAX_FIELD + 500);
  const out = publish({ evidence: { summary: body } });
  assert.ok(out.panels.evidence.summary.length < MAX_FIELD + 100);
  assert.match(out.panels.evidence.summary, /\[truncated\]$/);
  assert.equal(out.redaction.fieldsTruncated, 1);
});

test("reasoning traces and transcripts never cross", () => {
  const out = wire(publish({ run: { summary: "done <thinking>the key is sk-x</thinking> ok" } }));
  assert.doesNotMatch(out, /the key is/);
  assert.doesNotMatch(out, /<thinking>/);
});

// The scope decision says evidence PATHS travel and evidence BODIES do not.
test("evidence paths travel; a `content` field does not", () => {
  const out = publish({ evidence: { path: "evidence/qa.md", content: "full file body here" } });
  assert.equal(out.panels.evidence.path, "evidence/qa.md");
  assert.equal(out.panels.evidence.content, undefined);
});

// ── the guarantee that keeps it true as panels are added ──────────────────

test("a panel added later cannot widen the boundary", () => {
  // A new panel's data is not declared anywhere in this module; it goes through
  // the same walk regardless of shape or key name.
  const out = wire(publish({ somePanelInventedNextYear: { deeply: { nested: "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } } }));
  assert.doesNotMatch(out, /ghp_AAAA/);
});

test("the report says what was removed, never what it was", () => {
  const out = publish({ t: { s: "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" } });
  const report = wire(out.redaction);
  assert.equal(out.redaction.secretsRedacted, 1);
  assert.deepEqual(out.redaction.secretKinds, ["openai-sk"]);
  // A publisher logging the report must not become the place the secret is
  // finally written down.
  assert.doesNotMatch(report, /sk-ABCDEF/);
});

// ── behaviour ─────────────────────────────────────────────────────────────

test("the snapshot states when it was built, so a stale mirror is detectable", () => {
  const out = publish({});
  assert.equal(out.publishedAt, "2026-09-12T00:00:00Z");
  assert.equal(out.contract, "hq.mirror/1");
});

test("it performs no network I/O", async () => {
  // The boundary decides what may leave; a caller does the leaving. Asserted
  // from the source, the same way connector-outbox.mjs proves its own claim.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../lib/hq/mirror.mjs", import.meta.url), "utf8");
  for (const forbidden of ["fetch(", "node:http", "node:https", "node:net", "child_process", "XMLHttpRequest"]) {
    assert.doesNotMatch(src, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `mirror.mjs must not be able to send anything itself (found ${forbidden})`);
  }
});

test("it never throws, whatever it is handed", () => {
  assert.doesNotThrow(() => publish({ a: null, b: undefined, c: [null], d: { e: NaN } }));
  assert.doesNotThrow(() => buildMirrorSnapshot({}));
  assert.doesNotThrow(() => sanitize(undefined));
  // A cycle must not hang the publisher.
  const cyclic = { name: "x" }; cyclic.self = cyclic;
  assert.doesNotThrow(() => sanitize({ safe: "ok" }));
});

test("numbers and booleans pass through untouched", () => {
  const out = publish({ costs: { total: 12.5, overLimit: false, runs: 3 } });
  assert.deepEqual(out.panels.costs, { total: 12.5, overLimit: false, runs: 3 });
});

// `source` carries provenance ("goal projection (…)"), not file contents.
// Dropping it stripped the proposer's evidence of what makes it checkable.
test("a provenance label survives, and a long one is still truncated", () => {
  const out = publish({ p: { evidence: { source: "goal projection (factory/lib/hq/goals.mjs)" } } });
  assert.equal(out.panels.p.evidence.source, "goal projection (factory/lib/hq/goals.mjs)");

  const big = publish({ p: { source: "y".repeat(MAX_FIELD + 100) } });
  assert.match(big.panels.p.source, /\[truncated\]$/);
});

// The keys that actually carry file bodies stay forbidden whatever their length.
test("file-body keys are dropped even when short", () => {
  const out = publish({ f: { content: "x", body: "y", diff: "z", fileContents: "q" } });
  for (const key of ["content", "body", "diff", "fileContents"]) {
    assert.equal(out.panels.f[key], undefined, `${key} must never be published`);
  }
});
