// state.events[] was append-only inside the state document, and the whole
// document is rewritten on every mutation — so a long task paid for its entire
// event history on every write. Quadratic in write traffic, not in file size,
// which is why no disk alarm caught it. Measured before this change: 5,000
// mutations produced a 521.6 KiB entity row, rewritten in place 5,000 times.
//
// The fix is a window, not a deletion. The `events` table was already the
// append-only projection of this array, so the history is already durable
// outside the document; the document keeps a bounded tail and
// readTransactionalState rehydrates the full history from the table.
//
// The thing that makes this dangerous, and what most of these tests are about:
// windowing the array silently truncates the AUDIT RECORD unless the
// projection stops comparing array lengths first.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mutateTransactionalState, readTransactionalState } from "../lib/store/transactional-json.mjs";
import { openStateDb } from "../lib/store/sqlite-state.mjs";
import { projectTaskEvents } from "../lib/audit/envelope.mjs";

// The behavioural tests below deliberately import nothing that this change
// introduced, so that against the pre-change code they fail on BEHAVIOUR —
// a growing entity row, a truncated history — rather than on a missing export.
const WINDOW = 200;

function newDir() {
  const dir = mkdtempSync(join(tmpdir(), "events-window-"));
  return { dir, jsonPath: join(dir, "state.json"), dbPath: join(dir, "state.sqlite") };
}

function seed(jsonPath) {
  mutateTransactionalState(jsonPath, {
    commandId: "init", replayable: false, toResponse: () => ({ ok: true }),
    mutate: () => ({
      task: { id: "windowed-task" }, status: "active", currentStage: "builder",
      stages: {}, dispatches: [], assignments: {}, events: [],
      createdAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z",
    }),
  });
}

function append(jsonPath, n) {
  for (let i = 0; i < n; i++) {
    mutateTransactionalState(jsonPath, {
      commandId: `evt-${i}`, replayable: false, toResponse: () => ({ ok: true }),
      mutate: (s) => ({
        ...s,
        events: [...(s.events || []), {
          at: new Date(Date.UTC(2026, 8, 15, 0, 0, i)).toISOString(),
          type: "stage-pass", stage: "builder", actor: "backend-builder", n: i,
        }],
      }),
    });
  }
}

function entityRowBytes(dbPath) {
  const handle = openStateDb(dbPath);
  return handle.db.prepare("SELECT length(state_json) AS bytes FROM entity WHERE id = 'state'").get().bytes;
}

test("the entity row stays bounded while the history keeps growing", () => {
  const small = newDir(), large = newDir();
  try {
    seed(small.jsonPath); append(small.jsonPath, 300);
    seed(large.jsonPath); append(large.jsonPath, 3000);

    const smallBytes = entityRowBytes(small.dbPath);
    const largeBytes = entityRowBytes(large.dbPath);

    // 10x the mutations must not mean a meaningfully larger row. Before the
    // window this ratio was ~10; the tolerance here is for the eventsDropped
    // counter gaining digits, nothing else.
    assert.ok(largeBytes < smallBytes * 1.1,
      `entity row grew with history: ${smallBytes} -> ${largeBytes} bytes`);

    // ...and the history itself is all still there.
    assert.equal(readTransactionalState(large.jsonPath).events.length, 3000);
  } finally {
    rmSync(small.dir, { recursive: true, force: true });
    rmSync(large.dir, { recursive: true, force: true });
  }
});

test("events keep projecting after the window starts evicting", () => {
  // The trap: projectEvents used to compare newEvents.length to
  // oldEvents.length. Once the array is windowed it stops growing, so that
  // comparison reads "nothing new" forever and the table — the only remaining
  // copy of the history — silently stops receiving events.
  const { dir, jsonPath } = newDir();
  try {
    seed(jsonPath);
    const n = WINDOW * 3;
    append(jsonPath, n);
    const events = readTransactionalState(jsonPath).events;
    assert.equal(events.length, n, "every appended event must survive in the table");
    // and in order, with nothing dropped from the middle
    assert.deepEqual(events.map((e) => e.n), Array.from({ length: n }, (_, i) => i));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the audit envelope for a long task is unchanged by windowing", () => {
  // Compared, not asserted: the reference is the same event list projected
  // from an un-windowed document, exactly as the old code would have held it.
  const { dir, jsonPath } = newDir();
  try {
    seed(jsonPath);
    const n = WINDOW * 4;
    append(jsonPath, n);

    const stored = readTransactionalState(jsonPath);
    const reference = {
      task: { id: "windowed-task" },
      events: Array.from({ length: n }, (_, i) => ({
        at: new Date(Date.UTC(2026, 8, 15, 0, 0, i)).toISOString(),
        type: "stage-pass", stage: "builder", actor: "backend-builder", n: i,
      })),
    };

    const now = () => "2026-09-15T00:00:00.000Z";
    const fromStore = projectTaskEvents(stored, { now });
    const fromReference = projectTaskEvents(reference, { now });

    assert.equal(fromStore.length, n);
    assert.deepEqual(fromStore, fromReference,
      "the windowed store must produce the same audit envelope as an un-windowed document");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a state within the window is returned untouched, with no eventsDropped", () => {
  const { dir, jsonPath } = newDir();
  try {
    seed(jsonPath);
    append(jsonPath, 5);
    const state = readTransactionalState(jsonPath);
    assert.equal(state.events.length, 5);
    assert.ok(!state.eventsDropped, "a short task must not gain bookkeeping it does not need");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("windowStateEvents keeps the tail and counts what it dropped", async () => {
  const { windowStateEvents, eventsTotal } = await import("../lib/store/sqlite-state.mjs");
  const events = Array.from({ length: 10 }, (_, i) => ({ type: "e", n: i }));
  const windowed = windowStateEvents({ events }, 4);
  assert.deepEqual(windowed.events.map((e) => e.n), [6, 7, 8, 9]);
  assert.equal(windowed.eventsDropped, 6);
  assert.equal(eventsTotal(windowed), 10, "total must survive eviction");

  // Idempotent across repeated windowing — the count accumulates, not resets.
  const again = windowStateEvents({ ...windowed, events: [...windowed.events, { type: "e", n: 10 }] }, 4);
  assert.deepEqual(again.events.map((e) => e.n), [7, 8, 9, 10]);
  assert.equal(again.eventsDropped, 7);
  assert.equal(eventsTotal(again), 11);

  // Within the window it is the identical object, so the common path allocates nothing.
  const untouched = { events: [{ type: "e", n: 0 }] };
  assert.equal(windowStateEvents(untouched, 4), untouched);
});
