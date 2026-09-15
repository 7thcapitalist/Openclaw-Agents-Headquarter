#!/usr/bin/env node
// Aggregate the dashboard's request log into an answer to "which of these routes
// do I actually use?".
//
// The dashboard carries ~82 routes. An audit found ~25 with no UI caller, five
// surfaces rendering nothing, and two tabs reading the wrong database. Deleting
// against that audit alone is inference; this aggregates real traffic instead.
//
//   node scripts/hq-route-usage.mjs                 # summary
//   node scripts/hq-route-usage.mjs --unused        # routes the server has but nobody called
//   node scripts/hq-route-usage.mjs --errors        # non-2xx, worst first
//   node scripts/hq-route-usage.mjs --slow          # slowest routes by p95
//   node scripts/hq-route-usage.mjs --since 7d
//   node scripts/hq-route-usage.mjs --json
//
// Read-only. Touches nothing but the log files.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const DEFAULT_LOG = join(REPO_ROOT, "dashboard", "backend", "data", "requests.ndjson");
const SERVER_FILE = join(REPO_ROOT, "dashboard", "backend", "server.mjs");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const logFile = value("file", process.env.DASHBOARD_REQUEST_LOG || DEFAULT_LOG);

function parseSince(spec) {
  if (!spec) return 0;
  const m = String(spec).match(/^(\d+)([hd])$/);
  if (!m) {
    console.error(`unrecognised --since "${spec}"; use e.g. 24h or 7d`);
    process.exit(1);
  }
  const ms = Number(m[1]) * (m[2] === "h" ? 3_600_000 : 86_400_000);
  return Date.now() - ms;
}
const sinceMs = parseSince(value("since"));

// ── read ─────────────────────────────────────────────────────────────────────

function readEntries() {
  const entries = [];
  // Oldest first: the rotated file predates the live one.
  for (const file of [`${logFile}.1`, logFile]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a torn final line from a crash mid-append
      }
      if (sinceMs && Date.parse(entry.at) < sinceMs) continue;
      entries.push(entry);
    }
  }
  return entries;
}

// Routes the server declares, so we can report the ones with zero traffic.
// A regex over the source is approximate by nature — it will miss routes built
// dynamically — so treat a "never called" row as a candidate to check, not a
// verdict to act on blindly.
function declaredRoutes() {
  if (!existsSync(SERVER_FILE)) return [];
  const src = readFileSync(SERVER_FILE, "utf8");
  const found = new Set();
  const re = /\bapp\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
  let m;
  while ((m = re.exec(src))) found.add(`${m[1].toUpperCase()} ${m[2]}`);
  return [...found].sort();
}

// Express params (:id, :taskId) must collapse the same way requestLog collapses
// real path segments, or nothing will ever match.
function normalizeDeclared(path) {
  return (
    "/" +
    path
      .split("/")
      .filter(Boolean)
      .map((s) => (s.startsWith(":") ? ":id" : s))
      .join("/")
  );
}

// ── aggregate ────────────────────────────────────────────────────────────────

const entries = readEntries();
if (entries.length === 0) {
  console.log(`No request log yet at ${logFile}`);
  console.log("The dashboard writes it once lib/requestLog.mjs is live — restart hq-dashboard, then use it for a few days.");
  process.exit(0);
}

const byRoute = new Map();
for (const e of entries) {
  const key = `${e.method} ${e.route}`;
  let row = byRoute.get(key);
  if (!row) {
    row = { key, method: e.method, route: e.route, count: 0, errors: 0, aborted: 0, durations: [], lastAt: e.at, api: e.api };
    byRoute.set(key, row);
  }
  row.count += 1;
  if (e.status >= 400) row.errors += 1;
  if (e.aborted) row.aborted += 1;
  row.durations.push(e.durationMs ?? 0);
  if (e.at > row.lastAt) row.lastAt = e.at;
}

const percentile = (sorted, p) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

for (const row of byRoute.values()) {
  const sorted = row.durations.sort((a, b) => a - b);
  row.p50 = Math.round(percentile(sorted, 50) * 10) / 10;
  row.p95 = Math.round(percentile(sorted, 95) * 10) / 10;
  delete row.durations;
}

