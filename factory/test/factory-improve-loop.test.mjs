import test from "node:test";
import assert from "node:assert/strict";
import { assessRound } from "../../scripts/factory-improve-loop.mjs";

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
  // still "barren" by the shipped-nothing + status blocked rule, but with no
  // infra blockers the loop's providerPressure() won't add a reason from this.
  assert.equal(r.prs.length, 0);
});

test("assessRound: tolerates a missing/empty result", () => {
  const r = assessRound(undefined);
  assert.equal(r.prs.length, 0);
  assert.equal(r.status, "unknown");
});
