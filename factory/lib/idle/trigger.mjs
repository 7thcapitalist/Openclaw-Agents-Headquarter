import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { readPipelineCreditHeadroom } from "../credit-headroom.mjs";
import { readQueue, learningRootFor } from "../learning/queue.mjs";
import { readRepoAwareness } from "../hq/github.mjs";
import { decideIdleLaunch, idleTriggerConfig, resetDurationHours } from "./decide.mjs";
import { buildIdleObjectiveText } from "./objective-text.mjs";
import { launchesOnDay, readIdleState, updateIdleState } from "./state.mjs";
import { effectiveMode } from "./mode.mjs";

const execFileAsync = promisify(execFile);
const ACTIVE = new Set(["starting", "decomposing", "planned", "active", "running", "recovering", "incomplete", "integration-blocked", "yielded"]);

function readJson(path, fallback = null) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } }
function walk(root, name, out = []) {
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walk(path, name, out); else if (entry.name === name) out.push(path);
  }
  return out;
}

export function canonicalEvidenceExists(factoryRoot, evidencePath) {
  if (typeof evidencePath !== "string" || !evidencePath.trim()) return false;
  const root = resolve(factoryRoot);
  const direct = resolve(root, evidencePath);
  if ((direct === root || direct.startsWith(`${root}/`)) && existsSync(direct)) return true;
  const taskId = evidencePath.split(":", 1)[0];
  if (!taskId || taskId.includes("/") || taskId.includes("\\")) return false;
  return walk(root, "state.json").some((path) => readJson(path)?.task?.id === taskId);
}

