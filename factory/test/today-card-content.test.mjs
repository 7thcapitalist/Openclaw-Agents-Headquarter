import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../../dashboard/backend/public/app.js", import.meta.url), "utf8");

function functionSource(name) {
  const start = APP.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = APP.indexOf("\n  function ", start + 1);
  return APP.slice(start, end === -1 ? APP.length : end);
}

const esc = (value) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

function needsYouRenderer() {
  return new Function(
    "esc",
    "inboxItem",
    "renderFounderInboxEmpty",
    `${functionSource("runCountWord")}\n${functionSource("diagnosticInboxCard")}\n${functionSource("renderNeedsYou")}\nreturn renderNeedsYou;`,
  )(
    esc,
    (item) => `<div>${esc(item.id)}</div>`,
    () => `<div class="fi-empty"><strong>You're all caught up.</strong></div>`,
  );
}

function taskCardRenderer() {
  return new Function(
    "esc",
    "fmtDuration",
    `${functionSource("cardActionState")}\n${functionSource("taskCardInput")}\n${functionSource("cardActions")}\n${functionSource("founderTaskCard")}\nreturn founderTaskCard;`,
  )(esc, (milliseconds) => `${Math.floor(milliseconds / 60_000)}m`);
}

function objectiveCardRenderer() {
  return new Function(
    "esc",
    "fmtDuration",
    "objectiveView",
    "objectiveRecovery",
    `${functionSource("cardActionState")}\n${functionSource("objectiveCardInput")}\n${functionSource("cardActions")}\n${functionSource("founderObjectiveCard")}\nreturn founderObjectiveCard;`,
  )(
    esc,
    (milliseconds) => `${Math.floor(milliseconds / 60_000)}m`,
    {
      shortObjectiveTitle: (title) => title,
      whatIsHappeningNowLine: () => "Building — Backend Builder is working — 5m so far. Nothing needed from you.",
    },
    { isObjectiveRecoverable: (o) => (o?.recovery?.count || 0) > 0 },
  );
}

// Every attribute bindObjectiveControls / the Today binders give a plain
// `onclick`. On anything but a <button> it fires for every click inside that
// element as well — which is how Reject on an objective card used to be
// replaced by the execution view before its form could be used.
const CLICK_ATTRIBUTES = [
  "data-objective-details", "data-objective-execution", "data-report-task", "data-report-objective",
  "data-task-execution", "data-retry-task", "data-retry-objective", "data-approve", "data-reject",
];

function nonButtonClickTargets(html) {
  return [...html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/g)]
    .filter(([, tag, attrs]) => tag !== "button" && CLICK_ATTRIBUTES.some((name) => new RegExp(`\\s${name}=`).test(attrs)))
    .map(([whole]) => whole);
}

const objective = (overrides = {}) => ({
  objectiveId: "obj-1234abcd",
  title: "Ship it",
  project: "HQ",
  status6: "RUNNING",
  updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  ...overrides,
});

test("an objective card's actions are buttons, never the card itself", () => {
  const render = objectiveCardRenderer();
  const inbox = [{ objectiveId: "obj-1234abcd", taskId: "obj-1234abcd-builder", kind: "approval", statePath: "/tmp/s.json" }];
  for (const [label, html] of [
    ["running", render(objective())],
    ["blocked", render(objective({ status6: "BLOCKED" }))],
    ["approval", render(objective({ status6: "WAITING_FOR_FOUNDER" }), false, inbox)],
    ["complete", render(objective({ status6: "COMPLETE" }), true)],
  ]) {
    assert.deepEqual(nonButtonClickTargets(html), [], `${label} card must not make a non-button element a click target`);
    assert.match(html, /<article class="founder-objective[^"]*" data-objective-id="obj-1234abcd"/, `${label} card stays clickable through the guarded listener`);
  }
});

test("an active objective card states what is happening and whether the founder must act", () => {
  const html = objectiveCardRenderer()(objective());
  assert.match(html, /Building — Backend Builder is working — 5m so far\. Nothing needed from you\./);
});

test("an objective with a pending approval offers Approve and Reject, even behind a question", () => {
  const inbox = [
    { objectiveId: "obj-1234abcd", taskId: "obj-1234abcd-planner", kind: "question" },
    { objectiveId: "obj-1234abcd", taskId: "obj-1234abcd-builder", kind: "approval", statePath: "/tmp/s.json" },
  ];
  const html = objectiveCardRenderer()(objective({ status6: "WAITING_FOR_FOUNDER" }), false, inbox);
  assert.match(html, /data-approval-task="obj-1234abcd-builder" data-approval-statepath="\/tmp\/s\.json"/);
  assert.match(html, /<button class="btn tiny" data-approve="obj-1234abcd-builder">Approve<\/button>/);
  assert.match(html, /<button class="btn secondary tiny" data-reject="obj-1234abcd-builder">Reject<\/button>/);
});

