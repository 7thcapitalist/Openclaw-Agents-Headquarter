// `/api/system/readiness` existed, worked, and had no surface on any screen.
// On 2026-09-14 a task's state store reached 399 GiB with roughly an hour of
// disk left, and nothing anywhere said so.
//
// These tests pin the factory-side report that both surfaces now render, and
// especially pin the two ways a health panel lies: calling a check it could
// not run a failure, and calling a failure it did not look for a pass.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, openSync, ftruncateSync, closeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildReadinessSnapshot, checkDisk, checkStateStores, checkServices, checkGateway,
  rollUp, clearReadinessCache, EXPECTED_SERVICES, READINESS_CONTRACT,
} from "../lib/hq/readiness.mjs";
import { homeHealth } from "../../control-plane/public/home.mjs";
import { readinessPanel } from "../../dashboard/backend/public/lib/readinessView.mjs";

function hqWithStores(stores) {
  const root = mkdtempSync(join(tmpdir(), "readiness-"));
  for (const [name, bytes] of Object.entries(stores)) {
    const dir = join(root, "dashboard", "backend", "data", "factory", "proj", "tasks", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.sqlite"), Buffer.alloc(bytes));
  }
  return root;
}

const pm2 = (entries) => async () => ({ stdout: JSON.stringify(entries), stderr: "" });

// ── the roll-up: what counts as unhealthy ─────────────────────────────────

test("a check that could not be run is never reported as a failure", () => {
  // pm2 missing from a container is not an outage. Treating it as one teaches
  // the founder to ignore the panel, which is worse than not having it.
  assert.equal(rollUp({ a: { status: "ok" }, b: { status: "unknown" } }), "degraded");
  assert.notEqual(rollUp({ a: { status: "ok" }, b: { status: "unknown" } }), "fail");
});

test("one failing check fails the whole report, and a warning warns it", () => {
  assert.equal(rollUp({ a: { status: "ok" }, b: { status: "fail" } }), "fail");
  assert.equal(rollUp({ a: { status: "ok" }, b: { status: "warn" } }), "warn");
  assert.equal(rollUp({ a: { status: "warn" }, b: { status: "fail" } }), "fail");
  assert.equal(rollUp({ a: { status: "ok" }, b: { status: "ok" } }), "ok");
});

// ── disk: the check that would have bought back the hour ──────────────────

test("disk reports free space, and reads a real filesystem", () => {
  const disk = checkDisk(tmpdir());
  assert.ok(["ok", "warn", "fail"].includes(disk.status));
  assert.ok(disk.totalBytes > 0);
  assert.ok(disk.freeBytes >= 0);
  assert.match(disk.detail, /free of/);
});

test("a path that does not exist is unknown, not a failure", () => {
  assert.equal(checkDisk(join(tmpdir(), "definitely-not-here-9f3a")).status, "unknown");
});

// ── state stores: which task is why ───────────────────────────────────────

test("a store past a gigabyte warns, and past sixteen fails", () => {
  const small = checkStateStores({ hqRoot: hqWithStores({ a: 1024 }) });
  assert.equal(small.status, "ok");
  assert.equal(small.taskCount, 1);

  // Sparse files, so the assertion costs bytes rather than gigabytes.
  const root = hqWithStores({});
  const dir = join(root, "dashboard", "backend", "data", "factory", "proj", "tasks", "runaway");
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, "state.sqlite"), "w");
  ftruncateSync(fd, 2 * 1024 ** 3);
  closeSync(fd);
  assert.equal(checkStateStores({ hqRoot: root }).status, "warn");

  const fd2 = openSync(join(dir, "state.sqlite"), "w");
  ftruncateSync(fd2, 20 * 1024 ** 3);
  closeSync(fd2);
  assert.equal(checkStateStores({ hqRoot: root }).status, "fail");
});

test("the largest stores are named, biggest first, so the cause is reachable", () => {
  const report = checkStateStores({ hqRoot: hqWithStores({ small: 1024, big: 64 * 1024, mid: 8 * 1024 }) });
  assert.deepEqual(report.largest.map((entry) => entry.task.split("/").pop()), ["big", "mid", "small"]);
  assert.ok(report.largest[0].size);
});

