// The rule this file defends: HQ never operates on a durable file whose format
// it does not understand. Issue #159.
//
// The important test is the last one. Every other test proves one reader
// refuses a file from the future; the last proves a durable format cannot be
// *added* without a reader that does — the only thing that keeps the rule from
// decaying one new file at a time.
//
// Fixtures are written by HQ's own writers and then version-bumped, so what
// each reader is handed is exactly what HQ writes, not a hand-rolled guess at
// the shape.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  DURABLE_FORMATS, UnsupportedVersionError, assertSupportedVersion, isUnsupportedVersion, supportedVersion,
} from "../lib/store/durable-version.mjs";

import { enqueueWakeup, readWakeupQueue } from "../lib/wakeups/queue.mjs";
import { acquireTaskLease, readLease } from "../lib/leases/task-lease.mjs";
import { appendCostEvent, createCostEvent, readCostEvents } from "../lib/hq/cost-ledger.mjs";
import { appendAuditEvent, createAuditEvent, readAuditEvents } from "../lib/audit/envelope.mjs";
import { appendInteraction, createInteraction, readInteractions } from "../lib/hq/interactions.mjs";
import { connectorEvent, enqueue, outboxPaths, readConnectorState, readOutbox, setCursor } from "../lib/integrations/connector-outbox.mjs";
import { buildGoalsSnapshot, readGoalRegistry } from "../lib/hq/goals.mjs";
import { readPolicyRegistry } from "../lib/hq/budget-policies.mjs";
import { readPermissionRegistry } from "../lib/hq/permissions.mjs";
import { buildBudgetSnapshot } from "../lib/hq/budget-snapshot.mjs";
import { buildPermissionsSnapshot } from "../lib/hq/permissions-snapshot.mjs";
import { readState } from "../lib/task-workflow.mjs";
import { readObjState } from "../lib/objective/orchestrator.mjs";

const AT = "2026-09-10T00:00:00.000Z";
const root = () => mkdtempSync(join(tmpdir(), "hq-durable-"));

function put(file, body) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return file;
}

// Rewrite the version of every record in a file that HQ itself wrote. This is
// what a newer HQ writing the same file would look like to this one.
function bumpVersion(path, version, kind) {
  const raw = readFileSync(path, "utf8");
  if (kind === "ndjson") {
    const lines = raw.split("\n").filter(Boolean).map((line) => JSON.stringify({ ...JSON.parse(line), version }));
    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
  }
  writeFileSync(path, `${JSON.stringify({ ...JSON.parse(raw), version }, null, 2)}\n`);
  return path;
}

// One entry per durable format: write the file the way HQ writes it, and say
// how to read it back. The last test asserts this table covers DURABLE_FORMATS.
const READERS = {
  "task-state": (dir) => {
    const path = put(join(dir, "tasks", "t1", "state.json"), { version: 1, task: { id: "t1" }, stages: {}, dispatches: [], events: [] });
    return { path, read: () => readState(path) };
  },
  "objective-state": (dir) => {
    const path = put(join(dir, "objectives", "o1", "state.json"), { version: 1, objective: { id: "o1" }, nodes: [] });
    return { path, read: () => readObjState(path) };
  },
  "wakeup-queue": (dir) => {
    const path = join(dir, "wakeups.json");
    enqueueWakeup(path, { source: "schedule", taskRef: "t1", actorId: "worker", idempotencyKey: "k1", notBefore: AT });
    return { path, read: () => readWakeupQueue(path) };
  },
  "task-lease": (dir) => {
    const leaseRoot = join(dir, "leases");
    mkdirSync(leaseRoot, { recursive: true });
    acquireTaskLease({ root: leaseRoot, taskId: "t1", actorId: "a1", runId: "r1" });
    return { path: join(leaseRoot, "t1.lease", "lease.json"), read: () => readLease(leaseRoot, "t1") };
  },
  "goal-registry": (dir) => {
    const path = put(join(dir, "goals.json"), { version: 1, goals: [] });
    return { path, read: () => readGoalRegistry(dir, { path }) };
  },
  "budget-registry": (dir) => {
    const path = put(join(dir, "budgets.json"), { version: 1, policies: [] });
    return { path, read: () => readPolicyRegistry(dir, { path }) };
  },
  "permission-registry": (dir) => {
    const path = put(join(dir, "permissions.json"), { version: 1, mode: "off", grants: [] });
    return { path, read: () => readPermissionRegistry(dir, { path }) };
  },
  "connector-state": (dir) => {
    const paths = outboxPaths(dir);
    setCursor(paths, "tasks", "cursor-1");
    return { path: paths.state, read: () => readConnectorState(paths.state) };
  },
  "connector-event": (dir) => {
    const paths = outboxPaths(dir);
    enqueue(paths, connectorEvent({ kind: "task.updated", subjectType: "task", subjectId: "t1", occurredAt: AT, revision: 1 }));
    return { path: paths.events, read: () => readOutbox(paths.events) };
  },
  "audit-event": (dir) => {
    const path = join(dir, "audit.ndjson");
    appendAuditEvent(path, createAuditEvent({
      actor: { type: "system", id: "hq" }, action: "test.event", subject: { type: "task", id: "t1" }, correlation: {}, data: {},
    }));
    return { path, read: () => readAuditEvents(path) };
  },
  "cost-event": (dir) => {
    const path = join(dir, "cost.ndjson");
    appendCostEvent(path, createCostEvent({
      eventType: "usage", source: "openclaw", sourceEventId: "s1", provider: "anthropic", model: "opus",
      occurredAt: AT, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, costMicros: 1,
    }));
    return { path, read: () => readCostEvents(path) };
  },
  "interaction": (dir) => {
    const path = join(dir, "interactions.ndjson");
    appendInteraction(path, createInteraction({ taskId: "t1", kind: "comment", author: { type: "human", id: "founder" }, body: "hello", occurredAt: AT }));
    return { path, read: () => readInteractions(path) };
  },
};

