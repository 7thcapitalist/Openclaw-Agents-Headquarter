import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { effectiveMode, readModeOverride, setIdleMode } from "../lib/idle/mode.mjs";
import { evaluateIdleTrigger } from "../lib/idle/trigger.mjs";

const root = () => mkdtempSync(join(tmpdir(), "idle-mode-"));
const config = (mode = "on") => ({ learning: { patternThreshold: 2, idleTrigger: { mode } } });

test("mode override persists and wins over the tracked config", () => {
  const stateRoot = root();
  assert.equal(effectiveMode(config("on"), stateRoot).mode, "on");
  setIdleMode(stateRoot, "shadow", { by: "test", now: "2026-09-18T00:00:00Z" });
  assert.equal(readModeOverride(stateRoot).mode, "shadow");
  assert.deepEqual(effectiveMode(config("on"), stateRoot), {
    mode: "shadow", source: "override",
    override: { version: 1, mode: "shadow", setBy: "test", at: "2026-09-18T00:00:00Z" },
  });
});

test("only off, shadow, and on can be persisted", () => {
  assert.throws(() => setIdleMode(root(), "automatic"), /off, shadow, or on/);
});

test("the trigger honours off and shadow overrides", async () => {
  const stateRoot = root();
  const inputs = {
    objectives: [], founderQueued: false, openPrs: [],
    headroom: [{ status: "available", shortWindow: { percentLeft: 90 }, weekWindow: { percentLeft: 90, resetIn: "5h" } }],
    findings: [{ id: "L-1", status: "open", kind: "pattern", title: "Repeated issue", occurrences: 3, evidence: ["evidence/x.md"] }],
  };
  setIdleMode(stateRoot, "off");
  assert.equal((await evaluateIdleTrigger({ hqRoot: process.cwd(), stateRoot, deps: { config: config(), inputs } })).action, "off");

  setIdleMode(stateRoot, "shadow");
  const result = await evaluateIdleTrigger({ hqRoot: process.cwd(), stateRoot, deps: {
    config: config(), inputs, evidenceExists: () => true,
  } });
  assert.equal(result.action, "shadow");
});
