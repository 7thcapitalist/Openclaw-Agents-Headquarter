#!/usr/bin/env node
// Session hygiene for the factory. `openclaw sessions --all-agents` accumulates
// dozens of one-shot factory-dispatch and probe sessions plus stale spawn-child
// sessions; several carry 60-70% context. This deletes the safe-to-drop ones and
// runs the built-in store cleanup.
//
//   node scripts/prune-factory-sessions.mjs              # dry run — list only
//   node scripts/prune-factory-sessions.mjs --apply      # actually delete
//   node scripts/prune-factory-sessions.mjs --apply --max-age-hours 12
//
// Never touches `agent:main:main` (the live system session). Only removes
// sessions whose key looks like a transient factory dispatch or a probe/test.

import { execFileSync } from "child_process";

const APPLY = process.argv.includes("--apply");
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const MAX_AGE_HOURS = Number(arg("--max-age-hours", "24"));
const MAX_AGE_MS = MAX_AGE_HOURS * 3600 * 1000;

// Keys matching any of these (case-insensitive substring) are transient and safe
// to remove once older than MAX_AGE_HOURS.
const TRANSIENT = [":factory-", ":probe-", ":acp-probe-", ":route-check-", ":wire-check-", ":copilot-", ":sbtest", ":smoke-", ":scratch-"];
const NEVER = new Set(["agent:main:main"]);

function oc(args) {
  return execFileSync("openclaw", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function listSessions() {
  const out = oc(["sessions", "--all-agents", "--json", "--limit", "all"]);
  const parsed = JSON.parse(out);
  return parsed.sessions || [];
}

function isTransient(key) {
  const k = String(key).toLowerCase();
  return TRANSIENT.some((frag) => k.includes(frag));
}

function main() {
  const now = Date.now();
  const sessions = listSessions();
  const victims = sessions.filter((s) => {
    if (NEVER.has(s.key)) return false;
    if (!isTransient(s.key)) return false;
    const ageMs = Number.isFinite(s.ageMs) ? s.ageMs : now - Number(s.updatedAt || now);
    return ageMs >= MAX_AGE_MS;
  });

  console.log(`${sessions.length} sessions total; ${victims.length} transient and older than ${MAX_AGE_HOURS}h:`);
  for (const s of victims) {
    const ageH = Math.round((Number.isFinite(s.ageMs) ? s.ageMs : now - Number(s.updatedAt || now)) / 3600000);
    console.log(`  ${s.agentId.padEnd(16)} ${s.key}   (${ageH}h, ${s.totalTokens ?? "?"} tok)`);
  }

  if (!victims.length) {
    console.log("Nothing to prune.");
  } else if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to delete these and run store cleanup.");
    return;
  } else {
    const byAgent = new Map();
    for (const s of victims) {
      if (!byAgent.has(s.agentId)) byAgent.set(s.agentId, []);
      byAgent.get(s.agentId).push(s.key);
    }
    for (const [agentId, keys] of byAgent) {
      try {
        // `sessions delete` already archives the transcript and runs runtime
        // cleanup for each removed session (per its own help text).
        oc(["sessions", "delete", ...keys, "--agent", agentId, "--yes"]);
        console.log(`deleted ${keys.length} session(s) for ${agentId}`);
      } catch (error) {
        console.warn(`delete failed for ${agentId}: ${String(error.stderr || error.message).trim()}`);
      }
      try {
        oc(["sessions", "cleanup", "--agent", agentId]);
      } catch { /* cleanup is best-effort store maintenance */ }
    }
  }
}

main();
