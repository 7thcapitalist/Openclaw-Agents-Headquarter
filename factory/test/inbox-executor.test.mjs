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

test("ledger records first_pr_tests_passed for green and red first PR", async () => {
  for (const [passed, expected] of [[true, true], [false, false], [undefined, null]]) {
    const env = setup();
    writeFileSync(join(env.inboxDir, "t.md"), REQ);
    await processInbox({ ...env, dispatch: async () => ({ pr: 7, tests_passed: passed }) });
    const e = JSON.parse(readFileSync(env.ledgerPath, "utf8").trim());
    assert.equal(e.first_pr_tests_passed, expected);
  }
});

test("with tarefas, first_pr_tests_passed comes from the first PR, not later ones", async () => {
  const env = setup();
  writeFileSync(join(env.inboxDir, "t.md"), REQ + "tarefas:\n- um\n- dois\n");
  const results = [{ pr: 1, tests_passed: false }, { pr: 2, tests_passed: true }];
  await processInbox({ ...env, dispatch: async () => results.shift() });
  const last = readFileSync(env.ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)).pop();
  assert.equal(last.first_pr_tests_passed, false);
});

const tick = (...steps) => { let t = 0, i = 0; return () => (t += steps[i++ % steps.length]); };
const ledger = (p) => readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("ledger records duration_ms on success (single request)", async () => {
  const env = setup();
  writeFileSync(join(env.inboxDir, "d.md"), REQ);
  // clock reads: runStart=100, final=350
  await processInbox({ ...env, clock: tick(100, 250), dispatch: async () => ({ pr: 1 }) });
  assert.equal(ledger(env.ledgerPath)[0].duration_ms, 250);
});

test("ledger records duration_ms on failure", async () => {
  const env = setup();
  writeFileSync(join(env.inboxDir, "d.md"), REQ);
  await processInbox({ ...env, clock: tick(100, 40), dispatch: async () => { throw new Error("caiu"); } });
  const [e] = ledger(env.ledgerPath);
  assert.equal(e.status, "failed");
  assert.equal(e.duration_ms, 40);
});

test("with tarefas, each task line has its own duration_ms, and so does the failed one", async () => {
  const env = setup();
  writeFileSync(join(env.inboxDir, "d.md"), REQ + "tarefas:\n- um\n- dois\n- tres\n");
  const outs = [{ pr: 1 }, { pr: 2 }];
  // reads: runStart=10, um start=20 end=50, dois start=60 end=100, tres start=110 fail=170
  const reads = [10, 20, 50, 60, 100, 110, 170]; let i = 0;
  await processInbox({ ...env, clock: () => reads[i++], dispatch: async () => { const o = outs.shift(); if (!o) throw new Error("caiu"); return o; } });
  const lines = ledger(env.ledgerPath);
  assert.deepEqual(lines.map((l) => l.duration_ms), [30, 40, 60]);
  assert.equal(lines[2].status, "failed");
});

test("final line carries total_duration_ms = sum of task duration_ms", async () => {
  const env = setup();
  writeFileSync(join(env.inboxDir, "d.md"), REQ + "tarefas:\n- um\n- dois\n");
  // reads: runStart=0, um 10..40, dois 50..90, final=100
  const reads = [0, 10, 40, 50, 90, 100]; let i = 0;
  await processInbox({ ...env, clock: () => reads[i++], dispatch: async () => ({ pr: 1 }) });
  const last = ledger(env.ledgerPath).at(-1);
  assert.equal(last.total_duration_ms, 70);
  assert.equal(last.duration_ms, 100);
});

test("total_duration_ms includes tasks finished before an interruption (resume)", async () => {
  const env = setup();
  writeFileSync(join(env.inboxDir, "d.md"), REQ + "tarefas:\n- um\n- dois\n");
  let n = 0;
  const fail = async () => { if (n++ === 1) throw new Error("caiu"); return { pr: 1 }; };
  const a = [0, 10, 40, 50, 60]; let i = 0;
  await processInbox({ ...env, clock: () => a[i++], dispatch: fail }); // um=30, dois failed=10
  const b = [0, 5, 25, 30]; let j = 0;
  await processInbox({ ...env, clock: () => b[j++], dispatch: fail }); // dois retried=20
  assert.equal(ledger(env.ledgerPath).at(-1).total_duration_ms, 60);
});

test("without tarefas, total_duration_ms equals the run duration", async () => {
  const env = setup();
  writeFileSync(join(env.inboxDir, "d.md"), REQ);
  await processInbox({ ...env, clock: tick(100, 250), dispatch: async () => ({ pr: 1 }) });
  const [e] = ledger(env.ledgerPath);
  assert.equal(e.total_duration_ms, 250);
});
