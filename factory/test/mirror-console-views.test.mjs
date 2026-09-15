// The three partial views from the pipe audit, and the two divergences it found
// and could not explain.
//
// Neither divergence was a broken join. Both were definitional gaps — two
// honest answers to different questions, with nothing saying so — which is
// worse than a bug, because the numbers look authoritative while disagreeing.
import test from "node:test";
import assert from "node:assert/strict";

import { countByStatus } from "../lib/hq/company-state.mjs";
import { buildAgentActivity } from "../lib/hq/activity.mjs";
import { cleanSeat, readConfiguredSeats, resolveSeat } from "../lib/hq/seats.mjs";

// ─── the task-count vocabulary gap ───────────────────────────────────────────

test("task counts cover every status, not just active and blocked", () => {
  // lifemaxing's real shape: 1 failed, 2 merged, 0 active, 0 blocked. It
  // rendered as "0 active, 0 blocked, 3 tasks" — an idle-looking project where
  // two had shipped and one had failed.
  const tasks = [{ status: "failed" }, { status: "merged" }, { status: "merged" }];
  assert.deepEqual(countByStatus(tasks), { failed: 1, merged: 2 });

  const active = tasks.filter((t) => t.status === "active");
  const blocked = tasks.filter((t) => t.status === "blocked");
  assert.equal(active.length + blocked.length, 0, "the two legacy arrays see none of these");
  assert.equal(Object.values(countByStatus(tasks)).reduce((a, b) => a + b, 0), 3, "but the counts see all three");
});

test("a status the workflow has never emitted is absent, not reported as zero", () => {
  const counts = countByStatus([{ status: "active" }]);
  assert.deepEqual(counts, { active: 1 });
  assert.equal("merged" in counts, false, "a new status must show up as itself, not be silently dropped");
});

test("a task with no status is counted as unknown rather than skipped", () => {
  assert.deepEqual(countByStatus([{}, { status: null }]), { unknown: 2 });
});

// ─── the model seat ──────────────────────────────────────────────────────────

test("a seat drops its @version so one seat is one seat", () => {
  assert.equal(cleanSeat("openai/gpt-5.6-sol@2"), "openai/gpt-5.6-sol");
  assert.equal(cleanSeat("anthropic/claude-sonnet-5"), "anthropic/claude-sonnet-5");
  assert.equal(cleanSeat(null), null);
  assert.equal(cleanSeat(""), null);
});

test("the live runtime wins over configuration, and says which it used", () => {
  const seats = { reviewer: { primary: "anthropic/claude-sonnet-5", fallbacks: [] } };
  assert.deepEqual(
    resolveSeat({ runtimeAgentId: "reviewer", runtimeModel: "openai/gpt-5.4-mini@1", seats }),
    { primary: "openai/gpt-5.4-mini", fallbacks: [], source: "runtime" },
  );
  // The runtime read is unavailable far more often than not — every agent in
  // the live mirror carries runtimeResolved: false — so configuration is the
  // fallback rather than reporting no seat at all.
  assert.deepEqual(
    resolveSeat({ runtimeAgentId: "reviewer", runtimeModel: null, seats }),
    { primary: "anthropic/claude-sonnet-5", fallbacks: [], source: "config" },
  );
});

test("an unknown role reports no seat rather than inventing one", () => {
  assert.equal(resolveSeat({ runtimeAgentId: "nobody", runtimeModel: null, seats: {} }), null);
});

test("a missing or unreadable openclaw config costs the seat, never the snapshot", () => {
  assert.deepEqual(readConfiguredSeats({ configPath: "/nonexistent/openclaw.json" }), { seats: {}, defaultSeat: null });
});

test("agent rows carry the seat the role actually routes to", () => {
  const rows = buildAgentActivity({
    agents: [{ id: "reviewer", name: "Reviewer", role: "Review", kind: "claude", harness: "claude", runtimeAgentId: "reviewer", capabilities: [] }],
    tasks: [],
    seats: { seats: { reviewer: { primary: "anthropic/claude-sonnet-5", fallbacks: ["openai/gpt-5.6-sol"] } }, defaultSeat: null },
  });
  const reviewer = rows.agents.find((a) => a.id === "reviewer");
  // `harness` is the family and never answered "which model".
  assert.equal(reviewer.harness, "claude");
  assert.equal(reviewer.modelSeat.primary, "anthropic/claude-sonnet-5");
  assert.deepEqual(reviewer.modelSeat.fallbacks, ["openai/gpt-5.6-sol"]);
});
