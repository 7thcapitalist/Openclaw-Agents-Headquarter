import { execFile } from "child_process";
import { promisify } from "util";
import { setTimeout as delay } from "timers/promises";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { PROTOCOL_VERSION, computeDispatchPaths, failDispatch, ingestResult, markDispatchRunning, prepareDispatch, readResultFile } from "./openclaw-protocol.mjs";
import { parseAgentMeta } from "./hq/agent-meta.mjs";
import { readState, writeState } from "./task-workflow.mjs";
import { writeHandoff } from "./handoff.mjs";
import { publishMergeReadyTask } from "./hq/github-publish.mjs";
import { buildCompletionReport } from "./hq/completion-report.mjs";
import { sanitizeExcerpt } from "./common/redact.mjs";

const execFileAsync = promisify(execFile);

// Stages that may run concurrently once the builder is done and the branch is
// frozen. All three read-only against the same worktree; order of results does
// not matter because the engine still applies them one at a time.
export const DEFAULT_CONCURRENT_GROUPS = [["reviewer", "qa", "security"]];

export function isYieldedExecution(executed) {
  let envelope;
  try { envelope = JSON.parse(executed?.stdout || "{}"); } catch { return false; }
  if (envelope.status && envelope.status !== "ok") return false;
  return [envelope, envelope.result, envelope.result?.meta].some((part) =>
    part?.yielded === true || part?.livenessState === "paused");
}

// A yielded gateway turn is still owned by its delegated worker. Wait for the
// exact dispatch artifact; a bounded wait expiring is NOT a failed execution.
export async function waitForYieldedResult({ resultPath, wait = delay, now = Date.now,
  timeoutMs = 60 * 60 * 1000, pollMs = 5000, heartbeat = () => {} }) {
  const deadline = now() + timeoutMs;
  const ready = () => {
    try { return Boolean(readResultFile(resultPath)); } catch { return false; }
  };
  while (!ready()) {
    if (now() >= deadline) return false;
    heartbeat();
    await wait(Math.min(pollMs, deadline - now()));
  }
  return true;
}

export async function runOneStage({ hqRoot, statePath, agentIds = {}, maxAttemptsPerStage = 3, execute = executeOpenClaw, publish = publishMergeReadyTask, agentMetaByDispatchId = null, waitForResult = waitForYieldedResult }) {
  const initial = readState(statePath);
  if (initial.yieldedGroup) return { version: PROTOCOL_VERSION, status: "dispatch", taskId: initial.task.id, waiting: true };
  const prepared = prepareDispatch({ hqRoot, statePath });
  if (prepared.status !== "dispatch") return prepared;
  const owned = readState(statePath).currentDispatch;
  if (owned?.status === "running" && owned.yieldedAt) {
    if (!existsSync(prepared.resultPath)) return { ...prepared, waiting: true };
    const resumed = ingestResult({ statePath, result: readResultFile(prepared.resultPath), maxAttemptsPerStage });
    if (resumed.status === "merge-ready") resumed.githubPublish = publishAndRecord({ hqRoot, statePath, publish });
    if (["merge-ready", "blocked"].includes(resumed.status)) writeCompletionReport({ statePath });
    return resumed;
  }
  markDispatchRunning({ statePath, dispatchId: prepared.dispatchId });
  const agentId = selectAgentId(prepared, agentIds);
  const sessionKey = `agent:${agentId}:factory-${prepared.dispatchId}`;
  let response;
  const startedAt = Date.now();
  try {
    const executed = existsSync(prepared.resultPath) ? {} : await execute({
      agentId,
      messageFile: prepared.promptPath,
      sessionKey,
      cwd: prepared.cwd,
      dispatch: prepared,
    });
    if (!existsSync(prepared.resultPath) && isYieldedExecution(executed)) {
      const current = readState(statePath);
      current.currentDispatch.yieldedAt = new Date().toISOString();
      current.events.push({ at: current.currentDispatch.yieldedAt, type: "dispatch-yielded", dispatchId: prepared.dispatchId, stage: prepared.stage });
      writeState(statePath, current);
      const ready = await waitForResult({ resultPath: prepared.resultPath, heartbeat: () => {
        const live = readState(statePath);
        if (live.currentDispatch?.id !== prepared.dispatchId) throw new Error("Yielded dispatch ownership changed");
        live.updatedAt = new Date().toISOString();
        writeState(statePath, live);
      } });
      if (!ready) return { ...prepared, waiting: true };
    }
    const agentMeta = parseAgentMeta(executed, { durationMsFallback: Date.now() - startedAt })
      || agentMetaByDispatchId?.get(prepared.dispatchId)
      || null;
    if (!existsSync(prepared.resultPath)) {
      const diagnostic = writeMissingResultDiagnostic({
        worktree: prepared.cwd,
        dispatchId: prepared.dispatchId,
        stage: prepared.stage,
        actor: prepared.actor,
        sessionKey,
        resultPath: prepared.resultPath,
        stdout: executed?.stdout,
        stderr: executed?.stderr,
      });
      response = failDispatch({ statePath, dispatchId: prepared.dispatchId, error: diagnostic.summary, maxAttemptsPerStage });
    } else {
      response = ingestResult({ statePath, result: readResultFile(prepared.resultPath), agentMeta, maxAttemptsPerStage });
      if (response.status === "merge-ready") {
        response.githubPublish = publishAndRecord({ hqRoot, statePath, publish });
      }
    }
  } catch (error) {
    const current = readState(statePath);
    if (current.currentDispatch?.id !== prepared.dispatchId) {
      return { version: PROTOCOL_VERSION, status: current.status, taskId: current.task.id,
        currentStage: current.currentStage, blocker: current.blocker || null };
    }
    const agentMeta = parseAgentMeta(error, { durationMsFallback: Date.now() - startedAt })
      || agentMetaByDispatchId?.get(prepared.dispatchId)
      || null;
    const failure = existsSync(prepared.resultPath)
      ? summarizeError(error)
      : writeMissingResultDiagnostic({
        worktree: prepared.cwd,
        dispatchId: prepared.dispatchId,
        stage: prepared.stage,
        actor: prepared.actor,
        sessionKey,
        resultPath: prepared.resultPath,
        stdout: error?.stdout,
        stderr: error?.stderr,
        reason: summarizeError(error),
      }).summary;
    if (existsSync(prepared.resultPath)) {
      try {
        response = ingestResult({ statePath, result: readResultFile(prepared.resultPath), agentMeta, maxAttemptsPerStage });
      } catch (ingestError) {
        response = failDispatch({ statePath, dispatchId: prepared.dispatchId, error: summarizeError(ingestError), maxAttemptsPerStage });
      }
    } else {
      response = failDispatch({ statePath, dispatchId: prepared.dispatchId, error: failure, maxAttemptsPerStage });
    }
  }
  // A founder-readable completion report for every terminal or paused outcome —
  // successes and blockers alike. Rewritten (idempotent) each time the task
  // settles, and never allowed to break the run.
  if (response.status === "merge-ready" || response.status === "blocked") {
    writeCompletionReport({ statePath });
  }
  return response;
}

