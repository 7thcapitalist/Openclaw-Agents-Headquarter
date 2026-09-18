import test from "node:test";
import assert from "node:assert/strict";
import { parseUsageWindow } from "../lib/model-usage-window.mjs";

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
