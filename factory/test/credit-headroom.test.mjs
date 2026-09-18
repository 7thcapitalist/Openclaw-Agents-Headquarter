import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  collectPipelineSeats,
  collectRecentSeatPauses,
  readCreditHeadroom,
  readPipelineCreditHeadroom,
} from "../lib/credit-headroom.mjs";

const NOW = Date.parse("2026-09-17T12:00:00.000Z");
const OPENAI = "openai/gpt-5.6-sol";
const CLAUDE = "anthropic/claude-sonnet-5";

test("readCreditHeadroom directly reports both OpenAI usage windows", () => {
  const [record] = readCreditHeadroom({
    modelsOut: "openai usage: 5h 63% left ⏱2h 9m · Week 41% left ⏱3d 4h",
    pipelineSeats: [{ roleId: "backend-builder", seat: OPENAI }],
    seatPauses: [{ actor: "backend-builder", at: "2026-09-17T11:00:00.000Z" }],
    now: NOW,
  });
  assert.deepEqual(record, {
    seat: OPENAI,
    roles: ["backend-builder"],
    status: "available",
    shortWindow: { percentLeft: 63, resetIn: "2h 9m" },
    weekWindow: { percentLeft: 41, resetIn: "3d 4h" },
    reason: null,
    inference: null,
  });
});

test("an indeterminate claude-cli seat is unknown with no numeric headroom", () => {
  const [record] = readCreditHeadroom({
    modelsOut: "- anthropic/claude-sonnet-5 [indeterminate]\nRuntime auth: anthropic via claude-cli status=indeterminate",
    pipelineSeats: [{ roleId: "reviewer", seat: CLAUDE }],
    now: NOW,
  });
  assert.equal(record.status, "unknown");
  assert.match(record.reason, /indeterminate/i);
  assert.equal(record.shortWindow, null);
  assert.equal(record.weekWindow, null);
  assert.equal(record.inference.basis, "no-recent-seat-exhaustion-events");
  assert.match(record.inference.note, /inference.+not a direct read/i);
});

test("unreadable headroom is always unknown and never receives a numeric value", () => {
  const samples = [
    "",
    "not status output",
    "anthropic/claude-sonnet-5 [indeterminate]",
    "Week 52% left ⏱1d",
    "5h left ⏱2h · Week left",
    "openai usage: 5h 88% left ⏱3h · Week 70% left ⏱4d",
  ];
  for (const modelsOut of samples) {
    const records = readCreditHeadroom({
      modelsOut,
      pipelineSeats: [
        { roleId: "reviewer", seat: CLAUDE },
        { roleId: "main", seat: "github-copilot/gpt-4.1" },
      ],
      now: NOW,
    });
    for (const record of records) {
      assert.equal(record.status, "unknown", `${record.seat}: ${modelsOut}`);
      assert.equal(record.shortWindow, null);
      assert.equal(record.weekWindow, null);
      assert.notEqual(typeof record.shortWindow?.percentLeft, "number");
      assert.notEqual(typeof record.weekWindow?.percentLeft, "number");
    }
  }
});

test("an OpenAI seat with only a weekly window remains unknown", () => {
  const [record] = readCreditHeadroom({
    modelsOut: "openai usage: Week 52% left ⏱1d",
    pipelineSeats: [{ roleId: "backend-builder", seat: OPENAI }],
    now: NOW,
  });
  assert.equal(record.status, "unknown");
  assert.equal(record.shortWindow, null);
  assert.equal(record.weekWindow, null);
  assert.match(record.reason, /did not report a 5h usage window/);
});

test("seat-exhaustion inference is role-scoped, recent, labeled, and never upgrades unknown", () => {
  const records = readCreditHeadroom({
    modelsOut: `${CLAUDE} [indeterminate]\ngithub-copilot/gpt-4.1 [indeterminate]`,
    pipelineSeats: [
      { roleId: "reviewer", seat: CLAUDE },
      { roleId: "qa", seat: CLAUDE },
      { roleId: "main", seat: "github-copilot/gpt-4.1" },
    ],
    seatPauses: [
      { actor: "reviewer", at: "2026-09-17T11:00:00.000Z" },
      { actor: "main", at: "2026-09-15T11:00:00.000Z" },
    ],
    now: NOW,
  });
  const claude = records.find((record) => record.seat === CLAUDE);
  const copilot = records.find((record) => record.seat.startsWith("github-copilot/"));
  assert.deepEqual(claude.roles, ["qa", "reviewer"]);
  assert.equal(claude.status, "unknown");
  assert.equal(claude.inference.basis, "recent-seat-exhaustion-events");
  assert.equal(claude.inference.sampleCount, 1);
  assert.match(claude.inference.note, /inference.+not a direct read/i);
  assert.equal(copilot.status, "unknown");
  assert.equal(copilot.inference.basis, "no-recent-seat-exhaustion-events");
});

test("collectors resolve configured seats and read only recent seatExhausted dispatches", () => {
  const root = mkdtempSync(join(tmpdir(), "credit-headroom-"));
  const configPath = join(root, "openclaw.json");
  writeFileSync(configPath, JSON.stringify({
    agents: {
      defaults: { model: OPENAI },
      entries: {
        "backend-builder": { model: { primary: `${OPENAI}@2` } },
        reviewer: { model: { primary: CLAUDE } },
      },
    },
  }));
  const stateDir = join(root, "dashboard/backend/data/factory/project/tasks/task-1");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "state.json"), JSON.stringify({ dispatches: [
    { actor: "codex", agentId: "backend-builder", stage: "builder", seatExhausted: true, completedAt: "2026-09-17T11:00:00.000Z" },
    { actor: "claude", agentId: "reviewer", stage: "reviewer", seatExhausted: true, completedAt: "2026-09-15T11:00:00.000Z" },
    { actor: "codex", agentId: "backend-builder", stage: "builder", completedAt: "2026-09-17T11:30:00.000Z" },
  ] }));

  assert.deepEqual(collectPipelineSeats({ configPath }), [
    { roleId: "backend-builder", seat: OPENAI },
    { roleId: "reviewer", seat: CLAUDE },
  ]);
  assert.deepEqual(collectRecentSeatPauses({ hqRoot: root, now: NOW }), [
    { actor: "backend-builder", stage: "builder", at: "2026-09-17T11:00:00.000Z" },
  ]);

  const records = readPipelineCreditHeadroom({
    modelsOut: `openai usage: 5h 75% left ⏱2h · Week 50% left ⏱3d\n${CLAUDE} [indeterminate]`,
    hqRoot: root,
    configPath,
    now: NOW,
  });
  assert.equal(records.find((record) => record.seat === OPENAI).status, "available");
  assert.equal(records.find((record) => record.seat === CLAUDE).status, "unknown");
});

test("credit headroom implementation never imports cost-ledger signals", () => {
  for (const relative of ["../lib/credit-headroom.mjs", "../lib/model-usage-window.mjs"]) {
    const source = readFileSync(new URL(relative, import.meta.url), "utf8");
    assert.doesNotMatch(source, /cost-ledger|company-state|budget-snapshot/);
  }
});
