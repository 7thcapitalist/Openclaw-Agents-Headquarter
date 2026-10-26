#!/usr/bin/env node
// node factory/ops/inbox-executor-status.mjs --status [--ledger <runs.jsonl>]
import { join } from "node:path";
import { formatSummary, summarizeLedger } from "../lib/hq/inbox-executor.mjs";

const args = process.argv.slice(2);
if (!args.includes("--status")) { console.error("uso: inbox-executor-status.mjs --status [--ledger <runs.jsonl>]"); process.exit(2); }
const i = args.indexOf("--ledger");
const ledger = i >= 0 ? args[i + 1] : join(process.env.HOLDING_HQ || "C:/Users/joaov/dev/holding-hq", "studios/software/ledger/runs.jsonl");
console.log(formatSummary(summarizeLedger(ledger)));
