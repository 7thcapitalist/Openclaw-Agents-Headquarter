// A night the machine abandoned must be recoverable from a phone.
//
// `rootInFlight` and `child` in dashboard/backend/lib/overnightQueue.mjs are
// module state. A dashboard restart mid-run therefore left the queue at
// `status: "running"` with no child and nothing anywhere able to clear it:
// `stopOvernight` only set `stopRequested`, a flag the (now dead) runner was
// supposed to observe between items, and `addOvernightItem` /
// `removeOvernightItem` both refuse to touch a plan while it says it is
// running. The queue was stuck, permanently, and the only repair was editing
// state on the machine.
//
// That was merely bad while the founder had a tunnel dashboard. Once his only
// surface is a phone it is unrecoverable from anywhere he actually is, which
// is why it had to be fixed alongside wiring `overnight.stop`.
//
// The restart here is real: each `freshModule()` is a separate module instance
// with its own `rootInFlight`, exactly as a restarted process would have.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const MODULE = new URL("../../dashboard/backend/lib/overnightQueue.mjs", import.meta.url).href;

let generation = 0;
// A cache-busting query gives a genuinely new module instance — new module
// scope, `rootInFlight` back to null — which is what a restart is.
const freshModule = () => import(`${MODULE}?restart=${generation += 1}`);

function hqRoot() {
  const root = mkdtempSync(join(tmpdir(), "overnight-restart-"));
  mkdirSync(join(root, "dashboard", "backend", "data", "factory"), { recursive: true });
  return root;
}

// A child that never exits, so the run stays in flight for the test to
// interrupt. Unref'd and killed at the end so it cannot outlive the suite.
const strays = [];
function hangingChild(bin, args, opts) {
  const proc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { ...opts, stdio: "ignore" });
  proc.unref();
  strays.push(proc);
  return proc;
}
test.after(() => { for (const proc of strays) { try { proc.kill("SIGKILL"); } catch { /* already gone */ } } });

async function startedRun(items = ["first", "second"]) {
  const root = hqRoot();
  const before = await freshModule();
  for (const objective of items) before.addOvernightItem(root, { objective, projectId: "p", repo: root });
  before.startOvernight(root, { scriptPath: "unused", spawnChild: hangingChild });
  assert.equal(before.readOvernightQueue(root).status, "running");
  return { root, before };
}

test("a run records which process owns it", async () => {
  const { root, before } = await startedRun();
  const state = before.readOvernightQueue(root);
  assert.equal(state.runnerPid, process.pid, "without an owner, no later process can tell live from abandoned");
  assert.equal(state.items[0].status, "running");
});

test("after a restart, a stranded run is reported as stoppable and then stopped", async () => {
  const { root } = await startedRun();

  // The restart. New module scope; the queue still says "running" and still
  // names this pid, which is exactly the case that used to strand it — the
  // pid matches but nothing in this instance is driving anything.
  const after = await freshModule();
  const stopped = after.stopOvernight(root);

  assert.notEqual(stopped.status, "running", "the queue is still stuck at running after a restart");
  assert.equal(stopped.status, "needs-attention", "the item that was mid-flight did not finish, so the run needs attention");
  assert.equal(stopped.currentItemId, null);
  assert.equal(stopped.runnerPid, null, "ownership must be released or the next run inherits a dead owner");
  assert.ok(stopped.stoppedAt);
});

test("the objective that was mid-flight is failed with the reason, not silently completed", async () => {
  const { root } = await startedRun();
  const after = await freshModule();
  const stopped = after.stopOvernight(root);
  const interrupted = stopped.items[0];
  assert.equal(interrupted.status, "failed");
  assert.match(interrupted.error, /restarted mid-run/);
  // The one behind it never started and must not be blamed for the crash.
  assert.equal(stopped.items[1].status, "queued");
});

test("a stranded plan can be edited again from the phone", async () => {
  // add/remove both refuse while `status === "running"`. Before this fix, a
  // restart made the plan permanently uneditable as well as unstoppable.
  const { root } = await startedRun();
  const after = await freshModule();

  const queue = after.readOvernightQueue(root);
  const waiting = queue.items.find((item) => item.status === "queued");
  assert.doesNotThrow(() => after.removeOvernightItem(root, waiting.id));
  assert.doesNotThrow(() => after.addOvernightItem(root, { objective: "a new one", projectId: "p", repo: root }));

  const rebuilt = after.readOvernightQueue(root);
  assert.ok(!rebuilt.items.some((item) => item.id === waiting.id));
  assert.ok(rebuilt.items.some((item) => item.objective === "a new one"));
});

test("a stranded night does not block the next one", async () => {
  const { root } = await startedRun();
  const after = await freshModule();
  after.addOvernightItem(root, { objective: "tomorrow", projectId: "p", repo: root });

  const restarted = after.startOvernight(root, { scriptPath: "unused", spawnChild: hangingChild });
  assert.equal(restarted.status, "running");
  assert.equal(restarted.runnerPid, process.pid, "the new run must claim ownership, not inherit the dead one");

  // The run resumes at the FIRST thing still queued — the objective the
  // stranded night never reached — and the newly added one waits its turn.
  // The interrupted item stays failed; it is not silently retried.
  const byObjective = Object.fromEntries(restarted.items.map((item) => [item.objective, item.status]));
  assert.equal(byObjective.first, "failed");
  assert.equal(byObjective.second, "running");
  assert.equal(byObjective.tomorrow, "queued");
});

test("a LIVE run is never settled by reconciliation", async () => {
  // The failure this fix must not introduce: declaring a healthy run dead and
  // tearing down its bookkeeping underneath it.
  const { root, before } = await startedRun();
  const reconciled = before.reconcileOvernight(root);
  assert.equal(reconciled.status, "running", "reconciliation must leave a live run alone");
  assert.equal(reconciled.runnerPid, process.pid);
  assert.equal(reconciled.items[0].status, "running");

  // And stop on a live run still asks politely rather than settling it, so the
  // objective in flight is allowed to finish.
  const asked = before.stopOvernight(root);
  assert.equal(asked.status, "running");
  assert.equal(asked.stopRequested, true);
});

test("an idle or finished queue is untouched by reconciliation", async () => {
  const root = hqRoot();
  const mod = await freshModule();
  assert.equal(mod.reconcileOvernight(root).status, "idle");
  mod.addOvernightItem(root, { objective: "waiting", projectId: "p", repo: root });
  const after = mod.reconcileOvernight(root);
  assert.equal(after.status, "idle");
  assert.equal(after.items.length, 1);
  assert.equal(after.items[0].status, "queued");
});

test("a queue written before this fix, with no owner recorded, is recoverable", async () => {
  // The state on the machine right now has no `runnerPid`. A migration that
  // needed one would leave exactly the queues this fix exists to rescue stuck.
  const { root } = await startedRun();
  const mod = await freshModule();
  const { mutateTransactionalState } = await import("../lib/store/transactional-json.mjs");
  mutateTransactionalState(join(root, "dashboard", "backend", "data", "factory", "overnight-queue.json"), {
    commandId: "test-strip-owner",
    mutate: (state) => { const next = structuredClone(state); delete next.runnerPid; return next; },
  });

  const stopped = mod.stopOvernight(root);
  assert.notEqual(stopped.status, "running");
});
