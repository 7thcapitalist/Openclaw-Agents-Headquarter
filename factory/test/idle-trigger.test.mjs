import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { decideIdleLaunch, idleTriggerConfig } from "../lib/idle/decide.mjs";
import { buildIdleObjectiveText } from "../lib/idle/objective-text.mjs";
import { buildIdleTriggerState } from "../lib/idle/panel.mjs";
import { evaluateIdleTrigger, tickIdleTrigger } from "../lib/idle/trigger.mjs";
import { readIdleState, updateIdleState } from "../lib/idle/state.mjs";
import { shouldYieldSelfImprovement } from "../lib/idle/yield-gate.mjs";
import { writeQueue, learningRootFor } from "../lib/learning/queue.mjs";
import { handleObjectiveStart, listFounderJobs } from "../../dashboard/backend/lib/founderControlPlane.mjs";

const NOW = "2026-09-18T12:00:00.000Z";
const finding = (over = {}) => ({ id: "L-0042", status: "open", kind: "pattern", risk: "medium", title: "Repeated wasted review", observation: "The same unchanged gate runs repeatedly.", recommendation: "Skip unchanged reruns and retain the audit event.", occurrences: 3, evidence: [{ path: "task-1:stage:reviewer" }], ...over });
const seat = (over = {}) => ({ seat: "openai/codex", status: "available", shortWindow: { percentLeft: 60, resetIn: "2h" }, weekWindow: { percentLeft: 50, resetIn: "12h" }, ...over });
const base = (over = {}) => ({ config: { learning: { patternThreshold: 2 } }, now: NOW, objectives: [], founderQueued: false, headroom: [seat()], findings: [finding()], openPrs: [], launchesToday: 0, evidenceExists: () => true, ...over });

test("decision files one eligible low/medium finding", () => {
  assert.equal(decideIdleLaunch(base()).action, "launch");
});

const failedConditions = [
  ["founder active", "founder-active", { objectives: [{ status: "running" }] }],
  ["founder queued", "founder-queued", { founderQueued: true }],
  ["short-window below reserve", "short-window-low", { headroom: [seat({ shortWindow: { percentLeft: 39, resetIn: "2h" } })] }],
  ["weekly below reserve", "weekly-low", { headroom: [seat({ weekWindow: { percentLeft: 19, resetIn: "12h" } })] }],
  ["no expiring surplus", "no-expiring-surplus", { headroom: [seat({ weekWindow: { percentLeft: 50, resetIn: "2d" } })] }],
  ["self-improvement running", "self-improvement-running", { objectives: [{ origin: "learning-agent", status: "running" }] }],
  ["three open learning PRs", "open-pr-cap", { openPrs: [1, 2, 3].map((n) => ({ title: `learning-agent ${n}` })) }],
  ["finding below threshold", "no-eligible-finding", { findings: [finding({ occurrences: 1 })] }],
  ["finding without evidence", "no-eligible-finding", { findings: [finding({ evidence: [] })] }],
  ["finding already addressed", "no-eligible-finding", { openPrs: [{ title: "Fix L-0042", headRefName: "factory/fix" }], findings: [finding()] }],
];

for (const [name, reason, change] of failedConditions) {
  test(`no launch when ${name}`, () => {
    const result = decideIdleLaunch(base(change));
    assert.equal(result.action, "skip", reason);
    assert.equal(result.idleReason, reason, reason);
  });
}

test("unknown credit headroom and missing canonical evidence fail closed", () => {
  assert.equal(decideIdleLaunch(base({ headroom: [seat({ status: "unknown", shortWindow: null, weekWindow: null })] })).idleReason, "seat-unknown");
  assert.equal(decideIdleLaunch(base({ evidenceExists: () => false })).idleReason, "no-eligible-finding");
  assert.equal(decideIdleLaunch(base({ openPrs: [{ title: "Fix L-0042", headRefName: "factory/fix" }] })).idleReason, "no-eligible-finding");
});

