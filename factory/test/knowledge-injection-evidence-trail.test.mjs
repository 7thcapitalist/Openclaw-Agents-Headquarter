import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, readState, writeState } from "../lib/task-workflow.mjs";
import { writeHandoff } from "../lib/handoff.mjs";
import { buildCompletionReport } from "../lib/hq/completion-report.mjs";

const ACCEPTED_LESSON = `# Lessons Learned

## LL-2026-001 — Test before implementing

- Status: accepted

**Observation:** builders churn on vague specs.

**Recommendation:** require executable acceptance tests up front.
`;

// A self-contained hqRoot: its own prompts, dossier and config, so these
// tests never depend on this repo's own factory/knowledge/* content.
function fakeHq({ roleNote = null, lessons = null, injectIntoHandoff = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "knowledge-evidence-hq-"));
  mkdirSync(join(root, "factory", "knowledge", "agents"), { recursive: true });
  mkdirSync(join(root, "factory", "prompts"), { recursive: true });
  writeFileSync(join(root, "factory", "factory.config.json"), JSON.stringify({ learning: { injectIntoHandoff } }), "utf8");
  writeFileSync(join(root, "factory", "prompts", "builder.md"), "# Builder role\n\nImplement the task.\n", "utf8");
  if (roleNote) writeFileSync(join(root, "factory", "knowledge", "agents", "builder.md"), roleNote, "utf8");
  if (lessons) writeFileSync(join(root, "factory", "knowledge", "LESSONS_LEARNED.md"), lessons, "utf8");
  return root;
}

function fixtureState({ dispatchId = "d-1", stage = "builder" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "knowledge-evidence-state-"));
  const worktree = join(root, "worktree");
  mkdirSync(worktree, { recursive: true });
  const statePath = join(root, "state.json");
  const state = createState({
    task: { id: "t", issue: "1", outcome: "Ship it", acceptanceCriteria: ["works"], project: "p", workType: "backend", risk: "low" },
    repo: root, branch: "factory/t", worktree,
  });
  state.currentStage = stage;
  state.currentDispatch = {
    id: dispatchId, stage, actor: state.assignments[stage], kind: "stage",
    status: "ready", attempt: 1, createdAt: state.createdAt,
  };
  writeState(statePath, state);
  return { statePath, state };
}

// AC1: flag on + content exists -> injected:true with only the contributing sources.
test("writeHandoff records injected:true with the contributing dossier sources", () => {
  const hqRoot = fakeHq({ roleNote: "- keep diffs small", lessons: ACCEPTED_LESSON, injectIntoHandoff: true });
  const { statePath, state } = fixtureState({ dispatchId: "d-1" });
  writeHandoff({ hqRoot, statePath, state, dispatchId: "d-1" });
  const recorded = readState(statePath).currentDispatch.knowledgeInjection;
  assert.deepEqual(recorded, {
    injected: true,
    sources: ["factory/knowledge/agents/builder.md", "factory/knowledge/LESSONS_LEARNED.md"],
  });
});

// AC2a: flag off -> injected:false, no sources, even though content exists.
test("writeHandoff records injected:false with no sources when the flag is off", () => {
  const hqRoot = fakeHq({ roleNote: "- keep diffs small", lessons: ACCEPTED_LESSON, injectIntoHandoff: false });
  const { statePath, state } = fixtureState({ dispatchId: "d-2" });
  writeHandoff({ hqRoot, statePath, state, dispatchId: "d-2" });
  const recorded = readState(statePath).currentDispatch.knowledgeInjection;
  assert.deepEqual(recorded, { injected: false, sources: [] });
});

// AC2b: flag on but nothing relevant exists -> injected:false, no sources.
test("writeHandoff records injected:false when the flag is on but nothing renders", () => {
  const hqRoot = fakeHq({ injectIntoHandoff: true });
  const { statePath, state } = fixtureState({ dispatchId: "d-3" });
  writeHandoff({ hqRoot, statePath, state, dispatchId: "d-3" });
  const recorded = readState(statePath).currentDispatch.knowledgeInjection;
  assert.deepEqual(recorded, { injected: false, sources: [] });
});

