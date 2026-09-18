// The Today view fetches N endpoints in one Promise.all and destructures the
// results positionally. Several agent sessions add panels to it in parallel, so
// a rebase can land a new fetch without its name — every later binding then
// silently shifts by one and each panel renders another panel's data. That
// happened while adding the decisions panel: five fetches, four names.
//
// Positional destructuring cannot be made safe by review alone, so this asserts
// the invariant structurally.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "fs";

const APP = readFileSync(new URL("../../dashboard/backend/public/app.js", import.meta.url), "utf8");

function renderTodayBlock() {
  const start = APP.indexOf("async function renderToday()");
  assert.notEqual(start, -1, "renderToday() must exist");
  const open = APP.indexOf("await Promise.all([", start);
  assert.notEqual(open, -1, "renderToday() must load its data in one Promise.all");
  const close = APP.indexOf("]);", open);
  return { header: APP.slice(start, open), body: APP.slice(open, close) };
}

test("every value the Today view fetches has a name bound to it", () => {
  const { header, body } = renderTodayBlock();
  const names = /const \[([^\]]+)\]/.exec(header);
  assert.ok(names, "the results must be destructured by name");
  const bound = names[1].split(",").map((name) => name.trim()).filter(Boolean);
  // One entry per top-level call in the array: `apiJson(...)` or `loadX()`.
  const fetched = body.split("\n").filter((line) => /^\s{6}\S/.test(line) && line.includes("(")).length;
  assert.equal(bound.length, fetched,
    `renderToday() fetches ${fetched} values but binds ${bound.length} names — a positional shift silently feeds each panel another panel's data`);
});

// Counting names is not enough. A rebase that inserts a fetch in the middle
// keeps the count correct and still pairs every later name with the wrong
// payload — the retention panel arrived bound to the decisions endpoint that
// way, and the count check above passed. For the `/api/hq/*` fetches the
// convention is exact (binding `planLimits` <- `/api/hq/plan-limits`), so the
// pairing itself can be asserted rather than eyeballed.
test("each /api/hq value is bound to the name that matches its endpoint", () => {
  const { header, body } = renderTodayBlock();
  const bound = /const \[([^\]]+)\]/.exec(header)[1].split(",").map((n) => n.trim()).filter(Boolean);
  const calls = body.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("await Promise.all"));

  const mismatched = [];
  for (const [index, name] of bound.entries()) {
    const endpoint = /apiJson\("\/api\/hq\/([a-z-]+)"/.exec(calls[index] || "");
    if (!endpoint) continue; // founder/* routes and loadX() helpers do not follow the convention
    if (endpoint[1].replace(/-/g, "") !== name.toLowerCase()) mismatched.push(`${name} <- /api/hq/${endpoint[1]}`);
  }
  assert.deepEqual(mismatched, [], `Today bindings paired with the wrong endpoint:\n  ${mismatched.join("\n  ")}`);
});

test("every panel imported into app.js is actually rendered", () => {
  const imported = [...APP.matchAll(/import \{ (\w*[Pp]anel) \} from "\/lib\/\w+\.mjs";/g)].map((match) => match[1]);
  assert.ok(imported.length >= 4, "the Today view should import several panels");
  for (const panel of imported) {
    // Two ways a panel legitimately reaches the page: interpolated into the
    // view's template, or written into a container by a handler (the search
    // panel, which has nothing to show until the operator asks). Anything else
    // is an import that renders nothing.
    const interpolated = new RegExp(`\\$\\{${panel}\\(`).test(APP);
    const injected = new RegExp(`innerHTML\\s*=\\s*${panel}\\(`).test(APP);
    assert.ok(interpolated || injected, `${panel} is imported but never rendered`);
  }
});

test("no two panels are rendered from the same value", () => {
  // Panel names and binding names legitimately differ (costLimitsPanel(costs)),
  // so name matching is not the invariant. Feeding two panels the same value is
  // always wrong, and is what a copy-pasted render line produces.
  const { header } = renderTodayBlock();
  const bound = new Set(/const \[([^\]]+)\]/.exec(header)[1].split(",").map((name) => name.trim()));
  const used = new Map();
  for (const [, panel, argument] of APP.matchAll(/\$\{(\w+Panel)\((\w+)[,)]/g)) {
    if (!bound.has(argument)) continue; // rendered from a local, not a Today fetch
    assert.equal(used.has(argument), false,
      `${panel} and ${used.get(argument)} are both rendered from "${argument}"`);
    used.set(argument, panel);
  }
  assert.ok(used.size >= 4, "the Today view should render several fetched panels");
});

// ── Coverage, not just correctness ────────────────────────────────────────
//
// Everything above asserts that a panel which IS wired is wired *correctly*.
// None of it notices a panel that was never wired at all, and that is the
// failure that actually keeps happening: `/api/hq/blast-radius` shipped green
// in #172 with no panel, no fetch and no reference anywhere in the frontend.
// The endpoint works, the tests pass, and the operator cannot see the feature.
//
// So: every GET /api/hq/* route must either be fetched by the frontend, or be
// named below with a reason. The allowlist is the point — it converts "nobody
// noticed" into "somebody decided", and a new route gets neither for free.
const SERVER = readFileSync(new URL("../../dashboard/backend/server.mjs", import.meta.url), "utf8");
const FRONTEND = ["app.js", "cost-limits.mjs"]
  .map((f) => readFileSync(new URL(`../../dashboard/backend/public/${f}`, import.meta.url), "utf8"))
  .concat(
    readdirSync(new URL("../../dashboard/backend/public/lib/", import.meta.url))
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => readFileSync(new URL(`../../dashboard/backend/public/lib/${f}`, import.meta.url), "utf8")),
  )
  .join("\n");

