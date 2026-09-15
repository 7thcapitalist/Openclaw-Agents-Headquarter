// Where every piece of work sits. One mapping, both surfaces.
//
// The local Task Board read a 3-byte tasks.json and showed zero in all six
// columns while 21 real tasks were running.
import test from "node:test";
import assert from "node:assert/strict";

import { BOARD_COLUMNS, boardColumn, buildBoard, filterByProject, stagePosition } from "../../control-plane/public/board.mjs";

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
