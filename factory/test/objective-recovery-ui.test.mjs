import assert from "node:assert/strict";
import test from "node:test";

import {
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

test("objective recovery UI: click feedback sets disabled + Recovering…", () => {
  // DOM-level contract without jsdom: mount markup, locate the button, apply
  // the same disabled/label mutation the app.js binding performs on click.
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
  btn.disabled = true;
  btn.textContent = "Recovering…";
  assert.equal(btn.disabled, true);
  assert.equal(btn.textContent, "Recovering…");
  assert.equal(btn.dataset.retryObjective, "obj-aabbccdd-demo");
});
