import assert from "node:assert/strict";
import test from "node:test";
import { isObjectiveRecoverable, renderObjectiveRecovery } from "../../dashboard/backend/public/lib/objectiveRecovery.mjs";

// Thin smoke import so the recovery UI module stays covered if split files are skipped.
// Primary cases live in objective-recovery-ui.test.mjs and objective-recovery-endpoint.test.mjs.

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

test("objectiveRecovery module loads and hides empty recovery", () => {
  assert.equal(isObjectiveRecoverable({ recovery: { count: 0, nodes: [] } }), false);
  assert.equal(renderObjectiveRecovery({ recovery: { count: 0, nodes: [] } }, { esc }), "");
});
