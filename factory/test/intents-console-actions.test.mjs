// What the Home view's buttons can actually cause, and what happens when they
// press one this machine does not wire.
//
// Thirteen kinds are allowlisted and nine are handled. A console offering an
// unhandled kind previously enqueued a request that reported `failed` with
// "no handler registered" — technically true, but `failed` reads as "we tried",
// and a page cannot tell the founder that nothing was ever going to run.
//
// The fixture below deliberately wires only two kinds: these tests are about
// what `executeIntent` does with a kind it has or lacks, not about this
// machine's wiring. The real map is asserted separately, at the bottom, by
// importing it — because a fixture that restates the wiring is a fixture that
// will quietly disagree with it.
import test from "node:test";
import assert from "node:assert/strict";

import { executeIntent, executeBatch } from "../lib/hq/intent-worker.mjs";
import { INTENT_KINDS, validateIntent } from "../lib/integrations/intent-protocol.mjs";

const handlers = {
  "task.retry": async ({ taskId }) => `resumed ${taskId}`,
  "decision.resolve": async ({ decisionId }) => `recorded decision on ${String(decisionId).split(":")[0]}`,
};

// Every declared argument of a kind is required, and validation runs BEFORE the
// handler lookup. So a test about "is this kind wired" has to send a complete
// argument set, or it measures the validator instead.
function argsFor(kind) {
  const filled = { taskId: "task-ca3c3cdf", objectiveId: "obj-c58897c0", decisionId: "task-ca3c3cdf:reviewer",
    choice: "yes", reason: "no", assertion: "sig", itemId: "night-1", body: "text",
    objective: "do the thing", projectId: "lifemaxing", mode: "shadow" };
  return Object.fromEntries((INTENT_KINDS[kind]?.args || []).map((name) => [name, filled[name]]));
}

test("the two kinds Home needs execute and report what they did", async () => {
  const retry = await executeIntent({ id: "a", kind: "task.retry", args: { taskId: "obj-74ffa4cc-control-plane-app-shell" } }, handlers);
  assert.equal(retry.status, "done");
  assert.match(retry.detail, /^resumed obj-74ffa4cc/);

  const decide = await executeIntent({ id: "b", kind: "decision.resolve", args: { decisionId: "task-ca3c3cdf:reviewer", choice: "A: provision a temporary test database" } }, handlers);
  assert.equal(decide.status, "done");
  assert.match(decide.detail, /recorded decision on task-ca3c3cdf/);
});

test("an allowlisted but unwired kind is REJECTED with a reason a page can display", async () => {
  // Valid args on purpose: this must reach the handler lookup and be rejected
  // for being unwired, not bounce off the validator for a missing field.
  const result = await executeIntent({ id: "c", kind: "task.comment", args: { taskId: "task-ca3c3cdf", body: "any" } }, handlers);
  // `rejected`, not `failed`: this machine did not try and fail, it will not do
  // this at all. The distinction is what the founder reads.
  assert.equal(result.status, "rejected");
  assert.match(result.detail, /allowlisted but not handled/);
  assert.match(result.detail, /nothing was run/);
  assert.match(result.detail, /scripts\/hq-intents\.mjs/, "and says where it would be wired");
});

test("every unwired kind is rejected, none silently", async () => {
  const unwired = Object.keys(INTENT_KINDS).filter((k) => !(k in handlers));
  assert.ok(unwired.length >= 4, "the fixture wires two kinds; the rest must still be rejected");
  for (const kind of unwired) {
    const result = await executeIntent({ id: kind, kind, args: argsFor(kind) }, handlers);
    assert.equal(result.status, "rejected", `${kind} must not fail silently`);
    assert.ok(result.detail && result.detail.length > 20, `${kind} must carry a displayable reason`);
  }
});

test("a kind that is not allowlisted at all is rejected before any lookup", async () => {
  const hostile = { ...handlers, "evil.kind": async () => "ran" };
  const result = await executeIntent({ id: "d", kind: "evil.kind", args: {} }, hostile);
  assert.equal(result.status, "rejected");
  assert.match(result.detail, /unknown intent kind/);
});

