// A panel that HAS data must never render as absent.
//
// Ten snapshot builders set `available: warnings.length === 0`. That field
// therefore means "a warning was recorded", and says nothing about whether
// there is data. `unavailable()` read it as "not configured" and blanked the
// panel, so any single warning — however incidental — erased a working screen.
//
// The worst case, and the reason this file exists:
//
//   `buildOperationsSnapshot` pushes a warning when the COST LEDGER cannot be
//   read, and sets `available` from `warnings.length`. The Board does
//   `unavailable(panels.operations) ? [] : …`. So an unreadable cost ledger
//   rendered an EMPTY BOARD, captioned "not configured", while 21 tasks were
//   running — the same failure the founder already lived through from a
//   different cause, and the one the Board was rebuilt to prevent.
//
// The published contract already had the right fields for genuine absence;
// the helper was reading the wrong one:
//
//   unavailable: true   the builder threw (set by `gather()`) — no data
//   configured: false   the founder has not set it up — nothing to show
//   available: false    built fine, noted something — DATA IS PRESENT
//
// These tests walk every builder the publisher actually publishes, force each
// into the degraded shape, and assert the property directly. An eleventh
// builder that copies the pattern is covered the day it is added, because the
// list comes from the publisher's own source rather than from a list here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { unavailable, degraded } from "../../control-plane/public/render.mjs";
import { buildBoard } from "../../control-plane/public/board.mjs";

const PUBLISHER = readFileSync(new URL("../lib/hq/publisher.mjs", import.meta.url), "utf8");

