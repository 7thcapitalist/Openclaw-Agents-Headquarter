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
import { buildSnapshot, publishOnce } from "../factory/lib/hq/publisher.mjs";

const hqRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Slow enough to be cheap, fast enough that the founder-visible staleness is
// smaller than the time it takes to notice something. Tunable without a deploy.
const DEFAULT_INTERVAL_MS = 30_000;

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
  if (result.ok) {
    const r = result.redaction || {};
    console.log(
      `${stamp} published ${result.panels?.length ?? 0} panel(s) ` +
        `[secrets ${r.secretsRedacted ?? 0}, paths ${r.pathsRewritten ?? 0}, ` +
        `truncated ${r.fieldsTruncated ?? 0}, reasoning ${r.reasoningBlocksStripped ?? 0}]`,
    );
    return;
  }
  console.error(`${stamp} publish failed: ${result.reason || `status ${result.status}`}`);
}

async function once() {
  const result = await publishOnce({ hqRoot, tasks: tasks() });
  report(result);
  return result;
}

async function dryRun() {
  const snapshot = await buildSnapshot({ hqRoot, tasks: tasks() });
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
  const interval = Number(process.env.HQ_PUBLISH_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  console.log(`publishing every ${interval}ms; outbound only`);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      stopping = true;
      console.log(`${signal} received; stopping after the current publish`);
    });
  }
  // Sequential rather than on a timer: overlapping publishes would race to
  // overwrite the same document, and the newest writer would not reliably win.
  while (!stopping) {
    await once();
    if (stopping) break;
    await new Promise((r) => setTimeout(r, interval));
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