const rows = [...byRoute.values()].sort((a, b) => b.count - a.count);
const first = entries.reduce((min, e) => (e.at < min ? e.at : min), entries[0].at);
const last = entries.reduce((max, e) => (e.at > max ? e.at : max), entries[0].at);
const spanHours = Math.max(0.01, (Date.parse(last) - Date.parse(first)) / 3_600_000);

if (flag("json")) {
  console.log(JSON.stringify({ window: { first, last, spanHours }, total: entries.length, routes: rows }, null, 2));
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

console.log(`\nRequest log: ${logFile}`);
console.log(`Window: ${first}  →  ${last}  (${spanHours.toFixed(1)}h)`);
console.log(`Requests: ${entries.length.toLocaleString()}  ·  ${(entries.length / spanHours).toFixed(1)}/h  ·  ${rows.length} distinct routes\n`);

// ── --unused ─────────────────────────────────────────────────────────────────

if (flag("unused")) {
  const seen = new Set(rows.map((r) => r.key));
  const never = declaredRoutes().filter((d) => {
    const [method, path] = d.split(" ");
    return !seen.has(`${method} ${normalizeDeclared(path)}`);
  });
  console.log(`Declared in server.mjs but never called in this window — ${never.length} route(s):\n`);
  for (const route of never) console.log(`  ${route}`);
  console.log(`\nThese are deletion candidates. Verify each before removing: a route used`);
  console.log(`only during an incident, or mounted dynamically, will also show up here.`);
  process.exit(0);
}

// ── --errors ─────────────────────────────────────────────────────────────────

if (flag("errors")) {
  const bad = rows.filter((r) => r.errors > 0).sort((a, b) => b.errors - a.errors);
  if (bad.length === 0) {
    console.log("No non-2xx responses in this window.");
    process.exit(0);
  }
  console.log(`${pad("ROUTE", 52)} ${num("ERRORS", 7)} ${num("CALLS", 7)}  RATE`);
  for (const r of bad) {
    console.log(`${pad(r.key, 52)} ${num(r.errors, 7)} ${num(r.count, 7)}  ${((r.errors / r.count) * 100).toFixed(1)}%`);
  }
  process.exit(0);
}

// ── --slow ───────────────────────────────────────────────────────────────────

if (flag("slow")) {
  const slow = [...rows].sort((a, b) => b.p95 - a.p95).slice(0, 25);
  console.log(`${pad("ROUTE", 52)} ${num("P95 ms", 9)} ${num("P50 ms", 9)} ${num("CALLS", 7)}`);
  for (const r of slow) {
    console.log(`${pad(r.key, 52)} ${num(r.p95, 9)} ${num(r.p50, 9)} ${num(r.count, 7)}`);
  }
  process.exit(0);
}

// ── default summary ──────────────────────────────────────────────────────────

console.log(`${pad("ROUTE", 52)} ${num("CALLS", 7)} ${num("/HOUR", 8)} ${num("P95 ms", 8)} ${num("ERR", 5)}`);
for (const r of rows.slice(0, 40)) {
  console.log(
    `${pad(r.key, 52)} ${num(r.count, 7)} ${num((r.count / spanHours).toFixed(1), 8)} ${num(r.p95, 8)} ${num(r.errors, 5)}`
  );
}
if (rows.length > 40) console.log(`\n… ${rows.length - 40} more (use --json for all)`);

const apiCalls = entries.filter((e) => e.api).length;
const errorCalls = entries.filter((e) => e.status >= 400).length;
const abortedCalls = entries.filter((e) => e.aborted).length;
console.log(`\nAPI ${apiCalls.toLocaleString()} · static ${(entries.length - apiCalls).toLocaleString()} · errors ${errorCalls.toLocaleString()} · aborted ${abortedCalls.toLocaleString()}`);
console.log(`\nNext: --unused for deletion candidates, --errors for what is breaking, --slow for what to fix.`);
