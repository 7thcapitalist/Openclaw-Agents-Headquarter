// Where every piece of work sits. One mapping, both surfaces.
//
// The local Task Board read a 3-byte tasks.json and showed zero in all six
// columns while 21 real tasks were running.
import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import {
  BOARD_COLUMNS, boardColumn, buildBoard, filterByProject, filterStalled,
  movement, stagePosition, STALLED_AFTER_DAYS,
} from "../../control-plane/public/board.mjs";

test("the three gates collapse into one Review column", () => {
  // Reviewer, qa and security all mean "built, being checked". Three columns
  // would be unreadable and the founder acts on none of them differently.
  for (const stage of ["reviewer", "qa", "security"]) {
    assert.equal(boardColumn({ status: "active", stage }), "Review", stage);
  }
});

test("Blocked outranks stage", () => {
  // A task stuck at Quality check is Blocked, not Review: the founder acts on
  // "stuck", not on where it stopped.
  assert.equal(boardColumn({ status: "blocked", stage: "qa" }), "Blocked");
  assert.equal(boardColumn({ status: "failed", stage: "builder" }), "Blocked");
  assert.equal(boardColumn({ status: "blocked", stage: null }), "Blocked");
});

test("the other columns map as proposed", () => {
  assert.equal(boardColumn({ status: "active", stage: "product" }), "Assigned");
  assert.equal(boardColumn({ status: "active", stage: "architect" }), "Assigned");
  assert.equal(boardColumn({ status: "active", stage: "builder" }), "In Progress");
  assert.equal(boardColumn({ status: "active", stage: "release" }), "In Progress");
  assert.equal(boardColumn({ status: "active", stage: null }), "Inbox");
  for (const status of ["merge-ready", "merged", "complete"]) {
    assert.equal(boardColumn({ status, stage: "release" }), "Done", status);
  }
});

test("Done outranks stage, so finished work never sits in Review", () => {
  assert.equal(boardColumn({ status: "merged", stage: "qa" }), "Done");
});

test("every task lands in exactly one column, and none is dropped", () => {
  const tasks = [
    { taskId: "a", status: "active", stage: "builder" },
    { taskId: "b", status: "blocked", stage: "qa" },
    { taskId: "c", status: "merged", stage: "release" },
    { taskId: "d", status: "active", stage: "product" },
    { taskId: "e", status: "active", stage: "reviewer" },
    { taskId: "f", status: "active", stage: null },
  ];
  const board = buildBoard(tasks);
  const placed = BOARD_COLUMNS.reduce((n, c) => n + board.columns[c].length, 0);
  assert.equal(placed, tasks.length, "no task may vanish between the list and the board");
  assert.equal(board.total, 6);
  assert.deepEqual(board.counts, { Inbox: 1, Assigned: 1, "In Progress": 1, Review: 1, Done: 1, Blocked: 1 });
});

test("a card is named by its outcome and never by its id", () => {
  const board = buildBoard([{ taskId: "obj-c58897c0-game-backend", outcome: "Design the game backend.", status: "merged" }]);
  const card = board.columns.Done[0];
  assert.equal(card.title, "Design the game backend.");
  assert.equal(card.id, "obj-c58897c0-game-backend");
  assert.notEqual(card.title, card.id);
});

test("a card says what happened, never 'failed at —'", () => {
  const board = buildBoard([{ taskId: "x", status: "failed", stage: null }]);
  assert.equal(board.columns.Blocked[0].outcomeLine, "Failed before it started");
  assert.doesNotMatch(board.columns.Blocked[0].outcomeLine, /—/);
});

test("stage position gives a human label and a place in the pipeline", () => {
  assert.deepEqual(stagePosition("reviewer"), { index: 4, total: 7, label: "Independent review" });
  assert.equal(stagePosition(null), null);
});

test("a column is ordered by most recent movement", () => {
  const board = buildBoard([
    { taskId: "old", status: "active", stage: "builder", updatedAt: "2026-09-10T00:00:00.000Z" },
    { taskId: "new", status: "active", stage: "builder", updatedAt: "2026-09-14T00:00:00.000Z" },
  ]);
  assert.deepEqual(board.columns["In Progress"].map((c) => c.id), ["new", "old"]);
});

test("filtering by project is what Projects clicks through to", () => {
  const tasks = [{ taskId: "a", projectId: "lifemaxing" }, { taskId: "b", projectId: "openclaw-factory" }];
  assert.deepEqual(filterByProject(tasks, "lifemaxing").map((t) => t.taskId), ["a"]);
  assert.equal(filterByProject(tasks, null).length, 2);
});

test("a malformed row cannot break the board", () => {
  const board = buildBoard([null, {}, { taskId: "ok", status: "active", stage: "builder" }]);
  assert.equal(board.total, 1);
  assert.equal(board.columns["In Progress"].length, 1);
});

test("a card never says the stage twice", () => {
  // "Shaping the outcome · Shaping the outcome 1/7" — the outcome line IS the
  // stage name for work in flight, so the card shows the position instead.
  const active = buildBoard([{ taskId: "a", status: "active", stage: "product" }]).columns.Assigned[0];
  assert.equal(active.outcomeLine, "Shaping the outcome 1/7");

  // A blocked task says what happened AND where, because those differ.
  // "Blocked at preparing delivery · Preparing delivery 7/7" said it twice.
  const blocked = buildBoard([{ taskId: "b", status: "blocked", stage: "qa" }]).columns.Blocked[0];
  assert.equal(blocked.outcomeLine, "Blocked at quality check 5/7");
  assert.equal((blocked.outcomeLine.match(/quality check/gi) || []).length, 1, "the stage is named once");

  // And a task that never started has no position to show.
  const never = buildBoard([{ taskId: "c", status: "failed", stage: null }]).columns.Blocked[0];
  assert.equal(never.outcomeLine, "Failed before it started");
});

