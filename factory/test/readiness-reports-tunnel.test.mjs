// The tunnel's address, reported where the founder can find it.
//
// The tunnel runs as a QUICK tunnel — `cloudflared tunnel --url`, no Cloudflare
// account — so it is issued a new random *.trycloudflare.com hostname on every
// start. Four have been handed out on this machine. After the reboot on
// 2026-09-15 the only record of the live address was a log banner buried in a
// 70 MB file, and the founder had no way to reach Headquarters directly.
//
// cloudflared publishes the address on its own metrics server, so readiness
// asks the process instead of parsing its output.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { buildReadinessReport } from "../../dashboard/backend/lib/readiness.mjs";

// A stand-in for cloudflared's metrics server. `routes` maps path -> handler,
// so each test decides exactly what the tunnel says about itself.
async function withFakeCloudflared(routes, run) {
  const server = createServer((req, res) => {
    const handler = routes[req.url];
    if (!handler) { res.writeHead(404); res.end(); return; }
    handler(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const previous = process.env.HQ_TUNNEL_METRICS;
  process.env.HQ_TUNNEL_METRICS = `127.0.0.1:${port}`;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.HQ_TUNNEL_METRICS;
    else process.env.HQ_TUNNEL_METRICS = previous;
    await new Promise((resolve) => server.close(resolve));
  }
}

const json = (body) => (res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

// buildReadinessReport also probes pm2, openclaw and the db. None of that is
// what these tests are about, so the db is a stub and the rest is allowed to
// fail into the report's own `checks` — which is exactly what it does on a host
// without those tools.
const db = { prepare: () => ({ get: () => ({ ok: 1 }) }) };
const ROOT = "/nonexistent-hq-root-for-readiness-tunnel-test";

test("the live tunnel address is reported", async () => {
  const report = await withFakeCloudflared({
    "/quicktunnel": json({ hostname: "increasing-yrs-praise-mailing.trycloudflare.com" }),
    "/ready": json({ status: 200, readyConnections: 1 }),
  }, () => buildReadinessReport(db, ROOT));

  assert.equal(report.checks.tunnel.url, "https://increasing-yrs-praise-mailing.trycloudflare.com");
  assert.equal(report.checks.tunnel.connections, 1);
  assert.equal(report.checks.tunnel.ok, true, "an address plus a live connection is reachable");
});

test("an address with no live connection is not reachable, and says so", async () => {
  const report = await withFakeCloudflared({
    "/quicktunnel": json({ hostname: "example.trycloudflare.com" }),
    "/ready": json({ status: 503, readyConnections: 0 }),
  }, () => buildReadinessReport(db, ROOT));

  assert.equal(report.checks.tunnel.url, "https://example.trycloudflare.com");
  assert.equal(report.checks.tunnel.connections, 0);
  assert.equal(report.checks.tunnel.ok, false, "cloudflared is up but nothing can reach it");
  assert.ok(
    report.warnings.some((w) => /no live connection/i.test(w)),
    "the founder is told why the link will not work",
  );
});

test("no tunnel at all is a fact, not a failure", async () => {
  // Nothing listening on the metrics port: Headquarters is local-only. That is
  // a state to report, not an error that should take readiness down with it.
  const previous = process.env.HQ_TUNNEL_METRICS;
  process.env.HQ_TUNNEL_METRICS = "127.0.0.1:1"; // nothing listens on port 1
  try {
    const report = await buildReadinessReport(db, ROOT);
    assert.equal(report.checks.tunnel.ok, false);
    assert.equal(report.checks.tunnel.url, null);
    assert.ok(report.checks.tunnel.error, "the reason is recorded");
    assert.ok(report.checks, "the rest of the report still built");
  } finally {
    if (previous === undefined) delete process.env.HQ_TUNNEL_METRICS;
    else process.env.HQ_TUNNEL_METRICS = previous;
  }
});

// The aggregate `ok` is what the founder's readiness panel calls "ready".
// The tunnel must not be able to drag it down: a box with no tunnel is
// local-only, not unhealthy, and saying otherwise would make the panel report
// something untrue about the machine.
test("a tunnel that is down does not make Headquarters itself unready", async () => {
  const rule = (checks) =>
    Object.values(checks).every((c) => c.advisory || c.ok || c.detected === false);
  const healthy = {
    dashboard: { ok: true }, db: { ok: true }, hqData: { ok: true },
    pm2: { ok: true }, openclaw: { ok: true },
    tailscale: { ok: false, detected: false },
  };

  const report = await withFakeCloudflared({
    "/quicktunnel": json({ hostname: "example.trycloudflare.com" }),
    "/ready": json({ status: 503, readyConnections: 0 }),
  }, () => buildReadinessReport(db, ROOT));

  // The check itself reports the truth...
  assert.equal(report.checks.tunnel.ok, false);
  assert.equal(report.checks.tunnel.advisory, true, "the tunnel is advisory, not load-bearing");
  // ...but it is excluded from the verdict, so an otherwise-healthy host
  // stays ready with the tunnel in any state.
  assert.equal(rule({ ...healthy, tunnel: report.checks.tunnel }), true,
    "a down tunnel must not flip a healthy host to unready");
  assert.equal(rule({ ...healthy, tunnel: { ok: true, advisory: true } }), true);
});

test("a metrics server that hangs does not hold the Today tab open", async () => {
  const started = Date.now();
  const report = await withFakeCloudflared({
    "/quicktunnel": () => { /* never responds */ },
    "/ready": () => { /* never responds */ },
  }, () => buildReadinessReport(db, ROOT));

  // The probe is bounded at 1.5s. This asserts the bound exists at all, with
  // enough slack for the report's other checks on a loaded machine.
  assert.ok(Date.now() - started < 20_000, "the tunnel probe must be bounded");
  assert.equal(report.checks.tunnel.ok, false);
});