test("a finished objective says why there is nothing to do instead of rendering buttons", () => {
  const html = objectiveCardRenderer()(objective({ status6: "COMPLETE" }), true);
  assert.match(html, /Done — no action needed\./);
  assert.doesNotMatch(html, /<button\b/);
});

test("a blocked objective with nothing recoverable offers Open, not a Retry that would 409", () => {
  const html = objectiveCardRenderer()(objective({ status6: "BLOCKED", recovery: { count: 0 } }));
  assert.doesNotMatch(html, /data-retry-/);
  assert.match(html, /data-objective-execution="obj-1234abcd">Open</);
});

test("the guarded card listener, not an onclick, opens an objective", () => {
  const bind = functionSource("bindObjectiveControls");
  assert.match(bind, /querySelectorAll\("\.founder-objective"\)[\s\S]*?event\.target\.closest\("button, a"\)[\s\S]*?openExecutionView\(card\.dataset\.objectiveId\)/);
});

test("Retry on a blocked objective retries the objective, not one of its tasks", () => {
  const html = objectiveCardRenderer()(objective({ status6: "BLOCKED", blockedOn: null, recovery: { count: 1 }, nodes: { a: { id: "obj-1234abcd-a", status: "pending" } } }));
  assert.match(html, /<button class="btn tiny" data-retry-objective="obj-1234abcd">Retry<\/button>/);
  assert.doesNotMatch(html, /data-retry-task/);
});

test("a running objective offers one Open, not two buttons that do the same thing", () => {
  const html = objectiveCardRenderer()(objective());
  assert.equal((html.match(/<button\b/g) || []).length, 1);
  assert.match(html, /data-objective-execution="obj-1234abcd">Open</);
});

test("a diagnostic card names the objective it came from, not a fixed id", () => {
  const html = needsYouRenderer()([], [], 0, [{ kind: "divergence", taskId: "obj-9999ffff-builder", objectiveId: "obj-9999ffff" }]);
  assert.match(html, /data-diagnostic-source="obj-9999ffff"/);
  assert.doesNotMatch(html, /obj-c58897c0|obj-c7b263bb/);
  assert.match(html, /data-retry-objective="obj-9999ffff">Retry</, "a diagnostic retry goes through the objective, not one task");
  assert.equal(nonButtonClickTargets(html).length, 0);
});

test("Needs You renders divergence and changed-nothing diagnostics with objective retry and task follow", () => {
  const renderNeedsYou = needsYouRenderer();
  const html = renderNeedsYou([], [], 0, [
    { kind: "divergence", taskId: "obj-c58897c0-builder", objectiveId: "obj-c58897c0", project: "HQ" },
    { kind: "stalled-loop", taskId: "obj-c7b263bb-builder", objectiveId: "obj-c7b263bb", project: "HQ", streak: 8 },
  ]);

  assert.match(html, /This objective says it is running\. Nothing is actually running\./);
  assert.match(html, /Eight runs in a row changed nothing\./);
  for (const objectiveId of ["obj-c58897c0", "obj-c7b263bb"]) {
    const taskId = `${objectiveId}-builder`;
    assert.match(html, new RegExp(`Task <code>${taskId}</code>`));
    assert.match(html, new RegExp(`data-retry-objective="${objectiveId}"`));
    assert.match(html, new RegExp(`data-task-execution="${taskId}"`));
  }
  assert.doesNotMatch(html, /data-retry-task/);
});

test("Needs You preserves the existing all-caught-up line without findings", () => {
  const html = needsYouRenderer()([], [], 0, []);
  assert.match(html, /You're all caught up\./);
});

test("five task states all render moved labels and available action controls", () => {
  const renderTaskCard = taskCardRenderer();
  const updatedAt = "2026-09-16T12:00:00.000Z";
  const now = Date.parse("2026-09-16T12:05:00.000Z");
  const tasks = [
    { id: "task-running", status: "active", objective: "Running", updatedAt },
    { id: "task-queued", status: "queued", objective: "Queued", updatedAt },
    { id: "task-blocked", status: "blocked", objective: "Blocked", updatedAt },
    { id: "task-failed", status: "failed", objective: "Failed", updatedAt },
    { id: "task-approval", status: "blocked", objective: "Approval", updatedAt, awaitingFounderApproval: true, statePath: "/tmp/task-approval.json" },
  ];

  for (const task of tasks) {
    const html = renderTaskCard(task, now);
    assert.match(html, /moved 5m ago/, `${task.id} must show when it moved`);
    assert.match(html, /<button\b/, `${task.id} must expose an available action`);
  }
});

test("a terminal task states why no action applies instead of rendering a dead button", () => {
  const html = taskCardRenderer()({
    id: "task-complete",
    status: "complete",
    objective: "Delivered",
    updatedAt: "2026-09-16T12:00:00.000Z",
  }, Date.parse("2026-09-16T12:05:00.000Z"));

  assert.match(html, /moved 5m ago/);
  assert.match(html, /Done — no action needed\./);
  assert.match(html, /data-action-reason/);
  assert.doesNotMatch(html, /<button\b/);
  assert.doesNotMatch(html, /disabled/);
});
