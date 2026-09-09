import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("running objective nodes expose the existing execution-details route", () => {
  const source = readFileSync(new URL("../../dashboard/backend/public/app.js", import.meta.url), "utf8");
  assert.match(source, /objectiveId: o\.objectiveId/);
  assert.match(source, /data-objective-execution/);
  assert.match(source, /openExecutionView\(btn\.dataset\.objectiveExecution\)/);
});
