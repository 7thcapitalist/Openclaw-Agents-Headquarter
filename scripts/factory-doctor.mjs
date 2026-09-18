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
import { readClaudeUsage } from "../factory/lib/credit-headroom.mjs";
import { parseClaudeUsage, parseUsageWindow } from "../factory/lib/model-usage-window.mjs";

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
  const { shortWindow, weekWindow } = parseUsageWindow(modelsOut);
  const pct = shortWindow?.percentLeft ?? null;
  const detail = [
    shortWindow ? `5h window ${shortWindow.percentLeft}% left${shortWindow.resetIn ? ` (resets ${shortWindow.resetIn})` : ""}` : "5h window: unknown",
    weekWindow ? `week ${weekWindow.percentLeft}% left` : null,
  ].filter(Boolean).join(", ");
  if (cooldown || pct === 0) return { level: "fail", line: "OpenAI seat is rate-limited / in cooldown", detail: `${detail}. Factory runs only on the github-copilot fallback until this clears.` };
  if (pct !== null && pct <= 15) return { level: "warn", line: `OpenAI seat low (${pct}% of the 5h window left)`, detail };
  return { level: "ok", line: "OpenAI seat has headroom", detail };
}

// Anthropic (claude-cli) seat, read from `claude -p /usage` through the same
// shared parser credit-headroom uses. An unreadable read is a warning, never ok.
export function checkAnthropicSeat(claudeUsage, { now = Date.now() } = {}) {
  const { shortWindow, weekWindow } = parseClaudeUsage(claudeUsage?.ok ? claudeUsage.out : "", { now });
  if (!Number.isFinite(shortWindow?.percentLeft)) {
    return { level: "warn", line: "Anthropic seat headroom unknown", detail: "claude -p /usage did not return a readable session usage window; treat the seat as unavailable, not as having headroom." };
  }
  const pct = shortWindow.percentLeft;
  const detail = [
    `session ${pct}% left${shortWindow.resetIn ? ` (resets in ${shortWindow.resetIn})` : ""}`,
    weekWindow ? `week ${weekWindow.percentLeft}% left${weekWindow.resetIn ? ` (resets in ${weekWindow.resetIn})` : ""}` : null,
  ].filter(Boolean).join(", ");
  if (pct === 0 || weekWindow?.percentLeft === 0) return { level: "fail", line: "Anthropic seat is out of usage", detail };
  if (pct <= 15) return { level: "warn", line: `Anthropic seat low (${pct}% of the session window left)`, detail };
  return { level: "ok", line: "Anthropic seat has headroom", detail };
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

  // `claude` and `codex` are NOT served by acpx and must not be reported as
  // missing from it. Verified by probe on 2026-09-09:
  //   openclaw agent --agent reviewer        -> provider claude-cli, claude-sonnet-5
  //   openclaw agent --agent backend-builder -> provider openai,     gpt-5.6-sol
  // Both seats serve real dispatches through their own runtimes. The previous
  // check asserted the opposite ("silently falls back to OpenAI"), which read as
  // a broken Claude seat for months and is the premise behind the ACP section of
  // REVIEW_MODEL_ROUTING.md and part of DC-2026-001. acpx is only the bridge for
  // genuinely ACP-only harnesses, of which `cursor` is the one in use.
  const ACPX_ONLY = ["cursor"];
  const missing = ACPX_ONLY.filter((a) => !mapped.includes(a));

  // Report which seat each role actually resolves to, so "are both seats
  // working together" is answerable without a probe.
  const norm = (m) => (!m ? null : typeof m === "string" ? m : String(m.primary || ""));
  const entries = config?.agents?.entries || {};
  const seatOf = (model) => (model || "").split("/")[0] || "inherited";
  const bySeat = {};
  for (const [id, entry] of Object.entries(entries)) {
    const seat = seatOf(norm(entry.model) || norm(config?.agents?.defaults?.model));
    (bySeat[seat] ||= []).push(id);
  }
  const spread = Object.entries(bySeat)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([seat, ids]) => `${seat}:${ids.length}`)
    .join(", ");

  if (missing.length) {
    return { level: "warn", line: `acpx has no command mapping for: ${missing.join(", ")}`, detail: `acpx bridges ACP-only harnesses. Roles per seat — ${spread}.` };
  }
  if (Object.keys(bySeat).length < 2) {
    return { level: "warn", line: "every role resolves to one provider seat", detail: `A single seat is the throughput ceiling for the whole pipeline (DC-2026-001). Roles per seat — ${spread}.` };
  }
  return { level: "ok", line: `roles split across seats — ${spread}`, detail: `acpx agents mapped: ${mapped.join(", ") || "(none needed)"}` };
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


