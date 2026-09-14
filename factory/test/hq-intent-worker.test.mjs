// The one queue in this codebase that is fed from the internet.
//
// Every other queue here is written by the same machine that drains it. This
// one is written by a browser, over a public URL, and drained by a process on
// the founder's home machine. The failure mode is not a bad UX — it is remote
// code execution on a home network, so the tests are written against an
// attacker rather than against a typo.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { executeBatch, executeIntent } from "../lib/hq/intent-worker.mjs";

const hqRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const ran = [];
function handlers() {
  ran.length = 0;
  return {
    "task.retry": async (args) => {
      ran.push(["task.retry", args.taskId]);
      return `retried ${args.taskId}`;
    },
    "inbox.dismiss": async (args) => {
      ran.push(["inbox.dismiss", args.itemId]);
    },
  };
}

test("a valid intent runs its handler and reports done", async () => {
  const h = handlers();
  const result = await executeIntent({ id: "1", kind: "task.retry", args: { taskId: "obj-abc" } }, h);
  assert.equal(result.status, "done");
  assert.deepEqual(ran, [["task.retry", "obj-abc"]]);
});

test("an unknown kind is rejected and runs nothing", async () => {
  const h = handlers();
  for (const kind of ["task.destroy", "", "TASK.RETRY", "../../etc/passwd", "eval"]) {
    const result = await executeIntent({ id: "1", kind, args: {} }, h);
    assert.equal(result.status, "rejected", `${kind} must be rejected`);
  }
  assert.deepEqual(ran, [], "nothing may run");
});

test("a prototype-chain kind cannot reach a function", async () => {
  // "constructor" and "__proto__" resolve to callables on any plain object.
  // The allowlist check excludes them first; hasOwnProperty is the second lock.
  const h = handlers();
  for (const kind of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
    const result = await executeIntent({ id: "1", kind, args: {} }, h);
    assert.equal(result.status, "rejected", `${kind} must not resolve to a handler`);
  }
  assert.deepEqual(ran, []);
});

test("an argument shaped like a command is refused, not sanitised", async () => {
  const h = handlers();
  const hostile = [
    "obj-abc; rm -rf /",
    "obj-abc && curl evil.example",
    "$(whoami)",
    "`id`",
    "../../../etc/shadow",
    "/etc/passwd",
    "https://evil.example/payload",
    "require('child_process')",
    "obj\nabc",
  ];
  for (const taskId of hostile) {
    const result = await executeIntent({ id: "1", kind: "task.retry", args: { taskId } }, h);
    assert.equal(result.status, "rejected", `must reject: ${taskId}`);
  }
  assert.deepEqual(ran, [], "no handler may see a command-shaped argument");
});

test("an unexpected argument key is rejected rather than trimmed", async () => {
  const h = handlers();
  const result = await executeIntent(
    { id: "1", kind: "task.retry", args: { taskId: "obj-abc", andAlso: "something" } },
    h,
  );
  assert.equal(result.status, "rejected");
  assert.deepEqual(ran, [], "silently dropping a field makes the request and the action diverge");
});

test("a known kind with no registered handler fails without running anything", async () => {
  const result = await executeIntent({ id: "1", kind: "objective.retry", args: { objectiveId: "obj-x" } }, handlers());
  assert.equal(result.status, "failed");
  assert.match(result.detail, /no handler registered/);
});

test("a handler that throws fails the intent, never the loop", async () => {
  const result = await executeIntent({ id: "1", kind: "task.retry", args: { taskId: "obj-abc" } }, {
    "task.retry": async () => {
      throw new Error("disk on fire");
    },
  });
  assert.equal(result.status, "failed");
  assert.match(result.detail, /disk on fire/);
});

test("executeIntent never throws, whatever it is handed", async () => {
  for (const intent of [null, undefined, 42, "string", [], {}, { kind: null }, { kind: 1 }]) {
    const result = await executeIntent(intent, handlers());
    assert.ok(["rejected", "failed"].includes(result.status), `${JSON.stringify(intent)} -> ${result.status}`);
  }
});

test("a batch runs in order and one failure does not stop the rest", async () => {
  const seen = [];
  const results = await executeBatch(
    [
      { id: "a", kind: "task.retry", args: { taskId: "one" } },
      { id: "b", kind: "task.retry", args: { taskId: "$(boom)" } },
      { id: "c", kind: "task.retry", args: { taskId: "three" } },
    ],
    {
      "task.retry": async (args) => {
        seen.push(args.taskId);
      },
    },
  );
  assert.deepEqual(results.map((r) => r.status), ["done", "rejected", "done"]);
  assert.deepEqual(seen, ["one", "three"], "the rejected one must never reach the handler");
});

test("a failing result reporter does not lose the rest of the batch", async () => {
  const results = await executeBatch(
    [
      { id: "a", kind: "task.retry", args: { taskId: "one" } },
      { id: "b", kind: "task.retry", args: { taskId: "two" } },
    ],
    { "task.retry": async () => {} },
    {
      onResult: async () => {
        throw new Error("network down");
      },
    },
  );
  assert.equal(results.length, 2);
});

// --- structural guarantees ---------------------------------------------------

test("the protocol module still executes nothing", () => {
  const source = readFileSync(join(hqRoot, "factory", "lib", "integrations", "intent-protocol.mjs"), "utf8");
  for (const forbidden of ["child_process", "execFile", "spawn(", "eval(", "new Function"]) {
    assert.ok(!source.includes(forbidden), `intent-protocol.mjs must not reference ${forbidden}`);
  }
});

test("the worker resolves no handler dynamically", () => {
  const source = readFileSync(join(hqRoot, "factory", "lib", "hq", "intent-worker.mjs"), "utf8");
  for (const forbidden of ["child_process", "execFile", "spawn(", "eval(", "new Function", "await import("]) {
    assert.ok(!source.includes(forbidden), `intent-worker.mjs must not reference ${forbidden}`);
  }
  // The allowlist check must come before the handler lookup — in the CODE.
  // Comments in this file discuss `handlers[intent.kind]` while explaining why
  // it is guarded, so matching raw text finds the prose first and reports a
  // correct file as broken. Strip comment lines before judging order.
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  const guard = code.indexOf("isKnownIntentKind(intent.kind)");
  const lookup = code.indexOf("handlers[intent.kind]");
  assert.ok(guard > 0, "the allowlist check must exist");
  assert.ok(lookup > guard, "the kind must be proven legal before it indexes anything");
});

test("the control plane does not carry a second copy of the allowlist", () => {
  // Two definitions of what the founder may ask for would drift, and the
  // machine's must be the only one that decides.
  const queue = readFileSync(join(hqRoot, "control-plane", "api", "_lib", "queue.mjs"), "utf8");
  const endpoint = readFileSync(join(hqRoot, "control-plane", "api", "intents.mjs"), "utf8");
  for (const source of [queue, endpoint]) {
    assert.ok(!source.includes("INTENT_KINDS"), "the allowlist belongs to the machine alone");
    assert.ok(!source.includes("objective.start"), "no kind may be named in the deployable tree");
  }
});
