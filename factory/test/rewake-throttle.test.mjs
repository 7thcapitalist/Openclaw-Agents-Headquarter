import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DEFAULT_BYPASS_SOURCES, MODES, analyzeProgress, buildRewakeReport, decideRewake, readThrottleConfig,
} from "../lib/hq/rewake-throttle.mjs";

const T0 = "2026-09-10T12:00:00.000Z";
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

const dispatch = (over = {}) => ({ id: "d", stage: "builder", actor: "codex", outcome: "pass", startedAt: T0, completedAt: T0, ...over });
const task = (over = {}) => ({
  task: { id: "obj-abc-node", project: "hq", risk: "low" },
  status: "active", assignments: { builder: "codex" }, stages: {}, dispatches: [], events: [], ...over,
});

function fixture(config) {
  const root = mkdtempSync(join(tmpdir(), "hq-rewake-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  if (config !== undefined) writeFileSync(join(root, "factory", "rewake-throttle.json"), typeof config === "string" ? config : JSON.stringify(config));
  return root;
}

const conf = (over = {}) => ({ version: 1, mode: "enforce", threshold: 2, baseCooldownMs: 600_000, bypassSources: [...DEFAULT_BYPASS_SOURCES], present: true, ...over });

// ── what counts as progress ──────────────────────────────────────────────────
// The whole capability rests on this. Anything an agent can emit without moving
// canonical state must not read as progress, or the throttle never engages.

test("starting, running and finishing without moving the task is not progress", () => {
  const state = task({
    dispatches: [dispatch({ id: "d1", completedAt: at(1) }), dispatch({ id: "d2", completedAt: at(2) })],
    events: [
      { at: at(1), type: "dispatch-ready" }, { at: at(1), type: "dispatch-running" },
      { at: at(2), type: "handoff-ready" }, { at: at(2), type: "completion-report" },
    ],
  });
  assert.equal(analyzeProgress(state).streak, 2, "two finished runs, nothing canonical moved");
});

test("a stage that passed, failed, or asked for a decision all count as progress", () => {
  for (const type of ["stage-pass", "stage-fail", "stage-decision-required", "merge-ready", "recovery-verified"]) {
    const state = task({
      dispatches: [dispatch({ id: "d1", completedAt: at(1) }), dispatch({ id: "d2", completedAt: at(3) })],
      events: [{ at: at(2), type }],
    });
    assert.equal(analyzeProgress(state).streak, 1, `${type} must reset the streak`);
  }
});

test("a settled task is never stalling, whatever its dispatch history looks like", () => {
  for (const status of ["merge-ready", "merged", "complete"]) {
    const state = task({ status, dispatches: Array.from({ length: 9 }, (_, i) => dispatch({ id: `d${i}`, completedAt: at(i) })) });
    const progress = analyzeProgress(state);
    assert.equal(progress.settled, true);
    assert.equal(progress.streak, 0);
  }
});

test("a dispatch that never finished is not counted as a fruitless run", () => {
  const state = task({ dispatches: [dispatch({ id: "running", completedAt: undefined })] });
  assert.equal(analyzeProgress(state).streak, 0, "a run still in flight has not failed to produce anything yet");
});

test("the streak is attributed to the agents that ran", () => {
  const state = task({
    dispatches: [dispatch({ id: "d1", actor: "codex", completedAt: at(1) }), dispatch({ id: "d2", actor: "claude", completedAt: at(2) }), dispatch({ id: "d3", actor: "codex", completedAt: at(3) })],
  });
  assert.deepEqual(analyzeProgress(state).byActor, { codex: 2, claude: 1 });
});

// ── what is never throttled ──────────────────────────────────────────────────

test("a founder's own wake is never held back", () => {
  const state = task({ dispatches: Array.from({ length: 9 }, (_, i) => dispatch({ id: `d${i}`, completedAt: at(i) })) });
  const decision = decideRewake({ config: conf(), state, source: "manual", now: at(1) });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "bypass:manual");
});

test("crash recovery is never held back, or a process loss becomes a stall", () => {
  const state = task({ dispatches: Array.from({ length: 9 }, (_, i) => dispatch({ id: `d${i}`, completedAt: at(i) })) });
  assert.equal(decideRewake({ config: conf(), state, source: "recovery", now: at(1) }).reason, "bypass:recovery");
});

test("a mention is throttled, because HQ cannot tell whose mention it is", () => {
  // A wakeup carries identifiers and nothing else, so the author of the comment
  // that produced it is not knowable here. Delaying a founder's mention costs a
  // wait; exempting an agent's would let a cross-task write borrow the
  // founder's wake privileges.
  const state = task({ dispatches: Array.from({ length: 9 }, (_, i) => dispatch({ id: `d${i}`, completedAt: at(i) })) });
  assert.equal(DEFAULT_BYPASS_SOURCES.includes("mention"), false);
  assert.equal(decideRewake({ config: conf(), state, source: "mention", now: at(1) }).allowed, false);
});

// ── modes ────────────────────────────────────────────────────────────────────

test("with no config file every wake proceeds and the factory behaves as before", () => {
  const config = readThrottleConfig(fixture());
  assert.equal(config.mode, "off");
  assert.equal(config.present, false);
  const state = task({ dispatches: Array.from({ length: 9 }, (_, i) => dispatch({ id: `d${i}`, completedAt: at(i) })) });
  assert.equal(decideRewake({ config, state, source: "schedule", now: at(1) }).reason, "throttle-disabled");
});

test("a file with no mode defaults to report, so installing it cannot stall the factory", () => {
  assert.equal(readThrottleConfig(fixture({ version: 1, threshold: 2 })).mode, "report");
  assert.deepEqual([...MODES], ["off", "report", "enforce"]);
});

test("report mode computes the real verdict, says it would throttle, and lets the wake through", () => {
  const state = task({ dispatches: Array.from({ length: 5 }, (_, i) => dispatch({ id: `d${i}`, completedAt: at(i) })) });
  const decision = decideRewake({ config: conf({ mode: "report" }), state, source: "schedule", now: at(1) });
  assert.equal(decision.allowed, true, "report mode must never hold a wake back");
  assert.equal(decision.wouldThrottle, true, "but it must say the wake would have been held");
  assert.ok(decision.cooldownUntil);
});

test("enforce mode holds the wake back", () => {
  const state = task({ dispatches: Array.from({ length: 5 }, (_, i) => dispatch({ id: `d${i}`, completedAt: at(i) })) });
  const decision = decideRewake({ config: conf(), state, source: "schedule", now: at(1) });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "cooldown");
});