export async function gatherIdleInputs({ hqRoot, stateRoot, config, now, deps = {} }) {
  const factoryRoot = resolve(stateRoot, "..");
  const objectives = walk(factoryRoot, "objective-state.json").map((path) => readJson(path)).filter(Boolean);
  const control = readJson(join(factoryRoot, "control-plane.json"), {});
  const graphIds = new Set(objectives.map((objective) => objective.objectiveId).filter(Boolean));
  objectives.push(...(control.jobs || []).filter((job) => job.kind === "objective" && (!job.objectiveId || !graphIds.has(job.objectiveId))));
  const overnight = readJson(join(factoryRoot, "overnight-queue.json"), {});
  const founderQueued = (overnight.items || []).some((item) => item.status === "queued" || item.status === "running");
  let modelsOut = "";
  try { modelsOut = deps.modelsOut ?? (await execFileAsync("openclaw", ["models", "status"], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout; } catch { /* fail closed via unknown seats */ }
  const headroom = deps.headroom || readPipelineCreditHeadroom({ modelsOut, hqRoot, configPath: deps.seatsConfigPath, now });
  const queue = deps.queue || readQueue(learningRootFor(factoryRoot));
  let openPrs = deps.openPrs;
  if (!openPrs) {
    const project = (readJson(join(hqRoot, "factory", "projects.json"), {})?.projects || []).find((item) => item.key === "openclaw-factory");
    const awareness = await readRepoAwareness({ owner: project?.github?.owner, repo: project?.github?.repo });
    openPrs = awareness.available ? awareness.pullRequests : null;
  }
  return { objectives, founderQueued, headroom, findings: queue.findings || [], openPrs };
}

function recordDecision(stateRoot, result, now, field, extra = {}) {
  return updateIdleState(stateRoot, (state) => ({ ...state, idleReason: result.idleReason, [field]: [...(state[field] || []), { at: now, findingId: result.finding?.id || null, reasons: result.reasons, ...extra }].slice(-200) }));
}

export async function evaluateIdleTrigger({ hqRoot, stateRoot = join(hqRoot, "dashboard", "backend", "data", "factory", "hq-runtime"), now = new Date().toISOString(), trigger = "event", deps = {} } = {}) {
  const config = deps.config || readJson(join(hqRoot, "factory", "factory.config.json"), {});
  const settings = { ...idleTriggerConfig(config), mode: effectiveMode(config, stateRoot).mode };
  if (settings.mode === "off") return { action: "off", mode: "off" };
  const state = readIdleState(stateRoot);
  if (trigger === "heartbeat" && state.lastHeartbeatAt && Date.parse(now) - Date.parse(state.lastHeartbeatAt) < settings.heartbeatMinutes * 60_000) return { action: "rate-limited", mode: settings.mode };
  if (trigger === "heartbeat") updateIdleState(stateRoot, (current) => ({ ...current, lastHeartbeatAt: now }));

  const annotatePrs = (raw) => {
    const launches = readIdleState(stateRoot).launches;
    return { ...raw, openPrs: Array.isArray(raw.openPrs) ? raw.openPrs.map((pr) => {
      const launch = launches.find((entry) => entry.objectiveId && String(pr?.headRefName || pr?.branch || "").includes(entry.objectiveId));
      return launch ? { ...pr, origin: "learning-agent", title: `${pr.title || ""} ${launch.findingId || ""}`.trim() } : pr;
    }) : raw.openPrs };
  };
  const inputs = annotatePrs(deps.inputs || await gatherIdleInputs({ hqRoot, stateRoot, config, now, deps }));
  if (!Array.isArray(inputs.openPrs)) {
    const result = { action: "skip", idleReason: "open-prs-unknown", reasons: ["open-prs-unknown"] };
    updateIdleState(stateRoot, (current) => ({ ...current, idleReason: result.idleReason }));
    return { ...result, mode: settings.mode };
  }
  const evidenceExists = deps.evidenceExists || ((path) => canonicalEvidenceExists(resolve(stateRoot, ".."), path));
  let result = decideIdleLaunch({ config, now, ...inputs, launchesToday: launchesOnDay(state, now), evidenceExists });
  if (result.action === "skip") {
    updateIdleState(stateRoot, (current) => ({ ...current, idleReason: result.idleReason }));
    return { ...result, mode: settings.mode };
  }
  if (settings.mode === "shadow") {
    recordDecision(stateRoot, result, now, "wouldHaveLaunched", { action: result.action });
    return { action: "shadow", wouldHave: result.action, finding: result.finding, reasons: result.reasons, mode: settings.mode };
  }
  if (result.action === "propose") {
    if (!readIdleState(stateRoot).proposals.some((entry) => entry.findingId === result.finding.id)) {
      recordDecision(stateRoot, result, now, "proposals", { evidence: (result.finding.evidence || []).map((entry) => typeof entry === "string" ? entry : entry.path).filter(Boolean), risk: "high" });
    }
    return { ...result, mode: settings.mode };
  }

  // The founder can queue work while the first snapshot is being gathered.
  const fresh = annotatePrs(deps.recheckInputs ? await deps.recheckInputs() : (deps.inputs || await gatherIdleInputs({ hqRoot, stateRoot, config, now, deps })));
  result = decideIdleLaunch({ config, now, ...fresh, launchesToday: launchesOnDay(readIdleState(stateRoot), now), evidenceExists });
  if (result.action !== "launch") {
    updateIdleState(stateRoot, (current) => ({ ...current, idleReason: result.idleReason || "launch-recheck-failed" }));
    return { ...result, mode: settings.mode, rechecked: true };
  }
  const objective = buildIdleObjectiveText(result.finding);
  const launch = await deps.startObjective({ objective, projectId: "openclaw-factory", origin: "learning-agent" });
  const expiring = fresh.headroom.reduce((sum, seat) => sum + Math.max(0, seat.weekWindow.percentLeft - settings.weeklyReservePct), 0);
  updateIdleState(stateRoot, (current) => ({ ...current, idleReason: null, launches: [...current.launches, { at: now, findingId: result.finding.id, objectiveId: launch?.objectiveId || null, reasons: result.reasons }], credit: { ...current.credit, wouldHaveExpired: current.credit.wouldHaveExpired + expiring } }));
  return { ...result, launch, objective, mode: settings.mode };
}

export function idleEventFingerprint({ objectives = [], founderQueued = false, headroom = [] } = {}, now = new Date().toISOString()) {
  const nowMs = Date.parse(now);
  const resetStamp = (value) => {
    const hours = resetDurationHours(value);
    if (!Number.isFinite(nowMs) || hours === null) return null;
    return Math.round((nowMs + hours * 3_600_000) / 900_000) * 900_000;
  };
  return JSON.stringify({ objectives: objectives.map((item) => [item.objectiveId || item.id, item.status]).sort(), founderQueued, resets: headroom.map((seat) => [seat.seat, resetStamp(seat.shortWindow?.resetIn), resetStamp(seat.weekWindow?.resetIn)]).sort() });
}

export async function tickIdleTrigger(options = {}) {
  const { stateRoot, now = new Date().toISOString(), deps = {} } = options;
  const config = deps.config || readJson(join(options.hqRoot, "factory", "factory.config.json"), {});
  if (effectiveMode(config, stateRoot).mode === "off") return { action: "off", mode: "off" };
  const injectedInputs = Boolean(deps.inputs);
  const inputs = deps.inputs || await gatherIdleInputs({ ...options, config, now, deps });
  const state = readIdleState(stateRoot);
  const fingerprint = idleEventFingerprint(inputs, now);
  const changed = Boolean(state.lastFingerprint && state.lastFingerprint !== fingerprint);
  updateIdleState(stateRoot, (current) => ({ ...current, lastFingerprint: fingerprint }));
  const evalDeps = { ...deps, config, inputs };
  if (!injectedInputs) evalDeps.recheckInputs = () => gatherIdleInputs({ ...options, config, now, deps });
  return evaluateIdleTrigger({ ...options, now, trigger: changed ? "event" : "heartbeat", deps: evalDeps });
}

export function activeSelfImprovementObjectives({ stateRoot } = {}) {
  return walk(resolve(stateRoot, ".."), "objective-state.json").map((path) => ({ path, state: readJson(path) })).filter(({ state }) => state?.origin === "learning-agent" && ACTIVE.has(state?.status));
}