// `assert.throws` returns undefined, so capture the error the plain way.
function caught(fn) {
  try { fn(); } catch (error) { return error; }
  return null;
}

// ── the check itself ─────────────────────────────────────────────────────────

test("a version above what we understand is refused, naming the file and both versions", () => {
  const error = caught(() => assertSupportedVersion(2, { format: "task-state", path: "/hq/tasks/t1/state.json" }));
  assert.ok(error instanceof UnsupportedVersionError);
  assert.match(error.message, /\/hq\/tasks\/t1\/state\.json/, "names the file");
  assert.match(error.message, /is version 2/, "names the version found");
  assert.match(error.message, /version 1 at most/, "names the version supported");
  assert.equal(isUnsupportedVersion(error), true);
});

test("a missing version is the floor, not an error", () => {
  // Operator-authored registry files omit it today and are accepted today.
  // Refusing them would turn a hardening change into an outage on config the
  // operator already wrote.
  assert.equal(assertSupportedVersion(undefined, { format: "goal-registry", path: "/x" }), 1);
  assert.equal(assertSupportedVersion(null, { format: "goal-registry", path: "/x" }), 1);
});

test("a nonsense version is corruption, reported as such rather than as the future", () => {
  for (const bad of [0, -1, 1.5, "1", {}]) {
    const error = caught(() => assertSupportedVersion(bad, { format: "task-state", path: "/x" }));
    assert.ok(error, `${JSON.stringify(bad)} must be rejected`);
    assert.equal(isUnsupportedVersion(error), false, `${JSON.stringify(bad)} is corruption, not the future`);
    assert.match(error.message, /invalid version/);
  }
});

test("an unknown format is a programming error, caught immediately", () => {
  assert.throws(() => supportedVersion("not-a-format"), /Unknown durable format/);
});

// ── every reader ─────────────────────────────────────────────────────────────

for (const [format, entry] of Object.entries(DURABLE_FORMATS)) {
  const build = READERS[format];
  if (!build) continue; // the coverage test below is what fails for a gap

  test(`${format}: a file at the supported version reads exactly as it does today`, () => {
    const { read } = build(root());
    assert.doesNotThrow(read);
  });

  test(`${format}: a file from the future is refused rather than misread`, () => {
    const { path, read } = build(root());
    bumpVersion(path, entry.max + 1, entry.kind);

    if (format === "connector-state") {
      // The one deliberate exception. Connector state is a cache of cursor and
      // circuit position; the outbox log is the record, so losing the cache is
      // recoverable and throwing here would strand deliverable events. It
      // degrades — but it must not merge fields it does not understand, and it
      // must say why.
      const state = read();
      assert.equal(state.degraded, true);
      assert.match(state.reason || "", /understands version/);
      assert.deepEqual(state.cursors, {}, "a cursor from a format we cannot read must not be adopted");
      return;
    }

    const error = caught(read);
    assert.ok(error, `${format} must refuse a file from the future`);
    assert.equal(isUnsupportedVersion(error), true, `${format} must refuse with a typed error, got: ${error.message}`);
    assert.equal(error.found, entry.max + 1);
    assert.ok(error.path, "the refusal names the file");
  });
}

// ── the guard that keeps this from decaying ──────────────────────────────────

test("every durable format has a reader that performs the check", () => {
  assert.deepEqual(
    Object.keys(READERS).sort(),
    Object.keys(DURABLE_FORMATS).sort(),
    "A durable format was added to DURABLE_FORMATS without a reader exercised here. " +
    "Add it to READERS above — a format nothing checks is a format an older HQ will " +
    "one day silently misread.",
  );
});

// ── the refusal degrades a panel, it does not take the factory down ──────────

test("a registry from the future degrades its panel with an honest reason", () => {
  // The failure mode this whole issue exists to prevent is the silent one: an
  // older HQ parsing a newer file and rendering a confidently wrong projection.
  // The second-worst is a hard crash. What an operator should get is a panel
  // that says it cannot read the file, and why.
  const dir = root();
  mkdirSync(join(dir, "factory"), { recursive: true });
  put(join(dir, "factory", "goals.json"), { version: 2, goals: [] });
  put(join(dir, "factory", "budgets.json"), { version: 2, policies: [] });
  put(join(dir, "factory", "permissions.json"), { version: 2, mode: "off", grants: [] });

  for (const [name, build] of [["goals", buildGoalsSnapshot], ["budgets", buildBudgetSnapshot], ["permissions", buildPermissionsSnapshot]]) {
    const snapshot = build({ hqRoot: dir });
    assert.equal(snapshot.available, false, `${name} must report itself unavailable`);
    const warnings = (snapshot.warnings || []).join(" ");
    assert.match(warnings, /is version 2/, `${name} must name the version it found`);
    assert.match(warnings, /understands version 1 at most/, `${name} must name the version it supports`);
  }
});
