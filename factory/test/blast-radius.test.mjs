// Bound how much work one run may touch, not only which work. Issue #160.
//
// #141 scopes capabilities by company / project / task, which bounds WHICH
// work an agent may touch. Nothing bounded HOW MUCH. These tests pin the four
// properties that make the difference real: the count is per run, the founder
// is never counted, crossing is audited, and nothing is ever refused.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readAuditEvents } from "../lib/audit/envelope.mjs";
import {
  DEFAULT_THRESHOLD, analyzeBlastRadius, buildBlastRadiusReport, createRunBlastRadius,
  observeSubject, recordAllowedSubject, subjectKey,
} from "../lib/hq/blast-radius.mjs";
import { enforce, readPermissionRegistry } from "../lib/hq/permissions.mjs";

const AT = "2026-09-10T00:00:00.000Z";
const at = (n) => new Date(Date.parse(AT) + n * 1000).toISOString();
const logPath = () => join(mkdtempSync(join(tmpdir(), "hq-blast-")), "permissions.ndjson");

const allowed = (id, over = {}) => ({
  allowed: true, reason: "granted", actor: { type: "agent", id: "codex" },
  capability: "task.dispatch", scope: { type: "task", id, projectId: "demo" }, ...over,
});

const tracker = (over = {}) => createRunBlastRadius({ runId: "run-1", actorId: "codex", threshold: 3, ...over });

// ── what is counted ──────────────────────────────────────────────────────────

test("distinct subjects are counted, repeated work on one subject is not", () => {
  const run = tracker();
  // The blast radius is how far the run reached, not how busy it was.
  for (let i = 0; i < 20; i += 1) assert.equal(recordAllowedSubject(run, allowed("task-a")).count, 1);
  assert.equal(recordAllowedSubject(run, allowed("task-b")).count, 2);
});

test("a denial touched nothing, so it is not counted", () => {
  const run = tracker();
  const result = recordAllowedSubject(run, allowed("task-a", { allowed: false, reason: "out-of-scope" }));
  assert.equal(result.counted, false);
  assert.equal(result.reason, "denied");
  assert.equal(run.subjects.size, 0);
});

test("the founder's own actions are never counted against a bound", () => {
  const run = tracker();
  // A person acting is not an agent with a scope.
  assert.equal(recordAllowedSubject(run, allowed("task-a", { actor: { type: "human", id: "founder" } })).reason, "founder-action");
  assert.equal(recordAllowedSubject(run, allowed("task-b", { reason: "founder-authority" })).reason, "founder-action");
  assert.equal(run.subjects.size, 0);
});

test("an agent carrying a founder approval into other subjects IS counted", () => {
  // The founder approved ONE task. An agent that uses that approval to reach
  // twenty subjects is exactly what this measures, so `founder-approved-task`
  // is not a bypass.
  const run = tracker();
  assert.equal(recordAllowedSubject(run, allowed("task-a", { reason: "founder-approved-task" })).counted, true);
  assert.equal(run.subjects.size, 1);
});

test("a subject that cannot be named safely is not counted as one", () => {
  const run = tracker();
  for (const scope of [{ type: "task", id: "../../etc" }, { type: null, id: "x" }, { type: "task", id: null }]) {
    assert.equal(recordAllowedSubject(run, allowed("x", { scope })).reason, "unnamed-subject");
  }
  assert.equal(run.subjects.size, 0);
});

test("the live counter and the audit log name a subject the same way", () => {
  // If these ever diverge, the panel and the ledger disagree about what
  // happened, and the operator has no way to tell which is right.
  assert.equal(subjectKey({ scope: { type: "task", id: "task-a" } }), "task:task-a");
  assert.equal(subjectKey({ subject: { type: "project", id: "demo" } }), "project:demo");
  assert.equal(subjectKey({ scope: { type: null, id: null, projectId: "demo" } }), null);
});

// ── per run, not per agent lifetime ──────────────────────────────────────────

