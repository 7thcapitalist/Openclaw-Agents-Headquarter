#!/usr/bin/env node
// The canonical role -> model policy for the factory. Supersedes
// apply-review-model-routing.mjs. Operates on ~/.openclaw/openclaw.json.
//
//   node scripts/apply-model-policy.mjs --dry-run
//   node scripts/apply-model-policy.mjs
//   openclaw daemon restart
//
// Policy (see docs/software-factory/MODEL_POLICY.md for the rationale):
//
//   default (main / builders inherit)  openai/gpt-5.6-sol  -> openai/gpt-5.6-luna -> Claude
//     cheap, fast orchestration/routing — never Opus, never a big model for glue.
//   product                            github-copilot/gpt-4.1 -> gpt-5.4-mini
//   objective decomposition/intake    configured to the architect agent, below
//     (Claude primary -> Codex/OpenAI fallback), rather than failing when the
//     Claude seat is exhausted.
//   qa                                 github-copilot/gpt-4.1 -> Codex -> Claude
//     (kept a different harness from the builder by default; both seats remain available)
//   architect, reviewer, security,     anthropic/claude-sonnet-5 -> Codex -> gpt-4.1
//   release, research, learning
//     release moved off the shared OpenAI CLI seat (2026-09-07): it kept
//     failing "did not write its result file" and stranding otherwise-green
//     tasks. It also needs the acpx `runtime` block (set on the agent entry
//     directly; this script only manages `model`/`models`).
//     design / codebase understanding / independent review / security / research
//     — where the Claude subscription earns its cost. Sonnet, not Opus:
//     Opus stays opt-in per-task.
//
// backend-builder and frontend-builder stay on dedicated Codex-backed routes.

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { fileURLToPath } from "url";

const CONFIG = process.env.OPENCLAW_CONFIG || join(homedir(), ".openclaw", "openclaw.json");
const BACKUP = `${CONFIG}.before-model-policy`;
const DRY_RUN = process.argv.includes("--dry-run");

const OPENAI_MAIN = "openai/gpt-5.6-sol";
const LUNA = "openai/gpt-5.6-luna";
const MINI = "openai/gpt-5.4-mini";
const COPILOT = "github-copilot/gpt-4.1";
const CLAUDE = "anthropic/claude-sonnet-5";

// The first fallback crosses the subscription boundary. The remaining
// fallbacks are cheaper/secondary routes for hosts where one of those providers
// is not configured. This is intentionally explicit: a provider quota error is
// handled by OpenClaw's model chain instead of stranding a factory stage.
const DEFAULT_MODEL = { primary: OPENAI_MAIN, fallbacks: [LUNA, CLAUDE, MINI, COPILOT] };
const ROUTES = {
  // Keep these explicit even though they currently match defaults: these are
  // real Codex-backed agent entries and must carry their own Claude backup.
  main: { primary: OPENAI_MAIN, fallbacks: [LUNA, CLAUDE, MINI, COPILOT] },
  "backend-builder": { primary: OPENAI_MAIN, fallbacks: [LUNA, CLAUDE, MINI, COPILOT] },
  "frontend-builder": { primary: OPENAI_MAIN, fallbacks: [LUNA, CLAUDE, MINI, COPILOT] },
  architect: { primary: CLAUDE, fallbacks: [LUNA, OPENAI_MAIN, COPILOT, MINI] },
  reviewer: { primary: CLAUDE, fallbacks: [LUNA, OPENAI_MAIN, COPILOT, MINI] },
  security: { primary: CLAUDE, fallbacks: [LUNA, OPENAI_MAIN, COPILOT, MINI] },
  research: { primary: CLAUDE, fallbacks: [LUNA, OPENAI_MAIN, COPILOT, MINI] },
  learning: { primary: CLAUDE, fallbacks: [LUNA, OPENAI_MAIN, COPILOT, MINI] },
  qa: { primary: COPILOT, fallbacks: [LUNA, OPENAI_MAIN, CLAUDE, MINI] },
  product: { primary: COPILOT, fallbacks: [LUNA, OPENAI_MAIN, CLAUDE, MINI] },
  release: { primary: CLAUDE, fallbacks: [LUNA, OPENAI_MAIN, COPILOT, MINI] },
};

function withModels(entry, refs) {
  const next = structuredClone(entry ?? {});
  next.models = { ...(next.models || {}) };
  for (const r of refs) next.models[r] = next.models[r] || {};
  return next;
}

export function planModelPolicy(config) {
  const nextConfig = structuredClone(config);
  const defaults = nextConfig?.agents?.defaults;
  const entries = nextConfig?.agents?.entries;
  if (!defaults || !entries) throw new Error("agents.defaults / agents.entries missing");
  const changes = [];
  const warnings = [];

  // 1. cheap default (undo an Opus/Claude default if a login set one)
  const curDefault = JSON.stringify(defaults.model);
  const wantDefault = JSON.stringify(DEFAULT_MODEL);
  if (curDefault !== wantDefault) {
    defaults.model = structuredClone(DEFAULT_MODEL);
    changes.push(`defaults.model: ${JSON.parse(curDefault || "null")?.primary ?? "?"} -> ${OPENAI_MAIN} (fallbacks ${LUNA}, ${CLAUDE}, ${MINI}, ${COPILOT})`);
  }
  defaults.models = { ...(defaults.models || {}) };
  for (const r of [OPENAI_MAIN, LUNA, CLAUDE, MINI, COPILOT]) {
    if (!defaults.models[r]) {
      defaults.models[r] = {};
      changes.push(`defaults.models: registered ${r}`);
    }
  }

  // 2. per-role routes
  for (const [id, route] of Object.entries(ROUTES)) {
    if (!entries[id]) { warnings.push(`${id}: no such agent, skipping`); continue; }
    const before = JSON.stringify({ model: entries[id].model, models: entries[id].models });
    const updated = withModels(entries[id], [route.primary, ...route.fallbacks]);
    updated.model = { primary: route.primary, fallbacks: [...route.fallbacks] };
    if (JSON.stringify({ model: updated.model, models: updated.models }) === before) continue;
    entries[id] = updated;
    changes.push(`${id}: primary -> ${route.primary}, fallbacks -> [${route.fallbacks.join(", ")}]`);
  }

  return { changes, warnings, nextConfig };
}

function main() {
  if (!existsSync(CONFIG)) { console.error(`No config at ${CONFIG}`); process.exit(1); }
  let config;
  try { config = JSON.parse(readFileSync(CONFIG, "utf8")); }
  catch (e) { console.error(`config is not valid JSON: ${e.message}`); process.exit(1); }

  let plan;
  try { plan = planModelPolicy(config); }
  catch (e) { console.error(e.message); process.exit(1); }
  for (const warning of plan.warnings) console.warn(`- ${warning}`);
  for (const change of plan.changes) console.log(`- ${change}`);

  if (!plan.changes.length) { console.log("\nNothing to do; config already matches the policy."); return; }
  if (DRY_RUN) { console.log("\n--dry-run: nothing written."); return; }

  if (!existsSync(BACKUP)) { copyFileSync(CONFIG, BACKUP); console.log(`\nBacked up -> ${BACKUP}`); }
  else console.log(`\nBackup already at ${BACKUP} (kept).`);

  JSON.parse(JSON.stringify(plan.nextConfig));
  writeFileSync(CONFIG, `${JSON.stringify(plan.nextConfig, null, 2)}\n`, "utf8");
  console.log(`Wrote ${CONFIG}. Run: openclaw daemon restart`);
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) main();
