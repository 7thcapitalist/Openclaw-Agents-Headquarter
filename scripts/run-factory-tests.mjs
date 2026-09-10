#!/usr/bin/env node
// Runs the factory test suite with two independent bounds so a hung test can
// never hang the suite indefinitely again (see
// docs/software-factory/handoffs/2026-09-09-reliability-overhaul.md, item 2:
// a stale `for (;;)` wait once made `npm run test:factory` run forever):
//
//   1. `--test-timeout` fails any single test/subtest that overruns it.
//   2. A hard wall-clock ceiling on the whole child process, independent of
//      (1), for any hang outside an individual test (setup, teardown, an
//      import that never resolves).
//
// Both are generous relative to the suite's normal ~70-130s: they exist to
// convert a hang into a documented failure, not to police normal runtime.
import { spawn } from "node:child_process";
import { globSync } from "node:fs";

const PER_TEST_TIMEOUT_MS = 120_000;
const SUITE_WALL_CLOCK_MS = 600_000;

const files = globSync("factory/test/*.test.mjs").sort();
if (files.length === 0) {
  console.error("No files matched factory/test/*.test.mjs");
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ["--test", `--test-timeout=${PER_TEST_TIMEOUT_MS}`, ...files],
  { stdio: "inherit" },
);

let killedForTimeout = false;
const killer = setTimeout(() => {
  killedForTimeout = true;
  console.error(
    `\nfactory test suite exceeded its ${SUITE_WALL_CLOCK_MS}ms wall-clock bound and was killed. `
    + "This is the outer safety net, not the normal path: a passing suite finishes in well under this bound.",
  );
  child.kill("SIGKILL");
}, SUITE_WALL_CLOCK_MS);
killer.unref();

child.on("exit", (code, signal) => {
  clearTimeout(killer);
  if (killedForTimeout) {
    process.exit(1);
  }
  if (signal) {
    console.error(`factory test suite terminated by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