// Routes with no frontend caller, each with the reason it is absent.
// Removing an entry is how a gap gets closed; adding one should need an argument.
const NO_FRONTEND_CALLER = new Map([
  ["/api/hq/agents", "superseded by /api/hq/company, which the Today view already reads"],
  ["/api/hq/projects", "superseded by /api/hq/company"],
  ["/api/hq/projects/:id", "superseded by /api/hq/company"],
  ["/api/hq/projects/:id/profile", "superseded by /api/hq/company"],
  ["/api/hq/command-center", "legacy, predates the founder UI rebuild (#63)"],
  ["/api/hq/idle-trigger", "read-only data contract for the future panel; this milestone explicitly excludes panel UI"],
  // Genuine gaps — real capability the operator currently cannot see.
  // These are the entries to delete; each deletion is a feature becoming visible.
  ["/api/hq/projects/:id/deployment", "superseded by /api/hq/deployments, which the Today panel reads for every project at once"],
]);

test("every /api/hq route is reachable from the frontend, or explicitly excused", () => {
  const routes = [...SERVER.matchAll(/app\.get\("(\/api\/hq\/[^"]*)"/g)].map((m) => m[1]);
  assert.ok(routes.length >= 15, "expected the HQ API surface to be present");

  const unreachable = routes.filter((route) => {
    if (NO_FRONTEND_CALLER.has(route)) return false;
    // A parameterised route is called as a template literal, so match on the
    // literal prefix and suffix either side of the parameter.
    const [head, ...rest] = route.split(/\/:[^/]+/);
    return !(FRONTEND.includes(head) && rest.every((tail) => !tail || FRONTEND.includes(tail)));
  });

  assert.deepEqual(unreachable, [],
    `built but invisible — these routes have no frontend caller:\n  ${unreachable.join("\n  ")}\n`
    + "Wire a panel, or add the route to NO_FRONTEND_CALLER with the reason.");
});

// An excuse that is no longer true is worse than no excuse: it hides a gap that
// has since been closed, and it makes the list above untrustworthy.
test("nothing on the excused list is actually wired", () => {
  const stale = [...NO_FRONTEND_CALLER.keys()].filter((route) => FRONTEND.includes(route.split(/\/:[^/]+/)[0]));
  assert.deepEqual(stale, [],
    `these routes are excused as having no caller, but the frontend calls them:\n  ${stale.join("\n  ")}\n`
    + "Remove them from NO_FRONTEND_CALLER.");
});

// Every route on the list must say why. A bare entry is how "temporarily
// excused" becomes permanent.
test("every excused route carries a reason", () => {
  for (const [route, reason] of NO_FRONTEND_CALLER) {
    assert.ok(reason && reason.trim().length > 12, `${route} is excused without a real reason`);
  }
});

// ── the data has to arrive, not just the panel ────────────────────────────
//
// A panel can be fetched, bound and rendered and still take the whole page
// down. renderToday() binds the fetched values, but the markup lives in
// renderFounderHome(), which receives an explicit destructured object — so a
// panel rendered there from a value nobody passed through is a ReferenceError
// inside a template literal, and the render guard replaces the entire founder
// home with "Error loading page: <name> is not defined".
//
// That is not hypothetical. #146 added the retention panel, fetched `retention`
// in renderToday, rendered `${retentionPanel(retention, ...)}` in
// renderFounderHome, and passed it through at neither the call site nor the
// parameter list. The founder home was dead on load until #175.
test("every panel argument in renderFounderHome is actually passed to it", () => {
  const start = APP.indexOf("function renderFounderHome({");
  assert.notEqual(start, -1, "renderFounderHome() must exist");
  const params = APP.slice(start + "function renderFounderHome({".length, APP.indexOf("})", start))
    .split(",").map((name) => name.trim()).filter(Boolean);

  // The function body: from its signature to the next top-level declaration.
  const bodyEnd = APP.indexOf("\n  function ", start + 1);
  const body = APP.slice(start, bodyEnd === -1 ? APP.length : bodyEnd);

  const missing = [];
  for (const [, panel, argument] of body.matchAll(/\$\{(\w*[Pp]anel)\((\w+)[,)]/g)) {
    // A literal or a local is fine; an identifier that is neither a parameter
    // nor declared in the body is the failure mode above.
    if (params.includes(argument)) continue;
    if (new RegExp(`(const|let|var)\\s+${argument}\\b`).test(body)) continue;
    missing.push(`${panel}(${argument}) — "${argument}" is not a parameter of renderFounderHome`);
  }
  assert.deepEqual(missing, [], `these panels render from a value nobody passes in:\n  ${missing.join("\n  ")}`);
});

// The other half of the same wire: a value renderToday fetches, and
// renderFounderHome declares, must actually be handed over at the call site.
test("every renderFounderHome parameter is supplied at its call site", () => {
  const start = APP.indexOf("function renderFounderHome({");
  const params = APP.slice(start + "function renderFounderHome({".length, APP.indexOf("})", start))
    .split(",").map((n) => n.trim()).filter(Boolean);
  const call = /renderFounderHome\(\{([^}]+)\}\)/.exec(APP);
  assert.ok(call, "renderFounderHome must be called with an object literal");
  const supplied = call[1].split(",").map((n) => n.trim().split(":")[0].trim()).filter(Boolean);

  const undelivered = params.filter((name) => !supplied.includes(name));
  assert.deepEqual(undelivered, [],
    `renderFounderHome declares these but the call site omits them, so they are undefined inside it:\n  ${undelivered.join("\n  ")}`);
});
