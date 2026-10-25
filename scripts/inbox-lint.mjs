#!/usr/bin/env node
// Valida um pedido do inbox (repo/base/objetivo/pronto quando) antes do executor,
// para que pedido malformado não custe quota. Uso: node scripts/inbox-lint.mjs <arquivo>
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_FIELDS = [
  { key: 'repo', label: 'repo' },
  { key: 'base', label: 'base' },
  { key: 'objetivo', label: 'objetivo' },
  { key: 'pronto quando', label: 'pronto quando' },
];

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Aceita "Campo: valor", "- Campo: valor", "**Campo:** valor" e "## Campo" + linhas seguintes.
export function parseFields(text) {
  const names = REQUIRED_FIELDS.map((f) => f.key);
  const found = {};
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*]\s+|#{1,6}\s+)?/, '').replace(/\*\*|__/g, '');
    const m = line.match(/^([^:]+?)\s*:\s*(.*)$/);
    const head = norm(m ? m[1] : line);
    if (names.includes(head) && (m || /^\s*#{1,6}\s/.test(raw))) {
      current = head;
      found[current] = (m ? m[2] : '').trim();
    } else if (current && raw.trim()) {
      found[current] = `${found[current]} ${raw.trim()}`.trim();
    } else if (!raw.trim()) {
      // linha em branco não encerra o campo (valor pode vir em parágrafo seguinte)
    }
  }
  return found;
}

export function lintInbox(text) {
  const found = parseFields(text);
  const errors = [];
  for (const { key, label } of REQUIRED_FIELDS) {
    if (!(key in found)) errors.push(`campo obrigatório ausente: "${label}"`);
    else if (!found[key]) errors.push(`campo obrigatório vazio: "${label}"`);
  }
  return { ok: errors.length === 0, errors };
}

// Lista os arquivos .md de um diretório do inbox (ou o próprio arquivo, se for arquivo).
export function lintPath(path) {
  const files = statSync(path).isDirectory()
    ? readdirSync(path).filter((n) => n.endsWith(".md")).sort().map((n) => join(path, n))
    : [path];
  return files.map((file) => ({ file, ...lintInbox(readFileSync(file, "utf8")) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2];
  if (!target) {
    console.error("uso: node scripts/inbox-lint.mjs <arquivo|pasta-do-inbox>");
    process.exit(2);
  }
  let results;
  try {
    results = lintPath(target);
  } catch (e) {
    console.error(`não consegui ler ${target}: ${e.message}`);
    process.exit(2);
  }
  let bad = 0;
  for (const r of results) {
    if (r.ok) console.log(`OK: ${r.file}`);
    else {
      bad++;
      for (const e of r.errors) console.error(`ERRO ${r.file}: ${e}`);
    }
  }
  if (!results.length) console.log(`nenhum pedido em ${target}`);
  process.exit(bad ? 1 : 0);
}
