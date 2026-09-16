// The address has to survive the whole way: probe -> published snapshot ->
// the panel the hosted console draws.
//
// The first version of this feature put the probe in the dashboard's own
// readiness module. That module feeds `/api/system/readiness` and nothing else.
// The snapshot the console renders is built by factory/lib/hq/readiness.mjs,
// which knew nothing about it — so the console, which is the ONLY place the
// address actually matters (it is the page you can open from a phone), went on
// rendering "No direct link" against real data. Every unit test passed.
//
// This test exists because no unit test could have caught that. It asserts the
// join.

import test from "node:test";
import assert from "node:assert/strict";

import { buildReadinessSnapshot, checkTunnel } from "../lib/hq/readiness.mjs";
import { readinessPanel } from "../../control-plane/public/render.mjs";

// A stand-in for cloudflared's metrics server, injected rather than listened on
// so the test needs no port and no cloudflared.
function fakeCloudflared({ hostname = "increasing-yrs-praise-mailing.trycloudflare.com", connections = 1 } = {}) {
  return async (url) => {
    if (url.endsWith("/quicktunnel")) {
      return { ok: true, json: async () => ({ hostname }) };
    }
    if (url.endsWith("/ready")) {
      return { ok: true, json: async () => ({ status: 200, readyConnections: connections }) };
    }
    throw new Error(`unexpected ${url}`);
  };
}

test("the probe reports a reachable tunnel", async () => {
  const t = await checkTunnel({ fetchImpl: fakeCloudflared() });
  assert.equal(t.status, "ok");
  assert.equal(t.url, "https://increasing-yrs-praise-mailing.trycloudflare.com");
  assert.equal(t.connections, 1);
});

test("an address with no live connection is a warning, not a pass", async () => {
  const t = await checkTunnel({ fetchImpl: fakeCloudflared({ connections: 0 }) });
  assert.equal(t.status, "warn");
  assert.ok(t.url, "the address is still reported — it is the next restart's problem, not a secret");
  assert.match(t.detail, /will not answer/i);
});

test("no cloudflared at all is a warning that names itself, never a throw", async () => {
  const t = await checkTunnel({ fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); } });
  assert.equal(t.status, "warn");
  assert.equal(t.url, null);
  assert.match(t.detail, /no tunnel reachable/);
});

test("a hanging metrics server cannot hold the publisher open", async () => {
  const started = Date.now();
  const t = await checkTunnel({
    fetchImpl: (url, { signal }) => new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }),
    timeoutMs: 200,
  });
  assert.equal(t.status, "warn");
  assert.ok(Date.now() - started < 5000, "the probe is bounded");
});

// ── the join this test exists for ────────────────────────────────────────────

test("the PUBLISHED snapshot carries the address, and the console renders it", async () => {
  const snapshot = await buildReadinessSnapshot({
    hqRoot: process.cwd(),
    fetchImpl: fakeCloudflared(),
    ttlMs: 0,
  });

  // 1. the publisher's own panel must carry it — this is what was missing
  assert.ok(snapshot.checks.tunnel, "the published readiness panel must carry a tunnel check");
  assert.equal(snapshot.checks.tunnel.url, "https://increasing-yrs-praise-mailing.trycloudflare.com");

  // 2. and the console must turn it into a link
  const panel = readinessPanel({ readiness: snapshot });
  const link = panel.rows.find((r) => r.link);
  assert.ok(link, "the console must render the published address as a link");
  assert.equal(link.link, "https://increasing-yrs-praise-mailing.trycloudflare.com");
});

test("both readiness builders use the one probe", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

  const dash = readFileSync(join(root, "dashboard", "backend", "lib", "readiness.mjs"), "utf8");
  assert.match(dash, /import \{ checkTunnel \}/,
    "the dashboard must import the probe, not keep a second copy");
  assert.ok(!/\/quicktunnel/.test(dash),
    "and must not talk to the metrics endpoint itself — that is how the two drifted");
});
