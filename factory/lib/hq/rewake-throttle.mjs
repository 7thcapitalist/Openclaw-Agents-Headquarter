// Hold back re-wakes that have stopped producing information.
//
// Adapted from Paperclip's `issue-rewake-throttle` service (PAP-13775) at pinned
// commit 6abeb67334348dcb6fde2d591a27ffc7efc7118d (MIT). Issue #157.
//
// THE PROBLEM. `decideLivenessContinuation` already bounds continuations *within*
// one run, at two attempts. It resets when a new run starts. So any external
// driver — a dependency wakeup, an assignment sweep, a schedule — can wake the
// same task again, get another two continuations, and repeat, for as long as the
// task stays active. Every one of those wakes pays a full agent session. If the
// run changes nothing, the factory has bought nothing.
//
// Upstream measured 25 sessions and 2.4x cost for a single recovery this way.
// On this factory's live state when this was written, one task had EIGHT
// dispatches since its last canonical stage pass.
//
// WHAT COUNTS AS PROGRESS is deliberately narrow: a stage that actually passed,
// a stage that actually failed, or the task reaching a terminal status. An agent
// starting, running, and finishing without moving canonical state is exactly the
// case this exists to catch, so none of those count.
//
// MODES, matching how permissions (#141) and budgets (#139) were introduced:
//
//   off      no `factory/rewake-throttle.json`. Every wake proceeds. The factory
//            behaves exactly as it did before this module existed.
//   report   the file exists (the default when it does). Streaks are computed
//            and surfaced, and every wake still proceeds. This is how a
//            threshold gets tuned against real traffic before it can delay
//            anything.
//   enforce  a wake inside the cooldown is held back.
//
// A threshold tuned against no data is how a control ends up blocking
// legitimate work on its first day, so `report` is the default and the operator
// turns enforcement on deliberately.

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

export const MODES = Object.freeze(["off", "report", "enforce"]);

// Wake sources that are never throttled. `manual` is the founder asking
// directly; `recovery` is the factory's own crash recovery, which must stay
// immediate or a process loss turns into a stall.
//
// `mention` is deliberately NOT here. HQ cannot tell a human-authored mention
// from an agent-authored one at the wakeup layer — a wakeup carries identifiers
// and nothing else, by design. Throttling a founder's mention merely delays it;
// exempting an agent's would let a cross-task write smuggle the founder's wake
// privileges. Delay is the safe direction.
export const DEFAULT_BYPASS_SOURCES = Object.freeze(["manual", "recovery"]);

// Consecutive no-progress runs before the cooldown engages. Two is upstream's
// number: one fruitless run is noise, two is a pattern.
const DEFAULT_THRESHOLD = 2;
const DEFAULT_BASE_COOLDOWN_MS = 10 * 60_000;
const MAX_COOLDOWN_MS = 4 * 60 * 60_000;

// Canonical progress. Anything an agent can emit without changing the task is
// absent from this set on purpose.
const PROGRESS_EVENTS = new Set([
  "stage-pass",
  "stage-fail",
  "merge-ready",
  "founder-approval-recorded",
  "recovery-verified",
  "stage-decision-required",
]);
const TERMINAL_STATUSES = new Set(["merge-ready", "merged", "complete", "completed"]);

export function throttlePath(hqRoot) {
  return join(resolve(hqRoot), "factory", "rewake-throttle.json");
}

