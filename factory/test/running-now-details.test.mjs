import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("running objective nodes expose the existing execution-details route", () => {
  const appSource = readFileSync(new URL("../../dashboard/backend/public/app.js", import.meta.url), "utf8");
  const rowsSource = readFileSync(new URL("../../dashboard/backend/public/lib/runningNow.mjs", import.meta.url), "utf8");
  assert.match(rowsSource, /objectiveId: o\.objectiveId/);
  assert.match(appSource, /data-objective-execution/);
  assert.match(appSource, /openExecutionView\(btn\.dataset\.objectiveExecution\)/);
});