// ── the threshold and the cooldown ───────────────────────────────────────────

test("one fruitless run is noise; the threshold is a pattern", () => {
  const one = task({ dispatches: [dispatch({ completedAt: at(1) })] });
  assert.equal(decideRewake({ config: conf(), state: one, source: "schedule", now: at(2) }).reason, "below-threshold");
});

test("each further fruitless run doubles the wait, to a ceiling", () => {
  const runs = (n) => task({ dispatches: Array.from({ length: n }, (_, i) => dispatch({ id: `d${i}`, completedAt: T0 })) });
  const waitFor = (n) => {
    const d = decideRewake({ config: conf(), state: runs(n), source: "schedule", now: T0 });
    return Date.parse(d.cooldownUntil) - Date.parse(T0);
  };
  assert.equal(waitFor(2), 600_000, "at the threshold: the base cooldown");
  assert.equal(waitFor(3), 1_200_000, "one over: double");
  assert.equal(waitFor(4), 2_400_000, "two over: double again");
  assert.ok(waitFor(30) <= 4 * 60 * 60_000, "and never past the four-hour ceiling, so nothing goes silent for a working day");
});

test("once the cooldown has elapsed the wake proceeds again", () => {
  const state = task({ dispatches: Array.from({ length: 2 }, (_, i) => dispatch({ id: `d${i}`, completedAt: T0 })) });
  assert.equal(decideRewake({ config: conf(), state, source: "schedule", now: at(5) }).allowed, false);
  const later = decideRewake({ config: conf(), state, source: "schedule", now: at(20) });
  assert.equal(later.allowed, true);
  assert.equal(later.reason, "cooldown-elapsed");
});

