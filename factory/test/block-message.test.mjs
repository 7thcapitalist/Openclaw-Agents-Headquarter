import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { processInbox } from "../lib/hq/inbox-executor.mjs";
import { blockMessage, failuresFor } from "../lib/hq/block-message.mjs";

const REQ = "repo: 7thcapitalist/x\nobjetivo: Migrar o login\n";

test("falhou 2x -> mensagem de bloqueio com o que tentou e a pergunta exata", async () => {
  const root = mkdtempSync(join(tmpdir(), "block-"));
  const inboxDir = join(root, "inbox"), doneDir = join(root, "done"), ledgerPath = join(root, "runs.jsonl");
  mkdirSync(inboxDir);
  writeFileSync(join(inboxDir, "a.md"), REQ);
  const erros = ["codex: testes de auth falham (token expirado)", "claude: mesmo erro no teste de auth"];
  let n = 0;
  const dispatch = async () => { throw new Error(erros[n++]); };

  for (let i = 0; i < 2; i++) {
    const [r] = await processInbox({ inboxDir, doneDir, ledgerPath, dispatch });
    assert.equal(r.status, i === 0 ? "failed" : "blocked");
  }
  const falhas = failuresFor(readFileSync(ledgerPath, "utf8").split("\n"), (await processInboxKey(inboxDir)));
  assert.equal(falhas.length, 2);

  const msg = blockMessage({
    tarefa: "Migrar o login",
    tentativas: falhas.map((f) => f.failure_reason),
    travouEm: "teste de auth, token de sessão expirado nas duas tentativas",
    pergunta: "Posso regenerar o token de teste do ambiente staging?",
  });
  assert.equal(msg, [
    "Bloqueada: Migrar o login",
    "O que tentei:",
    "1. codex: testes de auth falham (token expirado)",
    "2. claude: mesmo erro no teste de auth",
    "Onde travou: teste de auth, token de sessão expirado nas duas tentativas",
    "Pergunta: Posso regenerar o token de teste do ambiente staging?",
  ].join("\n"));
});

test("sem pergunta exata não existe bloqueio", () => {
  assert.throws(() => blockMessage({ tarefa: "x", tentativas: ["a"], travouEm: "y", pergunta: "me ajuda" }), /pergunta exata/);
  assert.throws(() => blockMessage({ tarefa: "x", tentativas: [], travouEm: "y", pergunta: "Posso?" }), /tentado/);
});

async function processInboxKey(inboxDir) {
  const { parseRequest, requestKey } = await import("../lib/hq/inbox-executor.mjs");
  return requestKey(parseRequest(readFileSync(join(inboxDir, "a.md"), "utf8")));
}
