import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CorruptStateError,
  InvalidSchemaVersionError,
  StaleRevisionError,
  closeStateDb,
  importLegacyState,
  listQuarantine,
  mutateEntity,
  openStateDb,
  peekEntity,
} from "../../lib/store/sqlite-state.mjs";
import { mutateTransactionalState, readTransactionalState } from "../../lib/store/transactional-json.mjs";

function dbFile() {
  const root = mkdtempSync(join(tmpdir(), "sqlite-state-"));
  return join(root, "entity.sqlite");
}

test("mutateEntity creates revision 1, then advances the revision on every real mutation", () => {
  const handle = openStateDb(dbFile());
  const first = mutateEntity(handle, { entityId: "a", commandId: "c1", mutate: () => ({ nextState: { status: "active", events: [] } }) });
  assert.deepEqual(first, { status: "active", events: [] });
  assert.equal(peekEntity(handle, "a").revision, 1);
  mutateEntity(handle, { entityId: "a", commandId: "c2", mutate: (current) => ({ nextState: { ...current.state, status: "blocked" } }) });
  assert.equal(peekEntity(handle, "a").revision, 2);
  assert.equal(peekEntity(handle, "a").state.status, "blocked");
});

test("a repeated commandId replays the cached response and never calls mutate again", () => {
  const handle = openStateDb(dbFile());
  let calls = 0;
  const mutate = (current) => { calls += 1; return { nextState: { ...(current?.state || {}), count: (current?.state?.count || 0) + 1 } }; };
  const first = mutateEntity(handle, { entityId: "a", commandId: "dup", mutate });
  const second = mutateEntity(handle, { entityId: "a", commandId: "dup", mutate });
  assert.deepEqual(first, second);
  assert.equal(calls, 1, "mutate must not run twice for the same commandId");
  assert.equal(peekEntity(handle, "a").revision, 1, "a replayed command must not advance the revision");
});

test("expectedRevision rejects a stale caller instead of silently overwriting newer state", () => {
  const handle = openStateDb(dbFile());
  mutateEntity(handle, { entityId: "a", commandId: "c1", mutate: () => ({ nextState: { v: 1 } }) });
  assert.throws(
    () => mutateEntity(handle, { entityId: "a", commandId: "c2", expectedRevision: 0, mutate: () => ({ nextState: { v: 2 } }) }),
    (error) => error instanceof StaleRevisionError && error.expected === 0 && error.actual === 1,
  );
  // The rejected attempt must not have left any trace: revision unchanged,
  // and retrying with the now-correct expected revision succeeds.
  assert.equal(peekEntity(handle, "a").revision, 1);
  assert.equal(peekEntity(handle, "a").state.v, 1);
  mutateEntity(handle, { entityId: "a", commandId: "c3", expectedRevision: 1, mutate: () => ({ nextState: { v: 2 } }) });
  assert.equal(peekEntity(handle, "a").revision, 2);
});

test("approval and retry racing: two callers read revision 1, only the first expectedRevision=1 wins", () => {
  const handle = openStateDb(dbFile());
  mutateEntity(handle, { entityId: "task-1", commandId: "init", mutate: () => ({ nextState: { status: "blocked" } }) });
  const seenRevision = peekEntity(handle, "task-1").revision; // both callers "read" this
  mutateEntity(handle, { entityId: "task-1", commandId: "approve", expectedRevision: seenRevision, mutate: () => ({ nextState: { status: "active" } }) });
  assert.throws(
    () => mutateEntity(handle, { entityId: "task-1", commandId: "retry", expectedRevision: seenRevision, mutate: () => ({ nextState: { status: "active-again" } }) }),
    StaleRevisionError,
  );
  assert.equal(peekEntity(handle, "task-1").state.status, "active", "the winning approval's state is preserved, not clobbered by the stale retry");
});

test("mutate returning no change (undefined nextState) is a no-op: no new revision, no event, response still recorded", () => {
  const handle = openStateDb(dbFile());
  mutateEntity(handle, { entityId: "a", commandId: "c1", mutate: () => ({ nextState: { v: 1 } }) });
  const result = mutateEntity(handle, { entityId: "a", commandId: "c2", mutate: (current) => ({ response: { already: current.state.v } }) });
  assert.deepEqual(result, { already: 1 });
  assert.equal(peekEntity(handle, "a").revision, 1);
});

test("a thrown mutate leaves the prior committed state completely untouched (rollback)", () => {
  const handle = openStateDb(dbFile());
  mutateEntity(handle, { entityId: "a", commandId: "c1", mutate: () => ({ nextState: { v: 1 } }) });
  assert.throws(() => mutateEntity(handle, { entityId: "a", commandId: "c2", mutate: () => { throw new Error("boom"); } }), /boom/);
  assert.equal(peekEntity(handle, "a").revision, 1, "a failed transaction must not advance the revision");
  assert.equal(peekEntity(handle, "a").state.v, 1);
  // And the failed attempt's commandId was never recorded, so a legitimate
  // retry with the same commandId is free to actually run (not idempotently
  // replayed against a failure that never committed).
  const retried = mutateEntity(handle, { entityId: "a", commandId: "c2", mutate: (current) => ({ nextState: { ...current.state, v: 2 } }) });
  assert.equal(retried.v, 2);
});

