// Tonight's plan, on its way to the console.
//
// The panel exists so the console can answer "what is the factory doing
// tonight" without the tunnel. The tests below are mostly about what must NOT
// cross: this is founder-facing state that is read on a phone, and the queue it
// is built from holds absolute paths on the factory machine.
import test from "node:test";
import assert from "node:assert/strict";

import { buildOvernightPanel, OVERNIGHT_CONTRACT } from "../lib/hq/overnight.mjs";

const item = (over = {}) => ({
  id: "night-1", objective: "Ship the backend", projectId: "lifemaxing",
  repo: "/home/joao-vitor/repos/lifemax", status: "queued",
  addedAt: "2026-09-15T01:00:00.000Z", ...over,
});

test("the repository path never reaches the panel", () => {
  const panel = buildOvernightPanel({ status: "idle", items: [item()] }, { limit: 8 });
  const serialized = JSON.stringify(panel);
  assert.ok(!serialized.includes("/home/"), "no host path may cross the boundary");
  assert.ok(!serialized.includes("repo"), "and the key itself is dropped, not emptied");
  // The founder-readable half survives.
  assert.equal(panel.items[0].objective, "Ship the backend");
  assert.equal(panel.items[0].projectId, "lifemaxing");
});

test("an unreadable queue is unavailable with a reason, never a throw", () => {
  for (const bad of [null, undefined, "not an object", 42, []]) {
    const panel = buildOvernightPanel(bad, { limit: 8 });
    assert.equal(panel.contract, OVERNIGHT_CONTRACT);
    if (Array.isArray(bad)) continue; // an array is an object; covered below
    assert.equal(panel.available, false, `${typeof bad} must read as unavailable`);
    assert.ok(panel.reason.length > 10, "and say why, since an empty plan looks identical");
    assert.deepEqual(panel.items, []);
  }
});

test("a malformed queue costs the panel's contents, not the snapshot", () => {
  const panel = buildOvernightPanel({ status: "nonsense", items: "not a list" }, { limit: 8 });
  assert.equal(panel.available, true);
  assert.equal(panel.status, "idle", "an unknown run status falls back rather than being echoed");
  assert.deepEqual(panel.items, []);
});

test("an item with an unknown status is normalised, not echoed to the page", () => {
  const panel = buildOvernightPanel({ status: "idle", items: [item({ status: "<script>" })] }, { limit: 8 });
  assert.equal(panel.items[0].status, "queued");
});

test("item counts and the run state do not share a name", () => {
  const panel = buildOvernightPanel({
    status: "running",
    items: [item({ id: "a", status: "running" }), item({ id: "b", status: "queued" }), item({ id: "c", status: "failed" })],
  }, { limit: 8 });

  // `counts.running` is how many objectives are running; `isRunning` is whether
  // the night is going. Flattening these into one `running` key made the first
  // silently unreadable.
  assert.equal(panel.summary.counts.running, 1);
  assert.equal(panel.summary.isRunning, true);
  assert.equal(panel.summary.counts.failed, 1);
  assert.equal(panel.summary.total, 3);
  assert.equal(panel.summary.needsAttention, true, "a failed objective needs the founder");
});

test("a stop request is reported as pending, because the runner finishes the current objective", () => {
  const panel = buildOvernightPanel({
    status: "running", stopRequested: true, currentItemId: "night-1",
    items: [item({ status: "running" })],
  }, { limit: 8 });

  assert.equal(panel.stopRequested, true);
  assert.equal(panel.status, "running", "still running — the flag is checked between objectives");
  assert.equal(panel.currentItemId, "night-1");
});

test("the plan's limit travels with it, so the console can say when it is full", () => {
  const items = Array.from({ length: 8 }, (_, i) => item({ id: `n${i}` }));
  const full = buildOvernightPanel({ status: "idle", items }, { limit: 8 });
  assert.equal(full.limit, 8);
  assert.equal(full.full, true);

  const room = buildOvernightPanel({ status: "idle", items: items.slice(0, 3) }, { limit: 8 });
  assert.equal(room.full, false);

  // With no limit injected the console must not invent one.
  const unknown = buildOvernightPanel({ status: "idle", items }, {});
  assert.equal(unknown.limit, null);
  assert.equal(unknown.full, false);
});

test("timestamps are normalised to ISO, and unparseable ones become null rather than NaN", () => {
  const panel = buildOvernightPanel({
    status: "complete",
    items: [item({ addedAt: "not a date", startedAt: "2026-09-15T02:00:00Z", endedAt: null })],
  }, { limit: 8 });
  assert.equal(panel.items[0].addedAt, null);
  assert.equal(panel.items[0].startedAt, "2026-09-15T02:00:00.000Z");
  assert.equal(panel.items[0].endedAt, null);
});

test("a failed item carries the founder-readable sentence, not the exit code", () => {
  const panel = buildOvernightPanel({
    status: "needs-attention",
    items: [item({ status: "failed", exitCode: 137, error: "The objective stopped before delivery." })],
  }, { limit: 8 });
  assert.match(panel.items[0].error, /stopped before delivery/);
  assert.equal(panel.items[0].exitCode, undefined, "an exit code is not a sentence");
});
