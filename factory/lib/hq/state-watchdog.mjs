// A size backstop for the factory's state store, and the halt switch it pulls.
//
// On 2026-09-14 the dashboard wrote 447 GB into one task's state.sqlite in five
// and a half hours. The cause (#254, an unbounded events[] rewritten on every
// mutation) is fixed, but a known cause is not a bound: the next loop may come
// from somewhere else. Until the per-task write budget exists (Node 0 of
// FACTORY_GATE_INTEGRITY_2026), this is the bound — and it is what made it
// acceptable to turn HQ_AUTO_RETRY on.
//
// Two thresholds, because they call for different responses:
//   halt  a state file is far beyond anything healthy (steady state is < 6 MB).
//         Stop retrying automatically and tell the founder. Nothing else stops.
//   stop  a state file is growing like the incident did. The writer was the
//         dashboard process itself, so the only real bound is stopping it.
//
// The halt is a file, not an env var, so the dashboard picks it up on its next
// sweep without a restart, and it survives one. Deleting the file resumes.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const HALT_FILE = "AUTO_RETRY_HALTED.json";
export const DEFAULT_HALT_BYTES = 50 * 1024 * 1024;
export const DEFAULT_STOP_BYTES = 500 * 1024 * 1024;

export function autoRetryHaltPath(stateRoot) {
  return join(stateRoot, HALT_FILE);
}

// The halt record, or null. An unreadable file still halts: a switch that
// fails open is the thing this module exists to avoid.
export function readAutoRetryHalt(stateRoot) {
  const path = autoRetryHaltPath(stateRoot);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { reason: "halt file present but unreadable", path };
  }
}

export function writeAutoRetryHalt(stateRoot, record) {
  writeFileSync(autoRetryHaltPath(stateRoot), `${JSON.stringify(record, null, 2)}\n`);
}

// Every SQLite file under the state root, WAL included — a runaway writer can
// grow the WAL long before a checkpoint lands in the main file.
export function listStateFiles(stateRoot) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.sqlite(-wal)?$/.test(entry.name)) {
        try {
          out.push({ path, bytes: statSync(path).size });
        } catch {
          // Removed between readdir and stat; nothing to measure.
        }
      }
    }
  };
  walk(stateRoot);
  return out;
}

export function checkStateGrowth({ stateRoot, haltBytes = DEFAULT_HALT_BYTES, stopBytes = DEFAULT_STOP_BYTES }) {
  const files = listStateFiles(stateRoot);
  const oversized = files.filter((file) => file.bytes >= haltBytes).sort((a, b) => b.bytes - a.bytes);
  const action = oversized.some((file) => file.bytes >= stopBytes) ? "stop" : oversized.length ? "halt" : "none";
  return { scanned: files.length, oversized, action };
}
