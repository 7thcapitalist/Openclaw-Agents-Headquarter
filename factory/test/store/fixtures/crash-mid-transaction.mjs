// Child-process fixture for concurrency.test.mjs: opens the given db file,
// starts a real write transaction (BEGIN IMMEDIATE takes the writer lock),
// writes an in-progress value, then exits the process WITHOUT committing —
// modeling a hard kill between "event recorded" and "projection updated",
// since here they would be the same uncommitted transaction.
import { DatabaseSync } from "node:sqlite";

const dbPath = process.argv[2];
const db = new DatabaseSync(dbPath);
db.exec("BEGIN IMMEDIATE");
db.prepare("UPDATE entity SET revision = 999, state_json = ? WHERE id = 'a'").run(JSON.stringify({ v: 999 }));
process.exit(1); // never COMMIT
