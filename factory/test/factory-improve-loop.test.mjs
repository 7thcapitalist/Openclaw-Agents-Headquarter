import test from "node:test";
import assert from "node:assert/strict";
import { assessRound, waitForNextRound, retryableObjective, assertResumableObjective } from "../../scripts/factory-improve-loop.mjs";

test("assessRound: a round that shipped PRs is productive, not barren", () => {
  const r = assessRound({
    status: "complete",
    objective: {
      nodes: {
        a: { id: "a", githubPublish: { prUrl: "https://github.com/o/r/pull/1" } },
        b: { id: "b", githubPublish: { prUrl: "https://github.com/o/r/pull/2" } },
      },
      integration: { githubPublish: { prUrl: "https://github.com/o/r/pull/3" } },
    },
  });
  assert.equal(r.barren, false);
  assert.equal(r.prs.length, 3);
  assert.deepEqual(r.infraBlocked, []);
});

test("assessRound: zero PRs + an infra-class blocker is barren (credit pressure)", () => {
  const r = assessRound({
    status: "blocked",
    objective: {
      nodes: {
        a: { id: "a", blocker: { outcome: "fail", stage: "builder", summary: "openclaw agent could not run: [openclaw] Could not start the CLI" } },
        b: { id: "b", blocker: { outcome: "fail", stage: "reviewer", summary: "auth profile temporarily unavailable for openai/gpt-5.6-sol" } },
      },
      integration: {},
    },
  });
  assert.equal(r.barren, true);
  assert.deepEqual(r.infraBlocked.sort(), ["a", "b"]);
  assert.equal(r.prs.length, 0);
});

test("assessRound: zero PRs but a real FAIL (hard) blocker is NOT barren — that's a design wall, not credits", () => {
  const r = assessRound({
    status: "blocked",
    objective: {
      nodes: {
        a: { id: "a", blocker: { outcome: "fail", stage: "qa", summary: "QA: acceptance criteria not met — output is wrong" } },
      },
      integration: {},
    },
  });
  assert.equal(r.infraBlocked.length, 0);
  assert.equal(r.barren, false);
  assert.equal(r.prs.length, 0);
});

test("assessRound: tolerates a missing/empty result", () => {
  const r = assessRound(undefined);
  assert.equal(r.prs.length, 0);
  assert.equal(r.status, "unknown");
});


test("shutdown interrupts a long idle backoff immediately", async () => {
  const controller = new AbortController();
  const before = Date.now();
  const waiting = waitForNextRound(3 * 60 * 60 * 1000, controller.signal);
  controller.abort();
  await waiting;
  await waitForNextRound(100000, controller.signal);
  assert.ok(Date.now() - before < 1000);
});

test("objective retry preserves real decisions and rearms only infrastructure failures", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("fs");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  const root = mkdtempSync(join(tmpdir(), "loop-retry-"));
  try {
    const statePath = join(root, "state.json"), objectivePath = join(root, "objective.json");
    const state = { status: "blocked", currentStage: "architect", task: { risk: "low" }, stages: { product: { status: "pass" }, architect: { status: "fail" } }, events: [], blocker: { outcome: "fail", summary: "provider temporarily unavailable" } };
    const obj = { nodes: { a: { id: "a", status: "blocked", statePath } }, integration: { id: "integration", status: "pending" } };
    writeFileSync(statePath, JSON.stringify(state)); writeFileSync(objectivePath, JSON.stringify(obj));
    assert.equal(retryableObjective(objectivePath), true);
    assert.equal(retryableObjective(objectivePath, { resume: true }), true);
    const resumed = JSON.parse(readFileSync(statePath));
    assert.equal(resumed.status, "active"); assert.equal(resumed.stages.product.status, "pass");
    assert.equal(resumed.events.at(-1).type, "overnight-infra-retry");
    state.blocker.outcome = "decision-required";
    writeFileSync(statePath, JSON.stringify(state));
    assert.equal(retryableObjective(objectivePath, { resume: true }), false);
    assert.equal(JSON.parse(readFileSync(statePath)).status, "blocked");
    obj.nodes.a.status = "running"; writeFileSync(objectivePath, JSON.stringify(obj));
    assert.equal(retryableObjective(objectivePath), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("explicit resume rejects running jobs and any integration already started", () => {
  assert.doesNotThrow(() => assertResumableObjective({ nodes: { a: { status: "blocked" } }, integration: { status: "pending" } }));
  for (const status of ["running", "blocked", "gate-satisfied"]) {
    assert.throws(() => assertResumableObjective({ nodes: {}, integration: { status } }), /Integration already started/);
  }
  assert.throws(() => assertResumableObjective({ nodes: {}, integration: { status: "pending", statePath: "/existing/state" } }), /Integration already started/);
  assert.throws(() => assertResumableObjective({ nodes: { a: { status: "running" } }, integration: { status: "pending" } }), /running nodes/);
});
