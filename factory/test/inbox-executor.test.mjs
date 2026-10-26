import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { processInbox, ledgerStatus, formatStatus } from "../lib/hq/inbox-executor.mjs";

const REQ = "repo: 7thcapitalist/x\nbase: main\nobjetivo: Fazer   a coisa\npronto quando: testes\n";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "inbox-"));
  const inboxDir = join(root, "inbox");
  mkdirSync(inboxDir);
  return { inboxDir, doneDir: join(root, "done"), ledgerPath: join(root, "runs.jsonl") };
}

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