test("daily cap is enforced and high-risk findings become canonical-evidence proposals", async () => {
  assert.equal(decideIdleLaunch(base({ launchesToday: 4 })).idleReason, "daily-cap");
  const highFinding = finding({ risk: "high", title: "Change security gate" });
  const high = decideIdleLaunch(base({ findings: [highFinding] }));
  assert.equal(high.action, "propose");
  assert.deepEqual(high.finding.evidence, [{ path: "task-1:stage:reviewer" }]);
  const fx = fixture();
  let launched = false;
  await evaluateIdleTrigger({ ...fx, now: NOW, deps: { inputs: base({ findings: [highFinding] }), evidenceExists: () => true, startObjective: async () => { launched = true; } } });
  const proposal = readIdleState(fx.stateRoot).proposals[0];
  assert.equal(launched, false);
  assert.deepEqual(proposal.evidence, ["task-1:stage:reviewer"]);
});

test("objective text identifies waste, evidence, success measure, founder merge, and origin", () => {
  const text = buildIdleObjectiveText(finding());
  assert.match(text, /WHAT IS WASTEFUL[\s\S]*unchanged gate/);
  assert.match(text, /task-1:stage:reviewer/);
  assert.match(text, /FIX MUST ACHIEVE/);
  assert.match(text, /HOW TO MEASURE/);
  assert.match(text, /origin: learning-agent/);
  assert.match(text, /founder.*merge/i);
});

function fixture() {
  const hqRoot = mkdtempSync(join(tmpdir(), "idle-trigger-"));
  const stateRoot = join(hqRoot, "dashboard", "backend", "data", "factory", "hq-runtime");
  mkdirSync(join(hqRoot, "factory"), { recursive: true });
  writeFileSync(join(hqRoot, "factory", "factory.config.json"), JSON.stringify({ learning: { patternThreshold: 2 } }));
  return { hqRoot, stateRoot };
}

test("on is the default and exactly one objective goes through the injected normal-intake seam", async () => {
  const { hqRoot, stateRoot } = fixture();
  let calls = 0;
  let request;
  const result = await evaluateIdleTrigger({ hqRoot, stateRoot, now: NOW, deps: {
    inputs: base(), evidenceExists: () => true,
    startObjective: async (value) => { calls += 1; request = value; return { objectiveId: "obj-learning" }; },
  } });
  assert.equal(idleTriggerConfig({}).mode, "on");
  assert.equal(result.action, "launch");
  assert.equal(calls, 1);
  assert.equal(request.projectId, "openclaw-factory");
  assert.equal(request.origin, "learning-agent");
  assert.equal(readIdleState(stateRoot).launches.length, 1);
});

test("shadow records every would-launch decision, off performs no state I/O", async () => {
  const shadow = fixture();
  const config = { learning: { patternThreshold: 2, idleTrigger: { mode: "shadow" } } };
  let launches = 0;
  for (let i = 0; i < 2; i += 1) await evaluateIdleTrigger({ ...shadow, now: `2026-09-18T12:0${i}:00Z`, deps: { config, inputs: base(), evidenceExists: () => true, startObjective: async () => { launches += 1; } } });
  assert.equal(launches, 0);
  assert.equal(readIdleState(shadow.stateRoot).wouldHaveLaunched.length, 2);

  const off = fixture();
  const result = await evaluateIdleTrigger({ ...off, deps: { config: { learning: { idleTrigger: { mode: "off" } } } } });
  assert.equal(result.action, "off");
  assert.equal(readIdleState(off.stateRoot).idleReason, "not-evaluated");
});

test("heartbeat is limited to one evaluation per 15 minutes while a changed event evaluates immediately", async () => {
  const fx = fixture();
  const config = { learning: { patternThreshold: 2, idleTrigger: { mode: "shadow", heartbeatMinutes: 15 } } };
  const deps = { config, inputs: base(), evidenceExists: () => true };
  assert.equal((await evaluateIdleTrigger({ ...fx, now: NOW, trigger: "heartbeat", deps })).action, "shadow");
  assert.equal((await evaluateIdleTrigger({ ...fx, now: "2026-09-18T12:10:00Z", trigger: "heartbeat", deps })).action, "rate-limited");
  const first = await tickIdleTrigger({ ...fx, now: "2026-09-18T12:16:00Z", deps });
  assert.equal(first.action, "shadow");
  const changed = await tickIdleTrigger({ ...fx, now: "2026-09-18T12:17:00Z", deps: { ...deps, inputs: base({ founderQueued: true }) } });
  assert.equal(changed.idleReason, "founder-queued", "queue change bypasses the heartbeat window as an event");
});

