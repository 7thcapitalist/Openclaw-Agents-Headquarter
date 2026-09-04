import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildKnowledgeBlock, learningInjectionEnabled } from "../lib/learning/handoff-inject.mjs";

function fakeHq({ config = { learning: {} }, roleNote = null, lessons = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "learn-handoff-"));
  mkdirSync(join(root, "factory", "knowledge", "agents"), { recursive: true });
  writeFileSync(join(root, "factory", "factory.config.json"), JSON.stringify(config), "utf8");
  if (roleNote) writeFileSync(join(root, "factory", "knowledge", "agents", "builder.md"), roleNote, "utf8");
  if (lessons) writeFileSync(join(root, "factory", "knowledge", "LESSONS_LEARNED.md"), lessons, "utf8");
  return root;
}

const ACCEPTED_LESSON = `# Lessons Learned

## LL-2026-001 — Test before implementing

- Status: accepted

**Observation:** builders churn on vague specs.

**Recommendation:** require executable acceptance tests up front.
`;

const PROPOSED_LESSON = ACCEPTED_LESSON.replace("Status: accepted", "Status: proposed");

test("injection is off by default and on via env or config flag", () => {
  const root = fakeHq({ config: { learning: { injectIntoHandoff: false } } });
  assert.equal(learningInjectionEnabled(root, {}), false);
  assert.equal(learningInjectionEnabled(root, { FACTORY_LEARNING_IN_HANDOFF: "1" }), true);
  const rootOn = fakeHq({ config: { learning: { injectIntoHandoff: true } } });
  assert.equal(learningInjectionEnabled(rootOn, {}), true);
});

test("buildKnowledgeBlock returns empty when disabled", () => {
  const root = fakeHq({ roleNote: "- always run the suite", lessons: ACCEPTED_LESSON });
  assert.equal(buildKnowledgeBlock({ hqRoot: root, role: "builder", env: {} }), "");
});

test("buildKnowledgeBlock includes role notes and only accepted lessons when enabled", () => {
  const root = fakeHq({ roleNote: "- always run the existing suite\n- keep the diff minimal", lessons: ACCEPTED_LESSON });
  const block = buildKnowledgeBlock({ hqRoot: root, role: "builder", env: { FACTORY_LEARNING_IN_HANDOFF: "1" } });
  assert.match(block, /## Company knowledge/);
  assert.match(block, /For the builder role/);
  assert.match(block, /always run the existing suite/);
  assert.match(block, /Test before implementing/);
});

test("buildKnowledgeBlock omits proposed (non-accepted) lessons", () => {
  const root = fakeHq({ lessons: PROPOSED_LESSON });
  const block = buildKnowledgeBlock({ hqRoot: root, role: "builder", env: { FACTORY_LEARNING_IN_HANDOFF: "1" } });
  assert.equal(block, "");
});

test("buildKnowledgeBlock never throws on a broken hqRoot", () => {
  assert.equal(buildKnowledgeBlock({ hqRoot: "/definitely/not/here", role: "builder", env: { FACTORY_LEARNING_IN_HANDOFF: "1" } }), "");
});
