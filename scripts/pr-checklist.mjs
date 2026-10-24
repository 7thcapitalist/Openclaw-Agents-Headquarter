#!/usr/bin/env node
// Usage: node scripts/pr-checklist.mjs [--base origin/main] [--scope glob]... [--no-tests-required]
// Exits 1 when the branch diff has credentials, files outside --scope, or code without tests.
import { execFileSync } from "node:child_process";
import { runChecklist, parseAddedLines } from "../factory/lib/pr-checklist.mjs";

const args = process.argv.slice(2);
let base = "origin/main";
let requireTests = true;
const scope = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--base") base = args[++i];
  else if (args[i] === "--scope") scope.push(args[++i]);
  else if (args[i] === "--no-tests-required") requireTests = false;
}

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const range = `${git("merge-base", base, "HEAD").trim()}..HEAD`;
const files = git("diff", "--name-only", "--diff-filter=ACMR", range).split("\n").filter(Boolean);
const addedLines = parseAddedLines(git("diff", "--unified=0", "--diff-filter=ACMR", range));
const result = runChecklist({ files, addedLines, scope, requireTests });

for (const c of result.checks) {
  console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}${c.skipped ? " (skipped)" : ""}`);
  for (const d of c.details) console.log(`  - ${d}`);
}
process.exit(result.ok ? 0 : 1);
