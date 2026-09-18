import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { parseClaudeUsage, parseUsageWindow } from "../lib/model-usage-window.mjs";

test("parseUsageWindow reads percentages and reset times from real-shaped status output", () => {
  assert.deepEqual(
    parseUsageWindow("openai usage: 5h 100% left ⏱4h 59m · Week 48% left ⏱2d 3h"),
    {
      shortWindow: { percentLeft: 100, resetIn: "4h 59m" },
      weekWindow: { percentLeft: 48, resetIn: "2d 3h" },
    },
  );
});

test("parseUsageWindow keeps readable percentages when reset times are absent", () => {
  assert.deepEqual(parseUsageWindow("openai usage: 5h 31% left · Week 72% left"), {
    shortWindow: { percentLeft: 31, resetIn: null },
    weekWindow: { percentLeft: 72, resetIn: null },
  });
});

test("parseUsageWindow returns null windows for unreadable output", () => {
  assert.deepEqual(parseUsageWindow("Auth store unavailable"), {
    shortWindow: null,
    weekWindow: null,
  });
});

const FIXTURE = readFileSync(new URL("./fixtures/claude-usage.txt", import.meta.url), "utf8");
const NOW = Date.parse("2026-09-18T19:45:00Z"); // 3:45pm EDT

test("parseClaudeUsage reads session and weekly percent left with reset times", () => {
  assert.deepEqual(parseClaudeUsage(FIXTURE, { now: NOW }), {
    shortWindow: { percentLeft: 75, resetIn: "2h 45m" },
    weekWindow: { percentLeft: 28, resetIn: "3d 1h" },
  });
});

test("parseClaudeUsage rolls a past month/day into next year", () => {
  const out = "Current session: 5% used · resets Jan 2, 1am (America/New_York)";
  assert.deepEqual(parseClaudeUsage(out, { now: Date.parse("2026-12-31T12:00:00Z") }).shortWindow,
    { percentLeft: 95, resetIn: "1d 18h" });
});

test("parseClaudeUsage keeps percent but drops an unreadable reset", () => {
  assert.deepEqual(parseClaudeUsage("Current session: 40% used · resets Sep 18, 6:30pm (Not/AZone)", { now: NOW }).shortWindow,
    { percentLeft: 60, resetIn: null });
  assert.deepEqual(parseClaudeUsage("Current session: 40% used", { now: NOW }).shortWindow,
    { percentLeft: 60, resetIn: null });
});

test("parseClaudeUsage returns null windows for empty, garbage, or out-of-range output", () => {
  for (const bad of ["", null, "Error: not logged in", "Current session: 150% used", "Current session: abc% used",
    "Current week (Fable): 0% used · resets Sep 21, 5pm (America/New_York)"]) {
    assert.deepEqual(parseClaudeUsage(bad, { now: NOW }), { shortWindow: null, weekWindow: null }, String(bad));
  }
});
