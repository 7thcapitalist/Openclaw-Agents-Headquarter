import session from "express-session";

const SQLiteStoreBase = session.Store;

export class SQLiteSessionStore extends SQLiteStoreBase {
  /**
   * @param {import("better-sqlite3").Database} db
   */
  constructor(db) {
    super();
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dashboard_sessions (
        sid TEXT PRIMARY KEY,
        sess_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_expires
        ON dashboard_sessions(expires_at);
    `);
  }

  get(sid, cb) {
    try {
      const row = this.db
        .prepare("SELECT sess_json, expires_at FROM dashboard_sessions WHERE sid = ?")
        .get(sid);
      if (!row) return cb(null, null);
      if (row.expires_at <= Date.now()) {
        this.destroy(sid, () => cb(null, null));
        return;
      }
      cb(null, JSON.parse(row.sess_json));
    } catch (e) {
      cb(e);
    }
  }

  set(sid, sess, cb = () => {}) {
    try {
      const expires = sessionExpiryMs(sess);
      this.db
        .prepare(
          `INSERT INTO dashboard_sessions (sid, sess_json, expires_at)
           VALUES (?, ?, ?)
           ON CONFLICT(sid) DO UPDATE SET
             sess_json = excluded.sess_json,
             expires_at = excluded.expires_at`
        )
        .run(sid, JSON.stringify(sess), expires);
      cb(null);
    } catch (e) {
      cb(e);
    }
  }

  destroy(sid, cb = () => {}) {
    try {
      this.db.prepare("DELETE FROM dashboard_sessions WHERE sid = ?").run(sid);
      cb(null);
    } catch (e) {
      cb(e);
    }
  }

  touch(sid, sess, cb = () => {}) {
    try {
      this.db
        .prepare("UPDATE dashboard_sessions SET expires_at = ? WHERE sid = ?")
        .run(sessionExpiryMs(sess), sid);
      cb(null);
    } catch (e) {
      cb(e);
    }
  }

  pruneExpired() {
    this.db.prepare("DELETE FROM dashboard_sessions WHERE expires_at <= ?").run(Date.now());
  }
}

function sessionExpiryMs(sess) {
  const exp = sess?.cookie?.expires;
  const parsed = exp ? Date.parse(exp) : NaN;
  if (Number.isFinite(parsed)) return parsed;
  const maxAge = Number(sess?.cookie?.originalMaxAge || sess?.cookie?.maxAge);
  if (Number.isFinite(maxAge) && maxAge > 0) return Date.now() + maxAge;
  return Date.now() + 7 * 24 * 60 * 60 * 1000;
}
