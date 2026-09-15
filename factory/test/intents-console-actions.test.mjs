// What the Home view's buttons can actually cause, and what happens when they
// press one this machine does not wire.
//
// Twelve kinds are allowlisted and three are handled. A console offering an
// unhandled kind previously enqueued a request that reported `failed` with
// "no handler registered" — technically true, but `failed` reads as "we tried",
// and a page cannot tell the founder that nothing was ever going to run.
import test from "node:test";
import assert from "node:assert/strict";

import { executeIntent, executeBatch } from "../lib/hq/intent-worker.mjs";
import { INTENT_KINDS, validateIntent } from "../lib/integrations/intent-protocol.mjs";

const handlers = {
  "task.retry": async ({ taskId }) => `resumed ${taskId}`,
  "decision.resolve": async ({ decisionId }) => `recorded decision on ${String(decisionId).split(":")[0]}`,
};

test("the two kinds Home needs execute and report what they did", async () => {
  const retry = await executeIntent({ id: "a", kind: "task.retry", args: { taskId: "obj-74ffa4cc-control-plane-app-shell" } }, handlers);
  assert.equal(retry.status, "done");
  assert.match(retry.detail, /^resumed obj-74ffa4cc/);

  const decide = await executeIntent({ id: "b", kind: "decision.resolve", args: { decisionId: "task-ca3c3cdf:reviewer", choice: "A: provision a temporary test database" } }, handlers);
  assert.equal(decide.status, "done");
  assert.match(decide.detail, /recorded decision on task-ca3c3cdf/);
});

test("an allowlisted but unwired kind is REJECTED with a reason a page can display", async () => {
  const result = await executeIntent({ id: "c", kind: "overnight.start", args: {} }, handlers);
  // `rejected`, not `failed`: this machine did not try and fail, it will not do
  // this at all. The distinction is what the founder reads.
  assert.equal(result.status, "rejected");
  assert.match(result.detail, /allowlisted but not handled/);
  assert.match(result.detail, /nothing was run/);
  assert.match(result.detail, /scripts\/hq-intents\.mjs/, "and says where it would be wired");
});

test("every unwired kind is rejected, none silently", async () => {
  const unwired = Object.keys(INTENT_KINDS).filter((k) => !(k in handlers));
  assert.ok(unwired.length >= 9, "most kinds are still unwired, which is the point");
  for (const kind of unwired) {
    const result = await executeIntent({ id: kind, kind, args: {} }, handlers);
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
      { id: "2", kind: "overnight.stop", args: {} },
      { id: "3", kind: "decision.resolve", args: { decisionId: "obj-b:product", choice: "yes" } },
    ],
    handlers,
    { onResult: (intent, result) => { seen.push(`${intent.kind}:${result.status}`); } },
  );
  assert.deepEqual(seen, ["task.retry:done", "overnight.stop:rejected", "decision.resolve:done"]);
  assert.deepEqual(results.map((r) => r.status), ["done", "rejected", "done"]);
});
