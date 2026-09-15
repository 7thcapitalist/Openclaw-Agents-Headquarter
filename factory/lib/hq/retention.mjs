// Retention classes, dry-run pruning, backup health, and storage visibility.
//
// Adapted from Paperclip's `decision-retention` and `database-backup-health`
// services at pinned commit 6abeb67334348dcb6fde2d591a27ffc7efc7118d (MIT).
// Issue #126.
//
// The governing rule: DO NOT DELETE MATERIAL DATA MERELY BECAUSE IT IS OLD.
// Everything in this module is read-only. `planRetention()` produces a plan and
// removes nothing; the CLI is the only thing that can delete, and only when the
// operator names a class, an age, and the exact number of files they expect —
// a plan that has drifted by even one file is refused rather than applied.
//
// Classes exist so "prune" can never mean "prune everything". Two of them can
// never be deleted by this system at all, and a class not in the table is
// treated as protected: an unrecognised file is somebody's data until proven
// otherwise.

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, extname, join, relative, resolve } from "path";
import { createHash } from "crypto";
import { defaultStateRoot } from "./tasks.mjs";

export const RETENTION_CLASSES = Object.freeze({
  canonical: {
    prunable: false,
    reason: "Canonical workflow state, including the SQLite store that is its authority. Deleting it destroys the record of what the factory did.",
  },
  "append-only-audit": {
    prunable: false,
    reason: "Append-only audit and cost ledgers. Their value is that nothing removes entries.",
  },
  derived: {
    // Rebuildable from canonical state, but still not deleted by age alone —
    // it is what the operator dashboard reads.
    prunable: true,
    minAgeDays: 30,
    reason: "Rebuildable projection of canonical state.",
  },
  evidence: {
    prunable: true,
    minAgeDays: 90,
    reason: "Gate evidence. Retention follows factory.config.json learning.evidenceRetentionDays.",
  },
  ephemeral: {
    prunable: true,
    minAgeDays: 14,
    reason: "Per-dispatch handoffs and results. Superseded once the task settles.",
  },
  protected: {
    prunable: false,
    reason: "Unrecognised or sensitive file. Unknown data is protected until classified.",
  },
});

const CANONICAL_NAMES = new Set(["state.json", "objective-state.json", "control-plane.json"]);

// The SQLite store beside each canonical JSON file, and its WAL/SHM siblings.
//
// These were the one thing this report could not see. `state.json` is an
// EXPORT — the database is the authority, and it is the file that actually
// grows: on 2026-09-14 one task's `state.sqlite` reached 403 GiB while its
// `state.json` stayed at 195 KiB. Falling through to `protected` kept it
// undeletable, which is right, but labelled it "Unrecognised or sensitive
// file" and left its bytes uncounted in every storage total the founder reads.
// Naming it canonical keeps it just as undeletable and makes it visible.
const CANONICAL_STORE_STEMS = new Set(["state", "objective-state", "control-plane"]);
const STORE_SUFFIX_RE = /^(.+)\.sqlite(-wal|-shm)?$/;

function isCanonicalStoreFile(name) {
  const match = STORE_SUFFIX_RE.exec(name);
  return Boolean(match) && CANONICAL_STORE_STEMS.has(match[1]);
}
const AUDIT_NAMES = new Set(["audit.ndjson", "cost-events.ndjson", "permissions.ndjson", "wakeups.json"]);
const DERIVED_NAMES = new Set(["liveness.json", "graph-health.json", "metrics.json", "report.md", "completion-report.md"]);

export function classify(path, { stateRoot }) {
  const name = basename(path);
  // A key or certificate is never a retention candidate, whatever else it is.
  if ([".pem", ".key", ".crt", ".p12"].includes(extname(name))) return "protected";
  if (CANONICAL_NAMES.has(name)) return "canonical";
  if (isCanonicalStoreFile(name)) return "canonical";
  if (AUDIT_NAMES.has(name)) return "append-only-audit";
  if (DERIVED_NAMES.has(name)) return "derived";

  const rel = relative(stateRoot, path).split(/[\\/]/);
  if (rel.includes("results")) return "ephemeral";
  if (rel.includes("evidence")) return "evidence";
  if (/^handoff-[a-z-]+\.md$/.test(name)) return "ephemeral";
  if (/^contracts?$/.test(rel.at(-2) || "")) return "canonical";
  return "protected";
}

