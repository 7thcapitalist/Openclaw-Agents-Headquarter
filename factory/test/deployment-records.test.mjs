// Every "open what it produced" link on the console was dead, for two reasons
// at once: nothing outside the test suite ever called `runDeployment`, so no
// deployment record was ever written, and neither project declared a URL. The
// console then had nothing to link to and said so.
//
// These tests pin both halves — the founder-declared registry URL, and the
// record the release stage writes — and, just as importantly, pin the
// difference between them. A declared URL is a note in a config file; it is
// not evidence that anything was deployed, and a surface that renders it as
// "deployed" is showing a wrong answer.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { validateRegistry } from "../lib/intel/schema.mjs";
import { validateAgentResult } from "../lib/openclaw-protocol.mjs";
import { buildDeploymentsSnapshot } from "../lib/hq/deployments.mjs";
import { readDeploymentState } from "../lib/deploy/store.mjs";
import { recordReleaseDeployment, normalizeDeploymentUrl, readReleaseDeployment } from "../lib/deploy/record-release.mjs";
import { createState, readState, writeState } from "../lib/task-workflow.mjs";
import { deploymentsPanel } from "../../dashboard/backend/public/lib/deploymentsView.mjs";

function hq(projects) {
  const root = mkdtempSync(join(tmpdir(), "deploy-records-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  const complete = projects.map((p) => ({ repo: ".", status: "active", ...p }));
  writeFileSync(join(root, "factory", "projects.json"), JSON.stringify({ version: 1, projects: complete }), "utf8");
  return root;
}

function taskFixture(root, project = "demo") {
  const worktree = join(root, "worktree");
  const statePath = join(root, "state", "state.json");
  mkdirSync(worktree, { recursive: true });
  writeState(statePath, createState({
    task: {
      id: "task-deploy", issue: "local:deploy", outcome: "Ship it.",
      acceptanceCriteria: ["It is live"], project, workType: "ops", risk: "low",
    },
    repo: join(root, "repo"), branch: "factory/x", worktree,
  }));
  return statePath;
}

const releaseResult = (deployment) => ({
  version: 1, dispatchId: "d1", stage: "release", actor: "openclaw",
  outcome: "pass", summary: "released", evidence: ["e.txt"],
  ...(deployment === undefined ? {} : { deployment }),
});

// ── the registry half ─────────────────────────────────────────────────────

test("a project may declare where it lives in production", () => {
  const registry = { version: 1, projects: [{ key: "lifemaxing", repo: ".", productionUrl: "https://lifemax-umber.vercel.app" }] };
  assert.equal(validateRegistry(registry).projects[0].productionUrl, "https://lifemax-umber.vercel.app");
});

test("a declared URL that would render as a bad link is refused at load", () => {
  const bad = (productionUrl) => () => validateRegistry({ version: 1, projects: [{ key: "p", repo: ".", productionUrl }] });
  assert.throws(bad("http://lifemax-umber.vercel.app"), /must use https/);
  assert.throws(bad("lifemax-umber.vercel.app"), /absolute URL/);
  assert.throws(bad("https://user:pw@lifemax.app"), /credentials/);
  assert.throws(bad("https://localhost"), /fully qualified host/);
  assert.throws(bad(""), /non-empty string/);
  assert.throws(bad(42), /non-empty string/);
});

test("a declared URL reaches the snapshot, and says it was only declared", () => {
  const snapshot = buildDeploymentsSnapshot({ hqRoot: hq([{ key: "lifemaxing", name: "LifeMax", productionUrl: "https://lifemax-umber.vercel.app" }]) });
  const row = snapshot.deployments[0];
  assert.equal(row.productionUrl, "https://lifemax-umber.vercel.app");
  assert.equal(row.productionUrlSource, "registry");
  // The honest pairing: there is a URL to click AND nothing was deployed.
  assert.equal(row.state, "not_deployed");
});

test("the deployments panel does not let a declared URL read as a deployment", () => {
  const snapshot = buildDeploymentsSnapshot({ hqRoot: hq([{ key: "lifemaxing", name: "LifeMax", productionUrl: "https://lifemax-umber.vercel.app" }]) });
  const html = deploymentsPanel(snapshot);
  assert.match(html, /lifemax-umber\.vercel\.app/);
  assert.match(html, /declared in the registry, not observed/);
});

test("the shipped registry declares LifeMax, so that link resolves today", () => {
  const shipped = JSON.parse(readFileSync(new URL("../projects.json", import.meta.url), "utf8"));
  validateRegistry(shipped);
  const lifemax = shipped.projects.find((p) => p.key === "lifemaxing");
  assert.equal(lifemax.productionUrl, "https://lifemax-umber.vercel.app");
});

// ── what a release result may claim ───────────────────────────────────────

test("a release result may carry a deployment, and it is validated", () => {
  assert.doesNotThrow(() => validateAgentResult(releaseResult({ url: "https://app.example.com" })));
  assert.doesNotThrow(() => validateAgentResult(releaseResult(undefined)));
  assert.throws(() => validateAgentResult(releaseResult({ url: "http://app.example.com" })), /must use https/);
  assert.throws(() => validateAgentResult(releaseResult({ url: "not-a-url" })), /absolute URL/);
  assert.throws(() => validateAgentResult(releaseResult({})), /requires a url/);
  assert.throws(() => validateAgentResult(releaseResult({ url: "https://a.example.com", environment: "staging" })), /production or preview/);
  assert.throws(() => validateAgentResult(releaseResult({ url: "https://user:pw@a.example.com" })), /credentials/);
});

test("only the release stage may report a deployment", () => {
  const builder = { ...releaseResult({ url: "https://app.example.com" }), stage: "builder" };
  assert.throws(() => validateAgentResult(builder), /Only the release stage/);
});

test("a URL that is not clickable is not a URL", () => {
  assert.equal(normalizeDeploymentUrl("https://app.example.com/"), "https://app.example.com/");
  assert.equal(normalizeDeploymentUrl("http://app.example.com"), null);
  assert.equal(normalizeDeploymentUrl(""), null);
  assert.equal(normalizeDeploymentUrl(null), null);
  assert.equal(readReleaseDeployment({}), null);
  assert.equal(readReleaseDeployment({ deployment: { url: "http://x.example.com" } }).url, null);
});

// ── the record the release stage writes ───────────────────────────────────

test("a released production URL becomes the project's deployment record", () => {
  const root = hq([{ key: "demo", name: "Demo" }]);
  const statePath = taskFixture(root);
  const out = recordReleaseDeployment({
    hqRoot: root, statePath, state: readState(statePath),
    result: releaseResult({ url: "https://demo.example.com", provider: "vercel", providerDeploymentId: "dpl_1" }),
  });
  assert.equal(out.recorded, true);
  assert.equal(out.environment, "production");

  const record = readDeploymentState({ hqRoot: root, projectKey: "demo" });
  assert.equal(record.state, "deployed");
  assert.equal(record.productionUrl, "https://demo.example.com/");
  assert.equal(record.providerDeploymentId, "dpl_1");
  assert.ok(record.lastDeploymentAt);

  // And it now outranks the declared URL, labelled as observed.
  const snapshot = buildDeploymentsSnapshot({ hqRoot: root });
  assert.equal(snapshot.deployments[0].productionUrlSource, "deployment-record");
  assert.equal(snapshot.deployments[0].state, "deployed");
});

test("an observed deployment beats a declared one for the same project", () => {
  const root = hq([{ key: "demo", name: "Demo", productionUrl: "https://declared.example.com" }]);
  const statePath = taskFixture(root);
  recordReleaseDeployment({
    hqRoot: root, statePath, state: readState(statePath),
    result: releaseResult({ url: "https://observed.example.com" }),
  });
  const row = buildDeploymentsSnapshot({ hqRoot: root }).deployments[0];
  assert.equal(row.productionUrl, "https://observed.example.com/");
  assert.equal(row.productionUrlSource, "deployment-record");
});

test("a preview belongs to the task that made it, never to the project", () => {
  const root = hq([{ key: "demo", name: "Demo" }]);
  const statePath = taskFixture(root);
  const out = recordReleaseDeployment({
    hqRoot: root, statePath, state: readState(statePath),
    result: releaseResult({ url: "https://branch-preview.example.com", environment: "preview" }),
  });
  assert.equal(out.recorded, true);
  assert.equal(out.environment, "preview");
  assert.equal(out.projectRecordPath, null);
  assert.equal(readState(statePath).deployment.previewUrl, "https://branch-preview.example.com/");
  // The project must not claim a task's branch deployment as where it lives.
  assert.equal(readDeploymentState({ hqRoot: root, projectKey: "demo" }), null);
});

test("the task carries its own deployment, so a delivery can link to it", () => {
  const root = hq([{ key: "demo", name: "Demo" }]);
  const statePath = taskFixture(root);
  recordReleaseDeployment({
    hqRoot: root, statePath, state: readState(statePath),
    result: releaseResult({ url: "https://demo.example.com" }),
  });
  const state = readState(statePath);
  assert.equal(state.deployment.productionUrl, "https://demo.example.com/");
  assert.ok(state.events.some((e) => e.type === "deployment-recorded"));
});

test("a release that deployed nothing records nothing, and is not an error", () => {
  const root = hq([{ key: "demo", name: "Demo" }]);
  const statePath = taskFixture(root);
  const out = recordReleaseDeployment({ hqRoot: root, statePath, state: readState(statePath), result: releaseResult(undefined) });
  assert.equal(out.recorded, false);
  assert.match(out.reason, /declared no deployment/);
  assert.equal(readState(statePath).deployment, undefined);
});

test("recording never throws, whatever it is handed", () => {
  const root = hq([{ key: "demo", name: "Demo" }]);
  const statePath = taskFixture(root);
  assert.doesNotThrow(() => recordReleaseDeployment({ hqRoot: root, statePath, state: null, result: null }));
  assert.doesNotThrow(() => recordReleaseDeployment({ hqRoot: root, statePath, state: readState(statePath), result: releaseResult({ url: "nonsense" }) }));
  // A task whose project is not in the registry still gets its own record.
  const orphan = taskFixture(mkdtempSync(join(tmpdir(), "orphan-")), "NOT-A-SLUG");
  const out = recordReleaseDeployment({ hqRoot: root, statePath: orphan, state: readState(orphan), result: releaseResult({ url: "https://x.example.com" }) });
  assert.equal(out.recorded, true);
  assert.match(out.reason, /project record could not be written/);
  assert.equal(readState(orphan).deployment.productionUrl, "https://x.example.com/");
});

test("recording a deployment does not store a state copy in the ledger", () => {
  // The 2026-09-14 write storm was 403 GiB of exactly this: a mutation whose
  // ledger row held the whole 195 KiB document. A new writer must not
  // reintroduce it.
  const root = hq([{ key: "demo", name: "Demo" }]);
  const statePath = taskFixture(root);
  recordReleaseDeployment({
    hqRoot: root, statePath, state: readState(statePath),
    result: releaseResult({ url: "https://demo.example.com" }),
  });
  const source = readFileSync(new URL("../lib/deploy/record-release.mjs", import.meta.url), "utf8");
  assert.match(source, /replayable: false/);
  assert.match(source, /toResponse:/);
});
