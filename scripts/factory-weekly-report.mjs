#!/usr/bin/env node
// Usage: node scripts/factory-weekly-report.mjs <inbox-ledger.ndjson>
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readCostEvents } from "../factory/lib/hq/cost-ledger.mjs";
import { loadPricing, priceCostEvents } from "../factory/lib/hq/cost.mjs";
import { readLedger, renderWeeklyReport } from "../factory/lib/hq/weekly-failure-line.mjs";

const hqRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ledgerPath = process.argv[2];
if (!ledgerPath) { console.error("uso: factory-weekly-report.mjs <ledger.ndjson>"); process.exit(1); }
const costPath = join(hqRoot, ".openclaw-factory", "telemetry", "cost-events.ndjson");
const events = priceCostEvents(readCostEvents(costPath), loadPricing(hqRoot)).events;
process.stdout.write(renderWeeklyReport({ ledger: readLedger(ledgerPath), events, now: new Date().toISOString() }));
