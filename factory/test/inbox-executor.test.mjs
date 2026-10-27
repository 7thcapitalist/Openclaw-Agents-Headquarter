import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { processInbox, ledgerStatus, formatStatus } from "../lib/hq/inbox-executor.mjs";

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
test("request with empty repo, missing field or nonexistent base is rejected up front, naming the field", async () => {
  const env = setup();
  let calls = 0;
  const dispatch = async () => { calls++; };
  const check = async (r) => (r.base === "nao-existe" ? `base "${r.base}" inexistente em ${r.repo}` : null);
  const files = {
    "repo-vazio.md": "repo:\nobjetivo: A\n",
    "sem-objetivo.md": "repo: 7thcapitalist/x\n",
    "base-vazia.md": "repo: 7thcapitalist/x\nbase:\nobjetivo: C\n",
    "base-ruim.md": "repo: 7thcapitalist/x\nbase: nao-existe\nobjetivo: D\n",
  };
  for (const [f, body] of Object.entries(files)) writeFileSync(join(env.inboxDir, f), body);
  const r = await processInbox({ ...env, dispatch, check });
  assert.deepEqual(r.map((x) => x.status), ["rejeitado", "rejeitado", "rejeitado", "rejeitado"]);
  assert.equal(calls, 0);
  const motivo = (f) => r.find((x) => x.file === f).motivo;
  assert.match(motivo("base-ruim.md"), /base "nao-existe" inexistente/);
  assert.match(motivo("repo-vazio.md"), /campo "repo" vazio/);
  assert.match(motivo("sem-objetivo.md"), /campo "objetivo" ausente/);
  assert.match(motivo("base-vazia.md"), /campo "base" vazio/);
  for (const f of Object.keys(files)) {
    assert.equal(existsSync(join(env.inboxDir, f)), false);
    assert.match(readFileSync(join(env.doneDir, f), "utf8"), /status: rejeitado\nmotivo: pedido rejeitado: /);
  }
  assert.equal(readFileSync(env.ledgerPath, "utf8").trim().split("\n").length, 4);
});

test("production CLI path: real check rejects nonexistent repo/base with no dispatch; valid passes", async () => {
  const { main } = await import("../../scripts/factory-inbox.mjs");
  const env = setup();
  writeFileSync(join(env.inboxDir, "ok.md"), "repo: o/ok\nbase: main\nobjetivo: A\n");
  writeFileSync(join(env.inboxDir, "sem-repo.md"), "repo: o/nada\nobjetivo: B\n");
  writeFileSync(join(env.inboxDir, "sem-base.md"), "repo: o/ok\nbase: fantasma\nobjetivo: C\n");
  const calls = [];
  const run = async (args) => { calls.push(args[1]); return { notFound: args[1] === "repos/o/nada" || args[1].endsWith("/fantasma") }; };
  const r = await main(["--inbox", env.inboxDir, "--done", env.doneDir, "--ledger", env.ledgerPath], { run });
  const st = Object.fromEntries(r.map((x) => [x.file, x]));
  assert.equal(st["ok.md"].status, "valid-pending");
  assert.match(st["sem-repo.md"].motivo, /repo "o\/nada" inexistente/);
  assert.match(st["sem-base.md"].motivo, /base "fantasma" inexistente em o\/ok/);
  assert.ok(existsSync(join(env.inboxDir, "ok.md")));
  assert.ok(existsSync(join(env.doneDir, "sem-repo.md")) && existsSync(join(env.doneDir, "sem-base.md")));
});

test("production CLI path: a transient gh failure leaves the request in inbox/", async () => {
  const { main } = await import("../../scripts/factory-inbox.mjs");
  const env = setup();
  writeFileSync(join(env.inboxDir, "a.md"), REQ);
  await assert.rejects(main(["--inbox", env.inboxDir, "--done", env.doneDir, "--ledger", env.ledgerPath], { run: async () => { throw new Error("rede"); } }), /rede/);
  assert.ok(existsSync(join(env.inboxDir, "a.md")));
});

const ledger = (p) => readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("task that fails once then passes records attempts=2 and --status shows it", async () => {
  const env = setup();
  writeFileSync(join(env.inboxDir, "a.md"), REQ + "tarefas:\n- um\n");
  await processInbox({ ...env, dispatch: async () => { throw new Error("x"); } });
  await processInbox({ ...env, dispatch: async () => ({}) });
  const lines = ledger(env.ledgerPath);
  assert.equal(lines.find((l) => l.task === "um" && l.failure_reason).attempts, 1);
  assert.equal(lines.find((l) => l.task === "um" && !l.failure_reason).attempts, 2);
  const out = formatStatus(ledgerStatus(env.ledgerPath));
  assert.match(out, /attempts/);
  assert.match(out, /\tdone\t2\t/);
});

test("a resumed request runs only pending tasks; each task counts its own attempts", async () => {
  const env = setup();
  writeFileSync(join(env.inboxDir, "a.md"), REQ + "tarefas:\n- um\n- dois\n");
  const calls = [];
  await processInbox({ ...env, dispatch: async (_r, { task }) => { calls.push(task); if (task === "dois") throw new Error("boom"); return {}; } });
  await processInbox({ ...env, dispatch: async (_r, { task }) => { calls.push(task); return {}; } });
  assert.deepEqual(calls, ["um", "dois", "dois"]);
  const lines = ledger(env.ledgerPath);
  assert.equal(lines.find((l) => l.task === "um").attempts, 1);
  assert.equal(lines.filter((l) => l.task === "dois").at(-1).attempts, 2);
});

test("request without tarefas records attempts on its closing line", async () => {
  const env = setup();
  writeFileSync(join(env.inboxDir, "a.md"), REQ);
  await processInbox({ ...env, dispatch: async () => { throw new Error("x"); } });
  await processInbox({ ...env, dispatch: async () => ({ pr: "https://x/pull/1" }) });
  const last = ledger(env.ledgerPath).at(-1);
  assert.equal(last.attempts, 2);
  assert.equal(last.pr, "https://x/pull/1");
});

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
  assert.equal(ledger(env.ledgerPath).length, 1);
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

test("a failed request without tarefas is retried, not skipped as duplicate", async () => {
  const env = setup();
  writeFileSync(join(env.inboxDir, "a.md"), REQ);
  await processInbox({ ...env, dispatch: async () => { throw new Error("x"); } });
  const r = await processInbox({ ...env, dispatch: async () => ({}) });
  assert.equal(r[0].status, "processed");
});
