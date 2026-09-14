// The last two capabilities: posting to a task's context, and putting a wakeup
// on someone else's queue.
//
// Both differ from the task- and objective-level checks in a way worth stating.
// The only caller of `appendInteraction` today posts as the authenticated
// founder, whose authority is superior — so that path can never be refused, and
// the check exists for the agent callers that come later. And a wakeup carries
// no command, only an identifier, so `wakeup.enqueue` gates who may put work on
// a queue rather than what that work is.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { permissionAuditPath } from "../lib/hq/capability-check.mjs";
import { appendInteraction, createInteraction, readInteractions } from "../lib/hq/interactions.mjs";
import { enqueueWakeup, readWakeupQueue } from "../lib/wakeups/queue.mjs";

function hq({ mode = null, grants = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cap-side-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  if (mode) {
    writeFileSync(join(root, "factory", "permissions.json"), JSON.stringify({ version: 1, mode, grants }, null, 2));
  }
  return root;
}

const auditLines = (root) => {
  const path = permissionAuditPath(root);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
};

const wouldDeny = (entry) => String(entry.data.wouldDeny) === "true";
const grant = (actorId, capability) => ({ actorId, capability, scopeType: "company", scopeId: "*" });

const comment = (author, key = "k1") => createInteraction({
  taskId: "task-side",
  kind: "comment",
  author,
  body: "a note on the work",
  idempotencyKey: key,
});

const wakeup = (actorId = "reviewer", key = "w1") => ({
  actorId,
  taskRef: "task-side",
  source: "mention",
  idempotencyKey: key,
});

// ── interaction.post ────────────────────────────────────────────────────────

test("with no registry, an interaction is appended and nothing is audited", () => {
  const root = hq();
  const path = join(root, "interactions.ndjson");

  const result = appendInteraction(path, comment({ type: "human", id: "founder" }), { hqRoot: root });

  assert.equal(result.accepted, true);
  assert.equal(readInteractions(path).length, 1);
  assert.deepEqual(auditLines(root), []);
});

test("the founder posting is allowed even under enforce with an empty table", () => {
  const root = hq({ mode: "enforce", grants: [] });
  const path = join(root, "interactions.ndjson");

  const result = appendInteraction(path, comment({ type: "human", id: "founder" }), { hqRoot: root });

  assert.equal(result.accepted, true, "this is the only caller today, and it must never be refused");
  const entry = auditLines(root).at(-1);
  assert.equal(entry.data.reason, "founder-authority");
});

test("enforce mode refuses an ungranted agent and appends nothing", () => {
  const root = hq({ mode: "enforce", grants: [grant("someone-else", "interaction.post")] });
  const path = join(root, "interactions.ndjson");

  assert.throws(
    () => appendInteraction(path, comment({ type: "agent", id: "reviewer" }), { hqRoot: root }),
    /not permitted to interaction\.post/,
  );
  assert.deepEqual(readInteractions(path), [], "a refused post leaves no record");
});

test("report mode records an ungranted agent's post and appends it anyway", () => {
  const root = hq({ mode: "report", grants: [] });
  const path = join(root, "interactions.ndjson");

  const result = appendInteraction(path, comment({ type: "agent", id: "reviewer" }), { hqRoot: root });

  assert.equal(result.accepted, true, "report mode never stops work");
  assert.equal(readInteractions(path).length, 1);
  const entry = auditLines(root).at(-1);
  assert.equal(entry.data.capability, "interaction.post");
  assert.equal(wouldDeny(entry), true);
});

test("a caller that passes no hqRoot still posts", () => {
  const root = hq({ mode: "enforce", grants: [] });
  const path = join(root, "interactions.ndjson");

  assert.equal(appendInteraction(path, comment({ type: "agent", id: "reviewer" })).accepted, true);
  assert.deepEqual(auditLines(root), []);
});

// ── wakeup.enqueue ──────────────────────────────────────────────────────────

test("with no registry, a wakeup is queued and nothing is audited", () => {
  const root = hq();
  const path = join(root, "wakeups.json");

  enqueueWakeup(path, wakeup(), { hqRoot: root });

  assert.equal(readWakeupQueue(path).items.length, 1);
  assert.deepEqual(auditLines(root), []);
});

test("enforce mode refuses an ungranted wakeup and queues nothing", () => {
  const root = hq({ mode: "enforce", grants: [grant("someone-else", "wakeup.enqueue")] });
  const path = join(root, "wakeups.json");

  assert.throws(() => enqueueWakeup(path, wakeup(), { hqRoot: root }), /not permitted to wakeup\.enqueue/);
  assert.equal(existsSync(path), false, "a refused wakeup never creates the queue");
});

test("enforce mode allows the granted worker", () => {
  const root = hq({ mode: "enforce", grants: [grant("openclaw-wakeup-worker", "wakeup.enqueue")] });
  const path = join(root, "wakeups.json");

  enqueueWakeup(path, wakeup(), { hqRoot: root, actor: { type: "agent", id: "openclaw-wakeup-worker" } });
  assert.equal(readWakeupQueue(path).items.length, 1);
});

test("report mode records the wakeup decision and queues it anyway", () => {
  const root = hq({ mode: "report", grants: [] });
  const path = join(root, "wakeups.json");

  enqueueWakeup(path, wakeup("qa"), { hqRoot: root });

  assert.equal(readWakeupQueue(path).items.length, 1);
  const entry = auditLines(root).at(-1);
  assert.equal(entry.data.capability, "wakeup.enqueue");
  assert.equal(entry.correlation.targetActorId, "qa", "the log says whose queue was written to");
});

test("the check does not weaken what a wakeup is allowed to carry", () => {
  const root = hq({ mode: "report", grants: [] });
  const path = join(root, "wakeups.json");

  // Identifier-only is the property that makes wakeups safe; a capability check
  // in front of it must not become the thing that enforces it.
  assert.throws(
    () => enqueueWakeup(path, { ...wakeup(), command: "rm -rf /" }, { hqRoot: root }),
    /cannot contain commands/,
  );
});
