#!/usr/bin/env node
// Bulk, idempotent migration of existing task/objective JSON state into the
// transactional SQLite authority (factory/lib/store/). This is an
// operational convenience, not a required step: any code path that calls
// readState()/readObjState()/writeState() already lazily imports a legacy
// file on first touch (see factory/lib/store/transactional-json.mjs). Run
// this up front to pre-warm every file at once and get one consolidated
// report, e.g. before a release or after restoring a backup.
//
//   node scripts/migrate-factory-state.mjs --state-root dashboard/backend/data/factory [--dry-run]
//
// Exit code is 0 iff nothing was quarantined. A quarantined file's original
// JSON is never modified or deleted — see sqlite-state.mjs's quarantine
// table for the recorded reason and excerpt.
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readTransactionalState } from "../factory/lib/store/transactional-json.mjs";
import { CorruptStateError } from "../factory/lib/store/sqlite-state.mjs";

const STATE_FILE_NAMES = new Set(["state.json", "objective-state.json"]);

export function findLegacyStateFiles(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (!entry.name.startsWith(".")) walk(path); }
      else if (STATE_FILE_NAMES.has(entry.name)) found.push(path);
    }
  };
  walk(resolve(root));
  return found.sort();
}

// Pure, injectable core: given a list of file paths and a reader, classify
// each into imported / already-current / quarantined without doing any I/O
// itself beyond calling `readState`. Kept separate from the CLI's argv
// parsing and process.exit so it is unit-testable.
export function migrateFiles(files, { readState = readTransactionalState } = {}) {
  const report = { imported: [], alreadyCurrent: [], quarantined: [] };
  for (const path of files) {
    let before;
    try { before = statSync(`${path.replace(/\.json$/, "")}.sqlite`); } catch { /* no db yet */ }
    try {
      readState(path);
      // A pre-existing db file (from an earlier run, or from ordinary
      // production traffic that already touched this task) means this
      // legacy file was already imported; a first-ever import created the
      // db just now, in this call.
      report[before ? "alreadyCurrent" : "imported"].push(path);
    } catch (error) {
      if (error instanceof CorruptStateError) {
        report.quarantined.push({ path, reason: error.message });
      } else {
        throw error; // an unexpected, non-corruption failure must not be swallowed
      }
    }
  }
  return report;
}

function printReport(report, { dryRun }) {
  const verb = dryRun ? "would import" : "imported";
  console.log(`${verb}: ${report.imported.length}`);
  console.log(`already current: ${report.alreadyCurrent.length}`);
  console.log(`quarantined: ${report.quarantined.length}`);
  for (const item of report.quarantined) console.log(`  ✗ ${item.path}\n    ${item.reason}`);
}

async function main() {
  const args = process.argv.slice(2);
  const stateRootIdx = args.indexOf("--state-root");
  const stateRoot = stateRootIdx >= 0 ? args[stateRootIdx + 1] : "dashboard/backend/data/factory";
  const dryRun = args.includes("--dry-run");
  const files = findLegacyStateFiles(stateRoot);
  console.log(`found ${files.length} legacy state file(s) under ${resolve(stateRoot)}`);
  if (dryRun) {
    // A dry run must not create any db file at all, so it cannot use the
    // real reader (which imports as a side effect of reading). Report
    // findings only.
    console.log(`would import: ${files.length}`);
    console.log("already current: 0 (dry run does not distinguish; nothing is imported)");
    console.log("quarantined: 0 (dry run does not parse files)");
    return;
  }
  const report = migrateFiles(files);
  printReport(report, { dryRun });
  if (report.quarantined.length) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}
