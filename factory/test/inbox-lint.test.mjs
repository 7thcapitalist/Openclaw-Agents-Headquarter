import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintInbox, lintPath } from '../../scripts/inbox-lint.mjs';

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

test('3 pedidos (ok, malformado, vazio) na pasta: lista campos faltando por arquivo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-dir-'));
  writeFileSync(join(dir, 'a-ok.md'), OK);
  writeFileSync(join(dir, 'b-malformado.md'), 'Repo: a/b\nfaça alguma coisa aí\n');
  writeFileSync(join(dir, 'c-vazio.md'), '');
  const res = Object.fromEntries(lintPath(dir).map((r) => [r.file.split(/[\/]/).pop(), r]));
  assert.equal(res['a-ok.md'].ok, true);
  assert.deepEqual(res['b-malformado.md'].errors, [
    'campo obrigatório ausente: "base"',
    'campo obrigatório ausente: "objetivo"',
    'campo obrigatório ausente: "pronto quando"',
  ]);
  assert.equal(res['c-vazio.md'].errors.length, 4);
  const cli = spawnSync(process.execPath, ['scripts/inbox-lint.mjs', dir], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stdout, /OK: .*a-ok\.md/);
  assert.match(cli.stderr, /ERRO .*b-malformado\.md: campo obrigatório ausente: "base"/);
  assert.match(cli.stderr, /ERRO .*c-vazio\.md: campo obrigatório ausente: "repo"/);
});
