import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { assembleContextPack, SECTION_BUDGETS } from "../lib/intel/assemble.mjs";

function makeHq({ registry } = {}) {
  const hq = mkdtempSync(join(tmpdir(), "intel-assemble-hq-"));
  mkdirSync(join(hq, "factory", "context"), { recursive: true });
  writeFileSync(join(hq, "factory", "factory.config.json"), JSON.stringify({
    version: 1, mode: "human-merge",
    prohibitedAutonomousActions: ["push-to-main", "paid-purchase"],
    requiredGates: ["independent-review", "qa-evidence"],
  }));
  writeFileSync(join(hq, "factory", "context", "FACTORY.md"), "# Factory context\n\nThe factory ships software with operator control.\n");
  writeFileSync(join(hq, "factory", "projects.json"), JSON.stringify(registry ?? {
    version: 1, projects: [{ key: "acme", name: "Acme", repo: ".", contextDir: "context", status: "active" }],
  }));
  return hq;
}

function makeWorktree(files) {
  const wt = mkdtempSync(join(tmpdir(), "intel-assemble-wt-"));
  if (files) {
    mkdirSync(join(wt, "context"), { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(wt, "context", name), body);
  }
  return wt;
}

function stateFor(worktree, project = "acme") {
  return {
    repo: worktree,
    worktree,
    task: { id: "issue-1", issue: "1", project, outcome: "x", acceptanceCriteria: [], constraints: [] },
    assignments: { product: "openclaw" },
    currentStage: "product",
    stages: {},
  };
}

const fullFiles = {
  "PROJECT.md": "# Acme\n\nAcme helps small teams ship.\n",
  "VISION.md": "# Vision\n\nAcme exists to remove busywork from small teams.\n",
  "MISSION.md": "# Mission\n\nShip the scheduling module this quarter.\n",
  "ROADMAP.md": "# Roadmap\n\n## Current milestone\n\nScheduling module. Blocker: none.\n\n## Later\n\nBilling.\n",
  "TECH_CONTEXT.md": "# Tech context\n\n## Constraints\n\n- No ORM.\n- Node builtins only.\n",
  "USERS.md": "# Users\n\nSmall team leads.\n\n## Sensitivities\n\nCalendar data is private.\n",
  "COMPETITIVE_CONTEXT.md": "# Competitive context\n\n## Our wedge\n\nWe do scheduling without a login wall.\n",
  "MEMORY.md": "# Project memory\n\n- Vendor sandbox rate-limits to 5 req/s.\n- The webhook replays out of order.\n",
  "DECISIONS.md": "# Decisions\n\n## PRJ-2026-001 — Use SQLite\n\n## PRJ-2026-002 — No third-party auth\n",
  "ownership.json": JSON.stringify({
    version: 1,
    mission: "Remove busywork for small teams.",
    successMetrics: [{ id: "m1", name: "D30 retention", target: "35%", current: "22%", asOf: "2026-08-20" }],
    currentPriorities: [{ id: "p1", title: "Scheduling module" }],
    risks: [{ id: "r1", title: "No load testing", severity: "medium" }],
    openDecisions: ["DEC-2026-014"],
    responsibleAgents: { architect: "claude", builder: "codex" },
  }),
};

test("full context renders every section within budget", () => {
  const hq = makeHq();
  const wt = makeWorktree(fullFiles);
  const { text, sections, warnings } = assembleContextPack({ hqRoot: hq, state: stateFor(wt), now: new Date("2026-09-03T00:00:00Z") });
  assert.match(text, /## Factory context \(global\)/);
  assert.match(text, /Operating mode: human-merge/);
  assert.match(text, /## Project context: Acme \(key: acme\)/);
  assert.match(text, /Mission: Remove busywork for small teams\./);
  assert.match(text, /D30 retention: 22% -> 35% \(asOf 2026-08-20\)/);
  assert.match(text, /Current priorities: Scheduling module/);
  assert.match(text, /Active risks: No load testing \[medium\]/);
  assert.match(text, /Open decisions blocking work: DEC-2026-014/);
  assert.match(text, /Responsible agents: architect=claude, builder=codex/);
  assert.match(text, /Vision: Acme exists to remove busywork/);
  assert.match(text, /Current milestone: Scheduling module\. Blocker: none\./);
  assert.match(text, /Tech constraints: - No ORM\. - Node builtins only\./);
  assert.match(text, /Users: Small team leads\. Sensitivities: Calendar data is private\./);
  assert.match(text, /Competitive wedge: We do scheduling without a login wall\./);
  assert.match(text, /Recent durable facts: .*rate-limits to 5 req\/s/);
  assert.match(text, /Last accepted decisions: .*Use SQLite.*No third-party auth/);
  assert.match(text, /Full context files are in your worktree at: context\//);
  assert.deepEqual(warnings, []);
  assert.ok(sections.factory.length <= SECTION_BUDGETS.factory);
});

test("missing files degrade to warnings without throwing", () => {
  const hq = makeHq();
  const wt = makeWorktree({ "PROJECT.md": "# Acme\n\nOnly this file.\n" });
  const { text, warnings } = assembleContextPack({ hqRoot: hq, state: stateFor(wt) });
  assert.match(text, /## Project context: Acme/);
  assert.ok(warnings.some((w) => w.code === "ownership-missing"));
  assert.match(text, /ownership.json: not present/);
  assert.match(text, /Vision: not present\./);
});

test("unregistered project gets factory context and a not-registered note", () => {
  const hq = makeHq();
  const wt = makeWorktree(fullFiles);
  const { text, warnings } = assembleContextPack({ hqRoot: hq, state: stateFor(wt, "not-in-registry") });
  assert.match(text, /## Factory context \(global\)/);
  assert.match(text, /is not registered in factory\/projects\.json/);
  assert.ok(warnings.some((w) => w.code === "project-unregistered"));
});

test("secrets in a context file are scrubbed and warned", () => {
  const hq = makeHq();
  const wt = makeWorktree({
    ...fullFiles,
    "TECH_CONTEXT.md": "# Tech context\n\n## Constraints\n\n- API key sk-abcdefghijklmnopqrstuvwxyz012345 must rotate.\n",
  });
  const { text, warnings } = assembleContextPack({ hqRoot: hq, state: stateFor(wt) });
  assert.ok(!text.includes("sk-abcdefghijklmnopqrstuvwxyz012345"));
  assert.match(text, /\[redacted: openai-sk\]/);
  assert.ok(warnings.some((w) => w.code.startsWith("secret-redacted:")));
});

test("assembly is deterministic for fixed inputs and now", () => {
  const hq = makeHq();
  const wt = makeWorktree(fullFiles);
  const now = new Date("2026-09-03T00:00:00Z");
  const a = assembleContextPack({ hqRoot: hq, state: stateFor(wt), now });
  const b = assembleContextPack({ hqRoot: hq, state: stateFor(wt), now });
  assert.equal(a.text, b.text);
});

test("a structurally broken registry throws (handoff.mjs catches this)", () => {
  const hq = makeHq({ registry: { version: 1, projects: [{ key: "BAD KEY", repo: "." }] } });
  const wt = makeWorktree(fullFiles);
  assert.throws(() => assembleContextPack({ hqRoot: hq, state: stateFor(wt) }), /lowercase slug/);
});