test("prototype keys cannot resolve to a handler", async () => {
  for (const kind of ["constructor", "__proto__", "toString"]) {
    const result = await executeIntent({ id: kind, kind, args: {} }, handlers);
    assert.equal(result.status, "rejected");
  }
});

test("the historical rejection is reproducible: a shell metacharacter in a taskId", () => {
  // The only intent in this queue's history was rejected with exactly this.
  const verdict = validateIntent({ kind: "task.retry", args: { taskId: "obj-x; rm -rf /" } });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /shell-metacharacters/);

  // And a real task id is not affected — the validator was right, the caller
  // sent something that was not a task id.
  for (const id of ["obj-c58897c0-integration", "task-ca3c3cdf", "obj-74ffa4cc-control-plane-app-shell"]) {
    assert.equal(validateIntent({ kind: "task.retry", args: { taskId: id } }).ok, true, id);
  }
});

test("a batch runs in order and reports each outcome", async () => {
  const seen = [];
  const results = await executeBatch(
    [
      { id: "1", kind: "task.retry", args: { taskId: "obj-a" } },
      { id: "2", kind: "task.comment", args: { taskId: "obj-b", body: "any" } },
      { id: "3", kind: "decision.resolve", args: { decisionId: "obj-b:product", choice: "yes" } },
    ],
    handlers,
    { onResult: (intent, result) => { seen.push(`${intent.kind}:${result.status}`); } },
  );
  assert.deepEqual(seen, ["task.retry:done", "task.comment:rejected", "decision.resolve:done"]);
  assert.deepEqual(results.map((r) => r.status), ["done", "rejected", "done"]);
});


// ── what THIS machine actually wires ─────────────────────────────────────────
//
// Imported, not restated. `scripts/hq-intents.mjs` only runs its CLI when
// invoked directly, so importing it here yields the handler map and starts no
// polling.
test("every handler this machine wires is allowlisted", async () => {
  const { handlers: realHandlers } = await import("../../scripts/hq-intents.mjs");
  const wired = Object.keys(await realHandlers());
  for (const kind of wired) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(INTENT_KINDS, kind),
      `${kind} is wired but not allowlisted — a handler can never be the thing that grants a power`,
    );
  }
});

test("the console's actions are wired, and the rest still reject with a reason", async () => {
  const { handlers: realHandlers } = await import("../../scripts/hq-intents.mjs");
  const real = await realHandlers();

  // Everything the console offers a button for must execute here. A drawn
  // control whose kind is unwired is the dead button this project forbids.
  for (const kind of [
    "task.retry", "objective.retry", "decision.resolve",
    "objective.start", "overnight.add", "overnight.remove", "overnight.start", "overnight.stop",
    "question.ask", "inbox.dismiss", "task.comment",
    "learning.mode",
  ]) {
    assert.ok(typeof real[kind] === "function", `${kind} must be wired for the console to offer it`);
  }

  // And the kinds still unwired must reject — never `failed`, never silent.
  const unwired = Object.keys(INTENT_KINDS).filter((k) => !(k in real));
  assert.deepEqual(
    unwired.sort(),
    // Only the two approval kinds remain, and they are held back on purpose:
    // DC-2026-006 asks whether the factory should trust a second founder
    // approval key so high-risk builds can be approved from the hosted console,
    // and its stated default while open is that these stay unwired. That is a
    // founder decision about a security boundary, not a tidy-up.
    ["approval.reject", "approval.submit"],
    "if this list changed, wire the console button or update it deliberately",
  );
  for (const kind of unwired) {
    const result = await executeIntent({ id: kind, kind, args: argsFor(kind) }, real);
    assert.equal(result.status, "rejected", `${kind} must not fail silently`);
    assert.match(result.detail, /allowlisted but not handled/);
  }
});
