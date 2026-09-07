#!/usr/bin/env node
// Is the Cursor harness actually usable for the Frontend Builder role?
//
//   node scripts/probe-cursor-harness.mjs
//
// Frontend Builder is the ORGANIZATIONAL role; Cursor is its intended HARNESS.
// This checks whether `cursor-agent` can be driven by OpenClaw's acpx ACP
// backend, and what actually executes a `frontend-builder` dispatch today.
// Read-only.

import { execFileSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CONFIG = process.env.OPENCLAW_CONFIG || join(homedir(), ".openclaw", "openclaw.json");
const g = { ok: "✓", warn: "!", fail: "✗" };
const out = [];
const say = (level, line, detail) => { out.push({ level }); console.log(`${g[level]} ${line}`); if (detail) console.log(`    ${detail}`); };

// 1. cursor-agent installed + authed
try {
  const which = execFileSync("bash", ["-lc", "command -v cursor-agent"], { encoding: "utf8" }).trim();
  say("ok", `cursor-agent installed (${which})`);
  try {
    const status = execFileSync("cursor-agent", ["status"], { encoding: "utf8", timeout: 10000 });
    say("ok", `cursor-agent authed`, status.split("\n").find((l) => l.trim()) || "");
  } catch { say("warn", "cursor-agent not authenticated", "run `cursor-agent login`"); }
} catch { say("fail", "cursor-agent not installed"); process.exit(1); }

// 2. does cursor-agent expose an ACP server mode acpx can drive?
let acpMode = false;
try {
  const help = execFileSync("cursor-agent", ["--help"], { encoding: "utf8", timeout: 10000 });
  acpMode = /\bacp\b/i.test(help) || /agent client protocol/i.test(help);
} catch { /* ignore */ }
if (acpMode) say("ok", "cursor-agent advertises an ACP mode");
else say("fail", "cursor-agent has NO ACP server mode",
  "`cursor-agent acp` is a no-op and `--help` lists no ACP/stdio server. acpx cannot spawn it. Frontend Builder must run on its fallback harness.");

// 3. what does acpx map for `cursor`, and what actually runs?
if (existsSync(CONFIG)) {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
    const map = cfg?.plugins?.entries?.acpx?.config?.agents?.cursor;
    if (map) say("warn", `acpx maps cursor -> ${map.command} ${(map.args || []).join(" ")}`,
      "that command does not start an ACP server (see above), so dispatches fall through");
    else say("ok", "acpx has no cursor mapping");
  } catch { say("warn", "could not read openclaw.json"); }
}

// 4. live: what executes a frontend-builder dispatch right now?
try {
  const raw = execFileSync("openclaw", ["agent", "--agent", "frontend-builder", "--session-key", `cursor-probe-${Date.now()}`, "-m", "Reply with exactly: FE_OK", "--json", "--timeout", "120"],
    { encoding: "utf8", timeout: 130000 });
  const env = JSON.parse(raw);
  const ok = /FE_OK/.test(JSON.stringify(env));
  const sessions = JSON.parse(execFileSync("openclaw", ["sessions", "--agent", "frontend-builder", "--json", "--limit", "3"], { encoding: "utf8" })).sessions || [];
  const latest = sessions.sort((a, b) => (a.ageMs || 9e18) - (b.ageMs || 9e18))[0];
  say(ok ? "ok" : "warn", `frontend-builder dispatch ${ok ? "succeeded" : "returned unexpected output"}`,
    latest ? `ran on ${latest.modelProvider}/${latest.model} via runtime "${latest.agentRuntime?.id}" (acpRuntime=${latest.acpRuntime})` : "");
} catch (e) {
  say("warn", "frontend-builder dispatch failed", String(e.stderr || e.message || e).split("\n")[0]);
}

console.log("\nConclusion: Frontend Builder (role) — Harness: Cursor — Status: UNAVAILABLE — Fallback: Codex");
console.log("Reason: cursor-agent has no ACP server mode for OpenClaw's acpx backend. Revisit if Cursor ships one.");
process.exitCode = out.some((r) => r.level === "fail") ? 1 : 0;
