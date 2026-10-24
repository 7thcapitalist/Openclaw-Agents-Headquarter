#!/usr/bin/env node
// Manage operator tokens for the dashboard's Bearer principal
// (dashboard/backend/lib/operatorAuth.mjs).
//
//   node scripts/hq-operator-token.mjs create --id dot --out ~/.config/dot/hq-token
//   node scripts/hq-operator-token.mjs revoke --id dot
//   node scripts/hq-operator-token.mjs list
//
// `create` writes the SHA-256 of a fresh token to the operator store
// (~/.config/openclaw-hq/operators.json, or HQ_OPERATOR_STORE) and the raw
// token to --out, both 0600. The raw token is never printed: whoever needs it
// reads the file. Creating a token does not enable anything; the dashboard
// ignores tokens unless HQ_OPERATOR_ENABLED=1.

import { closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertOperatorId,
  createOperator,
  defaultOperatorStorePath,
  generateToken,
  listOperators,
  revokeOperator,
} from "../dashboard/backend/lib/operatorAuth.mjs";

const USAGE = "usage: hq-operator-token.mjs create --id <id> --out <path> | revoke --id <id> | list";

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value.`);
    flags[name] = value;
    i += 1;
  }
  return { command, flags };
}

function expandHome(path) {
  return path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path);
}

// O_EXCL: never overwrite an existing file, which may be another live token.
function writeTokenFile(path, token) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, `${token}\n`);
  } finally {
    closeSync(fd);
  }
}

export function run(argv, { storePath = defaultOperatorStorePath(), out = (value) => console.log(JSON.stringify(value, null, 2)) } = {}) {
  const { command, flags } = parseArgs(argv);
  if (command === "create") {
    const allowed = new Set(["id", "out"]);
    for (const name of Object.keys(flags)) if (!allowed.has(name)) throw new Error(`Unknown flag --${name}. ${USAGE}`);
    if (!flags.id || !flags.out) throw new Error(USAGE);
    const outPath = expandHome(flags.out);
    if (existsSync(outPath)) throw new Error(`${outPath} already exists; choose a new path or remove it first.`);
    assertOperatorId(flags.id);
    // Token file first, then the hash. If the store write fails the file is
    // removed; the reverse order could leave an active hash whose token nobody
    // holds.
    const token = generateToken();
    writeTokenFile(outPath, token);
    let record;
    try {
      ({ record } = createOperator(storePath, { id: flags.id, token }));
    } catch (error) {
      unlinkSync(outPath);
      throw error;
    }
    return out({ created: record, tokenFile: outPath, store: storePath });
  }
  if (command === "revoke") {
    for (const name of Object.keys(flags)) if (name !== "id") throw new Error(`Unknown flag --${name}. ${USAGE}`);
    if (!flags.id) throw new Error(USAGE);
    return out({ revoked: revokeOperator(storePath, flags.id), store: storePath });
  }
  if (command === "list") {
    if (Object.keys(flags).length) throw new Error(USAGE);
    return out({ operators: listOperators(storePath), store: storePath });
  }
  throw new Error(USAGE);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(String(error.message || error));
    process.exit(1);
  }
}
