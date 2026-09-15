#!/usr/bin/env node
// Publish the Headquarters mirror to the control plane.
//
//   node scripts/hq-publish.mjs once          one snapshot, then exit
//   node scripts/hq-publish.mjs loop          publish every HQ_PUBLISH_INTERVAL_MS
//   node scripts/hq-publish.mjs dry-run       build and report, send nothing
//
// This is the only process that talks to the control plane, and it only ever
// talks outbound (SFD-2026-012). It opens a connection, posts a snapshot, and
// closes it. It listens on nothing.
//
// `dry-run` exists because the interesting question about this process is not
// "did it send" but "what would it have sent". It prints the redaction report
// and the panel list without a credential and without a network call, so the
// boundary can be inspected before anything crosses it.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverFactoryTasks } from "../dashboard/backend/lib/founderControlPlane.mjs";
import { overnightLimit, readOvernightQueue } from "../dashboard/backend/lib/overnightQueue.mjs";
import { readState } from "../factory/lib/task-workflow.mjs";
import { buildSnapshot, buildTaskDetails, publishSnapshot, publishTaskDetail } from "../factory/lib/hq/publisher.mjs";
import { DEFAULTS, failureAlert, nextDelayMs, shouldPublish, snapshotFingerprint } from "../factory/lib/hq/publish-cadence.mjs";

const hqRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Publish on change, not on a metronome.
//
// A fixed 30s full-document rewrite published 2,880 byte-identical copies a day
// (~86k/month) and was the write amplification the pipe audit flagged. The
// cadence is now: never more often than the floor, always at least every
// heartbeat, and backing off when the store refuses.
const FLOOR_MS = Number(process.env.HQ_PUBLISH_INTERVAL_MS || DEFAULTS.floorMs);
const HEARTBEAT_MS = Number(process.env.HQ_PUBLISH_HEARTBEAT_MS || DEFAULTS.heartbeatMs);

