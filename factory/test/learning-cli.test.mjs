import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { handleRequest } from "../../scripts/factory-learn.mjs";

const NOW = "2026-09-03T00:00:00Z";

function fixtureStateRoot() {
  const root = mkdtempSync(join(tmpdir(), "learn-cli-"));
  const mk = (id, summary) => {
    const dir = join(root, "tasks", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({
      version: 1,
      task: { id, project: "demo", risk: "low", workType: "backend", issue: id },
      repo: "/demo", worktree: "/nonexistent", branch: `factory/${id}`,
      status: "blocked",
      assignments: { product: "openclaw", architect: "claude", builder: "codex", reviewer: "claude", qa: "codex", security: "claude", release: "openclaw" },
      currentStage: "builder",
      stages: { builder: { status: "fail", actor: "codex", summary } },
      dispatches: [{ id: "d1", stage: "builder", actor: "codex", attempt: 1, outcome: "fail", status: "completed", summary }],
      blocker: { stage: "builder", outcome: "fail", summary, actor: "codex", at: "2026-09-02T10:00:00Z" },
      events: [{ at: "2026-09-02T10:00:00Z", type: "stage-fail", stage: "builder", actor: "codex" }],
      createdAt: "2026-09-02T09:00:00Z", updatedAt: "2026-09-02T10:00:00Z",
    }), "utf8");
  };
  mk("issue-42", "acceptance criteria are not testable, ambiguous requirement");
  mk("issue-51", "requirement unclear and non-observable acceptance criteria");
  return root;
}

function noopPublish() {
  const calls = [];
  return {
    fn: (args) => { calls.push(args); return { published: true, branch: args.branch, committed: true, pushed: false, prUrl: null, notes: [], files: args.files.map((f) => f.path) }; },
    calls,
  };
}

test("analyze -> list -> synthesize -> promote -> dismiss flow", async () => {
  const stateRoot = fixtureStateRoot();
  const publish = noopPublish();

  const analyzed = await handleRequest({ version: 1, action: "analyze", stateRoot, now: NOW });
  assert.equal(analyzed.analyzedTasks, 2);
  assert.ok(analyzed.queue.added.length >= 3);
  assert.ok(existsSync(analyzed.runPath));

  const listed = await handleRequest({ version: 1, action: "list", stateRoot });
  assert.ok(listed.count >= 3);
  const pattern = listed.findings.find((f) => f.kind === "pattern");
  assert.ok(pattern, "a cross-task pattern is present");

  const dry = await handleRequest({ version: 1, action: "synthesize", stateRoot, now: NOW }, { publishProposals: publish.fn });
  assert.equal(dry.publication.published, false);
  assert.match(dry.publication.reason, /dry run/);
  assert.equal(publish.calls.length, 0);
  assert.ok(readdirSync(dry.proposalsDir).some((f) => f.includes("LESSONS_LEARNED") || f.includes("PROCESS_IMPROVEMENTS")));

  const published = await handleRequest({ version: 1, action: "synthesize", stateRoot, now: NOW, publish: true, branch: "learning/2026-09-03-test" }, { publishProposals: publish.fn });
  assert.equal(published.publication.published, true);
  assert.equal(publish.calls.length, 1);
  assert.ok(publish.calls[0].files.every((f) => f.path.startsWith("factory/knowledge/")));

  // promote a non-role finding as an entry, opt-in publish
  const success = listed.findings.find((f) => f.kind === "failure" && !/gate|routing|prompt/i.test(f.recommendation));
  const targetId = (success || listed.findings[0]).id;
  const promoted = await handleRequest({ version: 1, action: "promote", id: targetId, as: "entry", publish: true, stateRoot, now: NOW }, { publishProposals: publish.fn });
  assert.equal(promoted.dryRun, false);
  assert.equal(promoted.promoted, targetId);

  const afterPromote = await handleRequest({ version: 1, action: "list", stateRoot, status: "promoted" });
  assert.ok(afterPromote.findings.some((f) => f.id === targetId));

  const remaining = await handleRequest({ version: 1, action: "list", stateRoot });
  const dismissId = remaining.findings[0].id;
  const dismissed = await handleRequest({ version: 1, action: "dismiss", id: dismissId, reason: "handled elsewhere", stateRoot, now: NOW });
  assert.equal(dismissed.dismissed, dismissId);
});

test("promote routes gate/prompt recommendations to a scaffolded factory task", async () => {
  const stateRoot = fixtureStateRoot();
  await handleRequest({ version: 1, action: "analyze", stateRoot, now: NOW });
  const listed = await handleRequest({ version: 1, action: "list", stateRoot });
  const roleFinding = listed.findings.find((f) => f.targetRole === "builder" && /gate|requiredGates/i.test(f.recommendation));
  assert.ok(roleFinding);
  const res = await handleRequest({ version: 1, action: "promote", id: roleFinding.id, stateRoot, now: NOW });
  assert.equal(res.mode, "task");
  assert.ok(existsSync(res.taskContractPath));
  const contract = JSON.parse(readFileSync(res.taskContractPath, "utf8"));
  assert.equal(contract.risk, "low");
  assert.equal(contract.project, "openclaw-factory");
  assert.ok(contract.constraints.some((c) => /workflow engine/i.test(c)));
});

test("research writes a redacted, source-cited note via an injected model", async () => {
  const stateRoot = fixtureStateRoot();
  const payload = JSON.stringify({
    topic: "acceptance-test-first", date: "2026-09-02",
    sources: [{ title: "src", url: "https://example.com/x" }],
    summary: "spec-first reduces rework sk-abcdefghijklmnopqrstuvwxyz012345",
    applicability: ["product stage"], proposedActions: [{ area: "workflow", action: "add a gate" }],
  });
  const res = await handleRequest(
    { version: 1, action: "research", topic: "acceptance-test-first workflows", stateRoot, now: NOW },
    { executeResearch: async () => payload },
  );
  assert.equal(res.note.sources.length, 1);
  assert.ok(!JSON.stringify(res.note).includes("sk-abcdefghijklmnop"));
  assert.ok(existsSync(res.notePath));
  assert.ok(existsSync(res.notePath.replace(/\.json$/, ".md")));
});

test("unsupported action and bad version are rejected", async () => {
  await assert.rejects(handleRequest({ version: 2, action: "analyze" }), /Unsupported or missing request version/);
  await assert.rejects(handleRequest({ version: 1, action: "nope" }), /Unsupported action/);
});
