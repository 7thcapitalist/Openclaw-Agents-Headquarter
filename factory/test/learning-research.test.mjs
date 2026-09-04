import test from "node:test";
import assert from "node:assert/strict";
import { parseResearchNote, runResearch, renderResearchNoteMarkdown, researchPrompt } from "../lib/learning/research.mjs";

const NOW = "2026-09-03T00:00:00Z";

const goodPayload = JSON.stringify({
  topic: "Acceptance-test-first agent workflows",
  date: "2026-09-02",
  sources: [
    { title: "A study on ATDD for LLM agents", url: "https://example.com/atdd" },
    { title: "Blog: spec-first agents", url: "http://example.org/spec-first" },
  ],
  summary: "Writing executable acceptance tests before implementation reduces rework for autonomous coding agents. Token leak sk-abcdefghijklmnopqrstuvwxyz012345 should be scrubbed.",
  applicability: ["product stage", "requiredGates"],
  proposedActions: [
    { area: "workflow", action: "Add an acceptance-tests-present gate before the architect stage." },
    { area: "bogus", action: "ignored area is coerced to none" },
  ],
});

test("parseResearchNote validates sources, redacts, and coerces action areas", () => {
  const note = parseResearchNote(goodPayload, "fallback topic", { now: NOW });
  assert.equal(note.sources.length, 2);
  assert.ok(!JSON.stringify(note).includes("sk-abcdefghijklmnop"));
  assert.equal(note.proposedActions[0].area, "workflow");
  assert.equal(note.proposedActions[1].area, "none");
});

test("parseResearchNote rejects a note with no real source URL", () => {
  const bad = JSON.stringify({ topic: "x", summary: "y", sources: [{ title: "no url", url: "not-a-url" }] });
  assert.throws(() => parseResearchNote(bad, "x", { now: NOW }), /at least one real source/);
});

test("parseResearchNote tolerates fenced JSON and missing date", () => {
  const fenced = "```json\n" + JSON.stringify({
    topic: "t", summary: "s", sources: [{ title: "ok", url: "https://ok.example" }],
  }) + "\n```";
  const note = parseResearchNote(fenced, "t", { now: NOW });
  assert.equal(note.date, "2026-09-03");
});

test("runResearch drives an injected execute and returns a structured note", async () => {
  let seenPrompt = "";
  const note = await runResearch({
    topic: "Prompt design for autonomous builders",
    now: NOW,
    execute: async ({ prompt }) => { seenPrompt = prompt; return goodPayload; },
  });
  assert.match(seenPrompt, /Learning \/ R&D Agent/);
  assert.match(seenPrompt, /Prompt design for autonomous builders/);
  assert.equal(note.sources.length, 2);
  assert.match(renderResearchNoteMarkdown(note), /## Research note —/);
});

test("researchPrompt states the hard rules", () => {
  const p = researchPrompt("x");
  assert.match(p, /No secrets, no private data, no chain-of-thought/i);
  assert.match(p, /Do NOT create issues, tasks, branches, or PRs/);
});
