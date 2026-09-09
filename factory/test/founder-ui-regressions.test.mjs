import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const app = readFileSync(join(root, "dashboard/backend/public/app.js"), "utf8");
const server = readFileSync(join(root, "dashboard/backend/server.mjs"), "utf8");

test("founder UI keeps the Headquarters repo available as a work target", () => {
  assert.match(app, /function workTargets\(state, projects = state\.projects \|\| \[\]\)/);
  assert.match(app, /workTargets\(state, projects\)/);
  assert.match(app, /\(factory\)/);
  assert.match(app, /Open factory/);
});

test("founder question timeouts stay JSON and finish before a gateway timeout", () => {
  assert.match(server, /FOUNDER_QUESTION_TIMEOUT_MS/);
  assert.match(server, /String\(Math\.floor\(FOUNDER_QUESTION_TIMEOUT_MS \/ 1000\)\)/);
  assert.match(server, /res\.status\(504\)\.json\(\{ code: "OPENCLAW_TIMEOUT"/);
  assert.match(app, /res\.status === 524 \|\| res\.status === 504/);
});

test("execution view keeps long prompts behind a collapsed disclosure", () => {
  assert.match(app, /shortObjectiveTitle\(x\.title \|\| x\.objective \|\| "Objective"\)/);
  assert.match(app, /<details class="operation-original-request"><summary>View original request<\/summary>/);
  assert.match(app, /<details class="obj-original-request"><summary>Original request<\/summary>/);
});
