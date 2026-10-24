import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { processInbox } from "../lib/hq/inbox-executor.mjs";

const REQ = "repo: 7thcapitalist/x\nbase: main\nobjetivo: Fazer   a coisa\npronto quando: testes\n";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "inbox-"));
  const inboxDir = join(root, "inbox"), doneDir = join(root, "done");
  mkdirSync(inboxDir);
  return { inboxDir, doneDir, ledgerPath: join(root, "runs.jsonl") };
}

test("running twice over the same request yields one branch and one ledger line", async () => {
  const env = setup();
  const branches = [];
  const dispatch = async (_r, { branch }) => { branches.push(branch); };
  writeFileSync(join(env.inboxDir, "a.md"), REQ);
  const first = await processInbox({ ...env, dispatch });
  assert.equal(first[0].status, "processed");
  assert.ok(existsSync(join(env.doneDir, "a.md")));
  // same request re-dropped, under another name and with different spacing/case
  writeFileSync(join(env.inboxDir, "b.md"), REQ.replace("Fazer   a", "fazer a"));
  const second = await processInbox({ ...env, dispatch });
  assert.equal(second[0].status, "skipped-duplicate");
  assert.equal(branches.length, 1);
  assert.equal(readFileSync(env.ledgerPath, "utf8").trim().split("\n").length, 1);
  assert.equal(existsSync(join(env.inboxDir, "b.md")), false);
});

test("dedupes via done/ alone when the ledger is gone", async () => {
  const env = setup();
  mkdirSync(env.doneDir);
  writeFileSync(join(env.doneDir, "a.md"), REQ);
  writeFileSync(join(env.inboxDir, "a.md"), REQ);
  let calls = 0;
  const r = await processInbox({ ...env, dispatch: async () => { calls++; } });
  assert.equal(r[0].status, "skipped-duplicate");
  assert.equal(calls, 0);
});

test("a different objective is still processed", async () => {
  const env = setup();
  writeFileSync(join(env.inboxDir, "a.md"), REQ);
  writeFileSync(join(env.inboxDir, "c.md"), REQ.replace("coisa", "outra"));
  const r = await processInbox({ ...env, dispatch: async () => {} });
  assert.deepEqual(r.map((x) => x.status), ["processed", "processed"]);
  assert.notEqual(r[0].branch, r[1].branch);
});

test("interrupted request resumes running only the pending tasks", async () => {
  const env = setup();
  const multi = REQ + "tarefas:\n- um\n- dois\n- tres\n";
  writeFileSync(join(env.inboxDir, "m.md"), multi);
  const ran = [];
  const first = await processInbox({ ...env, dispatch: async (_r, { task }) => { if (task === "dois") throw new Error("boom"); ran.push(task); } });
  assert.equal(first[0].status, "interrupted");
  assert.deepEqual(ran, ["um"]);
  assert.ok(existsSync(join(env.inboxDir, "m.md")));
  const second = await processInbox({ ...env, dispatch: async (_r, { task }) => { ran.push(task); } });
  assert.equal(second[0].status, "processed");
  assert.deepEqual(ran, ["um", "dois", "tres"]);
  assert.ok(existsSync(join(env.doneDir, "m.md")));
  const lines = readFileSync(env.ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.filter((l) => l.task && l.status !== "failed").map((l) => l.task), ["um", "dois", "tres"]);
  assert.equal(lines.filter((l) => !l.task).length, 1);
});

test("failed task writes failure_reason (1 line) and last_log_tail (20 lines) to the ledger and is retried", async () => {
  const env = setup();
  writeFileSync(join(env.inboxDir, "f.md"), REQ + "tarefas:\n- um\n- dois\n");
  const log = Array.from({ length: 30 }, (_, i) => `linha ${i + 1}`).join("\n");
  const boom = Object.assign(new Error("npm test saiu com codigo 1\ndetalhe extra"), { log });
  const r = await processInbox({ ...env, dispatch: async (_r, { task }) => { if (task === "dois") throw boom; } });
  assert.equal(r[0].status, "interrupted");
  const fail = readFileSync(env.ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((l) => l.status === "failed");
  assert.equal(fail.task, "dois");
  assert.equal(fail.failure_reason, "npm test saiu com codigo 1");
  const tail = fail.last_log_tail.split("\n");
  assert.equal(tail.length, 20);
  assert.equal(tail[0], "linha 11");
  assert.equal(tail[19], "linha 30");
  // failure entry must not count as done: retry runs "dois" again
  const ran = [];
  const again = await processInbox({ ...env, dispatch: async (_r, { task }) => { ran.push(task); } });
  assert.deepEqual(ran, ["dois"]);
  assert.equal(again[0].status, "processed");
});

test("failed request without tarefas is recorded as failed and stays in inbox for retry", async () => {
  const env = setup();
  writeFileSync(join(env.inboxDir, "g.md"), REQ);
  const r = await processInbox({ ...env, dispatch: async () => { throw new Error("sem rede"); } });
  assert.equal(r[0].status, "failed");
  assert.ok(existsSync(join(env.inboxDir, "g.md")));
  const e = JSON.parse(readFileSync(env.ledgerPath, "utf8").trim());
  assert.equal(e.failure_reason, "sem rede");
  const retry = await processInbox({ ...env, dispatch: async () => {} });
  assert.equal(retry[0].status, "processed");
});
