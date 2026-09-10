import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { permissionsPanel } from "../../dashboard/backend/public/lib/permissionsView.mjs";
import { buildPermissionsSnapshot } from "../lib/hq/permissions-snapshot.mjs";
import { appendAuditEvent, createAuditEvent } from "../lib/audit/envelope.mjs";

const denial = (over = {}) => ({
  occurredAt: "2026-09-10T04:00:00Z", action: "permission.denied", actorId: "backend-builder",
  capability: "github.open-pr", reason: "out-of-scope", enforcement: "enforce", wouldDeny: false,
  subject: { type: "project", id: "lifemaxing" }, ...over,
});

const snapshot = (over = {}) => ({
  version: 1, available: true, enforcement: "enforce", configured: true, warnings: [],
  grants: [], summary: { grants: 12, actors: 7, denials: 1, wouldDeny: 0 },
  recentDenials: [denial()], ...over,
});

// --- panel -------------------------------------------------------------------

test("renders an honest unavailable state", () => {
  assert.match(permissionsPanel(null), /Unavailable/);
});

test("an unenforced factory gets one quiet line, not a dashboard of zeroes", () => {
  const html = permissionsPanel(snapshot({ enforcement: "off", configured: false, summary: {}, recentDenials: [] }));
  assert.match(html, /Not enforcing/);
  assert.match(html, /runs as before/);
  assert.doesNotMatch(html, /operations-metrics/, "an unused control must not occupy the founder's attention");
});

test("report mode says nothing is blocked and shows what would be", () => {
  const html = permissionsPanel(snapshot({ enforcement: "report", summary: { grants: 12, actors: 7, denials: 3, wouldDeny: 3 } }));
  assert.match(html, /Observing/);
  assert.match(html, /nothing is blocked/);
  assert.match(html, /would be denied/);
});

test("enforce mode names the actor, capability, and reason for each denial", () => {
  const html = permissionsPanel(snapshot());
  assert.match(html, /Enforcing/);
  assert.match(html, /backend-builder/);
  assert.match(html, /github\.open-pr/);
  assert.match(html, /out-of-scope/);
  assert.match(html, /lifemaxing/);
});

test("a registry that cannot be read reads as broken, never as off", () => {
  const html = permissionsPanel(snapshot({ available: false, enforcement: "off", warnings: ["permission registry unreadable: bad JSON"] }));
  assert.match(html, /Broken/);
  assert.match(html, /task initialization will refuse/);
  assert.match(html, /bad JSON/);
  assert.doesNotMatch(html, /Not enforcing/);
});

test("no denials is stated, not left blank", () => {
  assert.match(permissionsPanel(snapshot({ recentDenials: [], summary: { grants: 1, actors: 1, denials: 0, wouldDeny: 0 } })), /No permission denials recorded/);
});

test("actor ids, capabilities, and reasons are escaped", () => {
  const html = permissionsPanel(snapshot({ recentDenials: [denial({ actorId: "<script>", capability: "<img src=x>", reason: "\"><b>" })] }));
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /&lt;script&gt;/);
});

test("the panel carries an accessible section label", () => {
  assert.match(permissionsPanel(snapshot()), /aria-labelledby="factory-permissions-title"/);
});

// --- snapshot ----------------------------------------------------------------

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hq-perm-snap-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  return root;
}

test("with no registry the snapshot reports off and configured false", () => {
  const snap = buildPermissionsSnapshot({ hqRoot: fixture(), stateRoot: join(fixture(), "state") });
  assert.equal(snap.enforcement, "off");
  assert.equal(snap.configured, false);
  assert.equal(snap.available, true);
});

test("an unreadable registry is a warning, not a silent off", () => {
  const root = fixture();
  writeFileSync(join(root, "factory", "permissions.json"), "{ broken");
  const snap = buildPermissionsSnapshot({ hqRoot: root, stateRoot: join(root, "state") });
  assert.equal(snap.available, false);
  assert.match(snap.warnings.join(" "), /permission registry unreadable/);
});

test("denials are collected from the company log and from each task's own log", () => {
  const root = fixture();
  writeFileSync(join(root, "factory", "permissions.json"), JSON.stringify({
    version: 1, mode: "enforce",
    grants: [{ actorId: "builder", capability: "task.initialize", scopeType: "project", scopeId: "hq" }],
  }));

  const event = (id, action, at) => createAuditEvent({
    eventId: id, occurredAt: at, actor: { type: "agent", id: "builder" }, action,
    subject: { type: "project", id: "hq" }, correlation: {},
    data: { capability: "task.initialize", reason: "no-grant", enforcement: "enforce", wouldDeny: "false" },
  });
  appendAuditEvent(join(root, ".openclaw-factory", "telemetry", "permissions.ndjson"), event("a", "permission.denied", "2026-09-10T04:00:00Z"));
  const taskDir = join(root, "state", "proj", "tasks", "t1");
  mkdirSync(taskDir, { recursive: true });
  appendAuditEvent(join(taskDir, "audit.ndjson"), event("b", "permission.denied", "2026-09-10T05:00:00Z"));
  appendAuditEvent(join(taskDir, "audit.ndjson"), event("c", "permission.allowed", "2026-09-10T06:00:00Z"));

  const snap = buildPermissionsSnapshot({ hqRoot: root, stateRoot: join(root, "state") });
  assert.equal(snap.enforcement, "enforce");
  assert.equal(snap.summary.grants, 1);
  assert.equal(snap.summary.denials, 2, "both logs are read");
  assert.equal(snap.recentDenials[0].occurredAt, "2026-09-10T05:00:00Z", "newest first");
  assert.equal(snap.recentDenials.every((d) => d.action === "permission.denied"), true, "allows are not counted as denials");
});

test("a corrupt audit log degrades the view rather than hiding every denial", () => {
  const root = fixture();
  const taskDir = join(root, "state", "proj", "tasks", "t1");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "audit.ndjson"), "{ truncated\n");
  const snap = buildPermissionsSnapshot({ hqRoot: root, stateRoot: join(root, "state") });
  assert.equal(snap.available, false);
  assert.match(snap.warnings.join(" "), /permission decisions unavailable/);
});