test("read-only panel exposes the stable contract and estimated credit accounting", () => {
  const fx = fixture();
  mkdirSync(join(fx.stateRoot, "tasks", "task-1"), { recursive: true });
  writeFileSync(join(fx.stateRoot, "tasks", "task-1", "state.json"), JSON.stringify({ version: 1, task: { id: "task-1" }, events: [] }));
  writeQueue(learningRootFor(resolve(fx.stateRoot, "..")), { version: 1, updatedAt: NOW, nextId: 43, findings: [finding()] });
  updateIdleState(fx.stateRoot, (state) => ({ ...state, idleReason: "factory-idle", launches: [{ at: NOW, findingId: "L-0042" }], credit: { usedBySelfImprovement: 7, wouldHaveExpired: 30, basis: "estimate" } }));
  const panel = buildIdleTriggerState(fx);
  assert.equal(panel.contract, "hq.idle-trigger/1");
  assert.equal(panel.mode, "on");
  assert.equal(panel.credit.basis, "estimate");
  assert.equal(panel.findings[0].eligible, true);
});

test("a founder launch or queued objective activates the learning-objective yield gate", () => {
  const fx = fixture();
  const factoryRoot = resolve(fx.stateRoot, "..");
  const learning = { objectiveId: "obj-learning", origin: "learning-agent", status: "active" };
  mkdirSync(factoryRoot, { recursive: true });
  writeFileSync(join(factoryRoot, "control-plane.json"), JSON.stringify({ jobs: [{ id: "founder-1", kind: "objective", status: "running" }] }));
  assert.equal(shouldYieldSelfImprovement({ objective: learning, hqRoot: fx.hqRoot, stateRoot: fx.stateRoot }), true);
  writeFileSync(join(factoryRoot, "control-plane.json"), JSON.stringify({ jobs: [] }));
  writeFileSync(join(factoryRoot, "overnight-queue.json"), JSON.stringify({ items: [{ id: "queued-1", status: "queued" }] }));
  assert.equal(shouldYieldSelfImprovement({ objective: learning, hqRoot: fx.hqRoot, stateRoot: fx.stateRoot }), true);
});

test("normal objective intake persists learning origin on both job and graph", async () => {
  const { hqRoot } = fixture();
  const repo = join(hqRoot, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(hqRoot, "factory", "projects.json"), JSON.stringify({ projects: [{ key: "openclaw-factory", repo }] }));
  let objectivePath;
  const result = await handleObjectiveStart({ root: hqRoot, hqRoot, objective: buildIdleObjectiveText(finding()), projectId: "openclaw-factory", origin: "learning-agent", decompose: async () => ({ objectiveId: "obj-learning", status: "planned", nodes: {}, events: [] }), runObjective: async (args) => { objectivePath = args.objectivePath; return { status: "complete" }; } });
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(result.objectiveId, "obj-learning");
  assert.equal(listFounderJobs(hqRoot)[0].origin, "learning-agent");
  assert.equal(JSON.parse(readFileSync(objectivePath, "utf8")).origin, "learning-agent");
});

test("pm2 entry uses node and worker runs when argv[1] is a wrapper", () => {
  const root = process.cwd();
  const ecosystem = awaitImportCjs(join(root, "ecosystem.config.cjs"), root);
  const app = ecosystem.apps.find((item) => item.name === "hq-idle-trigger");
  assert.equal(app.interpreter, "node");
  const dir = mkdtempSync(join(tmpdir(), "idle-pm2-"));
  const wrapper = join(dir, "pm2-wrapper.mjs");
  writeFileSync(wrapper, `import ${JSON.stringify(pathToFileURL(join(root, "scripts", "hq-idle-trigger.mjs")).href)};\n`);
  const output = execFileSync(process.execPath, [wrapper], { cwd: root, env: { ...process.env, HQ_IDLE_TRIGGER_ONCE: "1", HQ_IDLE_TRIGGER_TEST_OFF: "1" }, encoding: "utf8" });
  assert.match(output, /\[idle-trigger\] off/);
});

function awaitImportCjs(path, root) {
  const source = readFileSync(path, "utf8");
  const module = { exports: {} };
  Function("require", "module", "exports", "__dirname", source)(requireForTest, module, module.exports, root);
  return module.exports;
}
function requireForTest(name) {
  if (name === "node:fs") return { readFileSync };
  if (name === "node:path") return { join };
  if (name === "node:os") return { homedir: () => tmpdir() };
  throw new Error(`unexpected require ${name}`);
}