// A missing file is "off", not "throttle everything": a control that changes
// behaviour the moment it is installed is an outage, not a control.
export function readThrottleConfig(hqRoot, { path = null } = {}) {
  const file = path || throttlePath(hqRoot);
  if (!existsSync(file)) {
    return { version: 1, mode: "off", threshold: DEFAULT_THRESHOLD, baseCooldownMs: DEFAULT_BASE_COOLDOWN_MS, bypassSources: [...DEFAULT_BYPASS_SOURCES], present: false, path: file };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`re-wake throttle config at ${file} is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error(`re-wake throttle config at ${file} must be an object`);

  const mode = parsed.mode ?? "report";
  if (!MODES.includes(mode)) throw new Error(`re-wake throttle mode must be one of ${MODES.join(", ")}`);

  const threshold = parsed.threshold ?? DEFAULT_THRESHOLD;
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 50) throw new Error("re-wake throttle threshold must be between 1 and 50");

  const baseCooldownMs = parsed.baseCooldownMs ?? DEFAULT_BASE_COOLDOWN_MS;
  if (!Number.isInteger(baseCooldownMs) || baseCooldownMs < 1000 || baseCooldownMs > MAX_COOLDOWN_MS) {
    throw new Error(`re-wake throttle baseCooldownMs must be between 1000 and ${MAX_COOLDOWN_MS}`);
  }

  const bypassSources = parsed.bypassSources ?? [...DEFAULT_BYPASS_SOURCES];
  if (!Array.isArray(bypassSources) || bypassSources.some((s) => typeof s !== "string")) {
    throw new Error("re-wake throttle bypassSources must be an array of strings");
  }

  return { version: 1, mode, threshold, baseCooldownMs, bypassSources, present: true, path: file };
}

// How many runs in a row have produced nothing, and when the task last actually
// moved. Pure: reads a task state object, touches no files.
export function analyzeProgress(state, { now = () => new Date().toISOString() } = {}) {
  const events = Array.isArray(state?.events) ? state.events : [];
  const dispatches = Array.isArray(state?.dispatches) ? state.dispatches : [];

  const lastProgress = [...events]
    .filter((event) => PROGRESS_EVENTS.has(event?.type) && event?.at)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .at(-1) || null;

  // A settled task is not stalling, whatever its dispatch history looks like.
  const settled = TERMINAL_STATUSES.has(String(state?.status || ""));

  const finished = dispatches
    .filter((dispatch) => dispatch?.completedAt)
    .sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));

  const since = lastProgress
    ? finished.filter((dispatch) => String(dispatch.completedAt) > String(lastProgress.at))
    : finished;

  const byActor = {};
  for (const dispatch of since) {
    const actor = dispatch.actor || state?.assignments?.[dispatch.stage] || "unknown";
    byActor[actor] = (byActor[actor] || 0) + 1;
  }

  return {
    taskId: state?.task?.id || null,
    settled,
    streak: settled ? 0 : since.length,
    lastProgressAt: lastProgress?.at || null,
    lastProgressEvent: lastProgress?.type || null,
    lastRunAt: since.at(-1)?.completedAt || null,
    byActor,
    asOf: now(),
  };
}

// Decide one wake. Never throws for odd input — a throttle that crashes is a
// throttle that gets deleted.
export function decideRewake({ config, state, source = "schedule", now = new Date().toISOString() }) {
  const progress = analyzeProgress(state, { now: () => now });
  const decision = (allowed, reason, extra = {}) => ({
    allowed,
    reason,
    wouldThrottle: false,
    mode: config?.mode || "off",
    source: String(source),
    taskId: progress.taskId,
    streak: progress.streak,
    threshold: config?.threshold ?? DEFAULT_THRESHOLD,
    lastProgressAt: progress.lastProgressAt,
    cooldownUntil: null,
    ...extra,
  });

  if (!config || config.mode === "off") return decision(true, "throttle-disabled");
  if ((config.bypassSources || DEFAULT_BYPASS_SOURCES).includes(String(source))) return decision(true, `bypass:${source}`);
  if (progress.settled) return decision(true, "task-settled");
  if (progress.streak < config.threshold) return decision(true, "below-threshold");

  // Escalating: each further fruitless run doubles the wait, to a ceiling, so a
  // task that keeps producing nothing backs off fast without ever going silent
  // for a working day.
  const over = progress.streak - config.threshold;
  const cooldownMs = Math.min(MAX_COOLDOWN_MS, config.baseCooldownMs * (2 ** over));
  const anchor = Date.parse(progress.lastRunAt || progress.lastProgressAt || now);
  const until = new Date((Number.isFinite(anchor) ? anchor : Date.parse(now)) + cooldownMs).toISOString();

  if (until <= now) return decision(true, "cooldown-elapsed", { cooldownUntil: until });

  // In `report` the verdict is computed and returned as what it WOULD be, then
  // the wake proceeds. That is the whole point of the mode.
  const held = config.mode === "enforce";
  return decision(!held, held ? "cooldown" : "cooldown", { wouldThrottle: true, cooldownUntil: until, cooldownMs });
}

// The operator view: which tasks are burning runs without moving, worst first.
// Never throws — a degraded source is reported, because this is a read-only
// projection over state other things own.
export function buildRewakeReport({ hqRoot, states, now = new Date().toISOString() }) {
  const warnings = [];
  let config = { version: 1, mode: "off", threshold: DEFAULT_THRESHOLD, present: false };
  try {
    config = readThrottleConfig(hqRoot);
  } catch (error) {
    warnings.push(`re-wake throttle config unavailable: ${error.message}`);
  }

  const stalling = [];
  for (const state of states || []) {
    const progress = analyzeProgress(state, { now: () => now });
    if (!progress.taskId || progress.streak < 1) continue;
    stalling.push({
      taskId: progress.taskId,
      streak: progress.streak,
      lastProgressAt: progress.lastProgressAt,
      lastProgressEvent: progress.lastProgressEvent,
      atOrOverThreshold: progress.streak >= (config.threshold ?? DEFAULT_THRESHOLD),
      byActor: progress.byActor,
    });
  }
  stalling.sort((a, b) => b.streak - a.streak || String(a.taskId).localeCompare(String(b.taskId)));

  const overThreshold = stalling.filter((item) => item.atOrOverThreshold);
  return {
    version: 1,
    asOf: now,
    available: warnings.length === 0,
    warnings,
    mode: config.mode,
    threshold: config.threshold ?? DEFAULT_THRESHOLD,
    summary: {
      stallingTasks: stalling.length,
      overThreshold: overThreshold.length,
      // The number that makes the cost concrete: runs already spent since the
      // last time any of these tasks moved.
      wastedRuns: stalling.reduce((sum, item) => sum + item.streak, 0),
    },
    tasks: stalling.slice(0, 20),
  };
}
