import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { addOvernightItem, readOvernightQueue, removeOvernightItem, startOvernight, stopOvernight } from "../../dashboard/backend/lib/overnightQueue.mjs";

test("overnight queue persists a bounded founder plan and supports removal", () => {
  const root = mkdtempSync(join(tmpdir(), "hq-overnight-"));
  const first = addOvernightItem(root, { objective: "Improve onboarding", projectId: "life", repo: "/tmp/life" });
  assert.equal(first.items.length, 1);
  assert.equal(readOvernightQueue(root).items[0].objective, "Improve onboarding");
  const removed = removeOvernightItem(root, first.items[0].id);
  assert.equal(removed.items.length, 0);
});

test("overnight start requires queued work and stop is safe when idle", () => {
  const root = mkdtempSync(join(tmpdir(), "hq-overnight-"));
  assert.throws(() => startOvernight(root, { scriptPath: "/tmp/factory-objective.mjs" }), /at least one objective/);
  assert.equal(stopOvernight(root).status, "idle");
});
