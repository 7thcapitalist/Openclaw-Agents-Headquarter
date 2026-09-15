// Bridges the SQLite transactional authority (sqlite-state.mjs) to the
// existing "one JSON file per task/objective" world so every current caller
// keeps the exact same on-disk contract.
//
// For a JSON state file at `.../<dir>/state.json` (or objective-state.json,
// overnight-queue.json, ...): the database lives alongside it at
// `.../<dir>/<basename>.sqlite` — one db file per JSON file, not per
// directory, so two differently-named state files that happen to share a
// directory (this is not today's task/objective layout, but is exactly the
// shape several tests use for a compact fixture) never collide on the same
// entity row. The database is the sole writable authority; the JSON file is
// regenerated after every committed mutation purely as a human/debug export
// (requirement: readable JSON stays an export, not a competing source of
// truth). A legacy JSON file written before this module existed is imported
// as revision 1 automatically the first time it is touched here — no
// separate migration step is required for a single file to keep working;
// scripts/migrate-factory-state.mjs additionally does this in bulk, up front,
// with a corruption report, for operators who want it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { assertSupportedVersion } from "./durable-version.mjs";
import { randomUUID } from "node:crypto";
import { CorruptStateError, StateStoreFullError, StaleRevisionError, importLegacyState, maxStateBytes, mutateEntity, openStateDb, peekEntity, quarantineRow, readEntityEvents, stateStoreBytes } from "./sqlite-state.mjs";

export { StaleRevisionError, CorruptStateError, StateStoreFullError, maxStateBytes, stateStoreBytes };

function dbPathFor(jsonPath) {
  const stem = basename(jsonPath, extname(jsonPath));
  return join(dirname(jsonPath), `${stem}.sqlite`);
}

// The one logical entity a colocated db holds. Kept as a real column (not
// hardcoded) so a future multi-entity-per-file use is a schema no-op, but
// today's layout is one JSON file <-> one entity <-> one db file.
const ENTITY_ID = "state";

function readLegacyJsonIfPresent(jsonPath) {
  if (!existsSync(jsonPath)) return null;
  const raw = readFileSync(jsonPath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    return { corrupt: true, raw, error };
  }
}

// Ensure the entity exists in the db, auto-importing a pre-existing legacy
// JSON file on first touch. Returns the current { revision, state } (state
// null if the entity has never existed and there was no legacy file either).
function ensureImported(handle, jsonPath) {
  const existing = peekEntity(handle, ENTITY_ID);
  if (existing) return existing;
  const legacy = readLegacyJsonIfPresent(jsonPath);
  if (!legacy) return null;
  if (legacy.corrupt) {
    quarantineRow(handle.db, ENTITY_ID, `legacy JSON at ${jsonPath} does not parse: ${legacy.error.message}`, legacy.raw, jsonPath);
    throw new CorruptStateError(ENTITY_ID, `legacy file ${jsonPath} is not valid JSON`);
  }
  importLegacyState(handle, { entityId: ENTITY_ID, state: legacy, sourcePath: jsonPath });
  return peekEntity(handle, ENTITY_ID);
}