// Produce a plan. Deletes nothing, ever. Every file is listed with its class,
// age, size, and whether it is eligible — including the ones that are not, so
// the operator can see what is being kept and why.
export function planRetention({ hqRoot, stateRoot = null, now = Date.now(), classes = null } = {}) {
  const warnings = [];
  const root = resolve(stateRoot || defaultStateRoot(hqRoot));
  const config = readRetentionConfig(hqRoot, warnings);
  const files = [];

  for (const path of walk(root, warnings)) {
    let stats;
    try {
      stats = statSync(path);
    } catch (error) {
      warnings.push(`${relative(root, path)} unavailable: ${error.message}`);
      continue;
    }
    const retentionClass = classify(path, { stateRoot: root });
    const rule = RETENTION_CLASSES[retentionClass];
    const ageDays = Math.floor((now - stats.mtimeMs) / 86_400_000);
    const minAgeDays = retentionClass === "evidence" ? config.evidenceRetentionDays : rule.minAgeDays;
    const eligible = rule.prunable && ageDays >= minAgeDays;
    files.push({
      path: relative(root, path),
      class: retentionClass,
      ageDays,
      bytes: stats.size,
      eligible,
      // Say why it is kept, not merely that it is. "Protected" with no reason is
      // the kind of message that gets a --force flag added to it.
      keptBecause: eligible ? null : (rule.prunable ? `younger than the ${minAgeDays}-day minimum for ${retentionClass}` : rule.reason),
    });
  }

  const selected = classes ? files.filter((file) => classes.includes(file.class)) : files;
  const eligible = selected.filter((file) => file.eligible);

  return {
    version: 1,
    asOf: new Date(now).toISOString(),
    available: warnings.length === 0,
    warnings,
    stateRoot: root,
    // A plan is a proposal. Nothing in this object has happened.
    applied: false,
    storage: storageByClass(files),
    totals: {
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      eligibleFiles: eligible.length,
      eligibleBytes: eligible.reduce((sum, file) => sum + file.bytes, 0),
      protectedFiles: files.filter((file) => !RETENTION_CLASSES[file.class].prunable).length,
    },
    // The exact, validated target list. The CLI refuses to act on a plan whose
    // count no longer matches.
    eligible: eligible.sort((a, b) => b.ageDays - a.ageDays),
  };
}

