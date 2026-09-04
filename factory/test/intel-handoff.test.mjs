import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { writeHandoff } from "../lib/handoff.mjs";

const realHq = resolve(".");

function tempState({ project, worktree }) {
  const dir = mkdtempSync(join(tmpdir(), "intel-handoff-state-"));
  const statePath = join(dir, "state.json");
  const state = {
    version: 1,
    repo: worktree,
    worktree,
    branch: "factory/issue-1",
    task: { id: "issue-1", issue: "1", project, outcome: "Ship it.", acceptanceCriteria: ["works"], constraints: [] },
    assignments: { product: "openclaw" },
    currentStage: "product",
    stages: { product: { status: "pending" } },
    dispatches: [],
    founderDecisions: [],
  };
  writeFileSync(statePath, JSON.stringify(state));
  return { statePath, state };
}

test("handoff for a registered project embeds the context pack and keeps existing sections", () => {
  const worktree = mkdtempSync(join(tmpdir(), "intel-handoff-wt-"));
  mkdirSync(join(worktree, "context"), { recursive: true });
  writeFileSync(join(worktree, "context", "ownership.json"), JSON.stringify({
    version: 1, mission: "Keep founders out of the weeds.", responsibleAgents: { builder: "codex" },
  }));
  writeFileSync(join(worktree, "context", "VISION.md"), "# Vision\n\nAn autonomous company OS.\n");

  const { statePath, state } = tempState({ project: "openclaw-factory", worktree });
  const path = writeHandoff({ hqRoot: realHq, statePath, state });
  const body = readFileSync(path, "utf8");

  assert.match(body, /## Factory context \(global\)/);
  assert.match(body, /## Project context: OpenClaw Agents Headquarter \(key: openclaw-factory\)/);
  assert.match(body, /Mission: Keep founders out of the weeds\./);
  assert.match(body, /Vision: An autonomous company OS\./);
  // existing structure preserved
  assert.match(body, /Assigned harness: openclaw/);
  assert.match(body, /## Outcome\n\nShip it\./);
  assert.match(body, /## Role instructions/);
  assert.match(body, /## Execution boundary/);
});

test("handoff for an unregistered project still writes, with a not-registered note", () => {
  const worktree = mkdtempSync(join(tmpdir(), "intel-handoff-wt-"));
  const { statePath, state } = tempState({ project: "some-other-project", worktree });
  const path = writeHandoff({ hqRoot: realHq, statePath, state });
  const body = readFileSync(path, "utf8");
  assert.match(body, /is not registered in factory\/projects\.json/);
  assert.match(body, /Assigned harness: openclaw/);
  assert.match(body, /## Outcome/);
});

test("a broken projects.json degrades to a note and never blocks the handoff", () => {
  const fakeHq = mkdtempSync(join(tmpdir(), "intel-handoff-hq-"));
  mkdirSync(join(fakeHq, "factory", "prompts"), { recursive: true });
  mkdirSync(join(fakeHq, "factory", "context"), { recursive: true });
  writeFileSync(join(fakeHq, "factory", "prompts", "product.md"), "# Product\n\nNormalize the outcome.\n");
  writeFileSync(join(fakeHq, "factory", "factory.config.json"), JSON.stringify({ version: 1, mode: "human-merge" }));
  writeFileSync(join(fakeHq, "factory", "projects.json"), JSON.stringify({ version: 1, projects: [{ key: "BAD KEY", repo: "." }] }));

  const worktree = mkdtempSync(join(tmpdir(), "intel-handoff-wt-"));
  const { statePath, state } = tempState({ project: "anything", worktree });
  const path = writeHandoff({ hqRoot: fakeHq, statePath, state });
  const body = readFileSync(path, "utf8");
  assert.match(body, /context assembly unavailable:/);
  assert.match(body, /Assigned harness: openclaw/);
  assert.match(body, /Normalize the outcome\./);
});
