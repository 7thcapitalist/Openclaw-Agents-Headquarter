// The chat view's poller, asserted from the source.
//
// The first version of this panel shipped with a comment that said "poll only
// while a reply is outstanding" above a `setInterval` that repainted the whole
// panel every three seconds regardless. The founder typed, the repaint emptied
// the textarea under his hands, and Send read a blank box and returned. The
// server log is unambiguous about what that looked like: 389 GETs, one POST,
// and that POST was the thread being created. Nothing he typed ever left the
// browser.
//
// Neither half of that is visible to the unit tests — the panel renders, the
// routes answer, every assertion passes. It is a wiring defect, and this file
// asserts the wiring, in the same spirit as today-panel-wiring.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";

const APP = readFileSync(new URL("../../dashboard/backend/public/app.js", import.meta.url), "utf8");

function chatBlock() {
  const start = APP.indexOf("// ── Chat: talking to an agent");
  assert.notEqual(start, -1, "the chat view must exist");
  const end = APP.indexOf("async function renderTasks()", start);
  assert.notEqual(end, -1);
  return APP.slice(start, end);
}

test("the chat poller stops itself when no reply is outstanding", () => {
  const block = chatBlock();
  const open = block.indexOf("setInterval(");
  assert.notEqual(open, -1, "the chat view polls");

  // Whatever else the tick does, a thread that is not running must end the
  // timer. Without this the panel redraws forever, which is the defect.
  const tick = block.slice(open, block.indexOf("}, 3000)", open));
  assert.match(tick, /status\s*!==\s*"running"|status\s*===\s*"running"/,
    "the tick must branch on whether a reply is still outstanding");
  assert.match(tick, /stopChatPoll\(\)/,
    "the tick must be able to stop the timer — a poller that cannot stop repaints over the composer");
});

test("polling starts only when a turn is actually in flight", () => {
  const block = chatBlock();
  const starts = [...block.matchAll(/startChatPoll\(/g)];
  assert.ok(starts.length >= 1, "something must start the poll");

  // Every call site has to be guarded by a running thread. An unconditional
  // start is the original bug wearing a different name.
  for (const match of starts) {
    const line = block.slice(block.lastIndexOf("\n", match.index), match.index + 40);
    if (line.includes("function startChatPoll")) continue;
    assert.match(line, /running/,
      `startChatPoll is called without checking that a reply is outstanding: ${line.trim()}`);
  }
});

test("a repaint gives the founder his half-typed message back", () => {
  const block = chatBlock();
  assert.match(block, /input\.value\s*=\s*chatDraft/,
    "paintChat must restore the draft — a repaint that empties the composer loses the message");
  assert.match(block, /addEventListener\("input"/,
    "the composer must record what is typed, or there is nothing to restore");
});

test("a send that fails does not swallow what was typed", () => {
  const block = chatBlock();
  const send = block.slice(block.indexOf('data-chat-send'));
  assert.match(send, /chatDraft\s*=\s*message/,
    "a failed send must hand the words back rather than making the founder retype them");
});
