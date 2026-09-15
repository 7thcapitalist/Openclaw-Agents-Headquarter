#!/usr/bin/env node
// Claim founder intents from the control plane and run them here.
//
//   node scripts/hq-intents.mjs once     claim and execute one batch, then exit
//   node scripts/hq-intents.mjs loop     poll every HQ_INTENT_INTERVAL_MS
//   node scripts/hq-intents.mjs peek     show what is queued, execute nothing
//
// This is the second and last process that talks to the control plane, and like
// the publisher it only ever talks OUTBOUND. It polls; nothing is pushed to
// this machine and nothing here listens.
//
// The handler map below is the whole of what a founder intent can cause to
// happen on this machine. It is a literal object, written here, and every entry
// calls something the founder can already do in the local dashboard. Adding a
// capability means editing this file AND the allowlist in
// factory/lib/integrations/intent-protocol.mjs — a new power can never arrive
// as data.
//
// `peek` exists for the same reason the publisher has `dry-run`: the
// interesting question is not "did it run" but "what is it about to run".

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { executeBatch } from "../factory/lib/hq/intent-worker.mjs";

const hqRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_INTERVAL_MS = 30_000;
const TIMEOUT_MS = 20_000;

function config() {
  const endpoint = process.env.HQ_CONTROL_PLANE_URL;
  const token = process.env.HQ_WRITE_TOKEN;
  if (!endpoint) throw Object.assign(new Error("HQ_CONTROL_PLANE_URL is not configured"), { code: "unconfigured" });
  if (!token) throw Object.assign(new Error("HQ_WRITE_TOKEN is not configured"), { code: "unconfigured" });
  return { endpoint, token };
}

// The credential must never reach a log, so any text derived from a response is
// stripped of it before it goes anywhere.
function withoutCredential(text, credential) {
  if (!text || !credential) return text || "";
  return text.split(credential).join("[redacted]");
}