test("fresh canonical progress clears the streak and ends the cooldown", () => {
  const stalled = task({ dispatches: Array.from({ length: 5 }, (_, i) => dispatch({ id: `d${i}`, completedAt: at(i) })) });
  assert.equal(decideRewake({ config: conf(), state: stalled, source: "schedule", now: at(6) }).allowed, false);

  const moved = task({ ...stalled, events: [{ at: at(5.5), type: "stage-pass" }] });
  assert.equal(decideRewake({ config: conf(), state: moved, source: "schedule", now: at(6) }).allowed, true);
});

// ── configuration is validated, not guessed ──────────────────────────────────

test("a malformed config is rejected with a usable message", () => {
  assert.throws(() => readThrottleConfig(fixture("{ nope")), /not valid JSON/);
  assert.throws(() => readThrottleConfig(fixture({ version: 1, mode: "yolo" })), /mode must be one of/);
  assert.throws(() => readThrottleConfig(fixture({ version: 1, threshold: 0 })), /threshold must be between/);
  assert.throws(() => readThrottleConfig(fixture({ version: 1, baseCooldownMs: 10 })), /baseCooldownMs must be between/);
  assert.throws(() => readThrottleConfig(fixture({ version: 1, bypassSources: "manual" })), /bypassSources must be an array/);
});

test("the shipped example config is valid and defaults to report", () => {
  const config = readThrottleConfig(new URL("../..", import.meta.url).pathname, { path: new URL("../rewake-throttle.example.json", import.meta.url).pathname });
  assert.equal(config.mode, "report");
  assert.deepEqual(config.bypassSources, ["manual", "recovery"]);
});

// ── the operator report ──────────────────────────────────────────────────────

test("the report ranks the worst offenders and totals the runs already spent", () => {
  const report = buildRewakeReport({
    hqRoot: fixture({ version: 1, mode: "report", threshold: 2 }),
    states: [
      task({ task: { id: "mild" }, dispatches: [dispatch({ completedAt: at(1) })] }),
      task({ task: { id: "bad" }, dispatches: Array.from({ length: 8 }, (_, i) => dispatch({ id: `d${i}`, completedAt: at(i) })) }),
      task({ task: { id: "fine" }, status: "merge-ready", dispatches: [dispatch({ completedAt: at(1) })] }),
    ],
    now: at(10),
  });
  assert.deepEqual(report.tasks.map((t) => t.taskId), ["bad", "mild"], "worst first");
  assert.equal(report.summary.overThreshold, 1, "only 'bad' is at or over the threshold");
  assert.equal(report.summary.wastedRuns, 9);
  assert.equal(report.mode, "report");
});

test("an unreadable config degrades the report rather than hiding the stalls", () => {
  const report = buildRewakeReport({
    hqRoot: fixture("{ broken"),
    states: [task({ dispatches: Array.from({ length: 3 }, (_, i) => dispatch({ id: `d${i}`, completedAt: at(i) })) })],
    now: at(10),
  });
  assert.equal(report.available, false);
  assert.match(report.warnings.join(" "), /throttle config unavailable/);
  assert.equal(report.tasks.length, 1, "the stall is still reported");
});

test("an empty factory reports nothing stalling, not a failure", () => {
  const report = buildRewakeReport({ hqRoot: fixture(), states: [], now: T0 });
  assert.equal(report.available, true);
  assert.deepEqual(report.summary, { stallingTasks: 0, overThreshold: 0, wastedRuns: 0 });
});