// Backup freshness and integrity. Reports; never creates or moves a backup, and
// never touches a backup destination — changing one is a founder decision.
export function inspectBackupHealth({ backupDir, maxAgeHours = 24, now = Date.now(), pattern = /\.(sql\.gz|tar\.gz|ndjson\.gz|zip)$/ } = {}) {
  const warnings = [];
  if (!backupDir) return { version: 1, configured: false, status: "not-configured", warnings: ["No backup directory is configured."], latest: null, backups: 0, bytes: 0 };
  if (!existsSync(backupDir)) {
    return { version: 1, configured: true, status: "missing", backupDir, warnings: [`Backup directory ${backupDir} does not exist.`], latest: null, backups: 0, bytes: 0 };
  }

  let entries = [];
  try {
    entries = readdirSync(backupDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => {
        const path = join(backupDir, entry.name);
        const stats = statSync(path);
        return { name: entry.name, bytes: stats.size, mtime: new Date(stats.mtimeMs).toISOString(), ageHours: round((now - stats.mtimeMs) / 3_600_000) };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch (error) {
    return { version: 1, configured: true, status: "unreadable", backupDir, warnings: [`Backup directory unreadable: ${error.message}`], latest: null, backups: 0, bytes: 0 };
  }

  const latest = entries[0] || null;
  if (!latest) warnings.push(`No backup archives found in ${backupDir}.`);
  else if (latest.ageHours > maxAgeHours) warnings.push(`Latest backup is ${latest.ageHours}h old, past the ${maxAgeHours}h bound.`);
  // A zero-byte archive is worse than none: it looks like a backup.
  if (latest && latest.bytes === 0) warnings.push(`Latest backup ${latest.name} is empty.`);

  const failureMarker = readFailureMarker(backupDir);
  if (failureMarker) warnings.push(`Backup failure marker present: ${failureMarker.message}`);

  return {
    version: 1,
    configured: true,
    status: warnings.length ? "warning" : "ok",
    backupDir,
    maxAgeHours,
    latest: latest ? { ...latest, sha256: hashOf(join(backupDir, latest.name), warnings) } : null,
    backups: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    lastFailure: failureMarker,
    warnings,
  };
}

export function buildRetentionSnapshot({ hqRoot, stateRoot = null, backupDir = null, maxAgeHours = 24, now = Date.now() } = {}) {
  const plan = planRetention({ hqRoot, stateRoot, now });
  const backups = inspectBackupHealth({ backupDir: backupDir || process.env.FACTORY_BACKUP_DIR || null, maxAgeHours, now });
  return {
    version: 1,
    asOf: new Date(now).toISOString(),
    available: plan.available && backups.status !== "unreadable",
    warnings: [...plan.warnings, ...backups.warnings],
    storage: plan.storage,
    totals: plan.totals,
    backups,
    // Restated at the top level so no consumer has to infer it.
    destructiveActionsRequireOperator: true,
  };
}

// ------------------------------------------------------------------ internals

function storageByClass(files) {
  const out = {};
  for (const file of files) {
    const bucket = out[file.class] ||= { files: 0, bytes: 0, eligibleFiles: 0, eligibleBytes: 0, prunable: RETENTION_CLASSES[file.class].prunable };
    bucket.files += 1;
    bucket.bytes += file.bytes;
    if (file.eligible) {
      bucket.eligibleFiles += 1;
      bucket.eligibleBytes += file.bytes;
    }
  }
  return out;
}

function readRetentionConfig(hqRoot, warnings) {
  const defaults = { evidenceRetentionDays: 90 };
  if (!hqRoot) return defaults;
  try {
    const config = JSON.parse(readFileSync(join(resolve(hqRoot), "factory", "factory.config.json"), "utf8"));
    const days = config?.learning?.evidenceRetentionDays;
    return Number.isInteger(days) && days > 0 ? { evidenceRetentionDays: days } : defaults;
  } catch (error) {
    warnings.push(`factory.config.json retention settings unavailable: ${error.message}`);
    return defaults;
  }
}

function readFailureMarker(backupDir) {
  for (const name of ["backup.failure", "db-backup.failure", "db-backup-to-s3.failure"]) {
    const path = join(backupDir, name);
    if (!existsSync(path)) continue;
    try {
      const stats = statSync(path);
      const message = readFileSync(path, "utf8").trim().split(/\r?\n/)[0] || "A backup failure marker is present.";
      return { path: name, mtime: new Date(stats.mtimeMs).toISOString(), message: message.slice(0, 300) };
    } catch {
      return { path: name, mtime: null, message: "A backup failure marker is present but unreadable." };
    }
  }
  return null;
}

function hashOf(path, warnings) {
  try {
    // Integrity of the archive as stored. Reading it is the only way to know it
    // is not truncated, and a backup nobody has ever read is a hope, not a backup.
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (error) {
    warnings.push(`Latest backup could not be hashed: ${error.message}`);
    return null;
  }
}

function walk(root, warnings, out = []) {
  if (!existsSync(root)) {
    warnings.push(`state root ${root} does not exist yet`);
    return out;
  }
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    warnings.push(`${root} unreadable: ${error.message}`);
    return out;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walk(path, warnings, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function round(value) {
  return Math.round(value * 10) / 10;
}