test("a corrupt state_json row is quarantined and removed, surfacing CorruptStateError instead of crashing", () => {
  const handle = openStateDb(dbFile());
  mutateEntity(handle, { entityId: "a", commandId: "c1", mutate: () => ({ nextState: { v: 1 } }) });
  handle.db.prepare("UPDATE entity SET state_json = 'not json' WHERE id = ?").run("a");
  assert.throws(() => peekEntity(handle, "a"), CorruptStateError);
  assert.equal(peekEntity(handle, "a"), null, "the corrupt row was quarantined and removed, not left to fail forever");
  const quarantined = listQuarantine(handle, "a");
  assert.equal(quarantined.length, 1);
  assert.match(quarantined[0].payload_text, /not json/);
});

test("importLegacyState is idempotent: a second call for the same entity is a no-op", () => {
  const handle = openStateDb(dbFile());
  const legacy = { status: "active", events: [{ at: "2026-01-01T00:00:00Z", type: "seed" }] };
  const first = importLegacyState(handle, { entityId: "a", state: legacy });
  assert.deepEqual(first, { imported: true, revision: 1 });
  const second = importLegacyState(handle, { entityId: "a", state: { status: "different" } });
  assert.deepEqual(second, { imported: false, revision: 1 }, "re-import must not overwrite an entity that already exists");
  assert.equal(peekEntity(handle, "a").state.status, "active", "the original import wins; a stale re-import cannot clobber it");
});

test("importLegacyState preserves every field verbatim: events, evidence, blockers, approvals", () => {
  const handle = openStateDb(dbFile());
  const legacy = {
    status: "blocked",
    blocker: { stage: "builder", outcome: "decision-required", founderAction: true, summary: "needs FACTORY_FOUNDER_PUBLIC_KEY" },
    events: [{ at: "t1", type: "task-created" }, { at: "t2", type: "stage-fail", stage: "qa" }],
    stages: { product: { status: "pass", evidence: [{ path: "evidence/x.md" }] } },
    dispatches: [{ id: "d1", stage: "builder", status: "completed", outcome: "fail" }],
    recovery: { attempts: [{ number: 1, status: "verified" }] },
    founderApproval: { assertion: "sig...", verifiedAt: "t3" },
  };
  importLegacyState(handle, { entityId: "a", state: legacy });
  assert.deepEqual(peekEntity(handle, "a").state, legacy);
});

test("schema_version mismatch on an existing db surfaces InvalidSchemaVersionError instead of silently reinterpreting it", () => {
  const path = dbFile();
  const handle = openStateDb(path);
  handle.db.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run();
  closeStateDb(path);
  assert.throws(() => openStateDb(path), InvalidSchemaVersionError);
});

test("the db file and its WAL/SHM siblings are created with private (0600) permissions", () => {
  const path = dbFile();
  const handle = openStateDb(path);
  mutateEntity(handle, { entityId: "a", commandId: "c1", mutate: () => ({ nextState: { v: 1 } }) });
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("an invalid entity id is rejected before touching the database", () => {
  const handle = openStateDb(dbFile());
  assert.throws(() => peekEntity(handle, "../escape"), /Invalid entity id/);
  assert.throws(() => mutateEntity(handle, { entityId: "bad id with spaces", commandId: "c1", mutate: () => ({ nextState: {} }) }), /Invalid entity id/);
});

test("mutateEntity requires a non-empty commandId — no unkeyed, unreplayable mutation is allowed", () => {
  const handle = openStateDb(dbFile());
  assert.throws(() => mutateEntity(handle, { entityId: "a", commandId: "", mutate: () => ({ nextState: {} }) }), /commandId/);
});

// ── transactional-json.mjs: the legacy-JSON-file bridge ─────────────────────

test("readTransactionalState auto-imports a pre-existing legacy JSON file on first touch", () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-json-"));
  const jsonPath = join(root, "state.json");
  writeFileSync(jsonPath, JSON.stringify({ status: "active", events: [] }));
  assert.equal(readTransactionalState(jsonPath).status, "active");
  assert.ok(existsSync(join(root, "state.sqlite")), "a colocated db was created");
});

test("readTransactionalState on a missing file throws the same ENOENT shape the old plain reader did", () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-json-missing-"));
  assert.throws(() => readTransactionalState(join(root, "missing.json")), (error) => error.code === "ENOENT" && /ENOENT/.test(error.message));
});

test("a corrupt legacy JSON file is quarantined and surfaced without deleting or modifying the original file", () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-json-corrupt-"));
  const jsonPath = join(root, "state.json");
  const rawBroken = "{ this is not valid json";
  writeFileSync(jsonPath, rawBroken);
  assert.throws(() => readTransactionalState(jsonPath), CorruptStateError);
  assert.equal(readFileSync(jsonPath, "utf8"), rawBroken, "a failed migration must leave the original data untouched");
});

test("mutateTransactionalState writes the JSON export back after every commit, matching what's in SQLite", () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-json-export-"));
  const jsonPath = join(root, "state.json");
  writeFileSync(jsonPath, JSON.stringify({ status: "active", events: [] }));
  mutateTransactionalState(jsonPath, { commandId: "bump", mutate: (state) => ({ ...state, status: "blocked" }) });
  assert.equal(JSON.parse(readFileSync(jsonPath, "utf8")).status, "blocked");
});

test("duplicate command replay via mutateTransactionalState: same commandId, same response, mutate runs once", () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-json-dup-"));
  const jsonPath = join(root, "state.json");
  writeFileSync(jsonPath, JSON.stringify({ status: "active", count: 0, events: [] }));
  let calls = 0;
  const mutate = (state) => { calls += 1; return { ...state, count: state.count + 1 }; };
  const first = mutateTransactionalState(jsonPath, { commandId: "same-key", mutate });
  const second = mutateTransactionalState(jsonPath, { commandId: "same-key", mutate });
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(readFileSync(jsonPath, "utf8")).count, 1);
});