test("no state root yet is unknown, not an emergency", () => {
  const report = checkStateStores({ hqRoot: mkdtempSync(join(tmpdir(), "empty-hq-")) });
  assert.equal(report.status, "unknown");
  assert.equal(report.taskCount, 0);
});

// ── services ──────────────────────────────────────────────────────────────

test("all four services online is ok", async () => {
  const entries = EXPECTED_SERVICES.map((name) => ({ name, pm2_env: { status: "online", restart_time: 0, pm_uptime: Date.now() - 1000 } }));
  const report = await checkServices({ exec: pm2(entries) });
  assert.equal(report.status, "ok");
  assert.equal(report.services.length, 4);
});

test("a service that has vanished reads as missing, not as a short list", () => {
  // An empty list looking like a healthy list is how "the publisher is down"
  // becomes "the factory is quiet".
  return checkServices({ exec: pm2([]) }).then((report) => {
    assert.equal(report.status, "fail");
    assert.deepEqual(report.services.map((s) => s.state), ["missing", "missing", "missing", "missing"]);
    assert.match(report.detail, /hq-dashboard is missing/);
  });
});

test("a stopped service fails and is named", async () => {
  const entries = EXPECTED_SERVICES.map((name) => ({
    name,
    pm2_env: { status: name === "hq-publisher" ? "stopped" : "online", restart_time: 0, pm_uptime: Date.now() },
  }));
  const report = await checkServices({ exec: pm2(entries) });
  assert.equal(report.status, "fail");
  assert.match(report.detail, /hq-publisher is stopped/);
});

test("pm2 being unreachable is unknown, never a failure", async () => {
  const report = await checkServices({ exec: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } });
  assert.equal(report.status, "unknown");
  assert.match(report.detail, /not reachable/);
});

// ── gateway: the stderr trap ──────────────────────────────────────────────

test("the gateway check reads stderr, where the complaint actually goes", async () => {
  // `openclaw gateway status` prints configuration to stdout and its
  // complaints to stderr. A check that reads stdout alone reports "ok"
  // straight through a real drift — which is the exact failure this panel
  // exists to stop, reintroduced inside the panel itself.
  const report = await checkGateway({
    exec: async () => ({ stdout: "Gateway: bind=loopback\n", stderr: "Service config looks out of date or non-standard.\n" }),
  });
  assert.equal(report.status, "warn");
});

test("a clean gateway is ok, and an unreachable one is unknown", async () => {
  assert.equal((await checkGateway({ exec: async () => ({ stdout: "Gateway: fine\n", stderr: "" }) })).status, "ok");
  assert.equal((await checkGateway({ exec: async () => { throw new Error("no such binary"); } })).status, "unknown");
});

// ── the whole report ──────────────────────────────────────────────────────

test("the report names its contract and never throws", async () => {
  const snapshot = await buildReadinessSnapshot({
    hqRoot: hqWithStores({ a: 2048 }),
    exec: async () => { throw new Error("nothing is installed here"); },
    ttlMs: 0,
  });
  assert.equal(snapshot.contract, READINESS_CONTRACT);
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.available, true);
  // pm2 and openclaw both missing: degraded, because nothing was observed to
  // be wrong — only unobservable.
  assert.equal(snapshot.status, "degraded");
});

test("a failing check reaches the report's warnings, named", async () => {
  const snapshot = await buildReadinessSnapshot({
    hqRoot: hqWithStores({ a: 2048 }),
    exec: pm2([]),
    ttlMs: 0,
  });
  assert.equal(snapshot.status, "fail");
  assert.ok(snapshot.warnings.some((w) => w.startsWith("services:")));
});

// ── both surfaces render it, and neither lies ─────────────────────────────

test("the console's model sorts the worst check first and names it in English", () => {
  const health = homeHealth({
    readiness: {
      status: "warn",
      checks: { disk: { status: "ok", detail: "411 GiB free" }, gateway: { status: "warn", detail: "config is out of date" } },
      warnings: ["gateway: config is out of date"],
    },
  });
  assert.equal(health.status, "warn");
  assert.equal(health.checks[0].name, "Gateway");
  assert.equal(health.checks[1].name, "Disk");
  assert.match(health.line, /Gateway: config is out of date/);
});

