import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { join } from "path";

/**
 * @param {string} dataDir
 */
export function openDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "db.sqlite");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      agent_key TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT,
      description TEXT,
      type TEXT,
      status TEXT,
      schedule TEXT,
      entrypoint TEXT,
      working_directory TEXT,
      tools_json TEXT,
      requires_approval_json TEXT,
      logs_path TEXT,
      outputs_path TEXT,
      created_at TEXT,
      owner TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_key TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      summary TEXT,
      output_file TEXT,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_key TEXT NOT NULL,
      event_type TEXT NOT NULL,
      message TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_runs_agent ON agent_runs(agent_key);
    CREATE INDEX IF NOT EXISTS idx_events_agent ON agent_events(agent_key);
  `);
  migrateAgentRunsSchema(db);
  return db;
}

/**
 * Older dashboard DBs may lack columns added later; ALTER if missing.
 * @param {import("better-sqlite3").Database} db
 */
function migrateAgentRunsSchema(db) {
  try {
    const cols = db.prepare("PRAGMA table_info(agent_runs)").all();
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("summary")) {
      db.exec("ALTER TABLE agent_runs ADD COLUMN summary TEXT");
    }
    if (!names.has("output_file")) {
      db.exec("ALTER TABLE agent_runs ADD COLUMN output_file TEXT");
    }
    if (!names.has("error_message")) {
      db.exec("ALTER TABLE agent_runs ADD COLUMN error_message TEXT");
    }
    if (!names.has("artifacts_json")) {
      db.exec("ALTER TABLE agent_runs ADD COLUMN artifacts_json TEXT");
    }
  } catch (e) {
    console.warn("[agent-lab] agent_runs migration:", e.message || e);
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} agentKey
 * @param {string} type
 * @param {string} message
 */
export function logEvent(db, agentKey, type, message) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_events (agent_key, event_type, message, created_at) VALUES (?, ?, ?, ?)`
  ).run(agentKey, type, message, now);
}