async function call(path, { method = "GET", body = null } = {}) {
  const { endpoint, token } = config();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(new URL(path, endpoint).toString(), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: abort.signal,
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(`${method} ${path} -> ${response.status} ${withoutCredential(text, token).slice(0, 200)}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

// ── the closed handler map ───────────────────────────────────────────────────
//
// Imported lazily, and from dashboard/backend/lib, because these are the same
// entry points the local dashboard uses. Loading them at module scope would
// make `peek` — which executes nothing — drag in the whole dashboard.
// The gates the local dashboard applies before it will spend anything, in one
// place so the two money-spending intents cannot drift apart from it or from
// each other. Every failure is a throw, which the worker records as `failed`
// with this reason — the founder sees why nothing happened.
function requireRunnableProject(control, projectId) {
  const id = String(projectId || "").trim();
  if (!id) throw new Error("a project is required");
  const repo = control.resolveProjectRepo(hqRoot, id);
  if (!repo) throw new Error(`no such project: ${id}`);
  if (!existsSync(join(repo, ".git"))) throw new Error(`${id} does not point at a git working tree`);
  if (control.isProjectPaused(hqRoot, id)) throw new Error(`${id} is paused — resume it before starting work`);
  return { repo };
}

// An objective can be a thousand characters. A result detail is read in a list.
function summarize(text) {
  const line = String(text || "").trim().replace(/\s+/g, " ");
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

async function handlers() {
  const control = await import("../dashboard/backend/lib/founderControlPlane.mjs");

  return {
    "task.retry": async ({ taskId }) => {
      const statePath = control.findTaskStatePath(hqRoot, taskId);
      if (!statePath) throw new Error(`no such task: ${taskId}`);
      const { resumeState, readState, writeState } = await import("../factory/lib/task-workflow.mjs");
      writeState(statePath, resumeState(readState(statePath)));
      return `resumed ${taskId}`;
    },

    "objective.retry": async ({ objectiveId }) => {
      const { runObjective } = await import("../factory/lib/objective/orchestrator.mjs");
      const result = await control.handleObjectiveRetry({ root: hqRoot, hqRoot, objectiveId, runObjective });
      return `retried ${objectiveId}: ${result?.status || "started"}`;
    },

    // Starting an objective is the one intent that spends real money
    // unattended, so it runs through the SAME gates the local dashboard
    // applies — a registered project, a real git tree, and not paused — and
    // refuses rather than improvising when any of them fails.
    //
    // It spawns `scripts/factory-objective.mjs`, exactly as the overnight
    // queue does. The objective text is an argv VALUE, never part of a shell
    // string: `spawn` is called without a shell, and the protocol has already
    // rejected any argument carrying a shell shape. Nothing here builds a
    // command out of founder text.
    //
    // The child is detached. Decomposing and running an objective takes hours,
    // and the intent worker's job is to start it and say so, not to hold the
    // poller open until it finishes.
    "objective.start": async ({ objective, projectId }) => {
      const { repo } = requireRunnableProject(control, projectId);
      const { spawn } = await import("node:child_process");
      const child = spawn(
        process.execPath,
        [join(hqRoot, "scripts", "factory-objective.mjs"), "start",
          "--objective", objective, "--project", projectId, "--repo", repo],
        { cwd: hqRoot, stdio: "ignore", detached: true },
      );
      child.unref();
      return `started an objective for ${projectId} (pid ${child.pid}): ${summarize(objective)}`;
    },

    // Planning the night only writes to the queue. It never starts the run —
    // that is a separate, deliberate act, and an intent that both queued work
    // and began spending on it would make "plan tomorrow" indistinguishable
    // from "go now".
    "overnight.add": async ({ objective, projectId }) => {
      const { repo } = requireRunnableProject(control, projectId);
      const { addOvernightItem } = await import("../dashboard/backend/lib/overnightQueue.mjs");
      const queue = addOvernightItem(hqRoot, { objective, projectId, repo });
      const added = queue.items[queue.items.length - 1];
      return `queued for tonight on ${projectId} (${queue.items.length} of 8): ${summarize(objective)} [${added?.id || "?"}]`;
    },

    "decision.resolve": async ({ decisionId, choice }) => {
      // decisionId is "<taskId>:<decision>" — the same id the inbox renders.
      const taskId = String(decisionId).split(":")[0];
      const statePath = control.findTaskStatePath(hqRoot, taskId);
      if (!statePath) throw new Error(`no such task: ${taskId}`);
      control.resolveFounderDecision({ root: hqRoot, hqRoot, statePath, direction: choice });
      return `recorded decision on ${taskId}`;
    },
  };
}

function report(line) {
  console.log(`${new Date().toISOString()} ${line}`);
}

async function once() {
  const { claimed } = await call("/api/intents?claim=1");
  if (!claimed?.length) return { claimed: 0 };

  report(`claimed ${claimed.length} intent(s)`);
  const map = await handlers();

  const results = await executeBatch(claimed, map, {
    onResult: async (intent, result) => {
      // Report the outcome back so the founder sees what became of the ask.
      // A failure to report leaves the intent claimed and unreported rather
      // than re-running it — at-most-once is the safer side to err on.
      await call("/api/intents", {
        method: "PATCH",
        // Report what was asked alongside what happened, so a rejection can be
        // diagnosed after the fact instead of only counted.
        body: { id: intent.id, status: result.status, detail: result.detail, kind: intent.kind, args: intent.args || null },
      });
      report(`  ${intent.kind} ${intent.id} -> ${result.status}`);
    },
  });

  return { claimed: claimed.length, results };
}

// What this machine is willing to do, without doing any of it.
//
// It does not list the queue: reading the queue needs a viewer session and this
// process holds only the write credential, which is the correct split. The
// auditable thing from here is the handler map — the complete set of actions a
// founder intent can cause on this machine — and the allowlist it must agree
// with. A kind in one and not the other is a bug worth seeing.
async function peek() {
  const { INTENT_KINDS } = await import("../factory/lib/integrations/intent-protocol.mjs");
  const map = await handlers();
  const registered = Object.keys(map).sort();
  const allowed = Object.keys(INTENT_KINDS).sort();

  console.log(JSON.stringify({
    registeredHandlers: registered,
    allowlistedButUnhandled: allowed.filter((kind) => !registered.includes(kind)),
    handledButNotAllowlisted: registered.filter((kind) => !allowed.includes(kind)),
  }, null, 2));
}

async function loop() {
  const interval = Number(process.env.HQ_INTENT_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  report(`polling for founder intents every ${interval}ms; outbound only`);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      stopping = true;
      report(`${signal} received; stopping after the current batch`);
    });
  }
  while (!stopping) {
    try {
      await once();
    } catch (error) {
      report(`poll failed: ${String(error?.message || error).slice(0, 200)}`);
    }
    if (stopping) break;
    await new Promise((r) => setTimeout(r, interval));
  }
}

const mode = process.argv[2] || "once";
try {
  if (mode === "once") await once();
  else if (mode === "loop") await loop();
  else if (mode === "peek") await peek();
  else {
    console.error(`unknown mode: ${mode}. Use once, loop or peek.`);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`intent poller error: ${String(error?.message || error).slice(0, 300)}`);
  process.exitCode = 1;
}