// Render the task's completion report from its own recorded state and drop it
// next to state.json as completion-report.md. Guarded: a report failure is
// swallowed — the workflow outcome stands regardless.
export function writeCompletionReport({ statePath }) {
  try {
    const state = readState(statePath);
    const markdown = buildCompletionReport(state);
    const path = join(dirname(statePath), "completion-report.md");
    writeFileSync(path, `${markdown}\n`, "utf8");
    const next = structuredClone(state);
    const generatedAt = new Date().toISOString();
    next.completionReport = { path, generatedAt, status: state.status };
    next.events.push({ at: generatedAt, type: "completion-report", stage: state.currentStage || "release", actor: "system", outcome: state.status });
    writeState(statePath, next);
    return { path, generatedAt };
  } catch (error) {
    return { error: summarizeError(error) };
  }
}

// Push the task's own branch + open a PR, then record the outcome on the
// task's own state.json so the dashboard/CLI can show it. A GitHub failure
// here is recorded, never thrown — the task already reached merge-ready
// through the workflow engine's own gates regardless of what GitHub does.
function publishAndRecord({ hqRoot, statePath, publish }) {
  const state = readState(statePath);
  let result;
  try {
    result = publish({ hqRoot, state });
  } catch (error) {
    result = { published: false, reason: summarizeError(error) };
  }
  const next = structuredClone(state);
  next.githubPublish = result;
  next.events.push({
    at: new Date().toISOString(),
    type: "github-publish",
    stage: "release",
    actor: "system",
    outcome: result.published ? (result.prUrl ? "pr-opened" : result.pushed ? "pushed" : "skipped") : "skipped",
  });
  writeState(statePath, next);
  return result;
}

export async function runToTerminal(options) {
  const groups = options.concurrentGroups || DEFAULT_CONCURRENT_GROUPS;
  let response;
  do {
    response = (await runConcurrentGroupIfReady({ ...options, groups })) || (await runOneStage(options));
  } while (response.status === "active");
  return response;
}

