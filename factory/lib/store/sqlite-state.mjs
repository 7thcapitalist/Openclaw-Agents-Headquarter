// A small, dependency-free transactional authority for workflow JSON state,
// built on Node's built-in `node:sqlite` (WAL mode). One database file backs
// one JSON state file's directory (task state, objective state, the overnight
// queue, ...) — see transactional-json.mjs for how call sites use this.
//
// Why node:sqlite and not better-sqlite3 (already a dashboard/backend
// dependency): factory/ is deliberately dependency-free today. node:sqlite is
// built into Node (stable since Node 22.5, and this repo targets Node 24+),
// gives the same synchronous WAL/transaction semantics, and avoids adding a
// native-compiled dependency to the core engine. dashboard/backend code that
// already depends on better-sqlite3 (db.mjs, sessionStore.mjs) is untouched —
// this module is only for factory/ workflow state and is imported by
// dashboard code the same way task-workflow.mjs already is (relative path).
//
// Schema (per database file):
//   meta              — schema_version
//   entity            — the current row per logical entity id: revision,
//                        status, current_stage, full state_json
//   state_revisions   — one row per committed revision (audit trail of *when*
//                        a revision was reached and by which command)
//   events            — append-only projection of state.events[] entries
//   commands          — idempotency ledger: command_id -> the response it
//                        produced, so a replayed command never re-executes
//   stages            — queryable projection of state.stages{}
//   dispatches        — append-only projection of state.dispatches[]
//   recovery_attempts — append-only projection of state.recovery.attempts[]
//   quarantine        — corrupt or unreadable rows, preserved for inspection
//
// All of the above commit in one SQLite transaction per mutation: the event
// log, the projections, and the current-state row can never disagree, and a
// process killed mid-mutation leaves the last-committed state exactly as it
// was (SQLite WAL is crash-consistent by construction), never a torn write.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const SCHEMA_VERSION = 1;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const BUSY_RETRIES = 30;
const BUSY_RETRY_DELAY_MS = 20;

// A hard ceiling on how large one task's state store may grow.
//
// On 2026-09-14 a single task's state.sqlite reached 403 GiB — 105,423,722
// pages of materialised state for a task with 15 dispatches — and took the host
// to 98% of a 468 GB disk in five and a half hours. Whatever drove that write
// loop, no one task's bookkeeping should ever be able to fill the disk. A task
// dying is recoverable; a full disk is not, because it takes every other task,
// the dashboard and the gateway down with it.
//
// This is a backstop, not a diagnosis. It is deliberately far above any
// legitimate task (the largest healthy store in the fleet is a few hundred KiB)
// so that hitting it always means something is wrong.
const DEFAULT_MAX_STATE_BYTES = 1024 * 1024 * 1024;

export class StateStoreFullError extends Error {
  constructor(path, bytes, ceiling) {
    super(
      `task state store exceeded its size ceiling and is refusing further writes: `
      + `${path} is ${bytes} bytes (${(bytes / 1024 ** 3).toFixed(2)} GiB), ceiling ${ceiling} bytes `
      + `(${(ceiling / 1024 ** 3).toFixed(2)} GiB). Set FACTORY_MAX_TASK_STATE_BYTES to change it.`,
    );
    this.name = "StateStoreFullError";
    this.path = path;
    this.bytes = bytes;
    this.ceiling = ceiling;
  }
}

// `0` disables the ceiling entirely; a malformed value falls back to the
// default rather than disabling the guard, because the failure mode of a typo
// must not be "no protection".
export function maxStateBytes(env = process.env) {
  const raw = env.FACTORY_MAX_TASK_STATE_BYTES;
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_MAX_STATE_BYTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_STATE_BYTES;
  return Math.floor(n);
}

// The whole store, not just the main file: a runaway write can sit in the WAL.
export function stateStoreBytes(dbPath) {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try { total += statSync(`${dbPath}${suffix}`).size; } catch { /* absent is zero */ }
  }
  return total;
}