test("the count is per run: ten runs of three subjects is a radius of three", () => {
  let widest = 0;
  for (let r = 0; r < 10; r += 1) {
    const run = createRunBlastRadius({ runId: `run-${r}`, actorId: "codex", threshold: 20 });
    for (const id of ["task-a", "task-b", "task-c"]) recordAllowedSubject(run, allowed(id));
    widest = Math.max(widest, run.subjects.size);
  }
  assert.equal(widest, 3, "a tracker must not accumulate across runs");
});

// ── crossing the threshold ───────────────────────────────────────────────────

test("crossing is reported once, not once per subject after it", () => {
  const run = tracker({ threshold: 3 });
  const crossings = ["a", "b", "c", "d", "e", "f"].map((id) => recordAllowedSubject(run, allowed(`task-${id}`)).crossed);
  assert.deepEqual(crossings, [false, false, true, false, false, false], "a 60-subject run must produce one alert, not 58");
});

test("crossing writes an audit event with the same attribution as a permission decision", () => {
  const path = logPath();
  const run = tracker({ threshold: 2 });
  for (const id of ["task-a", "task-b"]) {
    observeSubject({ tracker: run, decision: allowed(id), auditPath: path, correlation: { projectId: "demo" }, now: () => AT });
  }
  const events = readAuditEvents(path);
  assert.equal(events.length, 1, "exactly one alert");
  const [event] = events;
  assert.equal(event.action, "blast-radius.exceeded");
  assert.deepEqual(event.actor, { type: "agent", id: "codex" });
  assert.equal(event.correlation.runId, "run-1");
  assert.equal(event.correlation.projectId, "demo");
  assert.equal(event.data.subjects, "2");
  assert.equal(event.data.threshold, "2");
  // Stated in the record itself, so an operator reading raw NDJSON is not left
  // wondering whether something was stopped.
  assert.equal(event.data.enforcement, "alert-only");
});

test("nothing is ever refused, and nothing here can throw", () => {
  const run = tracker({ threshold: 1 });
  for (let i = 0; i < 50; i += 1) {
    assert.doesNotThrow(() => observeSubject({ tracker: run, decision: allowed(`task-${i}`), auditPath: "/nonexistent/dir/x.ndjson" }));
  }
  // An unwritable audit path must not turn an allowed action into an outage.
  assert.doesNotThrow(() => observeSubject({ tracker: null, decision: allowed("task-a") }));
  assert.doesNotThrow(() => observeSubject({ tracker: run, decision: null }));
});

// ── the permission path ──────────────────────────────────────────────────────

test("enforce counts the subject it allowed, and still allows it", () => {
  const registry = { version: 1, enforcement: "enforce", grants: [{ actorId: "codex", capability: "task.dispatch", scopeType: "company", scopeId: "openclaw" }], present: true };
  const run = tracker({ threshold: 2 });
  const path = logPath();

  for (const id of ["task-a", "task-b", "task-c"]) {
    const decision = enforce({
      registry, auditPath: path, blastRadius: run, correlation: { taskId: id },
      actorType: "agent", actorId: "codex", capability: "task.dispatch", scope: { type: "task", id, projectId: "demo" },
    });
    assert.equal(decision.allowed, true, "alert-only: the bound never refuses");
  }

  assert.equal(run.subjects.size, 3);
  const alerts = readAuditEvents(path).filter((event) => event.action === "blast-radius.exceeded");
  assert.equal(alerts.length, 1);
});

test("enforce without a tracker behaves exactly as it did before", () => {
  const registry = { version: 1, enforcement: "enforce", grants: [{ actorId: "codex", capability: "task.dispatch", scopeType: "company", scopeId: "openclaw" }], present: true };
  const path = logPath();
  const decision = enforce({
    registry, auditPath: path,
    actorType: "agent", actorId: "codex", capability: "task.dispatch", scope: { type: "task", id: "task-a", projectId: "demo" },
  });
  assert.equal(decision.allowed, true);
  assert.equal(readAuditEvents(path).filter((event) => event.action === "blast-radius.exceeded").length, 0);
});

// ── the durable analysis ─────────────────────────────────────────────────────

