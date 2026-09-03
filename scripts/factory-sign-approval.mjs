#!/usr/bin/env node
import { sign } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { evidenceSha256, founderApprovalPayload, readState, verifyEvidence } from "../factory/lib/task-workflow.mjs";

const args = parseArgs(process.argv.slice(2));
try {
  for (const name of ["state", "evidence", "private-key", "output"]) if (!args[name]) throw new Error(`Missing --${name}.`);
  const state = readState(resolve(args.state));
  if (state.task.risk !== "high" || !state.founderApprovalRequest) throw new Error("Task has no high-risk founder approval request.");
  const [evidence] = verifyEvidence([args.evidence], state.worktree);
  const approvedAt = new Date().toISOString();
  const digest = evidenceSha256(resolve(state.worktree, evidence.path));
  const unsigned = { ...state.founderApprovalRequest, approvedAt, evidenceSha256: digest };
  const signature = sign(null, Buffer.from(founderApprovalPayload(state, unsigned)), readFileSync(resolve(args["private-key"]), "utf8")).toString("base64");
  writeFileSync(resolve(args.output), `${JSON.stringify({ ...unsigned, signature }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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
