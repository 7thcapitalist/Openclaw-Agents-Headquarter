// The Founder Inbox is a human interface, not a factory state dump.
//
// Every item must answer four questions — what do you need from me, why, what
// happens if I do it, what do I click — in the founder's vocabulary, with the
// factory's own vocabulary (ids, prompts, stage names, retry diagnoses) present
// but folded away. These tests hold that contract.

import assert from "node:assert/strict";
import test from "node:test";

import {
  PRIORITY,
  choiceLabel,
  plainCause,
  presentFounderInbox,
  presentInboxItem,
  questionSentence,
  readRecovery,
  workTitle,
} from "../lib/hq/founder-inbox.mjs";
import {
  renderFounderInboxCard,
  renderFounderInboxEmpty,
} from "../../dashboard/backend/public/lib/founderInbox.mjs";

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

// The part of the card the founder actually reads: everything above the first
// drill-down fold.
function visible(html) {
  return html.split("<details")[0];
}

// What the founder can actually read on the card: markup and the attributes the
// existing handlers need are not text on the page.
function visibleText(html) {
  return visible(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

const APPROVAL = {
  kind: "approval",
  id: "obj-039f0f5a-deployment-capability-core:builder",
  taskId: "obj-039f0f5a-deployment-capability-core",
  project: "openclaw-factory",
  statePath: "/data/factory/openclaw/tasks/obj-039f0f5a-deployment-capability-core/state.json",
  objective: "Add a first-class, provider-extensible deployment capability to Headquarters with a standardized project deployment contract, a default Vercel adapter, and a build-to-smoke-test orchestrator.",
  title: "Approve a high-risk build",
  detail: 'The factory has planned "Add a first-class, provider-extensible deployment capability…" and is holding before it writes any code.',
  options: ["Submit signed approval", "Keep paused"],
  risk: "high",
  requestedAt: "2026-09-09T19:01:21.485Z",
  action: "one-click-approval",
};

const RECOVERY = {
  kind: "decision",
  id: "obj-c58897c0-game-backend:qa",
  taskId: "obj-c58897c0-game-backend",
  project: "lifemaxing",
  stage: "qa",
  statePath: "/data/factory/lifemaxing/tasks/obj-c58897c0-game-backend/state.json",
  objective: "Design and implement the LifeMaxing game backend: persistence, domain services, and APIs for character, attributes, XP, and leveling.",
  title: "Recovery could not continue after 3 bounded attempt(s): Independent re-verification at commit 5cd6915 confirms AC #4 FAILS as literally written: DeterministicMissionGenerator in src/domain/game-master/generator.ts never reads context.becomingStatement.",
  detail: "The qa stage cannot continue without founder direction.",
  options: ["Approve and resume", "Provide direction", "Keep paused"],
  risk: "high",
  requestedAt: "2026-09-10T03:55:15.949Z",
  action: "respond-and-resume",
};

const POST_TASK = {
  kind: "post-task-decision",
  id: "obj-842f30eb-cost-limits-data-apis:release-1788978836675",
  taskId: "obj-842f30eb-cost-limits-data-apis",
  project: "openclaw-factory",
  statePath: "/data/factory/openclaw/tasks/obj-842f30eb-cost-limits-data-apis/state.json",
  objective: "Capture dispatch usage, calculate priced cost rollups, discover provider-plan headroom, and expose both datasets through read-only Headquarters APIs.",
  title: "The cost-rollups objective already shipped to main (PR #33) and its production crash was already fixed (PR #49). How should this pipeline be closed?",
  detail: "The team completed the safe work and is reporting this choice for your review.",
  options: [
    "A. Close as already-delivered: mark obj-842f30eb-cost-limits-data-apis complete on the strength of merged PR #33 + PR #49, and discard local commit 6a9d811 (Recommended)",
    "B. Open a fresh scoped task to verify the live endpoints on current origin/main",
    "Other",
  ],
  risk: "medium",
  requestedAt: "2026-09-09T18:33:56.675Z",
  action: "record-decision",
};

const BLOCKED = {
  kind: "blocked",
  id: "task-81fca3b3:security",
  taskId: "task-81fca3b3",
  project: "openclaw-factory",
  stage: "security",
  objective: "Wire the deployment smoke test into the release gate.",
  title: "security failed — needs a look",
  detail: "The security stage stopped: the ambient-environment secret isolation flaw remains and the deployment credential is missing from the environment.",
  risk: "high",
  requestedAt: "2026-09-08T10:00:00.000Z",
  action: "review-blocked-task",
};

const QUESTION = {
  kind: "question",
  id: "q-1",
  title: "Question to backend-builder",
  detail: "Should the mission generator read the identity statement?",
  requestedAt: "2026-09-07T10:00:00.000Z",
  action: "none",
};

// ── the derivations ─────────────────────────────────────────────────────────

test("workTitle turns an engineering prompt into a short human name", () => {
  assert.equal(workTitle(APPROVAL.objective), "Add a deployment capability to Headquarters");
  assert.equal(workTitle(RECOVERY.objective), "Design and implement the LifeMaxing game backend");
  assert.ok(workTitle(POST_TASK.objective).length <= 60, "long comma series is cut to a readable clause");
  assert.equal(workTitle(""), "");
});

test("workTitle never leaks ids, paths, or prompt scaffolding", () => {
  const title = workTitle("Objective: fix obj-039f0f5a in dashboard/backend/lib/founderControlPlane.mjs so that the inbox reads well");
  assert.doesNotMatch(title, /^objective:/i);
  assert.doesNotMatch(title, /so that/i);
});

test("questionSentence prefers the founder's actual question", () => {
  assert.equal(questionSentence(POST_TASK.title), "How should this pipeline be closed?");
  assert.equal(questionSentence("A ".repeat(200)), "", "an unreadably long sentence is not a title");
});

test("readRecovery recognises an exhausted recovery and its attempt count", () => {
  const parsed = readRecovery(RECOVERY.title);
  assert.equal(parsed.attempts, 3);
  assert.match(parsed.diagnosis, /^Independent re-verification/);
  assert.equal(readRecovery("qa failed — needs a look"), null);
});

test("plainCause translates factory failure text into plain English", () => {
  assert.equal(plainCause("the assigned Claude ACP harness hit its session limit"), "An agent ran out of its usage allowance for now.");
  assert.equal(plainCause("no runtime agent is configured for stage builder"), "The work is assigned to an agent the factory no longer has.");
  assert.match(plainCause("AC #4 FAILS as literally written"), /misses one of the things/);
});

test("choiceLabel shortens an option into a button, keeping the full text elsewhere", () => {
  const label = choiceLabel(POST_TASK.options[0]);
  assert.equal(label, "A. Close as already-delivered");
  assert.ok(label.length <= 64);
});

// ── the cards ───────────────────────────────────────────────────────────────

test("an approval reads as a request from a chief of staff", () => {
  const { founder } = presentInboxItem(APPROVAL);
  assert.equal(founder.type, "approval");
  assert.equal(founder.typeLabel, "Needs your approval");
  assert.equal(founder.title, "Add a deployment capability to Headquarters");
  assert.ok(founder.why, "answers WHY YOU");
  assert.match(founder.next, /Builder → Review → QA → Security → Release/);
  assert.deepEqual(founder.actions.map((a) => a.intent), ["approve", "reject"]);
  assert.equal(founder.priority, PRIORITY.APPROVAL_GATE);
});

test("an exhausted recovery becomes a plain-English request for help", () => {
  const { founder, technical } = presentInboxItem(RECOVERY);
  assert.equal(founder.type, "recovery");
  assert.equal(founder.typeLabel, "Factory needs your help");
  assert.equal(founder.title, "Design and implement the LifeMaxing game backend");
  assert.match(founder.context, /retried this 3 times/);
  assert.match(founder.context, /misses one of the things it was asked to do/);
  // The 2,000-character diagnosis is kept, but only behind the fold.
  assert.ok(founder.context.length < 260, `context stayed short: ${founder.context.length}`);
  assert.equal(technical.rawTitle, RECOVERY.title);
  assert.deepEqual(founder.actions.map((a) => a.intent), ["direct", "choose"]);
});

test("card copy carries no ids, paths, stage names or option boilerplate", () => {
  for (const item of [APPROVAL, RECOVERY, POST_TASK, BLOCKED]) {
    const { founder } = presentInboxItem(item);
    const copy = [founder.title, founder.subject, founder.context, founder.why, founder.next].join(" ");
    assert.doesNotMatch(copy, /obj-[0-9a-f]{8}|task-[0-9a-f]{8}/, `no ids in ${founder.title}`);
    assert.doesNotMatch(copy, /\/data\/factory|state\.json|\.mjs|\.ts\b/, `no paths in ${founder.title}`);
    assert.doesNotMatch(copy, /decision-required|founderApprovalRequest|statePath/, `no internals in ${founder.title}`);
  }
});

test("a post-task decision is a real choice, not a stalled pipeline", () => {
  const { founder } = presentInboxItem(POST_TASK);
  assert.equal(founder.type, "decision");
  assert.equal(founder.title, "How should this pipeline be closed?");
  assert.match(founder.context, /already finished and safe/);
  assert.match(founder.next, /Nothing restarts/);
  assert.equal(founder.priority, PRIORITY.HIGH_IMPACT, "nothing is stalled behind it");
  const labels = founder.actions.map((a) => a.label);
  assert.deepEqual(labels, ["A. Close as already-delivered", "B. Open a fresh scoped task to verify the live endpoints on…", "Something else…"]);
  assert.equal(founder.actions[0].tone, "primary", "the recommended option leads");
});

test("a blocked task says what to do about it, not what threw", () => {
  const { founder } = presentInboxItem(BLOCKED);
  assert.equal(founder.type, "blocker");
  assert.equal(founder.typeLabel, "Blocked");
  assert.match(founder.context, /credential or setting/);
  assert.deepEqual(founder.actions.map((a) => a.intent), ["retry-task", "report"]);
});

test("a recorded question is informational and never outranks a real decision", () => {
  const { founder } = presentInboxItem(QUESTION);
  assert.equal(founder.type, "question");
  assert.equal(founder.title, "Should the mission generator read the identity statement?");
  assert.deepEqual(founder.actions, []);
  assert.equal(founder.priority, PRIORITY.INFORMATIONAL);
});

test("raw fields survive the translation untouched", () => {
  const presented = presentInboxItem(RECOVERY);
  for (const [key, value] of Object.entries(RECOVERY)) {
    assert.deepEqual(presented[key], value, `${key} is preserved for existing readers`);
  }
  assert.equal(presented.technical.statePath, RECOVERY.statePath);
  assert.equal(presented.technical.stage, "qa");
});

// ── the ordering ────────────────────────────────────────────────────────────

test("the inbox is ordered by what is holding the founder up, not by timestamp", () => {
  // Deliberately worst-case input: newest item last, oldest actionable first.
  const ordered = presentFounderInbox([QUESTION, POST_TASK, RECOVERY, BLOCKED, APPROVAL]);
  assert.deepEqual(ordered.map((item) => item.founder.type), [
    "approval",  // a gate only the founder can open
    "blocker",   // live work stopped
    "recovery",  // the factory tried and could not fix it
    "decision",  // a real choice with nothing stalled behind it
    "question",  // informational
  ]);
});

test("two items of the same tier order by risk, then by who has waited longest", () => {
  const older = { ...BLOCKED, id: "a", risk: "high", requestedAt: "2026-09-01T00:00:00.000Z" };
  const newer = { ...BLOCKED, id: "b", risk: "high", requestedAt: "2026-09-05T00:00:00.000Z" };
  const lowRisk = { ...BLOCKED, id: "c", risk: "low", requestedAt: "2026-08-01T00:00:00.000Z" };
  const ordered = presentFounderInbox([newer, lowRisk, older]);
  assert.deepEqual(ordered.map((item) => item.id), ["a", "b", "c"]);
});

// ── the rendering ───────────────────────────────────────────────────────────

test("the card renders the four questions in order and hides the rest", () => {
  const html = renderFounderInboxCard(presentInboxItem(APPROVAL), { esc });
  const head = visible(html);
  assert.match(head, /Needs your approval/);
  assert.match(head, /<h3 class="fi-title">Add a deployment capability to Headquarters<\/h3>/);
  assert.match(head, /After you approve/);
  // What the founder clicks, on the handler contract the dashboard already has.
  assert.match(head, /data-approve="obj-039f0f5a-deployment-capability-core"/);
  assert.match(head, /data-reject="obj-039f0f5a-deployment-capability-core"/);
  assert.match(html, /data-approval-statepath="[^"]+state\.json"/, "the signing flow keeps its state path");
  // Technical payload exists, but only inside the fold.
  assert.match(html, /View details/);
  assert.match(html, /first-class, provider-extensible/, "the full prompt is still reachable");
  assert.doesNotMatch(head, /first-class, provider-extensible/, "…but never above the fold");
  assert.doesNotMatch(visibleText(html), /state\.json|obj-039f0f5a/, "no ids or paths are readable on the card");
});

test("decision buttons keep the existing resolve wiring", () => {
  const html = renderFounderInboxCard(presentInboxItem(POST_TASK), { esc });
  assert.match(html, /data-resolve-choice="[^"]+" data-choice="A\. Close as already-delivered[^"]*" data-post-task="1"/);
  assert.match(html, /data-resolve-other="[^"]+" data-post-task="1"/);
  assert.match(html, /title="[^"]*discard local commit 6a9d811[^"]*"/, "the full option text stays available on hover");
});

test("a blocked card offers retry and the report, and shows ids only as fine print", () => {
  const html = renderFounderInboxCard(presentInboxItem(BLOCKED), { esc });
  assert.match(visible(html), /data-retry-task="task-81fca3b3"/);
  assert.match(visible(html), /data-report-task="task-81fca3b3"/);
  assert.doesNotMatch(visible(html), /task-81fca3b3<\/h3>/);
  assert.match(html, /data-task-execution="task-81fca3b3"/, "the full execution view is one click inside details");
});

// A deploy that is not followed by a restart serves the new assets against the
// old server's payload. That must never cost the founder the ability to act.
test("an untranslated payload keeps every action the founder had before", () => {
  const approval = renderFounderInboxCard({ ...APPROVAL, founder: undefined, technical: undefined }, { esc });
  assert.match(approval, /Needs your approval/);
  assert.match(approval, /data-approve="obj-039f0f5a-deployment-capability-core"/);
  assert.match(approval, /data-reject="obj-039f0f5a-deployment-capability-core"/);
  assert.match(approval, /data-approval-statepath="[^"]+state\.json"/);
  assert.match(approval, /data-approve-status/, "the signing status line is still there");

  const decision = renderFounderInboxCard({ ...POST_TASK, founder: undefined, technical: undefined }, { esc });
  assert.match(decision, /data-resolve-choice="[^"]+" data-choice="A\. Close as already-delivered[^"]*"/);
  assert.match(decision, /data-resolve-other=/);

  const blocked = renderFounderInboxCard({ ...BLOCKED, founder: undefined, technical: undefined }, { esc });
  assert.match(blocked, /data-retry-task="task-81fca3b3"/);
  assert.match(blocked, /data-report-task="task-81fca3b3"/);
});

test("an untranslated payload never offers a resolve that would contradict itself", () => {
  // "Keep paused" and "Approve and resume" are placeholders: resolving with
  // either records that direction AND resumes the task.
  const html = renderFounderInboxCard({ ...RECOVERY, founder: undefined, technical: undefined }, { esc });
  assert.doesNotMatch(html, /data-choice="Keep paused"/);
  assert.doesNotMatch(html, /data-choice="Approve and resume"/);
  assert.doesNotMatch(html, /data-choice="Provide direction"/);
  assert.match(html, /data-resolve-other=/, "the founder can still answer in their own words");
});

test("an untranslated payload still caps the heading and keeps the detail reachable", () => {
  const html = renderFounderInboxCard({ ...RECOVERY, founder: undefined, technical: undefined }, { esc });
  const heading = html.match(/<h3 class="fi-title">([^<]*)<\/h3>/)[1];
  assert.ok(heading.length <= 141, `heading capped, got ${heading.length}`);
  assert.match(html, /DeterministicMissionGenerator/, "the full diagnosis is still in the details fold");
  assert.match(html, /data-task-execution="obj-c58897c0-game-backend"/, "drill-downs are rebuilt from the raw item");
});

test("an item of an unknown shape still renders", () => {
  const html = renderFounderInboxCard({ title: "Something needs you", detail: "Older shape" }, { esc });
  assert.match(html, /Something needs you/);
  assert.match(html, /Older shape/);
});

test("an empty inbox says so plainly", () => {
  assert.match(renderFounderInboxEmpty(), /You're all caught up/);
});
