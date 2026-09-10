// Worker-thread fixture for concurrency.test.mjs: simulates one of two
// concurrent callers "ingesting the same dispatch result" — same
// idempotency key, same effect — from its own connection.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { mutateEntity } from "../../../lib/store/sqlite-state.mjs";

const { dbPath } = workerData;
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 10000");
const handle = { db, path: dbPath };

const response = mutateEntity(handle, {
  entityId: "dispatch-1",
  commandId: "ingest:result-42",
  mutate: (current) => ({ nextState: { ingested: current.state.ingested + 1 } }),
});
db.close();
parentPort.postMessage({ ok: true, response });