export class StaleRevisionError extends Error {
  constructor(entityId, expected, actual) {
    super(`stale revision for "${entityId}": expected ${expected}, current is ${actual}`);
    this.name = "StaleRevisionError";
    this.entityId = entityId;
    this.expected = expected;
    this.actual = actual;
  }
}

export class CorruptStateError extends Error {
  constructor(entityId, reason) {
    super(`entity "${entityId}" was corrupt and has been quarantined: ${reason}`);
    this.name = "CorruptStateError";
    this.entityId = entityId;
  }
}

export class InvalidSchemaVersionError extends Error {
  constructor(found, expected) {
    super(`database schema_version ${found} is not supported (expected ${expected}); run the migration tool.`);
    this.name = "InvalidSchemaVersionError";
  }
}

function assertId(id) {
  if (!ID_RE.test(String(id || ""))) throw new Error(`Invalid entity id: ${JSON.stringify(id)}`);
  return String(id);
}

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS entity (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  status TEXT,
  current_stage TEXT,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS state_revisions (
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  command_id TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (entity_id, revision)
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_id, seq);

CREATE TABLE IF NOT EXISTS commands (
  command_id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  response_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stages (
  entity_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT,
  actor TEXT,
  summary TEXT,
  evidence_json TEXT,
  completed_at TEXT,
  PRIMARY KEY (entity_id, stage)
);

CREATE TABLE IF NOT EXISTS dispatches (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  dispatch_id TEXT,
  stage TEXT,
  attempt INTEGER,
  kind TEXT,
  actor TEXT,
  status TEXT,
  outcome TEXT,
  created_at TEXT,
  completed_at TEXT,
  summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_dispatches_entity ON dispatches(entity_id, seq);

CREATE TABLE IF NOT EXISTS recovery_attempts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  attempt_number INTEGER,
  strategy TEXT,
  failed_stage TEXT,
  classification TEXT,
  status TEXT,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_recovery_entity ON recovery_attempts(entity_id, seq);

CREATE TABLE IF NOT EXISTS quarantine (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT,
  source_path TEXT,
  reason TEXT,
  payload_text TEXT,
  quarantined_at TEXT NOT NULL
);
`;

// Cache one open handle per resolved db path within this process — repeated
// opens of the same file are the common case (every dispatch on the same
// task) and node:sqlite connections are cheap to keep, not to reopen.
const cache = new Map();

export function openStateDb(dbPath) {
  const resolved = resolve(dbPath);
  const cached = cache.get(resolved);
  if (cached) return cached;
  mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolved);
  // busy_timeout must be the very first statement on this connection: it is
  // what makes every later statement wait-and-retry instead of throwing
  // immediately. Setting WAL mode itself briefly needs exclusive access the
  // first time a file is opened, so with many callers racing to open the
  // same brand-new db (e.g. 100 concurrent first-touches), that WAL switch —
  // and the first CREATE TABLE — must already be covered by busy_timeout,
  // not run before it.
  db.exec(`PRAGMA busy_timeout = ${BUSY_RETRY_DELAY_MS * BUSY_RETRIES}`);
  withRetry(() => {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(DDL);
  });
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (!row) {
    try {
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    } catch (error) {
      // Another concurrent first-opener already inserted it; that's fine as
      // long as it agrees with us.
      if (!/UNIQUE constraint failed/.test(String(error.message))) throw error;
    }
  } else if (Number(row.value) !== SCHEMA_VERSION) {
    throw new InvalidSchemaVersionError(row.value, SCHEMA_VERSION);
  }
  securePermissions(resolved);
  const handle = { db, path: resolved };
  cache.set(resolved, handle);
  return handle;
}

export function closeStateDb(dbPath) {
  const resolved = resolve(dbPath);
  const cached = cache.get(resolved);
  if (!cached) return;
  cached.db.close();
  cache.delete(resolved);
}

// Best-effort: keep the db file (and its WAL/SHM siblings, once they exist)
// unreadable by other local users. Not fatal if the platform disallows it.
function securePermissions(resolved) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = `${resolved}${suffix}`;
    try { if (existsSync(p)) chmodSync(p, 0o600); } catch { /* best effort */ }
  }
}

function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (error) {
      const busy = error?.code === "ERR_SQLITE_ERROR" && /busy|locked/i.test(String(error.message || ""));
      if (!busy || attempt >= BUSY_RETRIES) throw error;
      const until = Date.now() + BUSY_RETRY_DELAY_MS;
      while (Date.now() < until) { /* short synchronous backoff; busy_timeout should normally absorb this */ }
    }
  }
}

function readEntityRow(db, entityId) {
  const row = db.prepare("SELECT * FROM entity WHERE id = ?").get(entityId);
  if (!row) return null;
  let state;
  try {
    state = JSON.parse(row.state_json);
  } catch (error) {
    quarantineRow(db, entityId, `unparseable state_json: ${error.message}`, row.state_json);
    db.prepare("DELETE FROM entity WHERE id = ?").run(entityId);
    throw new CorruptStateError(entityId, error.message);
  }
  return { revision: row.revision, status: row.status, currentStage: row.current_stage, state };
}

function quarantineRow(db, entityId, reason, payloadText, sourcePath = null) {
  db.prepare(
    "INSERT INTO quarantine (entity_id, source_path, reason, payload_text, quarantined_at) VALUES (?, ?, ?, ?, ?)",
  ).run(entityId, sourcePath, reason, payloadText == null ? null : String(payloadText), new Date().toISOString());
}

export { quarantineRow };

// Read-only peek: current revision/state without starting a write
// transaction. Returns null when the entity has never been created.
export function peekEntity(handle, entityId) {
  assertId(entityId);
  return readEntityRow(handle.db, entityId);
}

export function listQuarantine(handle, entityId = null) {
  const rows = entityId
    ? handle.db.prepare("SELECT * FROM quarantine WHERE entity_id = ? ORDER BY seq").all(assertId(entityId))
    : handle.db.prepare("SELECT * FROM quarantine ORDER BY seq").all();
  return rows;
}

// The one write primitive. `mutate(current)` runs INSIDE the SQLite
// transaction and must be synchronous and side-effect-free beyond computing
// its return value — it is the only place caller logic touches state.
//
//   current   — { revision, status, currentStage, state } | null
//   returns   — { nextState, response? } to commit a new revision, or
//               { response } (nextState omitted) to make no change.
//
// commandId is required: every mutation is idempotent. A repeated commandId
// short-circuits to the previously recorded response without calling mutate
// again. expectedRevision is optional optimistic-concurrency: when given, a
// current revision that does not match throws StaleRevisionError instead of
// applying the mutation — for callers (dashboard actions) that read state in
// an earlier, separate step and must not act on data that has since moved.
export function mutateEntity(handle, { entityId, commandId, expectedRevision = null, mutate, now = () => new Date().toISOString() }) {
  assertId(entityId);
  if (!commandId || !String(commandId).trim()) throw new Error("mutateEntity requires a non-empty commandId.");
  const { db } = handle;
  return withRetry(() => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const existingCommand = db.prepare("SELECT response_json FROM commands WHERE command_id = ?").get(commandId);
      if (existingCommand) {
        db.exec("COMMIT");
        return JSON.parse(existingCommand.response_json);
      }
      const current = readEntityRow(db, entityId);
      // The size ceiling is checked here, inside the transaction and before the
      // caller's mutate() runs, so a runaway writer is stopped at the point it
      // would have grown the file again.
      const ceiling = maxStateBytes();
      if (ceiling > 0 && current?.state?.status !== "failed") {
        const bytes = stateStoreBytes(handle.path);
        if (bytes > ceiling) {
          const full = new StateStoreFullError(handle.path, bytes, ceiling);
          // Fail the task rather than only refusing the write. A refused write
          // with a live task just becomes a retry loop against the same full
          // file; a failed task stops, says why, and can be looked at.
          if (current?.state) {
            const at = now();
            const failed = {
              ...current.state,
              status: "failed",
              blocker: {
                stage: current.state.currentStage || null,
                outcome: "fail",
                actor: "system",
                summary: full.message,
                at,
              },
              events: [
                ...(current.state.events || []),
                { at, type: "state-store-full", stage: current.state.currentStage || null, actor: "system", path: handle.path, bytes, ceiling },
              ],
              updatedAt: at,
            };
            upsertEntity(db, entityId, (current.revision ?? 0) + 1, failed, current.state.createdAt || at, at);
            db.exec("COMMIT");
          } else {
            db.exec("ROLLBACK");
          }
          console.error(`[state-store-full] ${entityId}: ${full.message}`);
          throw full;
        }
      }
      if (expectedRevision != null) {
        const actual = current?.revision ?? 0;
        if (actual !== expectedRevision) throw new StaleRevisionError(entityId, expectedRevision, actual);
      }
      const result = mutate(current);
      const response = result && "response" in result ? result.response : (result?.nextState ?? current?.state ?? null);
      if (!result || result.nextState === undefined) {
        recordCommand(db, commandId, entityId, response, now());
        db.exec("COMMIT");
        return response;
      }
      const nextState = result.nextState;
      const nextRevision = (current?.revision ?? 0) + 1;
      const at = now();
      upsertEntity(db, entityId, nextRevision, nextState, current ? current.state.createdAt || at : at, at);
      db.prepare("INSERT INTO state_revisions (entity_id, revision, command_id, at) VALUES (?, ?, ?, ?)")
        .run(entityId, nextRevision, commandId, at);
      projectEvents(db, entityId, nextRevision, current?.state?.events || [], nextState.events || []);
      projectStages(db, entityId, nextState.stages || {});
      projectDispatches(db, entityId, current?.state?.dispatches || [], nextState.dispatches || []);
      projectRecoveryAttempts(db, entityId, current?.state?.recovery?.attempts || [], nextState.recovery?.attempts || []);
      recordCommand(db, commandId, entityId, response, at);
      db.exec("COMMIT");
      return response;
    } catch (error) {
      // A corrupt row was already quarantined (and deleted from `entity`)
      // inside this same transaction by readEntityRow(); COMMIT to keep that
      // cleanup rather than rolling it back away. Every other failure (a
      // stale revision, or the caller's mutate() throwing) happened before
      // any write, so ROLLBACK is a safe no-op.
      // StateStoreFullError already settled its own transaction above (COMMIT to
      // keep the failed marker, or ROLLBACK when there was nothing to mark).
      if (!(error instanceof StateStoreFullError)) {
        try { db.exec(error instanceof CorruptStateError ? "COMMIT" : "ROLLBACK"); } catch { /* best effort */ }
      }
      throw error;
    }
  });
}

function recordCommand(db, commandId, entityId, response, at) {
  db.prepare("INSERT INTO commands (command_id, entity_id, applied_at, response_json) VALUES (?, ?, ?, ?)")
    .run(commandId, entityId, at, JSON.stringify(response ?? null));
}

function upsertEntity(db, entityId, revision, state, createdAt, updatedAt) {
  db.prepare(`
    INSERT INTO entity (id, revision, status, current_stage, state_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      revision = excluded.revision,
      status = excluded.status,
      current_stage = excluded.current_stage,
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
  `).run(entityId, revision, state.status ?? null, state.currentStage ?? null, JSON.stringify(state), createdAt, updatedAt);
}

function projectEvents(db, entityId, revision, oldEvents, newEvents) {
  if (newEvents.length <= oldEvents.length) return;
  const stmt = db.prepare("INSERT INTO events (entity_id, revision, at, type, payload_json) VALUES (?, ?, ?, ?, ?)");
  for (let i = oldEvents.length; i < newEvents.length; i++) {
    const event = newEvents[i];
    stmt.run(entityId, revision, event?.at || new Date().toISOString(), event?.type || "event", JSON.stringify(event ?? {}));
  }
}

function projectStages(db, entityId, stages) {
  const stmt = db.prepare(`
    INSERT INTO stages (entity_id, stage, status, actor, summary, evidence_json, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entity_id, stage) DO UPDATE SET
      status = excluded.status, actor = excluded.actor, summary = excluded.summary,
      evidence_json = excluded.evidence_json, completed_at = excluded.completed_at
  `);
  for (const [stage, result] of Object.entries(stages)) {
    stmt.run(entityId, stage, result?.status ?? null, result?.actor ?? null, result?.summary ?? null,
      JSON.stringify(result?.evidence ?? []), result?.completedAt ?? null);
  }
}

function projectDispatches(db, entityId, oldDispatches, newDispatches) {
  const stmt = db.prepare(`
    INSERT INTO dispatches (entity_id, dispatch_id, stage, attempt, kind, actor, status, outcome, created_at, completed_at, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let i = oldDispatches.length; i < newDispatches.length; i++) {
    const d = newDispatches[i];
    stmt.run(entityId, d?.id ?? null, d?.stage ?? null, d?.attempt ?? null, d?.kind ?? null, d?.actor ?? null,
      d?.status ?? null, d?.outcome ?? null, d?.createdAt ?? null, d?.completedAt ?? null, d?.summary ?? null);
  }
}

function projectRecoveryAttempts(db, entityId, oldAttempts, newAttempts) {
  const insert = db.prepare(`
    INSERT INTO recovery_attempts (entity_id, attempt_number, strategy, failed_stage, classification, status, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let i = oldAttempts.length; i < newAttempts.length; i++) {
    const a = newAttempts[i];
    insert.run(entityId, a?.number ?? null, a?.strategy ?? null, a?.failedStage ?? null, a?.classification ?? null,
      a?.status ?? null, a?.startedAt ?? null, a?.completedAt ?? null);
  }
  // The last existing attempt's status/completedAt can change in place
  // (diagnosing -> verified/failed) without a new array entry.
  if (oldAttempts.length && newAttempts.length >= oldAttempts.length) {
    const idx = oldAttempts.length - 1;
    const a = newAttempts[idx];
    if (a) {
      db.prepare(`
        UPDATE recovery_attempts SET status = ?, completed_at = ?
        WHERE entity_id = ? AND attempt_number = ?
      `).run(a?.status ?? null, a?.completedAt ?? null, entityId, a?.number ?? idx + 1);
    }
  }
}

// Import an existing plain-JSON legacy state as the entity's initial
// revision, iff no row exists yet. Idempotent: a second call is a no-op and
// returns the existing (already-imported) row. Used both by the standalone
// migration tool and by transactional-json.mjs's on-first-touch auto-import.
export function importLegacyState(handle, { entityId, state, sourcePath = null, now = () => new Date().toISOString() }) {
  assertId(entityId);
  const { db } = handle;
  return withRetry(() => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = readEntityRow(db, entityId);
      if (existing) { db.exec("COMMIT"); return { imported: false, revision: existing.revision }; }
      const at = now();
      const commandId = `import:${entityId}`;
      upsertEntity(db, entityId, 1, state, state?.createdAt || at, state?.updatedAt || at);
      db.prepare("INSERT INTO state_revisions (entity_id, revision, command_id, at) VALUES (?, ?, ?, ?)")
        .run(entityId, 1, commandId, at);
      projectEvents(db, entityId, 1, [], state.events || []);
      projectStages(db, entityId, state.stages || {});
      projectDispatches(db, entityId, [], state.dispatches || []);
      projectRecoveryAttempts(db, entityId, [], state.recovery?.attempts || []);
      recordCommand(db, commandId, entityId, { imported: true, revision: 1 }, at);
      db.exec("COMMIT");
      return { imported: true, revision: 1 };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* transaction may already be gone */ }
      if (error instanceof CorruptStateError) {
        quarantineRow(db, entityId, `legacy import failed: ${error.message}`, JSON.stringify(state), sourcePath);
      }
      throw error;
    }
  });
}
