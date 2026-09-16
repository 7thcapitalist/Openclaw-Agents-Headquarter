// The address of the machine, on the page you can open from anywhere.
//
// The tunnel is a quick tunnel: it gets a new random *.trycloudflare.com
// hostname every restart — four on this machine already — and after a reboot
// the only record of the live one was a banner inside a 70 MB log file. The
// hosted console is reachable from a phone, which makes it the right place to
// keep the current address.
//
// Before this, `readiness` was published by the machine and the console drew it
// in the "does not know how to show it yet" bucket.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { panelsFor, readinessPanel } from "../../control-plane/public/render.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The PUBLISHED shape — `{status, detail}` — which is what this page receives.
// The first version of this feature was written against the dashboard route's
// `{ok, error}` shape and rendered "No direct link" against real data.
const snapshot = (tunnel, rest = {}) => ({
  panels: {
    readiness: { checks: { disk: { status: "ok" }, services: { status: "ok" }, tunnel, ...rest } },
  },
});

test("a reachable tunnel is shown as a link", () => {
  const panel = readinessPanel(snapshot({
    status: "ok", url: "https://increasing-yrs-praise-mailing.trycloudflare.com", connections: 1, quick: true,
  }).panels);

  const link = panel.rows.find((r) => r.link);
  assert.ok(link, "the address must be a link, not prose");
  assert.equal(link.link, "https://increasing-yrs-praise-mailing.trycloudflare.com");
  assert.equal(link.tone, "good");
  assert.ok(panel.rows.some((r) => /changes/i.test(r.primary)),
    "and the founder is told the address will not stay the same");
});

test("an address with no live connection is shown, and marked as not answering", () => {
  const panel = readinessPanel(snapshot({
    status: "warn", detail: "the address has no live connection — it will not answer yet",
    url: "https://example.trycloudflare.com", connections: 0, quick: true,
  }).panels);

  const link = panel.rows.find((r) => r.link);
  assert.equal(link.tone, "bad");
  assert.match(link.secondary, /will not answer/i,
    "offering a link that fails without saying so is worse than no link");
});

test("no tunnel says so instead of showing nothing", () => {
  const panel = readinessPanel(snapshot({ status: "warn", url: null, detail: "no tunnel reachable: connect ECONNREFUSED" }).panels);
  assert.ok(!panel.rows.some((r) => r.link), "there is no link to offer");
  assert.match(panel.rows[0].primary, /No direct link/i);
  assert.equal(panel.rows[0].tone, "bad");
});

test("the other readiness checks ride along, because a link to a dead box is no use", () => {
  const panel = readinessPanel(snapshot(
    { status: "ok", url: "https://x.trycloudflare.com", connections: 1 },
    { gateway: { status: "fail", detail: "not on PATH" } },
  ).panels);

  const gateway = panel.rows.find((r) => r.primary === "gateway");
  assert.equal(gateway.tone, "bad");
  assert.match(gateway.secondary, /not on PATH/);
  assert.match(panel.note, /need attention/);
});

test("an unavailable readiness panel degrades, it does not throw", () => {
  const panel = readinessPanel({ readiness: { unavailable: true, reason: "not published" } });
  assert.deepEqual(panel.rows, []);
  assert.ok(panel.note);
});

test("readiness is drawn first, and is no longer an unknown panel", () => {
  const panels = panelsFor(snapshot({ status: "ok", url: "https://x.trycloudflare.com", connections: 1 }));
  assert.equal(panels[0].title, "Reach Headquarters",
    "'how do I get in' is the question you have when you cannot get in");
  assert.ok(!panels.some((p) => p.unknown && p.title === "readiness"),
    "readiness must not fall through to the unknown bucket any more");
});

// --- the guard ---------------------------------------------------------------

test("only https can become an anchor", () => {
  // The row is drawn from a published snapshot. A row is data, and data does
  // not get to choose a URL scheme.
  const app = readFileSync(join(ROOT, "control-plane", "public", "app.js"), "utf8");
  assert.match(app, /function safeHref/, "the console must filter hrefs");
  assert.match(app, /protocol === "https:"/, "and accept only https");
  assert.match(app, /rel = "noopener noreferrer"/, "and not hand the opener to the target");

  // Behavioural check of the same rule, using the browser's own parser.
  const safeHref = (value) => {
    if (typeof value !== "string" || !value) return null;
    try {
      const url = new URL(value);
      return url.protocol === "https:" ? url.href : null;
    } catch { return null; }
  };
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("data:text/html,<script>1</script>"), null);
  assert.equal(safeHref("http://insecure.example.com"), null);
  assert.equal(safeHref("not a url"), null);
  assert.equal(safeHref(null), null);
  assert.equal(safeHref("https://ok.trycloudflare.com"), "https://ok.trycloudflare.com/");
});
