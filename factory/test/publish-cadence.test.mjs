// The publisher must write when something changed, prove liveness when nothing
// has, and get quieter-but-louder when the store refuses.
//
// Regression: a fixed 30s full-document rewrite published 2,880 byte-identical
// copies a day, and when the blob store was suspended on 2026-09-14 it retried
// into the same failure 1,350 times over eleven hours without once saying so.
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULTS,
  VOLATILE_KEYS,
  failureAlert,
  nextDelayMs,
  shouldPublish,
  snapshotFingerprint,
} from "../lib/hq/publish-cadence.mjs";
import { checkDisk } from "../lib/hq/readiness.mjs";

function snap(overrides = {}) {
  return {
    contract: "hq.mirror/1",
    publishedAt: "2026-09-15T00:00:00.000Z",
    panels: {
      company: { generatedAt: "2026-09-15T00:00:00.000Z", projects: [{ key: "lifemaxing", taskCount: 3 }] },
      budgets: { asOf: "2026-09-15T00:00:00.000Z", alerts: [{ policyId: "company-monthly", evaluatedAt: "2026-09-15T00:00:00.000Z", status: "ok" }] },
    },
    ...overrides,
  };
}

test("build stamps do not change the fingerprint", () => {
  // The exact churn measured on the live machine: two builds 1.5s apart differ
  // in 15 leaves, all of them stamps or age counters. If these counted, the
  // fingerprint would never match and publish-on-change would silently degrade
  // back into publish-always while appearing to work.
  const a = snap();
  const b = snap({ publishedAt: "2026-09-15T00:00:30.000Z" });
  b.panels.company.generatedAt = "2026-09-15T00:00:30.000Z";
  b.panels.budgets.asOf = "2026-09-15T00:00:30.000Z";
  b.panels.budgets.alerts[0].evaluatedAt = "2026-09-15T00:00:30.000Z";

  assert.equal(snapshotFingerprint(a), snapshotFingerprint(b));
});

test("age counters do not change the fingerprint", () => {
  const a = snap();
  a.panels.company.projects[0].elapsedMs = 1000;
  const b = snap();
  b.panels.company.projects[0].elapsedMs = 999_999;
  assert.equal(snapshotFingerprint(a), snapshotFingerprint(b));
  assert.ok(VOLATILE_KEYS.has("elapsedMs") && VOLATILE_KEYS.has("sinceLastActivityMs"));
});

test("real content changes DO change the fingerprint", () => {
  const a = snap();
  const b = snap();
  b.panels.company.projects[0].taskCount = 4;
  assert.notEqual(snapshotFingerprint(a), snapshotFingerprint(b));
});

test("key order does not change the fingerprint", () => {
  const a = { contract: "hq.mirror/1", panels: { x: { a: 1, b: 2 } } };
  const b = { panels: { x: { b: 2, a: 1 } }, contract: "hq.mirror/1" };
  assert.equal(snapshotFingerprint(a), snapshotFingerprint(b));
});

test("unchanged content is not republished until the heartbeat is due", () => {
  const fingerprint = "abc";
  const base = { fingerprint, lastFingerprint: fingerprint, lastPublishedAtMs: 1_000_000, heartbeatMs: 300_000 };

  assert.deepEqual(shouldPublish({ ...base, now: 1_000_000 + 30_000 }), { publish: false, reason: "unchanged" });
  assert.deepEqual(shouldPublish({ ...base, now: 1_000_000 + 299_999 }), { publish: false, reason: "unchanged" });
  // A quiet machine still has to prove it is alive.
  assert.deepEqual(shouldPublish({ ...base, now: 1_000_000 + 300_000 }), { publish: true, reason: "heartbeat" });
});

test("a change publishes immediately, and a first publish always goes", () => {
  assert.deepEqual(
    shouldPublish({ fingerprint: "b", lastFingerprint: "a", lastPublishedAtMs: 1_000_000, now: 1_000_001 }),
    { publish: true, reason: "changed" },
  );
  assert.deepEqual(
    shouldPublish({ fingerprint: "a", lastFingerprint: null, lastPublishedAtMs: null }),
    { publish: true, reason: "first-publish" },
  );
});

