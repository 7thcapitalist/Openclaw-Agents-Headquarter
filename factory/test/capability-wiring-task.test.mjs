// Wiring a capability to a call site must not change what the factory does.
//
// The permission system is strictly subtractive and ships in `report` mode:
// every decision is computed and audited, then the work is allowed anyway. So
// the load-bearing assertions here are the negative ones — a factory with no
// registry behaves exactly as before, a factory in report mode behaves exactly
// as before, and the only thing that changes is what the audit log knows.
//
// The `enforce`-mode tests exist because that mode is where a wiring mistake
// becomes an outage rather than a log entry, and it is a founder decision that
// this campaign deliberately does not take.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkCapability, permissionAuditPath } from "../lib/hq/capability-check.mjs";
import { publishMergeReadyTask } from "../lib/hq/github-publish.mjs";
import { prepareDispatch } from "../lib/openclaw-protocol.mjs";
import { createState, writeState } from "../lib/task-workflow.mjs";

const TASK = {
  id: "task-caps", issue: "local:caps", outcome: "Ship the thing",
  acceptanceCriteria: ["it ships"], project: "demo", workType: "backend", risk: "low",
};

function hq({ mode = null, grants = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cap-wiring-"));
  mkdirSync(join(root, "factory", "prompts"), { recursive: true });
  // prepareDispatch writes the stage handoff, which reads these.
  for (const stage of ["product", "architect", "builder", "reviewer", "qa", "security", "release"]) {
    writeFileSync(join(root, "factory", "prompts", `${stage}.md`), `# ${stage}\n`);
  }
  if (mode) {
    writeFileSync(
      join(root, "factory", "permissions.json"),
      JSON.stringify({ version: 1, mode, grants }, null, 2),
    );
  }
  return root;
}

function task(root, { status = "active", currentStage = "product" } = {}) {
  const worktree = join(root, "wt");
  mkdirSync(worktree, { recursive: true });
  const state = createState({ task: TASK, repo: join(root, "repo"), branch: "factory/task-caps", worktree });
  state.status = status;
  state.currentStage = currentStage;
  if (status === "merge-ready") state.currentStage = null;
  const statePath = join(root, "state", "task-caps", "state.json");
  writeState(statePath, state);
  return { state, statePath };
}

// One audit envelope per decision: { actor, action, subject, correlation, data }
// where `data` carries the capability, the reason, the enforcement mode, and
// `wouldDeny` — recorded as a string by the envelope's own serializer.
const auditLines = (root) => {
  const path = permissionAuditPath(root);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
};

const wouldDeny = (entry) => String(entry.data.wouldDeny) === "true";

const grant = (actorId, capability) => ({ actorId, capability, scopeType: "company", scopeId: "*" });

// ── the default: no registry at all ─────────────────────────────────────────

test("with no registry, a dispatch is prepared exactly as before and nothing is audited", () => {
  const root = hq();
  const { statePath } = task(root);

  const result = prepareDispatch({ hqRoot: root, statePath });

  assert.equal(result.status, "dispatch", "the caller is still handed a dispatch to run");
  assert.ok(JSON.parse(readFileSync(statePath, "utf8")).currentDispatch, "the dispatch was still created");
  assert.deepEqual(auditLines(root), [], "an unconfigured factory records no permission decisions");
});

// ── report mode: computed, audited, allowed ─────────────────────────────────

test("report mode audits the dispatch decision and prepares it anyway", () => {
  const root = hq({ mode: "report", grants: [grant("openclaw", "task.dispatch")] });
  const { statePath } = task(root);

  prepareDispatch({ hqRoot: root, statePath });

  assert.ok(JSON.parse(readFileSync(statePath, "utf8")).currentDispatch, "report mode never stops work");
  const [entry] = auditLines(root);
  assert.ok(entry, "the decision was recorded");
  assert.equal(entry.data.capability, "task.dispatch");
  assert.equal(entry.data.enforcement, "report");
  assert.equal(entry.actor.id, "openclaw", "the stage's assigned agent is the actor, not the factory");
  assert.equal(entry.correlation.stage, "product");
  assert.equal(wouldDeny(entry), false, "a granted actor is not flagged");
});

test("report mode records what enforcement WOULD have stopped, without stopping it", () => {
  // No grant for the product stage's actor.
  const root = hq({ mode: "report", grants: [grant("someone-else", "task.dispatch")] });
  const { statePath } = task(root);

  prepareDispatch({ hqRoot: root, statePath });

  assert.ok(JSON.parse(readFileSync(statePath, "utf8")).currentDispatch, "the ungranted dispatch still happened");
  const entry = auditLines(root)[0];
  assert.equal(entry.data.reason, "no-grant");
  assert.equal(wouldDeny(entry), true, "this is the signal report mode exists to produce");
});

// ── the audit log stays about real work ─────────────────────────────────────

test("a task that would not dispatch is not audited", () => {
  const root = hq({ mode: "report", grants: [] });
  // Blocked: prepareDispatch's transaction returns early, so no dispatch was
  // ever going to exist and a decision about one would be noise.
  const { statePath } = task(root, { status: "blocked" });

  prepareDispatch({ hqRoot: root, statePath });

  assert.deepEqual(auditLines(root), [], "no decision is recorded for work that cannot happen");
});

test("a dispatch that already exists is not audited again", () => {
  const root = hq({ mode: "report", grants: [grant("openclaw", "task.dispatch")] });
  const { statePath } = task(root);

  prepareDispatch({ hqRoot: root, statePath });
  prepareDispatch({ hqRoot: root, statePath });

  assert.equal(auditLines(root).length, 1, "the second call takes the early-return branch");
});

// ── enforce mode: the denial is real ────────────────────────────────────────

test("enforce mode refuses an ungranted dispatch and writes no dispatch", () => {
  const root = hq({ mode: "enforce", grants: [grant("someone-else", "task.dispatch")] });
  const { statePath } = task(root);

  assert.throws(() => prepareDispatch({ hqRoot: root, statePath }), /not permitted to task\.dispatch/);
  assert.equal(
    JSON.parse(readFileSync(statePath, "utf8")).currentDispatch,
    undefined,
    "a denial must arrive before any state is written, or it has denied nothing",
  );
});

test("enforce mode allows the granted actor", () => {
  const root = hq({ mode: "enforce", grants: [grant("openclaw", "task.dispatch")] });
  const { statePath } = task(root);

  prepareDispatch({ hqRoot: root, statePath });
  assert.ok(JSON.parse(readFileSync(statePath, "utf8")).currentDispatch);
});

// ── github.open-pr ──────────────────────────────────────────────────────────

test("publishing is checked only once the task is actually finished", () => {
  const root = hq({ mode: "report", grants: [] });
  const { state } = task(root, { status: "active" });

  const result = publishMergeReadyTask({ hqRoot: root, state });

  assert.equal(result.published, false);
  assert.match(result.reason, /not merge-ready/);
  assert.deepEqual(auditLines(root), [], "unfinished work was never going to publish");
});

test("enforce mode refuses to open a pull request for an ungranted actor", () => {
  const root = hq({ mode: "enforce", grants: [grant("someone-else", "github.open-pr")] });
  const { state } = task(root, { status: "merge-ready" });

  assert.throws(
    () => publishMergeReadyTask({ hqRoot: root, state }),
    /not permitted to github\.open-pr/,
  );
});

test("report mode records the publish decision and does not refuse it", () => {
  const root = hq({ mode: "report", grants: [] });
  const { state } = task(root, { status: "merge-ready" });

  // It proceeds past the check and stops for its own reasons (no git remote
  // here) — which is the point: the capability check did not decide this.
  const result = publishMergeReadyTask({ hqRoot: root, state });
  assert.doesNotMatch(String(result.reason || ""), /not permitted/);

  const entry = auditLines(root)[0];
  assert.equal(entry.data.capability, "github.open-pr");
  assert.equal(wouldDeny(entry), true);
});

// ── failing safe ────────────────────────────────────────────────────────────

test("an unreadable registry refuses the work rather than allowing it silently", () => {
  const root = hq();
  writeFileSync(join(root, "factory", "permissions.json"), "{ not json");
  const { statePath } = task(root);

  assert.throws(() => prepareDispatch({ hqRoot: root, statePath }), /permission registry is unreadable/);
});

test("without an hqRoot there is no registry to consult, and no check is made", () => {
  // Asserted on the seam rather than through prepareDispatch, which has always
  // required an hqRoot of its own. The property that matters is that a caller
  // with no root is not denied — a check that fails closed when it cannot find
  // its config would make adding one an outage for every such call site.
  assert.equal(
    checkCapability({ hqRoot: null, capability: "task.dispatch", scope: { type: "task", id: "task-caps" } }),
    null,
  );
});

test("an unconfigured factory returns no decision even with a root", () => {
  const root = hq();
  assert.equal(
    checkCapability({ hqRoot: root, capability: "task.dispatch", scope: { type: "task", id: "task-caps" } }),
    null,
    "enforcement-disabled is not a denial",
  );
  assert.deepEqual(auditLines(root), []);
});

test("the founder is never denied by a wired call site", () => {
  const root = hq({ mode: "enforce", grants: [] });
  const decision = checkCapability({
    hqRoot: root,
    capability: "github.open-pr",
    actor: { type: "human", id: "founder" },
    scope: { type: "task", id: "task-caps" },
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "founder-authority");
});
