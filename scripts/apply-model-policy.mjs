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
//   default (main / builders inherit)  openai/gpt-5.6-sol  -> gpt-5.4-mini -> gpt-4.1
//     cheap, fast orchestration/routing — never Opus, never a big model for glue.
//   product, release                   openai/gpt-5.4-mini -> gpt-4.1
//   qa                                 github-copilot/gpt-4.1 -> gpt-5.4-mini
//     (kept a different harness from the builder for independence + load spread)
//   architect, reviewer, security,     anthropic/claude-sonnet-5 -> gpt-4.1
//   research, learning
//     design / codebase understanding / independent review / security / research
//     — where the Claude subscription earns its cost. Sonnet, not Opus:
//     Opus stays opt-in per-task.
//
// backend-builder stays on the Codex harness; frontend-builder on Cursor
// (their `model` is just the acp bootstrap — real work is the subprocess).

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CONFIG = process.env.OPENCLAW_CONFIG || join(homedir(), ".openclaw", "openclaw.json");
const BACKUP = `${CONFIG}.before-model-policy`;
const DRY_RUN = process.argv.includes("--dry-run");

const OPENAI_MAIN = "openai/gpt-5.6-sol";
const MINI = "openai/gpt-5.4-mini";
const COPILOT = "github-copilot/gpt-4.1";
const CLAUDE = "anthropic/claude-sonnet-5";

const DEFAULT_MODEL = { primary: OPENAI_MAIN, fallbacks: [MINI, COPILOT] };
const ROUTES = {
  architect: { primary: CLAUDE, fallbacks: [COPILOT] },
  reviewer: { primary: CLAUDE, fallbacks: [COPILOT] },
  security: { primary: CLAUDE, fallbacks: [COPILOT] },
  research: { primary: CLAUDE, fallbacks: [COPILOT] },
  learning: { primary: CLAUDE, fallbacks: [COPILOT] },
  qa: { primary: COPILOT, fallbacks: [MINI] },
  product: { primary: MINI, fallbacks: [COPILOT] },
  release: { primary: MINI, fallbacks: [COPILOT] },
};

function withModels(entry, refs) {
  const next = structuredClone(entry ?? {});
  next.models = { ...(next.models || {}) };
  for (const r of refs) next.models[r] = next.models[r] || {};
  return next;
}

function main() {
  if (!existsSync(CONFIG)) { console.error(`No config at ${CONFIG}`); process.exit(1); }
  let config;
  try { config = JSON.parse(readFileSync(CONFIG, "utf8")); }
  catch (e) { console.error(`config is not valid JSON: ${e.message}`); process.exit(1); }

  const defaults = config?.agents?.defaults;
  const entries = config?.agents?.entries;
  if (!defaults || !entries) { console.error("agents.defaults / agents.entries missing"); process.exit(1); }

  const changes = [];

  // 1. cheap default (undo an Opus/Claude default if a login set one)
  const curDefault = JSON.stringify(defaults.model);
  const wantDefault = JSON.stringify(DEFAULT_MODEL);
  if (curDefault !== wantDefault) {
    changes.push(() => {
      defaults.models = { ...(defaults.models || {}) };
      for (const r of [OPENAI_MAIN, MINI, COPILOT]) defaults.models[r] = defaults.models[r] || {};
      defaults.model = structuredClone(DEFAULT_MODEL);
    });
    console.log(`- defaults.model: ${defaults.model?.primary ?? "?"} -> ${OPENAI_MAIN} (fallbacks ${MINI}, ${COPILOT})`);
  } else {
    console.log(`- defaults.model: already ${OPENAI_MAIN}`);
  }

  // 2. per-role routes
  for (const [id, route] of Object.entries(ROUTES)) {
    if (!entries[id]) { console.warn(`- ${id}: no such agent, skipping`); continue; }
    const before = JSON.stringify({ model: entries[id].model, models: entries[id].models });
    const updated = withModels(entries[id], [route.primary, ...route.fallbacks]);
    updated.model = { primary: route.primary, fallbacks: [...route.fallbacks] };
    if (JSON.stringify({ model: updated.model, models: updated.models }) === before) {
      console.log(`- ${id}: already ${route.primary}`);
      continue;
    }
    changes.push(() => { entries[id] = updated; });
    console.log(`- ${id}: primary -> ${route.primary}, fallbacks -> [${route.fallbacks.join(", ")}]`);
  }

  if (!changes.length) { console.log("\nNothing to do; config already matches the policy."); return; }
  if (DRY_RUN) { console.log("\n--dry-run: nothing written."); return; }

  if (!existsSync(BACKUP)) { copyFileSync(CONFIG, BACKUP); console.log(`\nBacked up -> ${BACKUP}`); }
  else console.log(`\nBackup already at ${BACKUP} (kept).`);

  for (const apply of changes) apply();
  JSON.parse(JSON.stringify(config));
  writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  console.log(`Wrote ${CONFIG}. Run: openclaw daemon restart`);
}

main();