// When the task is parked at the head of a concurrent group with the rest of the
// group still pending, run every member's `openclaw agent` call at once (the
// slow part), then feed each result back through the UNCHANGED engine one stage
// at a time. Returns the engine response, or null when no fan-out applies (the
// caller then does a normal sequential `runOneStage`).
export async function runConcurrentGroupIfReady({ hqRoot, statePath, agentIds = {}, maxAttemptsPerStage = 3, execute = executeOpenClaw, publish = publishMergeReadyTask, groups = DEFAULT_CONCURRENT_GROUPS, waitForResult = waitForYieldedResult }) {
  const state = readState(statePath);
  if (state.status !== "active" || state.currentDispatch) return null;
  if (state.yieldedGroup) {
    if (state.yieldedGroup.some((m) => !existsSync(m.resultPath))) {
      return { version: PROTOCOL_VERSION, status: "dispatch", taskId: state.task.id, waiting: true };
    }
    execute = async () => {}; // consume the already-produced group, never re-dispatch
  }
  const pending = (s) => {
    const st = state.stages?.[s]?.status;
    return st === undefined || st === "pending";
  };
  const group = (groups || []).find((g) => Array.isArray(g) && g.length >= 2 && g[0] === state.currentStage && g.slice(1).every(pending));
  if (!group) return state.yieldedGroup
    ? { version: PROTOCOL_VERSION, status: "dispatch", taskId: state.task.id, waiting: true }
    : null;

  const members = group.map((stage) => {
    const { dispatchId, resultPath } = computeDispatchPaths({ state, stage, statePath });
    const actor = state.assignments[stage];
    const agentId = selectAgentId({ stage, actor }, agentIds);
    const promptPath = writeHandoff({ hqRoot, statePath, state, resultPath, dispatchId, stage });
    return { stage, actor, dispatchId, resultPath, promptPath, agentId };
  });
  const agentMetaByDispatchId = new Map();

  // The expensive part, concurrent. If a member's agent throws OR leaves no
  // result file, synthesize a `fail` result carrying the real reason so the
  // engine routes it as a normal retry with a legible message — parity with the
  // single-stage `failDispatch` path, instead of an opaque "did not write its
  // result file".
  const settled = await Promise.allSettled(members.map(async (m) => {
    const startedAt = Date.now();
    try {
      const executed = existsSync(m.resultPath) ? {} : await execute({
        agentId: m.agentId,
        messageFile: m.promptPath,
        sessionKey: `agent:${m.agentId}:factory-${m.dispatchId}`,
        cwd: state.worktree,
        dispatch: {
          version: PROTOCOL_VERSION,
          status: "dispatch",
          taskId: state.task.id,
          dispatchId: m.dispatchId,
          stage: m.stage,
          actor: m.actor,
          cwd: state.worktree,
          promptPath: m.promptPath,
          resultPath: m.resultPath,
        },
      });
      if (!existsSync(m.resultPath) && isYieldedExecution(executed)) {
        const current = readState(statePath);
        current.yieldedGroup = members.map(({ dispatchId, stage, resultPath }) => ({ dispatchId, stage, resultPath }));
        current.updatedAt = new Date().toISOString();
        writeState(statePath, current);
        await waitForResult({ resultPath: m.resultPath, heartbeat: () => {
          const live = readState(statePath);
          live.updatedAt = new Date().toISOString();
          writeState(statePath, live);
        } });
      }
      const meta = parseAgentMeta(executed, { durationMsFallback: Date.now() - startedAt });
      if (meta) agentMetaByDispatchId.set(m.dispatchId, meta);
      return executed;
    } catch (error) {
      const meta = parseAgentMeta(error, { durationMsFallback: Date.now() - startedAt });
      if (meta) agentMetaByDispatchId.set(m.dispatchId, meta);
      throw error;
    }
  }));
  for (let i = 0; i < members.length; i += 1) {
    const m = members[i];
    const rejected = settled[i].status === "rejected";
    if ((rejected || !existsSync(m.resultPath)) && !(settled[i].status === "fulfilled" && isYieldedExecution(settled[i].value))) {
      const reason = rejected
        ? summarizeError(settled[i].reason)
        : `the ${m.stage} agent (${m.agentId}) produced no result file`;
      synthesizeFailResult({ worktree: state.worktree, member: m, reason });
    }
  }

  if (settled.some((r, i) => r.status === "fulfilled" && isYieldedExecution(r.value) && !existsSync(members[i].resultPath))) {
    return { version: PROTOCOL_VERSION, status: "dispatch", taskId: state.task.id, waiting: true };
  }
  const completedGroup = readState(statePath);
  delete completedGroup.yieldedGroup;
  writeState(statePath, completedGroup);
  // Apply through the real engine, one stage at a time, with a no-op execute so
  // `runOneStage` consumes the result file each member already wrote.
  const noop = async () => {};
  const applied = new Set();
  let response;
  for (const m of members) {
    response = await runOneStage({ hqRoot, statePath, agentIds, maxAttemptsPerStage, execute: noop, publish, agentMetaByDispatchId });
    applied.add(m.stage);
    if (readState(statePath).stages?.[m.stage]?.status !== "pass") break; // failed → routed away
  }
  // Discard the not-yet-applied members' result files so a later attempt of
  // those stages regenerates them cleanly.
  for (const m of members) {
    if (applied.has(m.stage)) continue;
    try { if (existsSync(m.resultPath)) unlinkSync(m.resultPath); } catch { /* best effort */ }
  }
  return response;
}