test("a snapshot with no readiness panel says so, rather than implying health", () => {
  const health = homeHealth({});
  assert.equal(health.available, false);
  assert.equal(health.status, "unknown");
  assert.match(health.line, /not published/);
});

test("the dashboard panel renders every check and escapes what it is given", () => {
  const html = readinessPanel({
    status: "fail",
    available: true,
    checks: {
      disk: { status: "fail", detail: "2 GiB free of 467 GiB" },
      stateStores: { status: "warn", detail: "largest 20 GiB", largest: [{ task: "proj/tasks/<script>", bytes: 1, size: "20 GiB" }] },
      services: { status: "ok", detail: "all 4 services online", services: [{ name: "hq-dashboard", state: "online", restarts: 3 }] },
    },
    warnings: ["disk: 2 GiB free of 467 GiB"],
  });
  assert.match(html, /System readiness/);
  assert.match(html, /Disk/);
  assert.match(html, /State stores/);
  assert.match(html, /hq-dashboard/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("the dashboard panel does not call a machine unhealthy because it could not look", () => {
  const html = readinessPanel({ status: "degraded", available: true, checks: { services: { status: "unknown", detail: "pm2 is not reachable" } }, warnings: [] });
  assert.match(html, /not checked/);
  assert.doesNotMatch(html, /failing/);
});

test("no readiness at all is unavailable, not healthy", () => {
  assert.match(readinessPanel(null), /has not been checked/);
  assert.match(readinessPanel({ available: false, error: "boom" }), /boom/);
});

// ── the cost of asking ────────────────────────────────────────────────────

test("the subprocess checks are cached, and the file checks never are", async () => {
  clearReadinessCache();
  // The publisher calls this on a 30-second floor forever. `pm2 jlist` plus
  // `openclaw gateway status` cost ~1.8s of process spawning; reading the disk
  // costs ~1.4ms. Spawning twice a minute on a host whose gateway has been
  // OOM-killed three times is a cost this panel must not add.
  let execCalls = 0;
  const exec = async (bin) => {
    execCalls += 1;
    if (bin === "pm2") return { stdout: "[]", stderr: "" };
    return { stdout: "fine", stderr: "" };
  };
  const hqRoot = hqWithStores({ a: 1024 });
  const first = await buildReadinessSnapshot({ hqRoot, exec, nowMs: 1000 });
  assert.equal(execCalls, 2);

  const second = await buildReadinessSnapshot({ hqRoot, exec, nowMs: 30_000 });
  assert.equal(execCalls, 2, "a second publish inside the TTL must not spawn anything");
  assert.deepEqual(second.checks.services, first.checks.services);

  // But disk and stores are re-read every time, because those are the numbers
  // that move in hours and the ones the founder acts on.
  assert.ok(second.checks.disk.totalBytes > 0);
  assert.equal(second.checks.stateStores.taskCount, 1);

  await buildReadinessSnapshot({ hqRoot, exec, nowMs: 1000 + 61_000 });
  assert.equal(execCalls, 4, "past the TTL it looks again");
});

test("a cache is never shared between two different exec implementations", async () => {
  clearReadinessCache();
  const hqRoot = hqWithStores({ a: 1024 });
  const healthy = await buildReadinessSnapshot({
    hqRoot, nowMs: 1000,
    exec: pm2(EXPECTED_SERVICES.map((name) => ({ name, pm2_env: { status: "online", restart_time: 0, pm_uptime: 1 } }))),
  });
  const broken = await buildReadinessSnapshot({ hqRoot, nowMs: 1000, exec: pm2([]) });
  assert.equal(healthy.checks.services.status, "ok");
  assert.equal(broken.checks.services.status, "fail");
});

test("ttlMs 0 always looks, for a caller that wants a fresh answer", async () => {
  clearReadinessCache();
  let execCalls = 0;
  const exec = async () => { execCalls += 1; return { stdout: "[]", stderr: "" }; };
  const hqRoot = hqWithStores({ a: 1024 });
  await buildReadinessSnapshot({ hqRoot, exec, ttlMs: 0 });
  await buildReadinessSnapshot({ hqRoot, exec, ttlMs: 0 });
  assert.equal(execCalls, 4);
});
