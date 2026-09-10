// Concurrency tests that exercise the transactional store from genuinely
// separate OS-level execution contexts (worker threads with their own
// DatabaseSync connection, or a real child process), not just interleaved
// calls within one synchronous test function. node:sqlite's DatabaseSync is
// synchronous, so a single Node process can never actually race itself;
// these tests are the only way to prove WAL + busy_timeout + the
// BEGIN-IMMEDIATE transaction boundary hold up under real concurrent writers.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { closeStateDb, mutateEntity, openStateDb, peekEntity } from "../../lib/store/sqlite-state.mjs";
import { readTransactionalState } from "../../lib/store/transactional-json.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

function dbFile(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return join(root, "entity.sqlite");
}

function runWorker(scriptName, workerData) {
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(new URL(scriptName, `file://${FIXTURES}`), { workerData });
    worker.on("message", (msg) => { worker.terminate(); msg.ok ? resolvePromise(msg.response) : reject(new Error(msg.error)); });
    worker.on("error", reject);
  });
}

test("100 concurrent mutations against one entity: exactly 100 increments land, no lost updates", async () => {
  const path = dbFile("concurrency-100-");
  const handle = openStateDb(path);
  mutateEntity(handle, { entityId: "counter", commandId: "seed", mutate: () => ({ nextState: { count: 0 } }) });

  const WORKERS = 100;
  await Promise.all(
    Array.from({ length: WORKERS }, (_, workerId) => runWorker("increment-worker.mjs", { dbPath: path, workerId })),
  );

  const final = peekEntity(handle, "counter");
  assert.equal(final.state.count, WORKERS, "every one of the 100 concurrent increments must be reflected — a lost update would leave count < 100");
  assert.equal(final.revision, WORKERS + 1, "seed + 100 real mutations = revision 101");
});

test("100 concurrent node completions against one objective-state.json cannot clobber each other (PROBLEM statement's own example)", async () => {
  const root = mkdtempSync(join(tmpdir(), "objective-concurrency-"));
  const objectivePath = join(root, "objective-state.json");
  const NODES = 100;
  const nodes = {};
  for (let i = 0; i < NODES; i++) nodes[`node-${i}`] = { id: `node-${i}`, status: "pending" };
  writeFileSync(objectivePath, JSON.stringify({ objectiveId: "obj-concurrency", nodes, events: [] }));

  await Promise.all(
    Array.from({ length: NODES }, (_, i) => runWorker("objective-patch-worker.mjs", { objectivePath, nodeId: `node-${i}` })),
  );

  const final = readTransactionalState(objectivePath);
  const unsatisfied = Object.values(final.nodes).filter((n) => n.status !== "gate-satisfied");
  assert.deepEqual(unsatisfied, [], "every node's completion must be reflected — a lost update would leave some nodes still 'pending'");
  assert.equal(final.events.filter((e) => e.type === "node-completed").length, NODES, "the append-only event log must record exactly one completion per node, not fewer");
});

test("two workers ingest the same duplicate command concurrently: the effect runs exactly once, both see the same response", async () => {
  const path = dbFile("concurrency-dup-");
  const handle = openStateDb(path);
  mutateEntity(handle, { entityId: "dispatch-1", commandId: "seed", mutate: () => ({ nextState: { ingested: 0 } }) });

  const [a, b] = await Promise.all([
    runWorker("duplicate-ingest-worker.mjs", { dbPath: path }),
    runWorker("duplicate-ingest-worker.mjs", { dbPath: path }),
  ]);
  assert.deepEqual(a, b, "both callers of the same duplicate command must observe the identical outcome");
  assert.equal(peekEntity(handle, "dispatch-1").state.ingested, 1, "the effect ran exactly once despite two concurrent callers");
});

test("a process killed mid-transaction leaves the last committed state exactly as it was", () => {
  const path = dbFile("concurrency-crash-");
  const handle = openStateDb(path);
  mutateEntity(handle, { entityId: "a", commandId: "seed", mutate: () => ({ nextState: { v: 1 } }) });
  closeStateDb(path); // release our handle so the child process can take the writer lock

  try {
    execFileSync(process.execPath, [join(FIXTURES, "crash-mid-transaction.mjs"), path], { stdio: "pipe" });
    assert.fail("the child process is expected to exit non-zero (it never commits)");
  } catch (error) {
    assert.notEqual(error.status, 0);
  }

  const reopened = openStateDb(path);
  const after = peekEntity(reopened, "a");
  assert.equal(after.revision, 1, "the uncommitted write must not be visible");
  assert.equal(after.state.v, 1, "state is exactly what was last committed, never the torn/partial write");

  // The store must still be fully usable afterwards — a stale writer lock
  // from the killed process must not permanently wedge the file.
  mutateEntity(reopened, { entityId: "a", commandId: "after-crash", mutate: (current) => ({ nextState: { v: current.state.v + 1 } }) });
  assert.equal(peekEntity(reopened, "a").state.v, 2);
});
