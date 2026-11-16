#!/usr/bin/env node
// Drains an inbox directory. Every request is validated first (fields, then the
// repo and base really existing on GitHub); invalid ones go to done/ as
// "rejeitado" and never reach dispatch.
//
//   node scripts/factory-inbox.mjs --inbox <dir> --done <dir> --ledger <file>
//   node scripts/factory-inbox.mjs ... --dispatch ./meu-dispatch.mjs   (default export: async (req, {key, branch}) => ({ pr }))
//
// Without --dispatch only validation runs: valid requests stay in inbox/.

import { execFile } from "child_process";
import { resolve } from "path";
import { pathToFileURL } from "url";
import { githubCheck, processInbox } from "../factory/lib/hq/inbox-executor.mjs";

// 404 from the GitHub API means "does not exist"; anything else is an error.
export function ghRun(args) {
  return new Promise((ok, fail) => {
    execFile("gh", args, { timeout: 30000 }, (err, _out, stderr) => {
      if (!err) return ok({ notFound: false });
      if (/HTTP 404|Not Found/i.test(String(stderr))) return ok({ notFound: true });
      fail(new Error(`gh ${args.join(" ")}: ${String(stderr || err.message).trim()}`));
    });
  });
}

export async function main(argv, { run = ghRun } = {}) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, "")] = argv[i + 1];
  for (const k of ["inbox", "done", "ledger"]) if (!o[k]) throw new Error(`--${k} obrigatório`);
  const dispatch = o.dispatch ? (await import(pathToFileURL(resolve(o.dispatch)).href)).default : undefined;
  return processInbox({ inboxDir: o.inbox, doneDir: o.done, ledgerPath: o.ledger, dispatch, check: githubCheck(run) });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).then((r) => console.log(JSON.stringify(r, null, 2)), (e) => {
    console.error(`factory-inbox: ${e.message || e}`);
    process.exitCode = 1;
  });
}