// Task states, read once per attempt and reused for both the mirror and the
// per-task detail documents.
function taskStates() {
  try {
    return discoverFactoryTasks(hqRoot)
      .map((view) => { try { return readState(view.statePath); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Tonight's plan, injected into the snapshot for the same reason `tasks` is:
// the reader lives in dashboard/backend/lib and factory/ must not import from
// there. Returning null rather than throwing keeps a broken queue file to one
// missing panel — `buildOvernightPanel` renders that as unavailable-with-reason.
function overnight() {
  try {
    return { queue: readOvernightQueue(hqRoot), limit: overnightLimit };
  } catch (error) {
    console.warn(`overnight plan unavailable: ${String(error?.message || error).slice(0, 200)}`);
    return null;
  }
}

function tasks() {
  try {
    return discoverFactoryTasks(hqRoot);
  } catch (error) {
    // A task-discovery failure costs one panel, not the publish.
    console.warn(`task discovery unavailable: ${String(error?.message || error).slice(0, 200)}`);
    return [];
  }
}

// Never print the snapshot itself. It is the company projection, and a terminal
// scrollback or a pm2 log is not a place to put it.
function report(result) {
  const stamp = new Date().toISOString();
  if (result.skipped) return;
  if (result.ok) {
    const r = result.redaction || {};
    console.log(
      `${stamp} published ${result.panels?.length ?? 0} panel(s) (${result.why || "changed"}) ` +
        `[secrets ${r.secretsRedacted ?? 0}, paths ${r.pathsRewritten ?? 0}, ` +
        `truncated ${r.fieldsTruncated ?? 0}, reasoning ${r.reasoningBlocksStripped ?? 0}]`,
    );
    return;
  }
  console.error(`${stamp} publish failed: ${result.reason || `status ${result.status}`}`);
}

// Build, decide, maybe send. Returns what happened so the loop can pace itself.
async function attempt(state) {
  let snapshot;
  try {
    snapshot = await buildSnapshot({ hqRoot, tasks: tasks(), readOvernight: overnight });
  } catch (error) {
    return { ok: false, reason: `snapshot build failed: ${String(error?.message || error).slice(0, 200)}` };
  }

  const fingerprint = snapshotFingerprint(snapshot);
  const decision = shouldPublish({
    fingerprint,
    lastFingerprint: state.lastFingerprint,
    lastPublishedAtMs: state.lastPublishedAtMs,
    heartbeatMs: HEARTBEAT_MS,
  });
  if (!decision.publish) return { ok: true, skipped: true, fingerprint };

  const result = await publishSnapshot({ snapshot });

  // Per-task detail, each blob fingerprinted on its own so one task changing
  // does not rewrite the other twenty. Skipping this would multiply the write
  // volume by N and recreate the quota problem the cadence change just solved.
  let taskWrites = 0;
  if (result.ok) {
    for (const { taskId, detail } of buildTaskDetails({ hqRoot, states: taskStates(), costs: snapshot.panels?.operations?.costs || null })) {
      const fingerprint = snapshotFingerprint(detail);
      if (state.taskFingerprints?.get(taskId) === fingerprint) continue;
      const wrote = await publishTaskDetail({ taskId, detail });
      if (wrote.ok) {
        state.taskFingerprints?.set(taskId, fingerprint);
        taskWrites += 1;
      }
    }
  }

  return {
    taskWrites,
    ...result,
    fingerprint,
    reason: result.reason,
    why: decision.reason,
    publishedAt: snapshot.publishedAt,
    redaction: snapshot.redaction,
    panels: Object.keys(snapshot.panels || {}),
  };
}

async function once() {
  const state = { lastFingerprint: null, lastPublishedAtMs: null, taskFingerprints: new Map() };
  const result = await attempt(state);
  report(result);
  return result;
}

async function dryRun() {
  const snapshot = await buildSnapshot({ hqRoot, tasks: tasks(), readOvernight: overnight });
  console.log(
    JSON.stringify(
      {
        contract: snapshot.contract,
        publishedAt: snapshot.publishedAt,
        publisher: snapshot.publisher,
        panels: Object.keys(snapshot.panels || {}),
        bytes: JSON.stringify(snapshot).length,
        redaction: snapshot.redaction,
      },
      null,
      2,
    ),
  );
}

async function loop() {
  console.log(
    `publish-on-change: floor ${FLOOR_MS}ms, heartbeat ${HEARTBEAT_MS}ms, ` +
      `backoff cap ${DEFAULTS.backoffCapMs}ms; outbound only`,
  );
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      stopping = true;
      console.log(`${signal} received; stopping after the current publish`);
    });
  }

  const state = { lastFingerprint: null, lastPublishedAtMs: null, failureStreak: 0, firstFailureAtMs: null, taskFingerprints: new Map() };

  // Sequential rather than on a timer: overlapping publishes would race to
  // overwrite the same document, and the newest writer would not reliably win.
  while (!stopping) {
    const result = await attempt(state);
    report(result);

    if (result.ok && !result.skipped) {
      state.lastFingerprint = result.fingerprint;
      state.lastPublishedAtMs = Date.now();
    }
    if (result.ok) {
      if (state.failureStreak > 0) {
        console.log(`${new Date().toISOString()} publisher recovered after ${state.failureStreak} failure(s)`);
      }
      state.failureStreak = 0;
      state.firstFailureAtMs = null;
    } else {
      state.failureStreak += 1;
      state.firstFailureAtMs ??= Date.now();
      // Eleven hours of failure with nobody told is the actual bug behind the
      // bug, so a run of failures gets louder rather than quieter.
      const alert = failureAlert({ failureStreak: state.failureStreak, firstFailureAtMs: state.firstFailureAtMs });
      if (alert) console.error(`${new Date().toISOString()} ${alert}`);
    }

    if (stopping) break;
    await new Promise((r) => setTimeout(r, nextDelayMs({ failureStreak: state.failureStreak, floorMs: FLOOR_MS })));
  }
}

const mode = process.argv[2] || "once";
try {
  if (mode === "once") {
    const result = await once();
    process.exitCode = result.ok ? 0 : 1;
  } else if (mode === "loop") {
    await loop();
  } else if (mode === "dry-run") {
    await dryRun();
  } else {
    console.error(`unknown mode: ${mode}. Use once, loop or dry-run.`);
    process.exitCode = 2;
  }
} catch (error) {
  // Never let the publisher take the shell down with a stack trace that might
  // carry a path or a value.
  console.error(`publisher error: ${String(error?.message || error).slice(0, 300)}`);
  process.exitCode = 1;
}
