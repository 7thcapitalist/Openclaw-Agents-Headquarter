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

import { dirname, resolve } from "node:path";
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
export async function handlers() {
  const control = await import("../dashboard/backend/lib/founderControlPlane.mjs");
  const overnight = await import("../dashboard/backend/lib/overnightQueue.mjs");

  // Every handler returns a sentence the console can show the founder. The
  // return value IS the acknowledgement — there is no second channel — so a
  // handler that cannot say what it did has not finished doing it.
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

    // Answering releases the objective node AND starts the run. Recording the
    // answer alone is what this handler used to do, and it is indistinguishable
    // from working: the console said `done`, the task said `task-resumed`, and
    // the objective sat there. The dashboard route never had that bug because
    // the resume was inline in it — so both now call the one shared function.
    "decision.resolve": async ({ decisionId, choice }) => {
      // decisionId is "<taskId>:<decision>" — the same id the inbox renders.
      const taskId = String(decisionId).split(":")[0];
      const statePath = control.findTaskStatePath(hqRoot, taskId);
      if (!statePath) throw new Error(`no such task: ${taskId}`);
      const task = control.resolveFounderDecision({ root: hqRoot, hqRoot, statePath, direction: choice });
      if (!task?.objectiveResume) return `recorded decision on ${taskId}`;
      const { runObjective } = await import("../factory/lib/objective/orchestrator.mjs");
      const resumed = control.resumeObjectiveAfterDecision({
        root: hqRoot, hqRoot, objectiveResume: task.objectiveResume, runObjective,
      });
      return resumed
        ? `recorded decision on ${taskId} and resumed ${resumed.objectiveId}`
        : `recorded decision on ${taskId}`;
    },

    // Start an outcome from the console. `handleObjectiveStart` awaits planning
    // and detaches the pipeline — see the comment on that function for why the
    // line is drawn there rather than around the whole run.
    "objective.start": async ({ objective, projectId }) => {
      const { decomposeObjective } = await import("../factory/lib/objective/decompose.mjs");
      const { runObjective } = await import("../factory/lib/objective/orchestrator.mjs");
      const result = await control.handleObjectiveStart({
        root: hqRoot, hqRoot, objective, projectId,
        decompose: decomposeObjective, runObjective,
      });
      if (result.blocked) {
        return `planned ${result.objectiveId}, then blocked: ${result.nodeCount} high-risk node(s) `
          + "need the founder approval key before anything runs.";
      }
      return `started ${result.objectiveId}: ${result.nodeCount} node(s) planned and running`;
    },

    // Dismissing an inbox item is presentation only: it writes a flag in
    // control-plane.json and touches no task state, no decision and no run.
    // Fully reversible from the dashboard.
    "inbox.dismiss": async ({ itemId }) => {
      const id = String(itemId || "").trim();
      if (!id) throw new Error("an inbox item id is required");
      control.setInboxItemDismissed(hqRoot, id, true, { reason: "dismissed from the console" });
      return `dismissed inbox item ${id}`;
    },

    // A comment is UNTRUSTED DATA and is treated as such all the way down: it
    // is stored, redacted, bounded and attributed, and never interpolated into
    // a prompt, a handoff or a command. The author is fixed to the founder here
    // — the intent protocol does not carry an author and must not start to.
    // A mention can cause a wakeup carrying an identifier and nothing else.
    "task.comment": async ({ taskId, body }) => {
      const result = control.postTaskComment({ root: hqRoot, hqRoot, taskId: String(taskId || ""), body });
      if (result.duplicate) return `comment already recorded on ${taskId}`;
      const notified = result.notified?.length ? `, notified ${result.notified.join(", ")}` : "";
      const redacted = result.redactions?.length ? `, ${result.redactions.length} redaction(s)` : "";
      return `commented on ${taskId}${notified}${redacted}`;
    },

    // The overnight plan. `repo` is resolved here rather than accepted as an
    // argument: the allowlist declares only `objective` and `projectId`, and a
    // path arriving from the network is exactly what the protocol forbids.
    "overnight.add": async ({ objective, projectId }) => {
      const project = String(projectId || "").trim();
      const repo = control.resolveProjectRepo(hqRoot, project);
      if (!repo) throw new Error(`no repository is registered for project "${project}"`);
      const state = overnight.addOvernightItem(hqRoot, { objective, projectId: project, repo });
      return `added to tonight's plan: ${state.items.length} of ${overnight.overnightLimit} objective(s) queued`;
    },

    "overnight.remove": async ({ itemId }) => {
      const before = overnight.readOvernightQueue(hqRoot).items.length;
      const state = overnight.removeOvernightItem(hqRoot, String(itemId || ""));
      if (state.items.length === before) throw new Error(`no such overnight item: ${itemId}`);
      return `removed from tonight's plan: ${state.items.length} objective(s) left`;
    },

    // startOvernight spawns the objective workers as children of whichever
    // process calls it — here, the intent worker rather than the dashboard.
    // That is safe in both directions: the shared `status === "running"` guard
    // in the queue state stops a second runner starting, and `stopOvernight`
    // signals through that same state rather than through a process handle.
    "overnight.start": async () => {
      const scriptPath = resolve(hqRoot, "scripts", "factory-objective.mjs");
      const state = overnight.startOvernight(hqRoot, { scriptPath });
      const queued = state.items.filter((item) => item.status === "queued").length;
      return `overnight run started: ${state.items.length} objective(s) in the plan, ${queued} still queued`;
    },

    // Ask the factory a question. Awaited: the founder is waiting for an
    // answer, the call is bounded by its own timeout, and the answer IS the
    // acknowledgement. Which agent answers is this machine's choice, not the
    // caller's — the allowlist carries no agent id for exactly that reason.
    "question.ask": async ({ question }) => {
      const record = control.askFounderQuestion(hqRoot, { question, agentId: "main" });
      const answered = await control.answerFounderQuestion(hqRoot, record);
      if (!answered) throw new Error("the question record vanished before it could be answered");
      if (answered.status === "failed") throw new Error(answered.error || "the factory could not answer");
      return `answered: ${String(answered.answer || "").slice(0, 400)}`;
    },

    "overnight.stop": async () => {
      const state = overnight.stopOvernight(hqRoot);
      if (state.status !== "stopped" && !state.stopRequested) return "nothing to stop — no overnight run is going";
      // The runner checks the flag between objectives, so the one in flight
      // finishes. Say that, rather than implying it died mid-build.
      return "overnight run will stop after the objective now in flight finishes";
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

// Run only when invoked as a command. Without this guard, importing the module
// to inspect the handler map — which is exactly what the wiring test does —
// would start polling the control plane as a side effect of the import.
const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
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
}
