#!/usr/bin/env node
// Runs under pm2 as hq-state-watchdog. See factory/lib/hq/state-watchdog.mjs.
//
// No entry guard on process.argv[1]: under pm2 that comparison matches nothing
// and the process sits "online" doing nothing (see ecosystem.config.cjs).

import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkStateGrowth,
  DEFAULT_HALT_BYTES,
  DEFAULT_STOP_BYTES,
  readAutoRetryHalt,
  writeAutoRetryHalt,
} from "../factory/lib/hq/state-watchdog.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateRoot = join(ROOT, "dashboard", "backend", "data", "factory");
const intervalMs = Math.max(10_000, Number(process.env.HQ_STATE_WATCHDOG_INTERVAL_MS) || 30_000);
const haltBytes = Number(process.env.HQ_STATE_HALT_BYTES) || DEFAULT_HALT_BYTES;
const stopBytes = Number(process.env.HQ_STATE_STOP_BYTES) || DEFAULT_STOP_BYTES;

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// Best effort: the founder's desktop. The halt file and the log are the record.
function notify(title, body) {
  execFile("notify-send", ["--urgency=critical", title, body], () => {});
}

let stopped = false;

function tick() {
  const { scanned, oversized, action } = checkStateGrowth({ stateRoot, haltBytes, stopBytes });
  if (action === "none") return;

  const worst = oversized[0];
  const summary = `${worst.path} is ${mb(worst.bytes)} (${oversized.length} file(s) over ${mb(haltBytes)}, ${scanned} scanned)`;

  if (!readAutoRetryHalt(stateRoot)) {
    writeAutoRetryHalt(stateRoot, {
      haltedAt: new Date().toISOString(),
      reason: "state file over size threshold",
      oversized,
      resume: "investigate, then delete this file",
    });
    console.error(`[state-watchdog] auto-retry HALTED: ${summary}`);
    notify("HQ: auto-retry halted", summary);
  }

  if (action === "stop" && !stopped) {
    stopped = true;
    console.error(`[state-watchdog] STOPPING hq-dashboard: ${summary}`);
    notify("HQ: dashboard stopped", `Runaway state growth. ${summary}`);
    execFile("pm2", ["stop", "hq-dashboard"], (error) => {
      if (error) console.error(`[state-watchdog] pm2 stop failed: ${error.message}`);
    });
  }
}

console.log(`[state-watchdog] every ${intervalMs / 1000}s; halt auto-retry at ${mb(haltBytes)}, stop dashboard at ${mb(stopBytes)}`);
tick();
setInterval(tick, intervalMs);
