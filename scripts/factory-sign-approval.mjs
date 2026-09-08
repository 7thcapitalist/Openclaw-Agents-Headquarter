#!/usr/bin/env node
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { createFounderApprovalAssertion, readState, verifyEvidence } from "../factory/lib/task-workflow.mjs";

const args = parseArgs(process.argv.slice(2));
try {
  for (const name of ["state", "evidence", "private-key", "output"]) if (!args[name]) throw new Error(`Missing --${name}.`);
  const state = readState(resolve(args.state));
  const [evidence] = verifyEvidence([args.evidence], state.worktree);
  const assertion = createFounderApprovalAssertion(state, {
    evidencePath: resolve(state.worktree, evidence.path),
    privateKey: readFileSync(resolve(args["private-key"]), "utf8"),
  });
  writeFileSync(resolve(args.output), `${JSON.stringify(assertion, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`Signed founder approval: ${resolve(args.output)}`);
} catch (error) {
  console.error(`factory-sign-approval: ${error.message || error}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined) throw new Error("Arguments must be --name value pairs.");
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}