// ── movement: the board must admit that work has stopped ──────────────────
//
// Every card already carried `updatedAt` and the columns were already sorted
// by it. Nothing rendered it, so a task that had not moved in eight days —
// task-ca3c3cdf sat blocked for 5.7 — looked identical to one that moved an
// hour ago.

const NOW = Date.parse("2026-09-15T12:00:00.000Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const DAY = 86_400_000;

test("a card says when it last moved, in words", () => {
  const board = buildBoard([
    { taskId: "t1", status: "active", stage: "builder", updatedAt: ago(30 * 60_000) },
  ], { now: NOW });
  assert.equal(board.columns["In Progress"][0].movement.label, "moved 30 minutes ago");
});

test("movement is reported at the scale a person would use", () => {
  const cases = [
    [30_000, "moved just now"],
    [45 * 60_000, "moved 45 minutes ago"],
    [5 * 3_600_000, "moved 5 hours ago"],
    [8 * DAY, "moved 8 days ago"],
    [1 * DAY, "moved 24 hours ago"],
  ];
  for (const [age, expected] of cases) {
    assert.equal(movement(ago(age), { now: NOW }).label, expected, String(age));
  }
});

test("three days without movement is stalled, and the threshold is exported", () => {
  assert.equal(STALLED_AFTER_DAYS, 3);
  assert.equal(movement(ago(2.9 * DAY), { now: NOW, column: "Review" }).stalled, false);
  assert.equal(movement(ago(3.1 * DAY), { now: NOW, column: "Review" }).stalled, true);
});

test("a Done card is never stalled", () => {
  // Finished work is SUPPOSED to stop moving. Marking it stalled turns the
  // most reassuring thing on the board into a warning.
  const board = buildBoard([
    { taskId: "done", status: "merged", updatedAt: ago(200 * DAY) },
    { taskId: "mr", status: "merge-ready", updatedAt: ago(200 * DAY) },
  ], { now: NOW });
  for (const card of board.columns.Done) assert.equal(card.movement.stalled, false, card.id);
  assert.equal(board.stalled, 0);
});

test("blocked and forgotten is flagged — that is the case that cost five days", () => {
  const board = buildBoard([
    { taskId: "t1", status: "blocked", stage: "reviewer", updatedAt: ago(5.7 * DAY) },
  ], { now: NOW });
  assert.equal(board.columns.Blocked[0].movement.stalled, true);
  assert.equal(board.columns.Blocked[0].movement.days, 5);
});

test("every in-flight column can stall", () => {
  const rows = [
    ["Assigned", { taskId: "a", status: "active", stage: "product" }],
    ["In Progress", { taskId: "b", status: "active", stage: "builder" }],
    ["Review", { taskId: "c", status: "active", stage: "qa" }],
    ["Inbox", { taskId: "d", status: "active", stage: null }],
  ];
  for (const [column, task] of rows) {
    const board = buildBoard([{ ...task, updatedAt: ago(9 * DAY) }], { now: NOW });
    assert.equal(board.columns[column][0].movement.stalled, true, column);
  }
});

test("a card with no timestamp reports nothing rather than a wrong age", () => {
  const board = buildBoard([{ taskId: "t1", status: "active", stage: "builder" }], { now: NOW });
  assert.equal(board.columns["In Progress"][0].movement, null);
  assert.equal(board.stalled, 0);
});

test("the board counts what has stopped, and names its own threshold", () => {
  const board = buildBoard([
    { taskId: "fresh", status: "active", stage: "builder", updatedAt: ago(1 * DAY) },
    { taskId: "old", status: "active", stage: "builder", updatedAt: ago(9 * DAY) },
    { taskId: "older", status: "blocked", stage: "qa", updatedAt: ago(12 * DAY) },
    { taskId: "done", status: "merged", updatedAt: ago(30 * DAY) },
  ], { now: NOW });
  assert.equal(board.stalled, 2);
  assert.equal(board.stalledAfterDays, 3);
  assert.equal(board.total, 4);
});

test("the stalled filter narrows to exactly what the count promised", () => {
  const tasks = [
    { taskId: "fresh", status: "active", stage: "builder", updatedAt: ago(1 * DAY) },
    { taskId: "old", status: "active", stage: "builder", updatedAt: ago(9 * DAY) },
    { taskId: "done", status: "merged", updatedAt: ago(30 * DAY) },
  ];
  const stalled = filterStalled(tasks, { now: NOW });
  assert.deepEqual(stalled.map((t) => t.taskId), ["old"]);
  // The filtered board and the count on the unfiltered one must agree, or the
  // button promises a number the next screen does not show.
  assert.equal(buildBoard(tasks, { now: NOW }).stalled, buildBoard(stalled, { now: NOW }).total);
});

test("movement never reads as activity — it is a state transition", () => {
  // `updatedAt` is the last recorded transition, not the last time an agent
  // did anything. The vocabulary is part of the contract.
  const source = readFileSync(new URL("../../control-plane/public/board.mjs", import.meta.url), "utf8");
  assert.match(source, /last recorded state transition/);
  assert.match(source, /NOT the last time an agent did/);
  assert.equal(movement(ago(DAY), { now: NOW }).label.startsWith("moved "), true);
});

test("a future timestamp does not produce a negative age", () => {
  const m = movement(new Date(NOW + 60_000).toISOString(), { now: NOW });
  assert.equal(m.ms, 0);
  assert.equal(m.stalled, false);
});
