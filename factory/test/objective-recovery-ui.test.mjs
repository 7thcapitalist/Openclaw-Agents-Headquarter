import assert from "node:assert/strict";
import test from "node:test";

import {
  bindObjectiveRecovery,
  isObjectiveRecoverable,
  renderObjectiveRecovery,
} from "../../dashboard/backend/public/lib/objectiveRecovery.mjs";

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

test("objective recovery UI: recovery.count===0 → no retry affordance", () => {
  assert.equal(isObjectiveRecoverable({ recovery: { count: 0, nodes: [] } }), false);
  const html = renderObjectiveRecovery({ recovery: { count: 0, nodes: [] } }, { esc });
  assert.equal(html, "");
  assert.doesNotMatch(html, /data-retry-objective/);
});

test("objective recovery UI: recovery.count===2 → button, step count, titles, no raw ids", () => {
  assert.equal(isObjectiveRecoverable({
    recovery: { count: 2, nodes: [{ role: "backend-builder", title: "Build API auth" }] },
  }), true);

  const html = renderObjectiveRecovery({
    objectiveId: "obj-aabbccdd-demo",
    recovery: {
      count: 2,
      nodes: [
        { role: "backend-builder", title: "Build API auth" },
        { role: "frontend-builder", title: "Build login UI" },
      ],
    },
  }, { esc });
  assert.match(html, /data-retry-objective="obj-aabbccdd-demo"/);
  assert.match(html, /Retry recoverable work/);
  assert.match(html, /2 steps/);
  assert.match(html, /Build API auth/);
  assert.match(html, /Build login UI/);
  assert.doesNotMatch(html, /obj-aabbccdd-demo-a/);
});

test("objective recovery UI: bound button disables, confirms, and refreshes", async () => {
  const html = renderObjectiveRecovery({
    objectiveId: "obj-aabbccdd-demo",
    recovery: {
      count: 1,
      nodes: [{ role: "backend-builder", title: "Build API auth" }],
    },
  }, { esc });
  assert.match(html, /data-retry-objective="obj-aabbccdd-demo"/);
  const match = html.match(/<button\b[^>]*data-retry-objective="([^"]+)"[^>]*>([^<]*)<\/button>/);
  assert.ok(match, "button present in markup");
  assert.equal(match[1], "obj-aabbccdd-demo");
  assert.equal(match[2], "Retry recoverable work");

  const btn = { disabled: false, textContent: match[2], dataset: { retryObjective: match[1] } };
  const root = { querySelectorAll: (selector) => selector === "[data-retry-objective]" ? [btn] : [] };
  const requests = [];
  const notices = [];
  let refreshed = false;
  bindObjectiveRecovery(root, {
    request: async (...args) => { requests.push(args); return { nodes: [{ role: "backend-builder" }] }; },
    notify: (...args) => notices.push(args),
    refresh: () => { refreshed = true; },
    schedule: (fn, delay) => { assert.equal(delay, 800); fn(); },
  });

  assert.equal(typeof btn.onclick, "function");
  await btn.onclick();
  assert.equal(btn.disabled, true);
  assert.equal(btn.textContent, "Recovering…");
  assert.deepEqual(requests, [["/api/founder/objectives/obj-aabbccdd-demo/retry", { method: "POST" }]]);
  assert.match(notices[0][0], /Retrying 1 step/);
  assert.equal(refreshed, true);
});

test("objective recovery UI: failed request restores the retry button", async () => {
  const btn = { disabled: false, textContent: "Retry recoverable work", dataset: { retryObjective: "obj-aabbccdd-demo" } };
  const notices = [];
  bindObjectiveRecovery({ querySelectorAll: () => [btn] }, {
    request: async () => { throw new Error("Recovery already in progress"); },
    notify: (...args) => notices.push(args),
    refresh: () => assert.fail("must not refresh after a failed request"),
  });

  await btn.onclick();
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, "Retry recoverable work");
  assert.deepEqual(notices, [["Recovery already in progress", true]]);
});

test("objective recovery UI: a failed request restores the label the button was rendered with", async () => {
  const btn = { disabled: false, textContent: "Retry", dataset: { retryObjective: "obj-aabbccdd-demo" } };
  bindObjectiveRecovery({ querySelectorAll: () => [btn] }, {
    request: async () => { throw new Error("Nothing to recover"); },
    notify: () => {},
    refresh: () => assert.fail("must not refresh after a failed request"),
  });

  await btn.onclick();
  assert.equal(btn.textContent, "Retry");
});