const permissionEvent = (over = {}) => ({
  version: 1, eventId: `e${Math.random().toString(36).slice(2, 10)}`, occurredAt: AT,
  actor: { type: "agent", id: "codex" }, action: "permission.allowed",
  subject: { type: "task", id: "task-a" }, correlation: { runId: "run-1" },
  data: { capability: "task.dispatch", reason: "granted", enforcement: "enforce", wouldDeny: "false" },
  ...over,
});

test("the report is read back from the ledger, so it cannot drift from what happened", () => {
  const events = ["a", "b", "c", "a", "b"].map((id, index) => permissionEvent({
    subject: { type: "task", id: `task-${id}` }, occurredAt: at(index),
  }));
  const [run] = analyzeBlastRadius(events, { threshold: 3 });
  assert.equal(run.runId, "run-1");
  assert.equal(run.subjects, 3, "distinct subjects, not events");
  assert.equal(run.atOrOverThreshold, true);
  assert.equal(run.firstAt, at(0));
  assert.equal(run.lastAt, at(4));
});

test("the report never counts the founder, and never counts a denial", () => {
  const events = [
    permissionEvent({ subject: { type: "task", id: "task-a" } }),
    permissionEvent({ subject: { type: "task", id: "task-b" }, actor: { type: "human", id: "founder" } }),
    permissionEvent({ subject: { type: "task", id: "task-c" }, action: "permission.denied" }),
  ];
  const [run] = analyzeBlastRadius(events);
  assert.equal(run.subjects, 1);
});

test("report-mode allowances are counted but flagged, so the two can be told apart", () => {
  const events = [
    permissionEvent({ subject: { type: "task", id: "task-a" } }),
    permissionEvent({ subject: { type: "task", id: "task-b" }, data: { ...permissionEvent().data, wouldDeny: "true" } }),
  ];
  const [run] = analyzeBlastRadius(events);
  assert.equal(run.subjects, 2);
  assert.equal(run.reportModeAllowances, 1);
});

test("runs are separate, and the widest is reported first", () => {
  const events = [
    ...["a", "b", "c"].map((id) => permissionEvent({ subject: { type: "task", id }, correlation: { runId: "wide" } })),
    permissionEvent({ subject: { type: "task", id: "z" }, correlation: { runId: "narrow" } }),
  ];
  const runs = analyzeBlastRadius(events);
  assert.deepEqual(runs.map((run) => [run.runId, run.subjects]), [["wide", 3], ["narrow", 1]]);
});

test("the operator report says alert-only at the top and reports an empty factory honestly", () => {
  const hqRoot = mkdtempSync(join(tmpdir(), "hq-blast-empty-"));
  const report = buildBlastRadiusReport({ hqRoot, stateRoot: join(hqRoot, "state"), now: AT });
  assert.equal(report.enforcement, "alert-only");
  assert.equal(report.available, true);
  assert.deepEqual(report.summary, { runs: 0, overThreshold: 0, widestRun: 0 });
  assert.equal(report.threshold, DEFAULT_THRESHOLD);
});

test("a threshold outside the allowed range is clamped rather than trusted", () => {
  assert.equal(createRunBlastRadius({ runId: "r", actorId: "a", threshold: 0 }).threshold, 1);
  assert.equal(createRunBlastRadius({ runId: "r", actorId: "a", threshold: "nonsense" }).threshold, DEFAULT_THRESHOLD);
  assert.ok(createRunBlastRadius({ runId: "r", actorId: "a", threshold: 99999 }).threshold <= 500);
});

test("the shipped example permission grants are what make this worth measuring", () => {
  // The example grant table hands `company:*` to task.initialize and
  // task.dispatch. That is a scope with no bound on how much it may touch,
  // which is the exact situation this counter exists to make visible.
  const registry = readPermissionRegistry(process.cwd(), { path: new URL("../permissions.example.json", import.meta.url).pathname });
  const companyWide = registry.grants.filter((grant) => grant.scopeType === "company");
  assert.ok(companyWide.length > 0, "if this ever becomes empty, re-read whether this control is still needed");
});
