// Whether the intent worker actually RUNS when a process manager starts it.
//
// On 2026-09-15 it did not, and nothing said so. #258 added an entry guard
// comparing `process.argv[1]` to this module's own path, so that a test could
// import the handler map without starting a poller. Under pm2 in fork mode that
// comparison is always false: pm2 loads the script inside its own wrapper, so
// argv[1] is `.../pm2/lib/ProcessContainerFork.js` and argv[2] is the real
// argument. The worker therefore ran nothing, printed nothing, and stayed
// `online` with a zero-byte log, because pm2's IPC channel keeps the process
// alive whether or not the module did any work.
//
// It stayed hidden for hours only because the live worker had been started at
// 02:33, before #258 merged at 14:50, and a long-running node process keeps the
// code it loaded. The next restart was going to take the founder's entire
// intent pipeline down silently. These tests are about that failure mode:
// "started, online, and doing nothing" must not be reachable.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKER = join(ROOT, "scripts", "hq-intents.mjs");

// `peek` executes nothing and talks to no network — it prints the handler map
// and exits — so it is the safe mode to prove the entry point is reached.
async function runPeek() {
  const { stdout } = await execFileAsync(process.execPath, [WORKER, "peek"], {
    cwd: ROOT,
    timeout: 60_000,
    // No control-plane credentials: peek must not need them.
    env: { ...process.env, HQ_CONTROL_PLANE_URL: "", HQ_WRITE_TOKEN: "" },
  });
  return stdout;
}

test("the worker reaches its entry point when started normally", async () => {
  const stdout = await runPeek();
  const report = JSON.parse(stdout);
  assert.ok(Array.isArray(report.registeredHandlers), "peek must print the handler map");
  assert.ok(report.registeredHandlers.includes("decision.resolve"));
});

// The regression itself. Before the fix this produced empty stdout and exit 0 —
// the exact signature of the silent worker.
test("the entry point does not depend on argv[1] being this file", async () => {
  const source = readFileSync(WORKER, "utf8");
  assert.ok(
    !/resolve\(process\.argv\[1\]\)\s*===\s*fileURLToPath\(import\.meta\.url\)/.test(source),
    "the entry guard must not compare argv[1] to this module — a process manager's wrapper occupies argv[1]",
  );
});

// The real reproduction: run the worker the way pm2 runs it. pm2 does not exec
// the script — it IMPORTS it from its own container, so argv[1] is the
// container and argv[2] is the mode. A wrapper that does the same thing is a
// faithful stand-in and needs no pm2 installed.
test("a mode is honoured when a process manager owns argv[1]", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm2-shim-"));
  const wrapper = join(dir, "ProcessContainerFork.mjs");
  writeFileSync(wrapper, `await import(${JSON.stringify(pathToFileURL(WORKER).href)});\n`, "utf8");

  const { stdout } = await execFileAsync(process.execPath, [wrapper, "peek"], {
    cwd: ROOT,
    timeout: 60_000,
    env: { ...process.env, HQ_CONTROL_PLANE_URL: "", HQ_WRITE_TOKEN: "" },
  });

  // Before the fix this was empty: the guard compared argv[1] — the wrapper —
  // against the worker's own path, matched nothing, and exited 0 having done
  // nothing at all.
  assert.notEqual(stdout.trim(), "", "the worker must run when a wrapper owns argv[1]");
  const report = JSON.parse(stdout);
  assert.ok(report.registeredHandlers.includes("decision.resolve"),
    "and must reach the same handler map it reaches when started directly");
});

test("importing the module runs nothing — the property the guard exists for", async () => {
  // `node --test <file>` leaves argv[2] undefined, so a test that imports the
  // worker for its handler map must not start a poller. Proven by importing it
  // here: if the CLI ran, this would hang on the poll loop or throw on the
  // missing credential.
  const module = await import(WORKER);
  assert.equal(typeof module.handlers, "function", "the handler map is importable");
});

test("an unrecognised mode fails loudly instead of doing nothing", async () => {
  await assert.rejects(
    () => execFileAsync(process.execPath, [WORKER, "definitely-not-a-mode"], { cwd: ROOT, timeout: 60_000 }),
    (error) => {
      assert.equal(error.code, 2, "exit 2, not a silent success");
      assert.match(error.stderr, /unknown mode/);
      return true;
    },
  );
});
