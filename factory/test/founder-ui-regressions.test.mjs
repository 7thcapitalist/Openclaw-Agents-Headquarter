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

// #70 made founder questions asynchronous. The old guarantee was "the answer
// comes back as JSON before the gateway times out" (a 504 body); the new, stronger
// guarantee is that the request never blocks on the model at all — it is accepted
// immediately and the answer is polled, so a slow agent cannot produce a gateway
// timeout in the first place. A model timeout becomes recorded question state.
test("founder questions never block the request on the model", () => {
  // The dispatch is still bounded, and the bound is passed through to OpenClaw.
  assert.match(server, /FOUNDER_QUESTION_TIMEOUT_MS/);
  assert.match(server, /String\(Math\.floor\(FOUNDER_QUESTION_TIMEOUT_MS \/ 1000\)\)/);
  // Asking is accepted immediately and answered out of band.
  assert.match(server, /void runFounderQuestion\(item\);/);
  assert.match(server, /res\.status\(202\)\.json\(\{ question: item \}\)/);
  assert.match(server, /app\.get\("\/api\/founder\/questions\/:id"/);
  // A timeout is recorded as question state, never surfaced as a raw HTTP error.
  assert.match(server, /status: "failed", error: questionError\(error\)/);
  // The client still degrades gracefully if a proxy times out anyway.
  assert.match(app, /res\.status === 524 \|\| res\.status === 504/);
});

test("execution blocker callout distinguishes automatic recovery from founder attention", () => {
  assert.match(app, /blocked\.autoRecovering \? "Factory recovery"/);
  assert.match(app, /blocked\.headline/);
  assert.match(app, /blocked\.detail/);
  assert.doesNotMatch(app, /blocked\.whatItNeedsFromFounder \|\| blocked\.summary/);
});

// #72 removed the original-request disclosure from the live operation room to
// keep it focused on the task title. The objective view keeps its own
// disclosure, which is where a founder goes to re-read what they asked for.
test("execution view leads with the task title, not the raw prompt", () => {
  assert.match(app, /shortObjectiveTitle\(x\.title \|\| x\.objective \|\| "Objective"\)/);
  assert.match(app, /<details class="obj-original-request"><summary>Original request<\/summary>/);
  assert.doesNotMatch(app, /operation-original-request/,
    "the operation room must not reintroduce the full prompt inline");
});
