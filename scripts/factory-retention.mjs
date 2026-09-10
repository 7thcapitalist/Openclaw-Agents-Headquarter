#!/usr/bin/env node
// Retention plan, backup health, and the ONLY path that can delete runtime data.
//
// Deleting is deliberately awkward. `--apply` requires the operator to name the
// class, the age bound, and the exact number of files they expect. If the plan
// has drifted by even one file since they read it, the run is refused rather
// than applied — an operator who approved "delete 40 results" must never
// silently get "delete 400".
//
//   node scripts/factory-retention.mjs
//   node scripts/factory-retention.mjs --backup-dir /var/backups/hq
//   node scripts/factory-retention.mjs --class ephemeral --older-than 30
//   node scripts/factory-retention.mjs --class ephemeral --older-than 30 --apply --confirm 128

import { rmSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { buildRetentionSnapshot, planRetention, RETENTION_CLASSES } from "../factory/lib/hq/retention.mjs";

const hqRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  process.stdout.write(usage());
  process.exit(0);
}

const snapshot = buildRetentionSnapshot({ hqRoot, backupDir: args.backupDir, maxAgeHours: args.maxAgeHours });
const plan = planRetention({ hqRoot, classes: args.classes, now: Date.now() });

if (!args.apply) {
  process.stdout.write(`${JSON.stringify({ ...snapshot, plan: summarize(plan, args) }, null, 2)}\n`);
  process.exit(snapshot.warnings.length ? 0 : 0);
}

// --- apply -------------------------------------------------------------------

const targets = plan.eligible.filter((file) => (!args.classes || args.classes.includes(file.class)) && file.ageDays >= args.olderThan);

if (!args.classes || args.classes.length !== 1) fail("--apply requires exactly one --class, so the blast radius is named.");
if (!Number.isInteger(args.olderThan)) fail("--apply requires --older-than <days>.");
if (!RETENTION_CLASSES[args.classes[0]]?.prunable) fail(`Class '${args.classes[0]}' is never prunable: ${RETENTION_CLASSES[args.classes[0]]?.reason || "unknown class"}`);
if (!Number.isInteger(args.confirm)) fail(`--apply requires --confirm <count>. The current plan targets ${targets.length} file(s).`);
if (args.confirm !== targets.length) {
  fail(`Refusing to apply: you confirmed ${args.confirm} file(s) but the plan now targets ${targets.length}. Re-read the plan and confirm the current number.`);
}
if (targets.length === 0) {
  process.stdout.write(`${JSON.stringify({ applied: true, removed: 0, bytes: 0, note: "Nothing was eligible." }, null, 2)}\n`);
  process.exit(0);
}

let removed = 0;
let bytes = 0;
const failures = [];
for (const file of targets) {
  const path = join(plan.stateRoot, file.path);
  // Belt and braces: the plan already resolved these under stateRoot, but a
  // delete loop is the wrong place to trust that.
  if (!resolve(path).startsWith(`${resolve(plan.stateRoot)}/`)) {
    failures.push({ path: file.path, error: "resolved outside the state root" });
    continue;
  }
  try {
    rmSync(path, { force: true });
    removed += 1;
    bytes += file.bytes;
  } catch (error) {
    failures.push({ path: file.path, error: String(error?.message || error) });
  }
}

process.stdout.write(`${JSON.stringify({ applied: true, class: args.classes[0], olderThanDays: args.olderThan, removed, bytes, failures }, null, 2)}\n`);
process.exitCode = failures.length ? 1 : 0;

// ------------------------------------------------------------------ internals

function summarize(plan, options) {
  const eligible = plan.eligible.filter((file) => file.ageDays >= (options.olderThan ?? 0));
  return {
    applied: false,
    classes: options.classes || Object.keys(RETENTION_CLASSES),
    olderThanDays: options.olderThan ?? null,
    eligibleFiles: eligible.length,
    eligibleBytes: eligible.reduce((sum, file) => sum + file.bytes, 0),
    sample: eligible.slice(0, 20),
    toApply: eligible.length
      ? `node scripts/factory-retention.mjs --class <one-class> --older-than ${options.olderThan ?? "<days>"} --apply --confirm ${eligible.length}`
      : null,
  };
}

function parseArgs(argv) {
  const out = { classes: null, olderThan: null, confirm: null, apply: false, backupDir: null, maxAgeHours: 24, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[index += 1];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--apply") out.apply = true;
    else if (arg === "--class") out.classes = [...(out.classes || []), next()];
    else if (arg === "--older-than") out.olderThan = Number.parseInt(next(), 10);
    else if (arg === "--confirm") out.confirm = Number.parseInt(next(), 10);
    else if (arg === "--backup-dir") out.backupDir = next();
    else if (arg === "--max-age-hours") out.maxAgeHours = Number.parseInt(next(), 10);
    else fail(`Unknown argument '${arg}'.\n\n${usage()}`);
  }
  if (out.olderThan !== null && !Number.isInteger(out.olderThan)) fail("--older-than must be a whole number of days.");
  if (out.confirm !== null && !Number.isInteger(out.confirm)) fail("--confirm must be a whole number of files.");
  return out;
}

function usage() {
  return [
    "factory-retention — report retention, storage and backup health; prune only on explicit request.",
    "",
    "  --class <name>          Restrict to one retention class. Repeatable when reporting.",
    "  --older-than <days>     Only files at least this old.",
    "  --backup-dir <path>     Where backup archives live (or FACTORY_BACKUP_DIR).",
    "  --max-age-hours <n>     Freshness bound for the latest backup. Default 24.",
    "  --apply --confirm <n>   Delete. Requires exactly one prunable --class, --older-than,",
    "                          and the exact current file count. A drifted plan is refused.",
    "",
    "Classes:",
    ...Object.entries(RETENTION_CLASSES).map(([name, rule]) => `  ${name.padEnd(20)}${rule.prunable ? `prunable after ${rule.minAgeDays}d` : "never pruned"} — ${rule.reason}`),
    "",
  ].join("\n");
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
