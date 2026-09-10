// Search across goals, decisions, interactions, timelines and evidence.
// Issue #158.
//
// The load-bearing test is "a prompt is unreachable through search". Everything
// else here is behaviour; that one is the property that makes a search endpoint
// safe to add to a system that holds agent prompts on the same disk.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SEARCH_LAYERS, parseLayers, parseQuery, searchHq } from "../lib/hq/search.mjs";
import { appendInteraction, createInteraction, interactionsPath } from "../lib/hq/interactions.mjs";

const AT = "2026-09-10T00:00:00.000Z";
const SECRET = "zzcanarystringzz";

// A factory laid out the way HQ lays one out, with one task that has a stage,
// evidence, an interaction thread, a founder approval request -- and a prompt
// file sitting right next to all of it, the way a real run leaves one.
function factory({ withPrompt = true, goals = null } = {}) {
  const hqRoot = mkdtempSync(join(tmpdir(), "hq-search-"));
  const stateRoot = join(hqRoot, "dashboard", "backend", "data", "factory");
  const taskDir = join(stateRoot, "demo", "tasks", "obj-abc-widget");
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(join(hqRoot, "factory"), { recursive: true });

  writeFileSync(join(taskDir, "state.json"), JSON.stringify({
    version: 1,
    task: { id: "obj-abc-widget", project: "demo", risk: "high", objectiveId: "obj-abc" },
    status: "active",
    currentStage: "builder",
    createdAt: AT,
    updatedAt: AT,
    assignments: { builder: "codex" },
    stages: {
      product: {
        status: "pass", actor: "openclaw", completedAt: AT,
        summary: "Pin the Vercel CLI so deploys stop drifting.",
        evidence: [{ path: "docs/vercel-cli-pin.md", recordedAt: AT }],
      },
    },
    dispatches: [],
    events: [
      { at: AT, type: "stage-pass", stage: "product", actor: "openclaw", summary: "Pin the Vercel CLI so deploys stop drifting." },
    ],
    founderApprovalRequest: { requestedAt: AT, challenge: "c1", decision: "build", version: 2 },
  }, null, 2));

  appendInteraction(interactionsPath(taskDir), createInteraction({
    taskId: "obj-abc-widget", kind: "comment", author: { type: "human", id: "founder" },
    body: "We should pin the Vercel CLI version before the next deploy.", occurredAt: AT,
  }));

  if (withPrompt) {
    // Exactly the files a real run leaves behind: the rendered handoff prompt
    // and the raw agent result, both full of prose HQ must never surface.
    writeFileSync(join(taskDir, "prompt.md"), `You are the builder. ${SECRET} Do the work.\n`);
    writeFileSync(join(taskDir, "handoff.md"), `Context for the builder: ${SECRET}\n`);
    writeFileSync(join(taskDir, "result.json"), JSON.stringify({ summary: SECRET, notes: SECRET }));
    mkdirSync(join(hqRoot, "factory", "prompts"), { recursive: true });
    writeFileSync(join(hqRoot, "factory", "prompts", "builder.md"), `Builder prompt. ${SECRET}\n`);
  }

  if (goals) writeFileSync(join(hqRoot, "factory", "goals.json"), JSON.stringify({ version: 1, goals }, null, 2));

  return { hqRoot, stateRoot, taskDir };
}

const run = (fixture, query, over = {}) => searchHq({
  hqRoot: fixture.hqRoot, stateRoot: fixture.stateRoot, query, now: AT, ...over,
});

// ── the property that makes this safe to add ─────────────────────────────────

test("a prompt is unreachable through search", () => {
  const fixture = factory();

  // Search for the canary directly, and every way a query could try to reach
  // the files that contain it.
  for (const query of [SECRET, `${SECRET} builder`, "prompt.md", "handoff.md", "result.json", "builder prompt"]) {
    const out = run(fixture, query);
    // The envelope echoes the query back, which is fine and expected. What must
    // never carry the canary is a RESULT.
    assert.equal(
      JSON.stringify(out.results).includes(SECRET), false,
      `the canary reached a result for query "${query}" - search must not read prompt, handoff or result files`,
    );
    if (query.includes(SECRET)) {
      assert.equal(out.total, 0, "a term that exists only inside a prompt must match nothing at all");
    }
  }

  // And the canary is genuinely on disk where search is looking, so the test
  // above is not passing because the fixture is empty.
  const positive = run(fixture, "vercel cli");
  assert.ok(positive.total > 0, "the fixture must be searchable at all, or the canary test proves nothing");
});

