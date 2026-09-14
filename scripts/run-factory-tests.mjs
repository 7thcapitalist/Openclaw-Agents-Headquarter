#!/usr/bin/env node
// Runs the factory test suite so that a broken test damages only this run.
//
// Three independent guards, because the suite has produced all three failures:
//
//   1. `--test-timeout` fails any single test/subtest that overruns it.
//   2. A hard wall-clock ceiling on the whole child process, independent of
//      (1), for a hang outside an individual test (setup, teardown, an import
//      that never resolves). See
//      docs/software-factory/handoffs/2026-09-09-reliability-overhaul.md item 2:
//      a stale `for (;;)` wait once made `npm run test:factory` run forever.
//   3. A private TMPDIR per run. 58 test files call `mkdtempSync(join(tmpdir(),
//      ...))` and only one removes what it created, so the suite used to leak
//      roughly 500 directories into the shared /tmp per run. Pointing TMPDIR at
//      one per-run root makes every fixture land inside it, so a single removal
//      collects all of them without touching the 58 call sites.
//
//      That root is named for this process, and the leftover sweep skips any
//      root whose owner is still alive. This repository runs several agent
//      sessions against one checkout by design, so two suites overlap often —
//      and a sweep that deleted every matching root would pull a live run's
//      fixtures out from under it. That is not hypothetical: it failed five
//      tests with ENOENT on a root that had just been created.
//
// (1) and (2) are generous relative to the suite's normal ~70-130s: they exist
// to convert a hang into a documented failure, not to police normal runtime.
import { spawn } from "node:child_process";
import { existsSync, globSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const PER_TEST_TIMEOUT_MS = 120_000;
const SUITE_WALL_CLOCK_MS = 600_000;
const TMP_PREFIX = "hq-factory-tests-";

// Both levels on purpose. `factory/test/*.test.mjs` alone is single-level, so a
// test placed in a subdirectory is silently never run — factory/test/store/
// arrived with 26 passing tests that the suite did not execute, and a suite
// that quietly skips tests is worse than one that fails.
const files = [...new Set([
  ...globSync("factory/test/*.test.mjs"),
  ...globSync("factory/test/**/*.test.mjs"),
])].sort();
if (files.length === 0) {
  console.error("No files matched factory/test/*.test.mjs. Run this from the repository root.");
  process.exit(1);
}

// This run's root is claimed FIRST and carries our pid, so the sweep below can
// tell it apart from anyone else's.
const runTmp = mkdtempSync(join(tmpdir(), `${TMP_PREFIX}${process.pid}-`));

// A failing run keeps its fixtures for inspection, so collect earlier runs'
// leftovers now rather than leaving them for the next operator — but never a
// root whose owning process is still running, and never our own.
const ownRoot = basename(runTmp);
for (const name of safeReadDir(tmpdir())) {
  if (!name.startsWith(TMP_PREFIX) || name === ownRoot) continue;
  if (isRunning(ownerPid(name))) continue;
  rmSync(join(tmpdir(), name), { recursive: true, force: true });
}

// `hq-factory-tests-<pid>-XXXXXX` -> <pid>. Roots left by the older naming have
// no pid segment and parse to NaN, which reads as "not running" and gets swept.
function ownerPid(name) {
  return Number.parseInt(name.slice(TMP_PREFIX.length).split("-")[0], 10);
}

function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // Signal 0 performs the permission and existence checks without delivering
  // anything. EPERM means the process exists but is not ours — still alive.
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

// Workspaces whose dependencies the suite actually imports.
//
// The repository root declares no dependencies, so it is easy to assume there
// is nothing to install. There is: `control-plane/` declares `@vercel/blob`,
// and nine tests import the API routes that use it. CI installs both
// workspaces explicitly (.github/workflows/factory-tests.yml), so this only
// ever bit developer machines — as nine identical ERR_MODULE_NOT_FOUND stacks
// that say nothing about the cause. Say it once, plainly, before running
// anything.
const WORKSPACES = [
  ["dashboard/backend", "the dashboard's CSRF, CSP, session and stored-XSS tests"],
  ["control-plane", "the control-plane API route tests (@vercel/blob)"],
];

const uninstalled = WORKSPACES.filter(([dir]) => !existsSync(join(dir, "node_modules")));
if (uninstalled.length) {
  console.error("Dependencies are missing, so part of the suite cannot run:\n");
  for (const [dir, what] of uninstalled) console.error(`  ${dir}/node_modules  — needed by ${what}`);
  console.error("\nRun `npm run setup` from the repository root, then try again.");
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ["--test", `--test-timeout=${PER_TEST_TIMEOUT_MS}`, ...files],
  { stdio: "inherit", env: { ...process.env, TMPDIR: runTmp } },
);

let killedForTimeout = false;
const killer = setTimeout(() => {
  killedForTimeout = true;
  console.error(
    `\nfactory test suite exceeded its ${SUITE_WALL_CLOCK_MS}ms wall-clock bound and was killed. `
    + "This is the outer safety net, not the normal path: a passing suite finishes well inside it.",
  );
  child.kill("SIGKILL");
}, SUITE_WALL_CLOCK_MS);
killer.unref();

child.on("exit", (code, signal) => {
  clearTimeout(killer);
  const failed = killedForTimeout || Boolean(signal) || code !== 0;
  if (failed) {
    console.error(`test fixtures kept for inspection at ${runTmp} (removed on the next run)`);
  } else {
    rmSync(runTmp, { recursive: true, force: true });
  }
  if (killedForTimeout) process.exit(1);
  if (signal) {
    console.error(`factory test suite terminated by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

function safeReadDir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
