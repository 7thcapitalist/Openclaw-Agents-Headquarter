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

test("request with no valid task is moved to done/ as rejeitado with a readable reason", async () => {
  const env = setup();
  let calls = 0;
  const dispatch = async () => { calls++; };
  writeFileSync(join(env.inboxDir, "vazio.md"), "repo: 7thcapitalist/x\nobjetivo: Algo\ntarefas:\n");
  writeFileSync(join(env.inboxDir, "semrepo.md"), "objetivo: Algo\n");
  const r = await processInbox({ ...env, dispatch });
  assert.deepEqual(r.map((x) => x.status), ["rejeitado", "rejeitado"]);
  assert.match(r[0].motivo, /repo/);
  assert.match(r[1].motivo, /sem nenhum item/);
  assert.equal(calls, 0);
  assert.equal(existsSync(join(env.inboxDir, "vazio.md")), false);
  const done = readFileSync(join(env.doneDir, "vazio.md"), "utf8");
  assert.match(done, /status: rejeitado/);
  assert.match(done, /motivo: pedido sem tarefa válida/);
  assert.equal(readFileSync(env.ledgerPath, "utf8").trim().split("\n").length, 2);
});

test("request with 4 tasks is processed, with 5 is rejected into done/ with a clear reason", async () => {
  const env = setup();
  const calls = [];
  const dispatch = async (_r, { task }) => { calls.push(task); };
  const req = (n, obj) => `repo: 7thcapitalist/x\nobjetivo: ${obj}\ntarefas:\n` + Array.from({ length: n }, (_, i) => `- t${i + 1}`).join("\n") + "\n";
  writeFileSync(join(env.inboxDir, "quatro.md"), req(4, "Quatro"));
  writeFileSync(join(env.inboxDir, "cinco.md"), req(5, "Cinco"));
  const r = await processInbox({ ...env, dispatch });
  assert.deepEqual(r.map((x) => x.status), ["rejeitado", "processed"]);
  assert.match(r[0].motivo, /5 tarefas, máximo é 4/);
  assert.deepEqual(calls, ["t1", "t2", "t3", "t4"]);
  assert.equal(existsSync(join(env.inboxDir, "cinco.md")), false);
  const done = readFileSync(join(env.doneDir, "cinco.md"), "utf8");
  assert.match(done, /status: rejeitado/);
  assert.match(done, /motivo: pedido rejeitado: 5 tarefas, máximo é 4/);
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

test("summarizeLedger/formatStatus: 1 ok + 1 falha", async () => {
  const { summarizeLedger, formatStatus } = await import("../lib/hq/inbox-executor.mjs");
  const env = setup();
  writeFileSync(join(env.inboxDir, "a.md"), REQ);
  writeFileSync(join(env.inboxDir, "b.md"), "repo: 7thcapitalist/y\nobjetivo: Outra\npronto quando: x\n");
  await processInbox({ ...env, dispatch: async (r) => { if (r.repo.endsWith("/y")) throw new Error("boom"); return { pr: "https://github.com/o/r/pull/7" }; } });
  const rows = summarizeLedger(env.ledgerPath);
  const ok = rows.find((r) => r.state === "ok"), bad = rows.find((r) => r.state === "failed");
  assert.equal(rows.length, 2);
  assert.equal(ok.pr, "https://github.com/o/r/pull/7");
  assert.equal(ok.attempts, 1);
  assert.match(bad.failure_reason, /boom/);
  assert.equal(bad.attempts, 1);
  const out = formatStatus(rows);
  assert.match(out, /1 ok, 1 falha, 0 pendente/);
  assert.match(out, /pull\/7/);
});
