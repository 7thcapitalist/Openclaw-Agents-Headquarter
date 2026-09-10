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
import { readFileSync } from "fs";

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

test("every panel imported into app.js is actually rendered", () => {
  const imported = [...APP.matchAll(/import \{ (\w*[Pp]anel) \} from "\/lib\/\w+\.mjs";/g)].map((match) => match[1]);
  assert.ok(imported.length >= 4, "the Today view should import several panels");
  for (const panel of imported) {
    assert.ok(new RegExp(`\\$\\{${panel}\\(`).test(APP), `${panel} is imported but never rendered`);
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