// Every panel name the publisher gathers, read from its source so this cannot
// drift as panels are added.
function publishedPanelNames() {
  const block = PUBLISHER.slice(PUBLISHER.indexOf("const panels = await Promise.all(["));
  return [...block.matchAll(/gather\("([a-z-]+)"/g)].map((m) => m[1]);
}

// Builders that derive `available` from how many warnings they collected.
function buildersConflatingWarnings() {
  const dir = new URL("../lib/hq/", import.meta.url);
  const names = [
    "agent-scorecards", "blast-radius", "budget-snapshot", "decision-history", "goals",
    "operations", "permissions-snapshot", "retention", "rewake-throttle", "search",
  ];
  return names.filter((name) => {
    try {
      return /available:\s*warnings\.length === 0/.test(readFileSync(new URL(`${name}.mjs`, dir), "utf8"));
    } catch { return false; }
  });
}

test("the publisher publishes panels, and this test knows which", () => {
  const names = publishedPanelNames();
  assert.ok(names.length >= 8, `expected the publisher's panel list, got ${JSON.stringify(names)}`);
  assert.ok(names.includes("operations"), "operations must be published — the Board reads it");
});

test("the conflating builders are still conflating, so this guard is still needed", () => {
  // If this ever drops to zero, the builders were fixed instead and this file
  // should be revisited rather than silently passing forever.
  const conflating = buildersConflatingWarnings();
  assert.ok(conflating.length > 0,
    "no builder derives `available` from warnings any more — re-read this file's premise");
  assert.ok(conflating.includes("operations"), "operations is the one that blanks the Board");
});

// ── the property ──────────────────────────────────────────────────────────

// A panel that built fine and recorded a warning. This is the exact shape all
// ten conflating builders produce.
const withWarning = (data) => ({ ...data, available: false, warnings: ["something could not be read"] });

test("a panel with data and a warning is never reported as absent", () => {
  for (const name of publishedPanelNames()) {
    const panel = withWarning({ version: 1, contract: `hq.${name}/1`, tasks: [], items: [] });
    assert.equal(unavailable(panel), null,
      `panel "${name}" with data plus a warning renders as absent — that is the defect`);
  }
});

test("and it says what was wrong, beside its data", () => {
  const panel = withWarning({ tasks: [1, 2, 3] });
  const message = degraded(panel);
  assert.ok(message, "a degraded panel must explain itself");
  assert.match(message, /could not be read/);
  assert.match(message, /something could not be read/, "the builder's own warning must survive");
});

test("several warnings are counted rather than dropped", () => {
  const message = degraded({ available: false, warnings: ["first", "second", "third"] });
  assert.match(message, /first/);
  assert.match(message, /\+2 more/);
});

test("a degraded panel with no warning text still says it is incomplete", () => {
  assert.match(degraded({ available: false, warnings: [] }), /may be incomplete/);
});

test("a healthy panel is not captioned as degraded", () => {
  assert.equal(degraded({ available: true, warnings: [] }), null);
  assert.equal(degraded({ tasks: [] }), null);
  assert.equal(degraded(undefined), null);
});

// ── "not configured" only when it genuinely is not ────────────────────────

test("only a builder that threw, or an unconfigured one, reads as absent", () => {
  assert.match(unavailable({ unavailable: true, reason: "ENOENT" }), /ENOENT/);
  assert.equal(unavailable({ configured: false }), "not configured");
  assert.equal(unavailable(undefined), "no data published");
  assert.equal(unavailable(null), "no data published");
  assert.equal(unavailable("nonsense"), "no data published");
});

test("a warning never produces the words 'not configured'", () => {
  // That caption was actively misleading: it sent the founder to look for
  // configuration that was already there.
  for (const name of publishedPanelNames()) {
    assert.notEqual(unavailable(withWarning({ name })), "not configured", name);
  }
});

test("an unconfigured panel is absent even when it also carries warnings", () => {
  // Nothing to show is nothing to show, whatever else was noted.
  assert.equal(unavailable({ configured: false, available: false, warnings: ["x"] }), "not configured");
});

test("a thrown builder outranks everything", () => {
  assert.match(unavailable({ unavailable: true, reason: "boom", configured: true, available: true }), /boom/);
});

// ── the Board, end to end ─────────────────────────────────────────────────

test("an unreadable cost ledger does not empty the Board", async () => {
  // Built from the real operations builder so the shape is the real one, then
  // degraded exactly as operations.mjs degrades itself.
  const { buildOperationsSnapshot } = await import("../lib/hq/operations.mjs");
  const real = buildOperationsSnapshot({ hqRoot: new URL("../../", import.meta.url).pathname });
  const tasks = real.tasks.length ? real.tasks : [
    { taskId: "t1", status: "active", stage: "builder", updatedAt: new Date().toISOString() },
    { taskId: "t2", status: "blocked", stage: "qa", updatedAt: new Date().toISOString() },
  ];

  const broken = { ...real, tasks, available: false, warnings: ["cost ledger unavailable: EACCES"] };
  assert.equal(unavailable(broken), null, "the Board would render empty");

  const rendered = unavailable(broken) ? [] : broken.tasks;
  assert.equal(buildBoard(rendered).total, tasks.length,
    "every task must still reach the board when only the cost ledger is unreadable");
  assert.match(degraded(broken), /cost ledger unavailable/);
});

test("the Board shows the warning beside the work, not instead of it", () => {
  const views = readFileSync(new URL("../../control-plane/public/views.mjs", import.meta.url), "utf8");
  const board = views.slice(views.indexOf("export function renderBoard"), views.indexOf("function boardCard"));
  assert.match(board, /degraded\(operations\)/, "the Board must render its panel's degradation");
  assert.match(board, /panel-degraded/);
});

// ── one implementation, not one per view ──────────────────────────────────

test("no view keeps a private copy of this judgement", () => {
  // Two tabs each grew their own `missing()` while this was being diagnosed.
  // Leaving them would be the same defect with more places to fix it.
  const dir = new URL("../../control-plane/public/", import.meta.url);
  // `next.mjs` and `launch.mjs` are not on main yet (#253, #249). They are
  // listed anyway and skipped while absent, so the guard covers them the day
  // they land rather than the day someone remembers to add them.
  for (const file of ["money.mjs", "views.mjs", "home.mjs", "board.mjs", "next.mjs", "launch.mjs"]) {
    let source;
    try { source = readFileSync(new URL(file, dir), "utf8"); } catch { continue; }
    assert.ok(!/^function missing\(/m.test(source), `${file} re-implements availability locally`);
    assert.ok(!/available === false\s*\)\s*return\s*(?:text\()?["']not configured/.test(source),
      `${file} re-implements the "not configured" rule locally`);
  }
});

test("render.mjs states which field means what", () => {
  // The fix is a reading of the contract, and the contract is only written
  // down here. If the comment goes, the next reader repeats the mistake.
  const source = readFileSync(new URL("../../control-plane/public/render.mjs", import.meta.url), "utf8");
  assert.match(source, /unavailable: true/);
  assert.match(source, /configured: false/);
  assert.match(source, /available: false/);
  assert.match(source, /DATA IS PRESENT/);
});