export async function executeOpenClaw({ agentId, messageFile, sessionKey, cwd }) {
  // Run the agent inside its assigned worktree. Both callers already pass
  // `cwd: state.worktree`; without forwarding it here the `openclaw agent`
  // process inherited the dashboard's cwd, so a relative-path edit could land
  // in the source checkout instead of the isolated worktree.
  return execFileAsync(
    "openclaw",
    ["agent", "--agent", agentId, "--session-key", sessionKey, "--message-file", messageFile, "--json", "--timeout", "3600"],
    { cwd: cwd || undefined, timeout: 60 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }
  );
}

function selectAgentId(dispatch, agentIds) {
  return agentIds[`${dispatch.stage}:${dispatch.actor}`]
    || agentIds[dispatch.stage]
    || agentIds[dispatch.actor]
    || dispatch.actor;
}

// Write a schema-valid `fail` result (+ its evidence file) for a concurrent
// group member whose agent threw or produced nothing, so the engine's normal
// retry routing applies with a clear reason.
function synthesizeFailResult({ worktree, member, reason }) {
  try {
    const evDir = join(worktree, "evidence");
    mkdirSync(evDir, { recursive: true });
    const rel = `evidence/${member.stage}-infra-failure.md`;
    writeFileSync(join(worktree, rel), `# ${member.stage} could not run\n\n${reason}\n`, "utf8");
    writeFileSync(member.resultPath, JSON.stringify({
      version: PROTOCOL_VERSION,
      dispatchId: member.dispatchId,
      stage: member.stage,
      actor: member.actor,
      outcome: "fail",
      summary: `${member.stage} agent could not run: ${String(reason).split("\n")[0].slice(0, 240)}`,
      evidence: [rel],
    }), "utf8");
  } catch { /* best effort — a missing file still routes as a failure downstream */ }
}

// Preserve the useful executor signal when a single-stage dispatch exits
// without satisfying the result-file protocol. Like synthesizeFailResult(),
// this is best effort: diagnostic persistence must never alter retry routing.
function writeMissingResultDiagnostic({ worktree, dispatchId, stage, actor, sessionKey, resultPath, stdout, stderr, reason }) {
  const rel = `evidence/${dispatchId}-missing-result.md`;
  const out = redactTail(stdout);
  const err = redactTail(stderr);
  const cleanReason = reason ? sanitizeExcerpt(reason, { maxLength: 240 }).text : "";
  const summary = `${stage} dispatch wrote no result file (session ${sessionKey}); redacted executor output captured at ${rel}.${cleanReason ? ` Reason: ${cleanReason}` : ""}`;
  try {
    mkdirSync(join(worktree, "evidence"), { recursive: true });
    const lines = [
      `# ${stage} dispatch wrote no result file`,
      "",
      `- dispatchId: ${dispatchId}`,
      `- stage: ${stage}`,
      `- actor: ${actor}`,
      `- sessionKey: ${sessionKey}`,
      `- expectedResultFile: ${basename(resultPath)}`,
      cleanReason ? `- reason: ${cleanReason}` : null,
      "",
      "## Executor stdout (redacted, truncated)",
      "",
      "```",
      out.text || "(empty)",
      "```",
      "",
      "## Executor stderr (redacted, truncated)",
      "",
      "```",
      err.text || "(empty)",
      "```",
      "",
    ].filter((line) => line !== null);
    writeFileSync(join(worktree, rel), lines.join("\n"), "utf8");
    return { rel, summary };
  } catch {
    return { rel: null, summary: `${summary} (diagnostic artifact could not be written)` };
  }
}

function redactTail(value) {
  const raw = String(value ?? "");
  const truncated = raw.length > 4000;
  const clean = sanitizeExcerpt(raw.slice(-4000), { maxLength: 4000 });
  return {
    ...clean,
    text: truncated ? `… ${clean.text}` : clean.text,
    truncated: truncated || clean.truncated,
  };
}

function summarizeError(error) {
  const stderr = String(error?.stderr || "").trim();
  return stderr || error?.message || String(error);
}
