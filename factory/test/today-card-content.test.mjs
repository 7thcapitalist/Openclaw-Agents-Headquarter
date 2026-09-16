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

test("Needs You renders divergence and changed-nothing diagnostics with task actions", () => {
  const renderNeedsYou = needsYouRenderer();
  const html = renderNeedsYou([], [], 0, [
    { kind: "divergence", taskId: "obj-c58897c0-builder", objectiveId: "obj-c58897c0", project: "HQ" },
    { kind: "stalled-loop", taskId: "obj-c7b263bb-builder", objectiveId: "obj-c7b263bb", project: "HQ", streak: 8 },
  ]);

  assert.match(html, /This objective says it is running\. Nothing is actually running\./);
  assert.match(html, /Eight runs in a row changed nothing\./);
  for (const taskId of ["obj-c58897c0-builder", "obj-c7b263bb-builder"]) {
    assert.match(html, new RegExp(`Task <code>${taskId}</code>`));
    assert.match(html, new RegExp(`data-retry-task="${taskId}"`));
    assert.match(html, new RegExp(`data-task-execution="${taskId}"`));
  }
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
