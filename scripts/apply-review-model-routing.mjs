#!/usr/bin/env node
// Re-route the review-side OpenClaw agents (architect, reviewer, qa, security)
// off the single exhausted OpenAI seat and onto a second model, so:
//   1. builder (codex/openai) and reviewer are genuinely different models again
//      — real independence, per docs/software-factory/OPERATING_RULES.md;
//   2. the design + review load leaves the seat that is repeatedly near its 5h
//      window limit.
//
// Target: github-copilot/gpt-4.1 primary + openai/gpt-5.4-mini fallback.
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
const AGENTS = ["architect", "reviewer", "qa", "security"];
const PRIMARY = "github-copilot/gpt-4.1";
const FALLBACK = "openai/gpt-5.4-mini";
const DRY_RUN = process.argv.includes("--dry-run");

function desiredEntry(entry) {
  const next = structuredClone(entry ?? {});
  next.models = { ...(next.models || {}), [PRIMARY]: next.models?.[PRIMARY] || {}, [FALLBACK]: next.models?.[FALLBACK] || {} };
  next.model = { primary: PRIMARY, fallbacks: [FALLBACK] };
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
  for (const id of AGENTS) {
    if (!entries[id]) {
      console.warn(`- ${id}: no such agent entry, skipping`);
      continue;
    }
    const before = JSON.stringify({ model: entries[id].model, models: entries[id].models });
    const updated = desiredEntry(entries[id]);
    const after = JSON.stringify({ model: updated.model, models: updated.models });
    if (before === after) {
      console.log(`- ${id}: already routed to ${PRIMARY}`);
      continue;
    }
    changes.push({ id, updated });
    console.log(`- ${id}: model -> ${PRIMARY} (fallback ${FALLBACK})`);
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
