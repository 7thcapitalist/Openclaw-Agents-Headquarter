import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintInbox } from '../../scripts/inbox-lint.mjs';

const OK = `Repo: org/projeto
Base: main
Objetivo: criar o script X
Pronto quando: node --test passa
`;

test('pedido completo passa', () => {
  assert.deepEqual(lintInbox(OK), { ok: true, errors: [] });
});

test('campo faltando gera erro claro por campo', () => {
  const r = lintInbox('Repo: a/b\nBase: main\nObjetivo: algo\n');
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['campo obrigatório ausente: "pronto quando"']);
});

test('campo vazio gera erro e CLI sai com 1', () => {
  const txt = OK.replace('Base: main', 'Base:   ');
  const r = lintInbox(txt);
  assert.deepEqual(r.errors, ['campo obrigatório vazio: "base"']);
  const f = join(mkdtempSync(join(tmpdir(), 'lint-')), 'p.md');
  writeFileSync(f, txt);
  const cli = spawnSync(process.execPath, ['scripts/inbox-lint.mjs', f], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /vazio: "base"/);
});
