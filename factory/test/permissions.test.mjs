import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CAPABILITIES, PermissionDeniedError, authorize, enforce,
  readPermissionRegistry, recordPermissionDecision,
} from "../lib/hq/permissions.mjs";
import { readAuditEvents } from "../lib/audit/envelope.mjs";

const grant = (over = {}) => ({ actorId: "builder", capability: "task.initialize", scopeType: "project", scopeId: "hq", ...over });
const registry = (mode, grants = [grant()]) => ({ version: 1, enforcement: mode, grants, present: true, path: null });

function fixture(contents) {
  const root = mkdtempSync(join(tmpdir(), "hq-perms-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  if (contents !== undefined) writeFileSync(join(root, "factory", "permissions.json"), typeof contents === "string" ? contents : JSON.stringify(contents));
  return root;
}

// --- the safety properties ---------------------------------------------------

test("this system can only deny: no capability grants merge, deploy, spend, or secrets", () => {
  for (const forbidden of ["pr.merge", "deploy.production", "billing.change", "secret.read", "git.push-to-main"]) {
    assert.equal(CAPABILITIES.includes(forbidden), false, `${forbidden} must never be a capability`);
  }
});

test("a registry naming a forbidden capability is rejected outright, not partially honoured", () => {
  const root = fixture({ version: 1, mode: "enforce", grants: [grant({ capability: "pr.merge" })] });
  assert.throws(() => readPermissionRegistry(root), /must never confer/);
  // The message has to say where the real authority lives, or the next person
  // just adds the capability to the list.
  assert.throws(() => readPermissionRegistry(root), /prohibitedAutonomousActions/);
});

test("founder authority outranks the grant table and cannot be locked out", () => {
  const decision = authorize({ registry: registry("enforce", []), actorType: "human", actorId: "founder", capability: "task.initialize", scope: {} });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "founder-authority");
});

test("a task carrying a verified founder approval is allowed regardless of grants", () => {
  const decision = authorize({
    registry: registry("enforce", []), actorId: "builder", capability: "task.initialize",
    scope: { projectId: "hq" }, founderApproval: { verified: true },
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "founder-approved-task");
});

test("an unverified approval claim grants nothing", () => {
  for (const claim of [{ verified: false }, { verified: "true" }, {}, null]) {
    const decision = authorize({ registry: registry("enforce", []), actorId: "builder", capability: "task.initialize", scope: { projectId: "hq" }, founderApproval: claim });
    assert.equal(decision.allowed, false, `${JSON.stringify(claim)} must not be treated as approval`);
  }
});

// --- modes -------------------------------------------------------------------

test("with no permissions file every check allows and says why", () => {
  const decision = authorize({ registry: readPermissionRegistry(fixture()), actorId: "nobody", capability: "task.initialize", scope: {} });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "enforcement-disabled");
});

test("report mode computes the real verdict, records it, and allows anyway", () => {
  const decision = authorize({ registry: registry("report", []), actorId: "builder", capability: "task.initialize", scope: { projectId: "hq" } });
  assert.equal(decision.allowed, true, "report mode must not stop work");
  assert.equal(decision.wouldDeny, true, "but it must say the work would have been stopped");
  assert.equal(decision.reason, "no-grant");
});

test("a file with no mode defaults to report, so adding it cannot take the factory down", () => {
  const root = fixture({ version: 1, grants: [grant()] });
  assert.equal(readPermissionRegistry(root).enforcement, "report");
});

test("enforce mode denies", () => {
  assert.equal(authorize({ registry: registry("enforce", []), actorId: "builder", capability: "task.initialize", scope: { projectId: "hq" } }).allowed, false);
});

// --- scoping -----------------------------------------------------------------

test("a project grant covers its project and nothing else", () => {
  const reg = registry("enforce");
  assert.equal(authorize({ registry: reg, actorId: "builder", capability: "task.initialize", scope: { projectId: "hq" } }).allowed, true);
  assert.equal(authorize({ registry: reg, actorId: "builder", capability: "task.initialize", scope: { projectId: "other" } }).reason, "out-of-scope");
});

test("an under-specified request fails closed rather than matching every scope", () => {
  const reg = registry("enforce");
  assert.equal(authorize({ registry: reg, actorId: "builder", capability: "task.initialize", scope: {} }).reason, "out-of-scope");
});

test("a task grant covers exactly that task", () => {
  const reg = registry("enforce", [grant({ scopeType: "task", scopeId: "task-7" })]);
  assert.equal(authorize({ registry: reg, actorId: "builder", capability: "task.initialize", scope: { type: "task", id: "task-7" } }).allowed, true);
  assert.equal(authorize({ registry: reg, actorId: "builder", capability: "task.initialize", scope: { type: "task", id: "task-8" } }).allowed, false);
});

test("a company wildcard covers everything below it", () => {
  const reg = registry("enforce", [grant({ scopeType: "company", scopeId: "*" })]);
  assert.equal(authorize({ registry: reg, actorId: "builder", capability: "task.initialize", scope: { projectId: "anything" } }).allowed, true);
});

test("a grant for one capability does not carry to another", () => {
  const reg = registry("enforce");
  assert.equal(authorize({ registry: reg, actorId: "builder", capability: "github.open-pr", scope: { projectId: "hq" } }).reason, "no-grant");
});

test("an unknown actor or capability is a reasoned denial, never a crash", () => {
  const reg = registry("enforce");
  assert.equal(authorize({ registry: reg, actorId: "builder", capability: "not-a-capability", scope: {} }).reason, "unknown-capability");
  assert.equal(authorize({ registry: reg, actorId: "../etc/passwd", capability: "task.initialize", scope: {} }).reason, "unknown-actor");
  assert.equal(authorize({ registry: reg, actorId: null, capability: null, scope: null }).allowed, false);
});

// --- registry validation -----------------------------------------------------

test("a malformed or dangerous registry is rejected with a usable message", () => {
  assert.throws(() => readPermissionRegistry(fixture("{ nope")), /not valid JSON/);
  assert.throws(() => readPermissionRegistry(fixture({ version: 1 })), /'grants' array/);
  assert.throws(() => readPermissionRegistry(fixture({ version: 1, mode: "yolo", grants: [] })), /mode must be one of/);
  assert.throws(() => readPermissionRegistry(fixture({ version: 1, grants: [grant({ scopeType: "galaxy" })] })), /invalid scopeType/);
  assert.throws(() => readPermissionRegistry(fixture({ version: 1, grants: [grant({ capability: "made.up" })] })), /unknown capability/);
  assert.throws(() => readPermissionRegistry(fixture({ version: 1, grants: [grant({ actorId: "../x" })] })), /actorId is invalid/);
  assert.throws(() => readPermissionRegistry(fixture({ version: 1, grants: [grant({ scopeId: "a/../../etc" })] })), /has invalid scopeId/);
  assert.throws(() => readPermissionRegistry(fixture({ version: 1, grants: [grant(), grant()] })), /duplicate grant/);
});

test("the shipped example registry is valid and defaults to report", () => {
  const reg = readPermissionRegistry(new URL("../..", import.meta.url).pathname, { path: new URL("../permissions.example.json", import.meta.url).pathname });
  assert.equal(reg.enforcement, "report");
  assert.ok(reg.grants.length > 0);
});

// --- auditing ----------------------------------------------------------------

test("every decision is auditable, and a report-mode verdict records what it would have denied", () => {
  const root = fixture();
  const auditPath = join(root, "audit.ndjson");

  recordPermissionDecision(auditPath, authorize({ registry: registry("enforce"), actorId: "builder", capability: "task.initialize", scope: { projectId: "hq" } }), { correlation: { taskId: "t1" } });
  recordPermissionDecision(auditPath, authorize({ registry: registry("enforce", []), actorId: "builder", capability: "task.initialize", scope: { projectId: "hq" } }), { correlation: { taskId: "t2" } });
  recordPermissionDecision(auditPath, authorize({ registry: registry("report", []), actorId: "builder", capability: "task.initialize", scope: { projectId: "hq" } }), { correlation: { taskId: "t3" } });

  const events = readAuditEvents(auditPath);
  assert.deepEqual(events.map((e) => e.action), ["permission.allowed", "permission.denied", "permission.denied"]);
  assert.equal(events[1].data.reason, "no-grant");
  assert.equal(events[1].data.capability, "task.initialize", "the attempted capability is recorded");
  assert.deepEqual(events[1].subject, { type: "project", id: "hq" }, "the subject is the thing acted on");
  assert.equal(events[2].data.wouldDeny, "true", "a report-mode allow is still recorded as the denial it would have been");
  assert.equal(events[0].correlation.taskId, "t1");
});

test("an unwritable audit path degrades, it never turns an allowed action into an outage", () => {
  const root = fixture();
  // A regular file where a directory has to be: mkdirSync fails with ENOTDIR.
  writeFileSync(join(root, "blocked"), "not a directory");
  const result = recordPermissionDecision(join(root, "blocked", "audit.ndjson"), authorize({ registry: registry("enforce"), actorId: "builder", capability: "task.initialize", scope: { projectId: "hq" } }));
  assert.equal(result.recorded, false);
  assert.ok(result.reason);
});

test("enforce() throws a typed error carrying the decision", () => {
  const root = fixture();
  try {
    enforce({ registry: registry("enforce", []), auditPath: join(root, "a.ndjson"), actorId: "builder", capability: "task.initialize", scope: { projectId: "hq" } });
    assert.fail("expected a denial");
  } catch (error) {
    assert.ok(error instanceof PermissionDeniedError);
    assert.equal(error.decision.reason, "no-grant");
    assert.match(error.message, /builder is not permitted to task\.initialize/);
  }
  assert.equal(readAuditEvents(join(root, "a.ndjson")).length, 1, "the denial is audited before it is thrown");
});
