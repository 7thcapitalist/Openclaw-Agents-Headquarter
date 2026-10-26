#!/usr/bin/env node
import { formatStatus, ledgerStatus } from "../factory/lib/hq/inbox-executor.mjs";

const args = process.argv.slice(2);
if (!args.includes("--status")) { console.error("uso: inbox-status.mjs --status [ledger/runs.jsonl]"); process.exit(2); }
const ledgerPath = args.find((a) => !a.startsWith("--")) || "ledger/runs.jsonl";
console.log(formatStatus(ledgerStatus(ledgerPath)));
