// Worker-thread fixture for concurrency.test.mjs: opens its own connection to
// the given db file and applies exactly one optimistic-concurrency increment
// to entity "counter", retrying on StaleRevisionError like a real caller
// would. Reports back via workerData/parentPort so the test can run many of
// these truly concurrently (separate threads, separate DatabaseSync handles,
// same underlying file).
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { StaleRevisionError, mutateEntity } from "../../../lib/store/sqlite-state.mjs";

const { dbPath, workerId } = workerData;
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 10000");
const handle = { db, path: dbPath };

let done = false;
for (let attempt = 0; attempt < 100 && !done; attempt++) {
  const before = db.prepare("SELECT revision, state_json FROM entity WHERE id = 'counter'").get();
  const revision = before.revision;
  const count = JSON.parse(before.state_json).count;
  try {
    mutateEntity(handle, {
      entityId: "counter",
      commandId: `increment-worker-${workerId}`,
      expectedRevision: revision,
      mutate: () => ({ nextState: { count: count + 1 } }),
    });
    done = true;
  } catch (error) {
    if (!(error instanceof StaleRevisionError)) { db.close(); parentPort.postMessage({ ok: false, error: String(error.message || error) }); process.exit(0); }
  }
}
db.close();
parentPort.postMessage({ ok: done, error: done ? null : "exhausted retries" });
