#!/usr/bin/env node
// Factory health at a glance. Read-only — runs `openclaw` queries and inspects
// local state, prints ✓ / ! / ✗ lines, exits non-zero if anything is ✗.
//
//   npm run factory:doctor
//
// Complements scripts/factory-doctor.sh (CLI-presence checks); this one looks at
// the live runtime: model quota, the Copilot fallback, session bloat, the
// acpx agent-command gap, and whether any task has ever run through the engine.

import { execFileSync } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const HQ_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || join(homedir(), ".openclaw", "openclaw.json");

function realRun(args) {
  try {
    return { ok: true, out: execFileSync("openclaw", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 }) };
  } catch (error) {
    return { ok: false, out: String(error.stdout || "") + String(error.stderr || error.message || "") };
  }
}

// ── individual checks: each returns { level: "ok"|"warn"|"fail", line, detail? }

export function checkOpenAiSeat(modelsOut) {
  const cooldown = /openai[^\n]*cooldown/i.test(modelsOut);
  const window5h = modelsOut.match(/5h\s+(\d+)%\s+left(?:\s+⏱\s*([^\n·]+))?/i);
  const week = modelsOut.match(/Week\s+(\d+)%\s+left/i);
  const pct = window5h ? Number(window5h[1]) : null;
  const detail = [
    window5h ? `5h window ${window5h[1]}% left${window5h[2] ? ` (resets ${window5h[2].trim()})` : ""}` : "5h window: unknown",
    week ? `week ${week[1]}% left` : null,
  ].filter(Boolean).join(", ");
  if (cooldown || pct === 0) return { level: "fail", line: "OpenAI seat is rate-limited / in cooldown", detail: `${detail}. Factory runs only on the github-copilot fallback until this clears.` };
  if (pct !== null && pct <= 15) return { level: "warn", line: `OpenAI seat low (${pct}% of the 5h window left)`, detail };
  return { level: "ok", line: "OpenAI seat has headroom", detail };
}

export function checkCopilotFallback(modelsOut) {
  if (/github-copilot\/gpt-4\.1[^\n]*indeterminate/i.test(modelsOut) || /Auth readiness could not be confirmed for github-copilot/i.test(modelsOut)) {
    return { level: "warn", line: "github-copilot/gpt-4.1 auth readiness is [indeterminate]", detail: "Works in practice for main/research/learning; openai/gpt-5.4-mini covers a miss — but if OpenAI is also cooling down that fallback is dead too." };
  }
  if (/github-copilot/i.test(modelsOut)) return { level: "ok", line: "github-copilot provider present" };
  return { level: "warn", line: "no github-copilot provider configured", detail: "Run scripts/apply-review-model-routing.mjs to add the fallback." };
}

export function checkSessions(sessionsJson) {
  let sessions = [];
  try { sessions = JSON.parse(sessionsJson).sessions || []; } catch { return { level: "warn", line: "could not read sessions" }; }
  const now = Date.now();
  const transient = /:factory-|:probe-|:acp-probe-|:route-|:wire-check-|:sbtest|:smoke-|:scratch-/i;
  const stale = sessions.filter((s) => transient.test(s.key) && (Number.isFinite(s.ageMs) ? s.ageMs : now - Number(s.updatedAt || now)) >= 24 * 3600 * 1000);
  const heavy = sessions.filter((s) => Number(s.contextTokens) > 0 && Number(s.totalTokens) / Number(s.contextTokens) > 0.6);
  const detail = `${sessions.length} sessions; ${stale.length} stale transient (>24h); ${heavy.length} over 60% context`;
  if (stale.length >= 10 || heavy.length >= 5) return { level: "warn", line: "session store needs pruning", detail: `${detail}. Run: npm run factory:prune-sessions -- --apply` };
  return { level: "ok", line: "session store is tidy", detail };
}

export function checkAcpxAgents(configText) {
  let config;
  try { config = JSON.parse(configText); } catch { return { level: "warn", line: "could not read openclaw.json" }; }
  const mapped = Object.keys(config?.plugins?.entries?.acpx?.config?.agents || {});
  const missing = ["claude", "codex"].filter((a) => !mapped.includes(a));
  if (missing.length) {
    return { level: "warn", line: `acpx has no command mapping for: ${missing.join(", ")}`, detail: "runtime.acp.agent:\"claude\" has nothing to spawn and silently falls back to OpenAI. `claude` has no ACP mode, so this cannot be wired the way `cursor` is — see REVIEW_MODEL_ROUTING.md." };
  }
  return { level: "ok", line: `acpx agents mapped: ${mapped.join(", ")}` };
}

export function checkFactoryActivity(hqRoot) {
  const dir = join(hqRoot, "dashboard", "backend", "data", "factory");
  let stateFiles = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "state.json") stateFiles.push(p);
    }
  };
  walk(dir);
  if (!stateFiles.length) return { level: "warn", line: "no task has ever run through the factory engine", detail: `No state.json under ${dir}. Kick one off with scripts/factory-task.mjs or npm run factory:run-many.` };
  return { level: "ok", line: `${stateFiles.length} factory task(s) recorded` };
}

export function checkGateway(daemonOut) {
  if (/Runtime:\s*running/i.test(daemonOut) && /probe:\s*ok/i.test(daemonOut)) return { level: "ok", line: "OpenClaw gateway running, probe ok" };
  if (/Runtime:\s*running/i.test(daemonOut)) return { level: "warn", line: "gateway running but probe not confirmed" };
  return { level: "fail", line: "OpenClaw gateway not reachable", detail: "Start it before autonomous dispatch." };
}

// ── orchestration

export function runDoctor({ run = realRun, configText = null, hqRoot = HQ_ROOT } = {}) {
  const cfg = configText ?? (existsSync(OPENCLAW_CONFIG) ? readFileSync(OPENCLAW_CONFIG, "utf8") : "{}");
  const results = [
    checkGateway(run(["daemon", "status"]).out),
    checkOpenAiSeat(run(["models"]).out),
    checkCopilotFallback(run(["models"]).out),
    checkSessions(run(["sessions", "--all-agents", "--json", "--limit", "all"]).out),
    checkAcpxAgents(cfg),
    checkFactoryActivity(hqRoot),
  ];
  return results;
}

const GLYPH = { ok: "✓", warn: "!", fail: "✗" };

function main() {
  console.log("\nOpenClaw Software Factory — health\n=================================\n");
  const results = runDoctor();
  let failed = false;
  for (const r of results) {
    if (r.level === "fail") failed = true;
    console.log(`${GLYPH[r.level]} ${r.line}`);
    if (r.detail) console.log(`    ${r.detail}`);
  }
  const warn = results.filter((r) => r.level === "warn").length;
  const fail = results.filter((r) => r.level === "fail").length;
  console.log(`\n${results.length - warn - fail} ok, ${warn} warning(s), ${fail} failure(s).\n`);
  process.exitCode = failed ? 1 : 0;
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) main();