test("failure backs off exponentially and is capped", () => {
  assert.equal(nextDelayMs({ failureStreak: 0, floorMs: 15_000 }), 15_000);
  assert.equal(nextDelayMs({ failureStreak: 1, floorMs: 15_000 }), 15_000);
  assert.equal(nextDelayMs({ failureStreak: 2, floorMs: 15_000 }), 30_000);
  assert.equal(nextDelayMs({ failureStreak: 3, floorMs: 15_000 }), 60_000);
  // Capped, so a suspended store is retried on a widening interval forever
  // rather than every 30s for eleven hours.
  assert.equal(nextDelayMs({ failureStreak: 50, floorMs: 15_000 }), DEFAULTS.backoffCapMs);
});

test("a failure run gets reported, with how long it has been going on", () => {
  const first = 1_000_000;
  assert.equal(failureAlert({ failureStreak: 1, firstFailureAtMs: first, now: first }), null, "one failure is noise");
  assert.equal(failureAlert({ failureStreak: 2, firstFailureAtMs: first, now: first }), null);

  const alert = failureAlert({ failureStreak: 3, firstFailureAtMs: first, now: first + 600_000 });
  assert.match(alert, /failed 3 time\(s\) in a row/);
  assert.match(alert, /10 minute\(s\)/, "the duration is what makes it actionable");
  assert.match(alert, /mirror is stale/);

  // Not every failure after that — but never silent either.
  assert.equal(failureAlert({ failureStreak: 7, firstFailureAtMs: first, now: first }), null);
  assert.ok(failureAlert({ failureStreak: 10, firstFailureAtMs: first, now: first }));
  assert.ok(failureAlert({ failureStreak: 1350, firstFailureAtMs: first, now: first }));
});

// ── an idle machine must not publish ────────────────────────────────────────
//
// `freeBytes` moved by a few kilobytes between every two snapshots — log lines
// being written — and made every idle build look changed. ~1,900 writes a day
// with nothing happening, the same amplification that got the blob store
// suspended on 2026-09-14.


const withDisk = (disk) => ({ panels: { readiness: { checks: { disk } } } });

test("a few kilobytes of log output does not count as a change", () => {
  const base = { status: "ok", totalBytes: 982_000_000_000, freePercent: 44.7, detail: "409 GiB free of 915 GiB" };
  const a = snapshotFingerprint(withDisk({ ...base, freeBytes: 438_872_150_016 }));
  const b = snapshotFingerprint(withDisk({ ...base, freeBytes: 438_872_064_000 }));
  assert.equal(a, b, "byte-level free space must not defeat publish-on-change");
  assert.equal(shouldPublish({ fingerprint: b, lastFingerprint: a, lastPublishedAtMs: 0, now: 1_000 }).publish, false);
});

test("a disk that is actually filling still publishes at once", () => {
  const before = { status: "ok", totalBytes: 982e9, freeBytes: 439e9, freePercent: 44.7, detail: "409 GiB free of 915 GiB" };
  const lessSpace = { ...before, freeBytes: 437e9, freePercent: 44.5, detail: "407 GiB free of 915 GiB" };
  const warning = { ...before, status: "warn" };
  for (const after of [lessSpace, warning]) {
    assert.notEqual(snapshotFingerprint(withDisk(before)), snapshotFingerprint(withDisk(after)));
  }
});

test("the real disk check still reports the byte count it no longer publishes on", () => {
  const disk = checkDisk(process.cwd());
  assert.equal(typeof disk.freeBytes, "number");
  // Every field that DOES count toward the fingerprint is coarse by construction.
  assert.match(disk.detail, /^\d+(\.\d)? [KMGT]iB free of/);
  assert.equal(Math.round(disk.freePercent * 10) / 10, disk.freePercent);
});

test("services staying up do not count as a change; a restart does", () => {
  const svc = (over = {}) => ({ panels: { readiness: { checks: { services: { status: "ok", services: [
    { name: "hq-dashboard", state: "online", restarts: 6, uptimeMs: 35_969_955, startedAt: "2026-09-16T19:31:29.000Z", ...over },
  ] } } } } });
  assert.equal(snapshotFingerprint(svc()), snapshotFingerprint(svc({ uptimeMs: 36_032_369 })),
    "uptime ticking by is not news");
  assert.notEqual(snapshotFingerprint(svc()),
    snapshotFingerprint(svc({ restarts: 7, uptimeMs: 1_000, startedAt: "2026-09-17T06:00:00.000Z" })),
    "a restart must still publish");
  assert.notEqual(snapshotFingerprint(svc()), snapshotFingerprint(svc({ state: "errored" })));
});