// No dispatchId at all (e.g. task-initializer's placeholder handoff) -> nothing
// is attached; there is no committed dispatch yet to attach a fact to.
test("writeHandoff with no dispatchId records no knowledge-injection fact", () => {
  const hqRoot = fakeHq({ roleNote: "- keep diffs small", lessons: ACCEPTED_LESSON, injectIntoHandoff: true });
  const { statePath, state } = fixtureState({ dispatchId: "d-4" });
  writeHandoff({ hqRoot, statePath, state });
  const recorded = readState(statePath).currentDispatch.knowledgeInjection;
  assert.equal(recorded, undefined);
});

// The concurrent-group pre-write calls writeHandoff with a dispatchId while
// state.currentDispatch is still unset for a different id — the identity
// guard must no-op rather than attach the fact to the wrong dispatch.
test("writeHandoff does not attach the fact when the dispatch identity does not match currentDispatch", () => {
  const hqRoot = fakeHq({ roleNote: "- keep diffs small", lessons: ACCEPTED_LESSON, injectIntoHandoff: true });
  const { statePath, state } = fixtureState({ dispatchId: "d-5" });
  writeHandoff({ hqRoot, statePath, state, dispatchId: "some-other-dispatch" });
  const recorded = readState(statePath).currentDispatch.knowledgeInjection;
  assert.equal(recorded, undefined);
});

// AC3: buildCompletionReport renders one line per stage, sourced from the
// *last* recorded dispatch for that stage (mirrors how state.stages already
// collapses retries to one current verdict).
test("buildCompletionReport renders the last dispatch's knowledge-injection fact per stage", () => {
  const state = {
    task: { id: "t-1" },
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    events: [],
    stages: {},
    dispatches: [
      { id: "d-1", stage: "builder", kind: "stage", knowledgeInjection: { injected: false, sources: [] } },
      { id: "d-2", stage: "builder", kind: "stage", knowledgeInjection: { injected: true, sources: ["factory/knowledge/agents/builder.md"] } },
      { id: "d-3", stage: "qa", kind: "stage", knowledgeInjection: { injected: true, sources: ["factory/knowledge/LESSONS_LEARNED.md", "factory/knowledge/PROCESS_IMPROVEMENTS.md"] } },
    ],
  };
  const report = buildCompletionReport(state, { now: Date.parse("2026-01-01T00:00:00.000Z") });
  assert.match(report, /## Knowledge injection/);
  // The builder line reflects the LAST dispatch (d-2, injected), not the
  // first retry (d-1, not injected).
  assert.match(report, /- \*\*builder\*\* — knowledge injected from: factory\/knowledge\/agents\/builder\.md/);
  assert.doesNotMatch(report, /\*\*builder\*\* — no knowledge block injected/);
  assert.match(report, /- \*\*qa\*\* — knowledge injected from: factory\/knowledge\/LESSONS_LEARNED\.md, factory\/knowledge\/PROCESS_IMPROVEMENTS\.md/);
});

test("buildCompletionReport says no knowledge block injected when the last dispatch recorded injected:false", () => {
  const state = {
    task: { id: "t-2" },
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    events: [],
    stages: {},
    dispatches: [
      { id: "d-1", stage: "product", kind: "stage", knowledgeInjection: { injected: true, sources: ["factory/knowledge/agents/product.md"] } },
      { id: "d-2", stage: "product", kind: "stage", knowledgeInjection: { injected: false, sources: [] } },
    ],
  };
  const report = buildCompletionReport(state, { now: Date.parse("2026-01-01T00:00:00.000Z") });
  assert.match(report, /- \*\*product\*\* — no knowledge block injected/);
});

test("buildCompletionReport omits the Knowledge injection section when no dispatch recorded the fact", () => {
  const state = {
    task: { id: "t-3" },
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    events: [],
    stages: {},
    dispatches: [{ id: "d-1", stage: "builder", kind: "stage" }],
  };
  const report = buildCompletionReport(state, { now: Date.parse("2026-01-01T00:00:00.000Z") });
  assert.doesNotMatch(report, /## Knowledge injection/);
});