function writeJsonExport(jsonPath, state) {
  mkdirSync(dirname(jsonPath), { recursive: true });
  const tmp = `${jsonPath}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tmp, jsonPath);
}

// Read the current state for `jsonPath` through the transactional authority
// (importing a legacy file on first touch). Same return shape as the old
// plain `JSON.parse(readFileSync(jsonPath))` — just sourced from the db when
// one exists, so every existing reader keeps working unmodified.
// `format` distinguishes the two canonical shapes that share this store —
// task state and objective state — so a refusal names the right thing. Both
// are version 1 today; the check exists so a version 2 written by a newer HQ
// is refused rather than parsed into a confidently wrong projection.
export function readTransactionalState(jsonPath, { format = "task-state" } = {}) {
  const handle = openStateDb(dbPathFor(jsonPath));
  const row = ensureImported(handle, jsonPath);
  if (!row) {
    // No SQLite row and no legacy file to import: match the original
    // `JSON.parse(readFileSync(jsonPath))` failure mode exactly (message and
    // `.code`) so every existing caller/test that greps for "ENOENT" or
    // checks `error.code` keeps working unmodified.
    const error = new Error(`ENOENT: no such file or directory, open '${jsonPath}'`);
    error.code = "ENOENT";
    error.path = jsonPath;
    throw error;
  }
  assertSupportedVersion(row.state?.version, { format, path: jsonPath });
  return rehydrateEvents(handle, row.state);
}

// The stored document keeps only a bounded tail of state.events[] (see
// windowStateEvents in sqlite-state.mjs). The `events` table holds the whole
// history, so readers are handed the whole history here — the audit envelope,
// the activity projection, the run timeline and the objective orchestrator's
// maxParallel derivation all read `state.events` and all of them need history,
// not a tail. Rehydrating at this single funnel is what lets the document
// shrink without any of them changing or noticing.
//
// The tail in the document is not the source of truth and is not merged with
// the table: the table already contains every event the tail does.
function rehydrateEvents(handle, state) {
  if (!state || !Array.isArray(state.events)) return state;
  if (!state.eventsDropped) return state;
  const history = readEntityEvents(handle, ENTITY_ID);
  if (history.length < state.events.length) return state;
  return { ...state, events: history };
}

export function peekRevision(jsonPath) {
  const handle = openStateDb(dbPathFor(jsonPath));
  const row = ensureImported(handle, jsonPath);
  return row?.revision ?? null;
}

// The atomic read-modify-write callers must use instead of separate
// readState()/writeState() calls. `mutate(currentState)` returns the next
// state (or throws to abort with no change) and runs inside the SQLite
// transaction, so no other writer can observe or clobber the state in
// between the read and the write — that gap is exactly what caused lost
// updates before this change.
//
//   jsonPath          — the existing state file path (unchanged convention)
//   commandId          — idempotency key; required
//   mutate(state)      — (state) => nextState; state is null only for a
//                         brand-new entity that also has no legacy file
//   expectedRevision   — optional optimistic-concurrency guard
//   toResponse(state)  — optional; defaults to returning the next state
//   replayable         — false when `commandId` is generated fresh per call
//                         (a UUID), so this command can never be presented a
//                         second time. The ledger keeps the row and drops the
//                         payload.
//
// A note on `toResponse`, because the default is a trap. Whatever this returns
// is ALSO what gets stored in the idempotency ledger, one row per mutation,
// forever. Defaulting to the whole state document meant every caller — none of
// which passed a `toResponse` — wrote a full copy of the task's state on every
// single mutation. At 195 KiB a copy that is 403 GiB per 2.21M mutations,
// which is precisely what the 2026-09-14 write storm was made of. Pass the
// small projection the caller actually consumes.
export function mutateTransactionalState(jsonPath, { commandId, mutate, expectedRevision = null, toResponse = null, replayable = true, now }) {
  const handle = openStateDb(dbPathFor(jsonPath));
  ensureImported(handle, jsonPath);
  // Every existing caller's own `now` parameter defaults to a plain ISO
  // string (`new Date().toISOString()`), not a callback; sqlite-state.mjs
  // wants a function it can call once per attempt (including on a busy
  // retry). Accept both without asking any call site to change.
  const nowFn = typeof now === "function" ? now : (now ? () => now : undefined);
  const response = mutateEntity(handle, {
    entityId: ENTITY_ID,
    commandId,
    expectedRevision,
    replayable,
    ...(nowFn ? { now: nowFn } : {}),
    mutate: (current) => {
      const nextState = mutate(current?.state ?? null);
      if (nextState === undefined) return { response: toResponse ? toResponse(current?.state ?? null) : (current?.state ?? null) };
      return { nextState, response: toResponse ? toResponse(nextState) : nextState };
    },
  });
  // Re-read the committed row so the JSON export always reflects exactly
  // what was persisted, even on the idempotent-replay path.
  const committed = peekEntity(handle, ENTITY_ID);
  if (committed) writeJsonExport(jsonPath, committed.state);
  return response;
}
