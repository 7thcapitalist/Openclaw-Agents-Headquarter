import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { EventEmitter } from "node:events";
import { buildFounderOverview } from "../../dashboard/backend/lib/founderControlPlane.mjs";
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

test("failed objective cannot starve later queued work or restart as a duplicate", () => {
  const root = mkdtempSync(join(tmpdir(), "hq-night-failure-"));
  for (const objective of ["First", "Second", "Third"]) addOvernightItem(root, { objective, projectId: "life", repo: "/tmp/life" });
  const children = [];
  const spawnChild = () => { const child = new EventEmitter(); children.push(child); return child; };
  startOvernight(root, { scriptPath: "unused", spawnChild });
  children[0].emit("close", 2);
  assert.equal(children.length, 2);
  children[1].emit("close", 0);
  children[2].emit("close", 0);
  const state = readOvernightQueue(root);
  assert.deepEqual(state.items.map(x => x.status), ["failed", "complete", "complete"]);
  assert.equal(state.status, "needs-attention");
  assert.equal(children.length, 3);
  assert.throws(() => startOvernight(root, { scriptPath: "unused", spawnChild }), /at least one/);
});

test("stop lets the current objective finish and leaves later objectives queued", () => {
  const root = mkdtempSync(join(tmpdir(), "hq-night-stop-"));
  for (const objective of ["First", "Second"]) addOvernightItem(root, { objective, projectId: "life", repo: "/tmp/life" });
  const child = new EventEmitter();
  child.kill = () => assert.fail("stop must not kill the current objective");
  startOvernight(root, { scriptPath: "unused", spawnChild: () => child });
  stopOvernight(root);
  assert.equal(readOvernightQueue(root).items[0].status, "running");
  child.emit("close", 0);
  assert.equal(readOvernightQueue(root).status, "stopped");
  assert.deepEqual(readOvernightQueue(root).items.map(x => x.status), ["complete", "queued"]);
});

test("worker startup error settles once and continues the queue", () => {
  const root = mkdtempSync(join(tmpdir(), "hq-night-spawn-"));
  addOvernightItem(root, { objective: "First", projectId: "life", repo: "/tmp/life" });
  const child = new EventEmitter();
  startOvernight(root, { scriptPath: "unused", spawnChild: () => child });
  child.emit("error", new Error("spawn failed"));
  child.emit("close", 0);
  assert.equal(readOvernightQueue(root).status, "needs-attention");
  assert.equal(readOvernightQueue(root).items[0].status, "failed");
  const itemId = `overnight:${readOvernightQueue(root).items[0].id}`;
  const overview = buildFounderOverview(root, []);
  assert.ok(overview.inbox.some(item => item.id === itemId && item.kind === "blocked"));
});
