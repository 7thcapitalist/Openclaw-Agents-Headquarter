import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readAutonomy } from "../lib/hq/autonomy.mjs";

function hqRootWith(configLearningAutonomy) {
  const root = mkdtempSync(join(tmpdir(), "hq-autonomy-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  const cfg = { version: 1, learning: { patternThreshold: 2 } };
  if (configLearningAutonomy) cfg.learning.autonomy = { enabled: true, cadenceDays: 3 };
  writeFileSync(join(root, "factory", "factory.config.json"), JSON.stringify(cfg));
  return root;
}

const cronJson = JSON.stringify({
  jobs: [
    { declarationKey: "heartbeat:main", displayName: "Heartbeat (main)", agentId: "main", enabled: true,
      schedule: { kind: "every", everyMs: 1800000 },
      state: { nextRunAtMs: Date.now() + 300000, lastRunAtMs: Date.now() - 1500000, lastStatus: "ok", consecutiveErrors: 0 } },
    { declarationKey: "skill-collection-review:reviewer", displayName: "Skill collection review (reviewer)", agentId: "reviewer", enabled: true,
      schedule: { kind: "every", everyMs: 604800000 }, state: { lastStatus: "ok" } },
  ],
});

test("readAutonomy classifies scheduled work, live counts, and configured-but-not-running", async () => {
  const root = hqRootWith(true); // learning.autonomy enabled but no cron for it
  const exec = async (args) => (args.join(" ") === "cron list --json" ? { stdout: cronJson, code: 0 } : { stdout: "", code: 1 });

  const a = await readAutonomy({ hqRoot: root, exec, running: { objectives: 1, tasks: 2, jobs: 0 } });

  assert.equal(a.scheduled.length, 2);
  const hb = a.scheduled.find((s) => /heartbeat/i.test(s.key));
  assert.equal(hb.schedule, "every 30m");
  assert.equal(hb.lastStatus, "ok");
  assert.ok(hb.nextRunAt);

  assert.equal(a.running.anythingLive, true);
  assert.equal(a.running.objectives, 1);
  assert.equal(a.running.tasks, 2);

  const notRunning = a.configuredNotRunning.map((c) => c.feature);
  assert.ok(notRunning.includes("Learning autonomy cycle"), "flags configured-not-running learning cycle");
});

test("readAutonomy: no false 'not running' when the feature isn't configured; degrades if cron is unavailable", async () => {
  const root = hqRootWith(false);
  const okExec = async () => ({ stdout: cronJson, code: 0 });
  const a = await readAutonomy({ hqRoot: root, exec: okExec, running: {} });
  assert.equal(a.configuredNotRunning.some((c) => c.feature === "Learning autonomy cycle"), false);
  assert.equal(a.running.anythingLive, false);

  const badExec = async () => ({ stdout: "", code: 1 });
  const b = await readAutonomy({ hqRoot: root, exec: badExec, running: {} });
  assert.deepEqual(b.scheduled, []);
  assert.ok(b.scheduleError);
});