// Does every gate agent's route actually finish work?
//
// `openclaw models` proves a seat authenticates; it cannot tell you whether the
// model behind a role can complete an agentic task. On lifemaxing the qa agent's
// primary was github-copilot/gpt-4.1 while every other gate agent was on
// claude-sonnet-5. It authenticated fine, answered every dispatch with a plan,
// and stopped without writing a result — failing the QA gate silently until a
// human read a redacted executor trace.
//
// The recorded dispatch history already answers this: for each (stage, model)
// route, did it ever produce a gate artifact, or only ever leave none?
const NO_ARTIFACT_RE = /no result file|produced no result|did not write|could not run|without writing a result/i;

export function checkAgentProductivity(hqRoot, configText = null) {
  const dir = join(hqRoot, "dashboard", "backend", "data", "factory");
  const files = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "state.json") files.push(p);
    }
  };
  walk(dir);
  if (!files.length) return { level: "ok", line: "no dispatch history to judge agent routes on yet" };

  // Per gate stage. Recovery dispatches carry the failed stage's name but are a
  // different job on a different route, so counting them would let a working
  // recovery agent mask a gate agent that never finishes anything.
  const stages = new Map();
  for (const file of files) {
    let state;
    try { state = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
    for (const d of state.dispatches || []) {
      if (!d.stage) continue;
      if (d.kind && d.kind !== "stage") continue;
      const seen = stages.get(d.stage) || { stage: d.stage, productive: 0, barren: 0, models: new Set() };
      if (d.usage?.model) seen.models.add(`${d.usage.provider || "?"}/${d.usage.model}`);
      const text = String(d.summary || d.error || "");
      if (d.status === "failed" || NO_ARTIFACT_RE.test(text)) seen.barren += 1;
      else if (d.outcome) seen.productive += 1;
      stages.set(d.stage, seen);
    }
  }

  // Suspect once a stage has failed to produce an artifact more than once and
  // has never produced one: the route authenticates but does not finish work.
  const suspect = [...stages.values()].filter((r) => r.barren >= 2 && r.productive === 0);
  if (!suspect.length) {
    const proven = [...stages.values()].filter((r) => r.productive > 0).length;
    return { level: "ok", line: `${proven} gate stage(s) have produced artifacts on their current route` };
  }

  let entries = {};
  try {
    entries = JSON.parse(configText ?? (existsSync(OPENCLAW_CONFIG) ? readFileSync(OPENCLAW_CONFIG, "utf8") : "{}"))?.agents?.entries || {};
  } catch { /* config is advisory here */ }

  const worst = suspect
    .map((r) => {
      const route = [...r.models].join(", ") || entries[r.stage]?.model?.primary || "unknown route";
      return `${r.stage} via ${route} (${r.barren} dispatches, 0 artifacts)`;
    })
    .join("; ");
  const primaries = Object.entries(entries)
    .filter(([id]) => ["architect", "reviewer", "qa", "security", "release"].includes(id))
    .map(([id, e]) => `${id}=${e?.model?.primary || "inherited"}`)
    .join(", ");
  return {
    level: "warn",
    line: `gate stage(s) that never produced an artifact: ${worst}`,
    detail: `That route authenticates but does not finish the task — re-point it at a model that does.${primaries ? ` Gate primaries — ${primaries}.` : ""}`,
  };
}

export function checkGateway(daemonOut) {
  if (/Runtime:\s*running/i.test(daemonOut) && /probe:\s*ok/i.test(daemonOut)) return { level: "ok", line: "OpenClaw gateway running, probe ok" };
  if (/Runtime:\s*running/i.test(daemonOut)) return { level: "warn", line: "gateway running but probe not confirmed" };
  return { level: "fail", line: "OpenClaw gateway not reachable", detail: "Start it before autonomous dispatch." };
}

// ── orchestration

export function runDoctor({ run = realRun, runClaude = () => readClaudeUsage(), now = Date.now(), configText = null, hqRoot = HQ_ROOT } = {}) {
  const cfg = configText ?? (existsSync(OPENCLAW_CONFIG) ? readFileSync(OPENCLAW_CONFIG, "utf8") : "{}");
  const results = [
    checkGateway(run(["daemon", "status"]).out),
    checkOpenAiSeat(run(["models"]).out),
    checkAnthropicSeat(runClaude(), { now }),
    checkCopilotFallback(run(["models"]).out),
    checkSessions(run(["sessions", "--all-agents", "--json", "--limit", "all"]).out),
    checkAcpxAgents(cfg),
    checkFactoryActivity(hqRoot),
    checkAgentProductivity(hqRoot, cfg),
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
