// When the publisher should actually write.
//
// The publisher used to rewrite the whole mirror document every 30 seconds
// regardless of whether anything had changed: 2,880 whole-blob writes a day,
// ~86k a month, almost all of them byte-identical to the one before. That is
// the write amplification the pipe audit flagged, and on 2026-09-14 the blob
// store was suspended and the publisher retried into it 1,350 times in a row
// without ever raising its voice.
//
// This module is the decision half, kept pure so it can be tested without a
// network, a clock, or a store. scripts/hq-publish.mjs owns the loop.

import { createHash } from "node:crypto";

// Fields that change on every build even when nothing about the company has.
//
// Measured, not guessed: two snapshots built 1.5s apart with nothing else
// happening differ in exactly 15 leaves, and every one of them is either a
// build stamp or an age counter derived from `now`. Hashing without stripping
// these means the fingerprint never matches and publish-on-change degrades
// silently back into publish-always — which would look like it was working.
//
// Age counters are safe to drop because they are derivable by the viewer from
// the timestamp they were computed against (`lastActivityAt`, `createdAt`).
export const VOLATILE_KEYS = Object.freeze(new Set([
  "publishedAt",
  "generatedAt",
  "asOf",
  "evaluatedAt",
  "recordedAt",
  "elapsedMs",
  "sinceLastActivityMs",
  // Free disk space, to the byte. Every log line the machine writes moves it,
  // so it differed between every two snapshots and silently turned
  // publish-on-change back into publish-always: on 2026-09-16/17, with the
  // factory completely idle, the publisher wrote ~80 "changed" snapshots an
  // hour (~1,900/day) and never once skipped. It was the only leaf that
  // differed between two idle builds 20s apart.
  //
  // Dropping it loses nothing a viewer can see. The same check carries
  // `detail` ("409 GiB free of 915 GiB", whole-GiB), `freePercent` (0.1%
  // steps) and `status` (ok/warn/fail), and all three still count — so a disk
  // that is genuinely filling still publishes immediately.
  "freeBytes",
  // How long each pm2 service has been up, in milliseconds. An age counter like
  // `elapsedMs`, and the second leaf that kept an idle snapshot "changed" once
  // the disk was fixed: readiness refreshes it about once a minute. A restart
  // is still visible to the fingerprint through `restarts`, `state` and
  // `startedAt`, none of which move while a service simply stays up.
  "uptimeMs",
]));

// Canonical JSON: keys sorted at every level, volatile keys removed, so two
// structurally identical snapshots always produce the same bytes.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (VOLATILE_KEYS.has(key)) continue;
      out[key] = canonical(value[key]);
    }
    return out;
  }
  return value;
}

/** A stable content fingerprint for a snapshot. Ignores build stamps. */
export function snapshotFingerprint(snapshot) {
  return createHash("sha256").update(JSON.stringify(canonical(snapshot))).digest("hex");
}

export const DEFAULTS = Object.freeze({
  // Coalesce a burst of changes rather than publishing three times in a second.
  floorMs: 15_000,
  // A quiet machine still has to prove it is alive, or "nothing changed" and
  // "the publisher died" look identical to the viewer.
  heartbeatMs: 300_000,
  // Never retry faster than the floor, never slower than this.
  backoffCapMs: 300_000,
  // Say something out loud once a failure run passes this.
  streakAlertAt: 3,
});

/**
 * Should this snapshot be written?
 *
 * Unchanged content is not published unless the heartbeat is due. A first
 * publish (no previous fingerprint) always goes.
 */
export function shouldPublish({
  fingerprint,
  lastFingerprint = null,
  lastPublishedAtMs = null,
  now = Date.now(),
  heartbeatMs = DEFAULTS.heartbeatMs,
} = {}) {
  if (!lastFingerprint || lastPublishedAtMs == null) return { publish: true, reason: "first-publish" };
  if (fingerprint !== lastFingerprint) return { publish: true, reason: "changed" };
  if (now - lastPublishedAtMs >= heartbeatMs) return { publish: true, reason: "heartbeat" };
  return { publish: false, reason: "unchanged" };
}

/**
 * How long to wait before the next attempt.
 *
 * On success: the floor. On failure: exponential from the floor, capped — so a
 * suspended store is retried on a widening interval instead of every 30s for
 * eleven hours.
 */
export function nextDelayMs({
  failureStreak = 0,
  floorMs = DEFAULTS.floorMs,
  backoffCapMs = DEFAULTS.backoffCapMs,
} = {}) {
  if (failureStreak <= 0) return floorMs;
  const grown = floorMs * 2 ** (failureStreak - 1);
  return Math.min(grown, backoffCapMs);
}

/**
 * Whether a failure run is now loud enough to report, and what to say.
 *
 * Reporting every failure is what produced 1,350 identical lines nobody read;
 * reporting none is what let eleven hours pass unnoticed. So: the first few,
 * then decreasing frequency, always with how long it has been going on.
 */
export function failureAlert({ failureStreak, firstFailureAtMs, now = Date.now(), streakAlertAt = DEFAULTS.streakAlertAt } = {}) {
  if (failureStreak < streakAlertAt) return null;
  const isMilestone = failureStreak === streakAlertAt || failureStreak % 10 === 0;
  if (!isMilestone) return null;
  const forMs = firstFailureAtMs ? now - firstFailureAtMs : 0;
  const mins = Math.round(forMs / 60_000);
  return `publisher has failed ${failureStreak} time(s) in a row over ${mins} minute(s) — the mirror is stale`;
}