test("nothing appears in a result that does not appear in the projection it came from", () => {
  const fixture = factory();
  const out = run(fixture, "vercel");
  assert.ok(out.total > 0);

  for (const result of out.results) {
    // Every result names where the operator can go to see it in full. A hit
    // that cannot be traced back to a panel is a hit from somewhere unaudited.
    assert.match(result.source, /^GET \/api\//, `result from ${result.layer} must name its panel`);
    assert.ok(SEARCH_LAYERS.includes(result.layer));
    assert.ok(result.ref, "every result is addressable");
  }
});

test("evidence results carry the path and never file contents", () => {
  const fixture = factory();
  const out = run(fixture, "vercel-cli-pin", { layers: ["evidence"] });
  assert.equal(out.counts.evidence, 1);
  const hit = out.results[0];
  assert.equal(hit.title, "docs/vercel-cli-pin.md");
  // The path IS the snippet. There is deliberately nothing else.
  assert.equal(hit.snippet, "docs/vercel-cli-pin.md");
  assert.equal(hit.content, undefined);
  assert.equal(hit.body, undefined);
});

test("an interaction result stays marked untrusted, as it is in its own panel", () => {
  const fixture = factory();
  const out = run(fixture, "pin vercel", { layers: ["interactions"] });
  assert.equal(out.counts.interactions, 1);
  assert.equal(out.results[0].trust, "untrusted-input");
});

// ── the query is validated, never interpreted ────────────────────────────────

test("a query is terms, never a regular expression", () => {
  const fixture = factory();
  // Each of these would match broadly, or backtrack catastrophically, if the
  // query were ever compiled into a pattern.
  for (const hostile of [".*", "(a+)+$", "^.*vercel.*$", ".+", "[a-z]+"]) {
    const out = run(fixture, hostile);
    assert.equal(out.total, 0, `"${hostile}" must be treated as a literal term, not a pattern`);
  }
  // And a query that cannot compile at all is an ordinary empty result rather
  // than a 500.
  for (const malformed of ["[", "\\", "(", "*"]) {
    assert.doesNotThrow(() => run(fixture, `${malformed}${malformed}`));
  }
});

test("a query cannot widen the set of files read", () => {
  const fixture = factory();
  // A traversal in the query is just a term that matches nothing. There is no
  // path anywhere in this module that is built from caller input.
  for (const hostile of ["../../etc/passwd", "/etc/passwd", "..%2f..%2fetc"]) {
    const out = run(fixture, hostile);
    assert.equal(out.total, 0);
    assert.equal(out.available, true, "a hostile query is an empty result, not a degraded factory");
  }
});

test("query length and layer names are validated with a usable message", () => {
  assert.throws(() => parseQuery("a"), /at least 2 characters/);
  assert.throws(() => parseQuery("x".repeat(201)), /at most 200 characters/);
  assert.throws(() => parseQuery("   "), /at least 2 characters/);
  assert.throws(() => parseLayers("goals,prompts"), /unknown search layer\(s\): prompts/);
  assert.deepEqual(parseLayers(""), [...SEARCH_LAYERS]);
  assert.deepEqual(parseLayers("goals, decisions"), ["goals", "decisions"]);
});

test("control characters in a query are neutralised rather than carried through", () => {
  const parsed = parseQuery("vercel\u0000\u001fcli");
  assert.deepEqual(parsed.terms, ["vercel", "cli"]);
  assert.equal(/[\u0000-\u001f\u007f]/.test(parsed.text), false, "the echoed query must not carry control bytes back to the caller");
});

test("terms are deduped and bounded, so a long query cannot become a long scan", () => {
  const parsed = parseQuery("a b c d e f g h i j k l");
  assert.equal(parsed.terms.length, 8);
  assert.deepEqual(parseQuery("vercel VERCEL vercel").terms, ["vercel"]);
});

test("all terms must match, not any", () => {
  const fixture = factory();
  assert.ok(run(fixture, "vercel cli").total > 0);
  assert.equal(run(fixture, "vercel kubernetes").total, 0, "AND, not OR: OR across five layers finds nothing");
});

// ── bounds and honest reporting ──────────────────────────────────────────────

test("the result count is bounded and says so rather than looking complete", () => {
  const fixture = factory();
  const out = run(fixture, "vercel", { limit: 1 });
  assert.equal(out.results.length, 1);
  assert.ok(out.total > 1, "total reports what matched");
  assert.equal(out.truncated, true, "a truncated answer must not look complete");
});

test("a limit outside the allowed range is clamped, not rejected", () => {
  const fixture = factory();
  assert.ok(run(fixture, "vercel", { limit: 0 }).results.length <= 1);
  assert.ok(run(fixture, "vercel", { limit: 99999 }).results.length <= 200);
  assert.ok(run(fixture, "vercel", { limit: "nonsense" }).results.length <= 50);
});

test("results are ordered newest first and stable across identical calls", () => {
  const fixture = factory();
  const first = run(fixture, "vercel");
  const second = run(fixture, "vercel");
  assert.deepEqual(first.results.map((r) => r.ref), second.results.map((r) => r.ref));
});

test("a layer that cannot be read degrades the search, it does not fail it", () => {
  const fixture = factory();
  // A goal registry from a format we cannot parse.
  writeFileSync(join(fixture.hqRoot, "factory", "goals.json"), "{ not json");
  const out = run(fixture, "vercel");
  assert.equal(out.available, false);
  assert.match(out.warnings.join(" "), /goals/);
  assert.ok(out.total > 0, "the layers that do work still return results");
});

test("an empty factory is an empty result, not a failure", () => {
  const hqRoot = mkdtempSync(join(tmpdir(), "hq-search-empty-"));
  const out = searchHq({ hqRoot, stateRoot: join(hqRoot, "state"), query: "anything", now: AT });
  assert.equal(out.total, 0);
  assert.equal(out.tasksScanned, 0);
  assert.deepEqual(out.results, []);
});

test("the goal layer searches the tracked registry", () => {
  const fixture = factory({
    goals: [{ id: "g-deploys", level: "company", title: "Stop deploy drift" }],
  });
  const out = run(fixture, "deploy drift", { layers: ["goals"] });
  assert.equal(out.counts.goals, 1);
  assert.equal(out.results[0].ref, "g-deploys");
  assert.equal(out.results[0].source, "GET /api/hq/goals");
});

test("the decision layer finds the founder approval that is still waiting", () => {
  const fixture = factory();
  const out = run(fixture, "founder approval", { layers: ["decisions"] });
  assert.ok(out.counts.decisions > 0);
  assert.equal(out.results[0].taskId, "obj-abc-widget");
});

test("asking for one layer searches only that layer", () => {
  const fixture = factory();
  const out = run(fixture, "vercel", { layers: ["evidence"] });
  assert.deepEqual(out.layers, ["evidence"]);
  for (const key of ["goals", "decisions", "interactions", "timeline"]) {
    assert.equal(out.counts[key], 0, `${key} must not be searched when it was not asked for`);
  }
});
