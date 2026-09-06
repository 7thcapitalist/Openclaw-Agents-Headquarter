#!/usr/bin/env node
// Give the factory agents a model path that survives an OpenAI cooldown, and
// restore real builder/reviewer independence.
//
//   review side (architect, reviewer, qa, security):
//     github-copilot/gpt-4.1 PRIMARY + openai/gpt-5.4-mini fallback
//     -> different model from the builder (codex/openai); design+review load
//        leaves the single OpenAI seat entirely.
//   intake/release (product, release):
//     openai/gpt-5.4-mini PRIMARY (unchanged) + github-copilot/gpt-4.1 fallback
//     -> the pipeline can still START and FINISH while OpenAI is rate-limited
//        (product is stage 1 and today has no fallback at all).
//
// main / backend-builder / frontend-builder inherit agents.defaults.model, which
// already carries the github-copilot/gpt-4.1 fallback — left untouched.
//
// Operates on ~/.openclaw/openclaw.json (private runtime state, NOT in the repo).
// Reversible via scripts/revert-review-model-routing.mjs.
//
//   node scripts/apply-review-model-routing.mjs --dry-run   # show the diff, write nothing
//   node scripts/apply-review-model-routing.mjs             # apply, after backing up
//   openclaw daemon restart                                 # then reload the daemon
//
// See docs/software-factory/REVIEW_MODEL_ROUTING.md.

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CONFIG = process.env.OPENCLAW_CONFIG || join(homedir(), ".openclaw", "openclaw.json");
const BACKUP = `${CONFIG}.before-review-routing`;
const COPILOT = "github-copilot/gpt-4.1";
const MINI = "openai/gpt-5.4-mini";
const DRY_RUN = process.argv.includes("--dry-run");

// id -> { primary, fallbacks }
const ROUTES = {
  architect: { primary: COPILOT, fallbacks: [MINI] },
  reviewer: { primary: COPILOT, fallbacks: [MINI] },
  qa: { primary: COPILOT, fallbacks: [MINI] },
  security: { primary: COPILOT, fallbacks: [MINI] },
  product: { primary: MINI, fallbacks: [COPILOT] },
  release: { primary: MINI, fallbacks: [COPILOT] },
};

function desiredEntry(entry, route) {
  const next = structuredClone(entry ?? {});
  const refs = [route.primary, ...route.fallbacks];
  next.models = { ...(next.models || {}) };
  for (const ref of refs) next.models[ref] = next.models[ref] || {};
  next.model = { primary: route.primary, fallbacks: [...route.fallbacks] };
  return next;
}

function main() {
  if (!existsSync(CONFIG)) {
    console.error(`No OpenClaw config at ${CONFIG}. Set OPENCLAW_CONFIG or run OpenClaw first.`);
    process.exit(1);
  }
  const raw = readFileSync(CONFIG, "utf8");
  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    console.error(`Config is not valid JSON: ${error.message}`);
    process.exit(1);
  }

  const entries = config?.agents?.entries;
  if (!entries) {
    console.error("config.agents.entries is missing — nothing to route.");
    process.exit(1);
  }

  const changes = [];
  for (const [id, route] of Object.entries(ROUTES)) {
    if (!entries[id]) {
      console.warn(`- ${id}: no such agent entry, skipping`);
      continue;
    }
    const before = JSON.stringify({ model: entries[id].model, models: entries[id].models });
    const updated = desiredEntry(entries[id], route);
    const after = JSON.stringify({ model: updated.model, models: updated.models });
    if (before === after) {
      console.log(`- ${id}: already ${route.primary} (fallback ${route.fallbacks.join(", ")})`);
      continue;
    }
    changes.push({ id, updated });
    console.log(`- ${id}: primary -> ${route.primary}, fallbacks -> [${route.fallbacks.join(", ")}]`);
  }

  if (!changes.length) {
    console.log("\nNothing to do; config already matches the desired routing.");
    return;
  }

  if (DRY_RUN) {
    console.log("\n--dry-run: no files written. Re-run without --dry-run to apply.");
    return;
  }

  if (!existsSync(BACKUP)) {
    copyFileSync(CONFIG, BACKUP);
    console.log(`\nBacked up ${CONFIG} -> ${BACKUP}`);
  } else {
    console.log(`\nBackup already exists at ${BACKUP} (kept as-is — the earliest baseline).`);
  }

  for (const { id, updated } of changes) entries[id] = updated;
  JSON.parse(JSON.stringify(config)); // final sanity parse
  writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  console.log(`Wrote ${CONFIG}. Run: openclaw daemon restart`);
}

main();
