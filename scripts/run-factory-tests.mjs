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
// (1) and (2) are generous relative to the suite's normal ~70-130s: they exist
// to convert a hang into a documented failure, not to police normal runtime.
import { spawn } from "node:child_process";
import { globSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PER_TEST_TIMEOUT_MS = 120_000;
const SUITE_WALL_CLOCK_MS = 600_000;
const TMP_PREFIX = "hq-factory-tests-";

const files = globSync("factory/test/*.test.mjs").sort();
if (files.length === 0) {
  console.error("No files matched factory/test/*.test.mjs. Run this from the repository root.");
  process.exit(1);
}

// A failing run keeps its fixtures for inspection, so collect the previous
// run's leftovers now rather than leaving them for the next operator.
for (const name of safeReadDir(tmpdir())) {
  if (name.startsWith(TMP_PREFIX)) rmSync(join(tmpdir(), name), { recursive: true, force: true });
}
const runTmp = mkdtempSync(join(tmpdir(), TMP_PREFIX));

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
