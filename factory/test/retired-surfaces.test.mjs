// Four dashboard pages were retired on 2026-09-15: SOPs, Logs, Reports, Runs.
//
// Each answered a real question with a fake answer. SOPs and Reports read
// 3-byte empty arrays that nothing had ever written to. Logs and Runs read
// `agent_runs`, a pre-factory table holding one row, while the factory's real
// record — 1,272 events across 21 tasks — lived somewhere those pages never
// looked. All four were reachable from the main nav, so the founder could open
// "Reports" and be told, truthfully and uselessly, that there were none.
//
// This pins the retirement. Re-adding one should take an argument, not a
// rebase, and a page that comes back must come back with a real backing store.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const APP = readFileSync(new URL("../../dashboard/backend/public/app.js", import.meta.url), "utf8");
const SERVER = readFileSync(new URL("../../dashboard/backend/server.mjs", import.meta.url), "utf8");
const RETIRED = ["sops", "logs", "reports", "runs"];

test("no retired page is in the navigation", () => {
  const nav = APP.slice(APP.indexOf("function buildNav()"), APP.indexOf("function buildNav()") + 900);
  const back = RETIRED.filter((name) => nav.includes(`"#/${name}"`));
  assert.deepEqual(back, [],
    `these pages were retired but are in the nav again: ${back.join(", ")}.\n`
    + "If one is genuinely back, it needs a backing store that something writes to.");
});

test("no retired page has a render function", () => {
  const back = RETIRED
    .map((name) => `render${name[0].toUpperCase()}${name.slice(1)}`)
    .filter((fn) => APP.includes(`function ${fn}(`));
  assert.deepEqual(back, [], `retired render functions are back: ${back.join(", ")}`);
});

test("the collections nothing writes to are no longer served", () => {
  // `/api/hq/agents` stays: it is a fallback roster for an install with no
  // factory/agents.json, and is already excused in today-panel-wiring.
  for (const name of ["tasks", "sops", "reports", "logs"]) {
    assert.ok(!SERVER.includes(`\`/api/hq/${name}\``) && !SERVER.includes(`"/api/hq/${name}"`),
      `/api/hq/${name} is served again, but nothing writes that collection`);
  }
  assert.match(SERVER, /for \(const name of \["agents"\]\)/,
    "the HQ collection loop should serve only the agents fallback");
});

test("the pre-factory run history is no longer served", () => {
  // Agent Lab's own last-run lookup still reads `agent_runs` directly and is
  // deliberately untouched; what went is the founder-facing browse of it.
  assert.ok(!SERVER.includes('app.get("/api/runs"'), "/api/runs is back");
  assert.ok(!SERVER.includes('app.get("/api/runs/:runId"'), "/api/runs/:runId is back");
  assert.ok(SERVER.includes("/api/agents/:project/:id"), "Agent Lab's own agent route must survive the retirement");
});

test("a bookmark to a retired page says where its content went", () => {
  // Falling through to Today would look like the page had simply moved, and
  // the founder would keep looking for it.
  assert.match(APP, /const RETIRED = \{/);
  for (const name of RETIRED) {
    assert.match(APP, new RegExp(`\\n\\s{4}${name}: \\{`), `${name} has no retirement notice`);
  }
  assert.match(APP, /function renderRetired\(/);
});

test("every retirement notice explains itself", () => {
  const block = APP.slice(APP.indexOf("const RETIRED = {"), APP.indexOf("function parseRoute()"));
  for (const name of RETIRED) {
    const why = new RegExp(`${name}: \\{[\\s\\S]{0,400}?why: "([^"]{40,})"`).exec(block);
    assert.ok(why, `${name} is retired without a reason the founder can read`);
  }
});

test("the demo seed is gone, not merely unreferenced", () => {
  const root = new URL("../../", import.meta.url);
  assert.ok(!existsSync(new URL("examples/hq", root)), "examples/hq is back");
  assert.ok(!existsSync(new URL("scripts/seed-hq.sh", root)), "scripts/seed-hq.sh is back");

  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  assert.ok(!("seed:hq" in pkg.scripts), "the seed:hq script is back");

  // The README told every new install to run it. A Quick Start that seeds
  // fake data into a real console is how the Board came to claim example
  // data that did not exist.
  const readme = readFileSync(new URL("README.md", root), "utf8");
  assert.ok(!readme.includes("seed:hq"), "the README still tells a new install to seed demo data");
});

test("the real agent roster ships, so nothing needed the demo fallback", () => {
  // This is why removing the seed is safe rather than merely tidy:
  // `liveAgents` reads factory/agents.json and only falls back to the demo
  // collection when that yields nothing — which it never does.
  const roster = JSON.parse(readFileSync(new URL("../agents.json", import.meta.url), "utf8"));
  const agents = Array.isArray(roster) ? roster : roster.agents;
  assert.ok(Array.isArray(agents) && agents.length > 0, "factory/agents.json must ship a real roster");
});

// ── and the report the Reports tab never called ───────────────────────────

test("the execution view offers the report, not just the pull request", () => {
  // `/api/founder/tasks/:id/report` has always worked. The retired Reports
  // tab read an empty file instead of calling it, and the execution view —
  // the screen a founder actually opens from the Board — offered the PR and
  // nothing else. The one durable thing the factory writes about a finished
  // task was unreachable from the screen about that task.
  assert.match(APP, /data-open-report="/, "the execution view has no report button");
  assert.match(APP, /function wireReportButton\(\)/);
  // Both openers must identify what they are showing, or the button cannot
  // know which report to ask for.
  assert.match(APP, /renderExecutionView\(execution, undefined, undefined, \{ kind: "objective", id \}\)/);
  assert.match(APP, /renderExecutionView\(execution, thread, timeline, \{ kind: "task", id \}\)/);
});

test("the report route is called for both kinds of work", () => {
  assert.match(APP, /\/api\/founder\/tasks\/\$\{id\}\/report/);
  assert.match(APP, /\/api\/founder\/objectives\/\$\{id\}\/report/);
});
