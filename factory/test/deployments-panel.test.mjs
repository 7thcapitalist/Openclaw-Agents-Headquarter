import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildDeploymentsSnapshot } from "../lib/hq/deployments.mjs";
import { deploymentsPanel } from "../../dashboard/backend/public/lib/deploymentsView.mjs";

// `repo` is required by the registry schema; a fixture without it makes
// readRegistry throw, which is a different path from the one under test.
function hq(projects) {
  const root = mkdtempSync(join(tmpdir(), "hq-deployments-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  const complete = projects.map((p) => ({ repo: ".", status: "active", ...p }));
  writeFileSync(join(root, "factory", "projects.json"), JSON.stringify({ version: 1, projects: complete }), "utf8");
  return root;
}

// ── the aggregate ─────────────────────────────────────────────────────────

test("a project with no deployment record reads as never deployed, not failed", () => {
  const snapshot = buildDeploymentsSnapshot({ hqRoot: hq([{ key: "a", name: "Alpha" }]) });
  assert.equal(snapshot.deployments[0].state, "not_deployed");
  assert.equal(snapshot.summary.neverDeployed, 1);
  assert.equal(snapshot.summary.failed, 0);
});

test("no registry is a warning and an empty list, never a throw", () => {
  const snapshot = buildDeploymentsSnapshot({ hqRoot: mkdtempSync(join(tmpdir(), "hq-empty-")) });
  assert.deepEqual(snapshot.deployments, []);
  assert.equal(snapshot.summary.projects, 0);
});

test("a malformed registry degrades to a warning, never breaks the view", () => {
  // The registry schema rejects an entry with no key by throwing. The panel
  // must not propagate that into the Today view.
  const snapshot = buildDeploymentsSnapshot({ hqRoot: hq([{ name: "no key" }]) });
  assert.deepEqual(snapshot.deployments, []);
  assert.equal(snapshot.warnings.length, 1);
  assert.match(snapshot.warnings[0], /registry/i);
});

test("what needs a human sorts to the top, then ties break by name", () => {
  const rank = { founderActionRequired: 0, failed: 1, unknown: 2, deployed: 3, not_deployed: 4 };
  assert.ok(rank.founderActionRequired < rank.failed && rank.failed < rank.deployed);
  const snapshot = buildDeploymentsSnapshot({ hqRoot: hq([{ key: "z", name: "Zeta" }, { key: "a", name: "Alpha" }]) });
  assert.deepEqual(snapshot.deployments.map((d) => d.name), ["Alpha", "Zeta"]);
});

test("it declares itself read-only", () => {
  assert.equal(buildDeploymentsSnapshot({ hqRoot: hq([]) }).readOnly, true);
});

test("it never throws, whatever it is handed", () => {
  assert.doesNotThrow(() => buildDeploymentsSnapshot({ hqRoot: "/nonexistent/xyz" }));
  assert.doesNotThrow(() => buildDeploymentsSnapshot({}));
});

// ── the panel ─────────────────────────────────────────────────────────────

const row = (over = {}) => ({
  projectKey: "lifemaxing", name: "LifeMax", kind: "product",
  state: "deployed", productionUrl: "https://lifemax.example.com",
  health: "ok", lastDeploymentAt: "2026-09-12T00:00:00Z", founderActionRequired: false, ...over,
});
const snap = (deployments, summary = {}) => ({
  available: true, readOnly: true, deployments,
  summary: { projects: deployments.length, deployed: 0, failed: 0, neverDeployed: 0, awaitingFounder: 0, ...summary },
  warnings: [],
});

test("a live deployment links its production URL", () => {
  const html = deploymentsPanel(snap([row()], { deployed: 1 }));
  assert.match(html, /1 live/);
  assert.match(html, /href="https:\/\/lifemax\.example\.com"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test("a project awaiting the founder outranks a failure in the heading", () => {
  const html = deploymentsPanel(snap(
    [row({ state: "failed", founderActionRequired: true })], { failed: 1, awaitingFounder: 1 }));
  assert.match(html, /1 awaiting you/);
  assert.match(html, /Needs you/);
  assert.match(html, /waiting on a founder action/);
});

test("never deployed is stated plainly, not as an error", () => {
  const html = deploymentsPanel(snap([row({ state: "not_deployed", productionUrl: null, health: null, lastDeploymentAt: null })], { neverDeployed: 1 }));
  assert.match(html, /Never deployed/);
  assert.match(html, /No deployment recorded yet/);
  assert.doesNotMatch(html, /status-bad/);
});

test("an unrecognised state is surfaced, never bucketed as healthy", () => {
  const html = deploymentsPanel(snap([row({ state: "sideways" })]));
  assert.match(html, /Unrecognised state/);
});

// A provider response supplies this value, so it is not trusted markup.
test("a javascript: production URL is printed, never linked", () => {
  const html = deploymentsPanel(snap([row({ productionUrl: "javascript:alert(1)" })]));
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /javascript:alert\(1\)/);
});

test("project names are escaped", () => {
  const html = deploymentsPanel(snap([row({ name: "<img src=x onerror=alert(1)>" })]));
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test("a missing payload degrades instead of throwing", () => {
  assert.doesNotThrow(() => deploymentsPanel(null));
  assert.match(deploymentsPanel(null), /not available/i);
  assert.match(deploymentsPanel(snap([])), /No projects are registered/);
});
