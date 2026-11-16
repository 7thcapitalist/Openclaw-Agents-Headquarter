// SOF-1: the ledger booked ~$0.085 for ~$98 of Codex work because it kept the
// per-message fragment from the harness envelope instead of the session's
// cumulative total_token_usage from the rollout transcript.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readRolloutUsage, withRolloutUsage } from "../lib/hq/codex-rollout-usage.mjs";
import { parseAgentMeta } from "../lib/hq/agent-meta.mjs";
import { loadPricing, priceCostEvents } from "../lib/hq/cost.mjs";
import { createCostEvent } from "../lib/hq/cost-ledger.mjs";

const tokenCount = (total) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: total } } });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rollout-"));
  mkdirSync(join(dir, "2026", "09"), { recursive: true });
  writeFileSync(join(dir, "2026", "09", "rollout-a.jsonl"), [
    JSON.stringify({ type: "response_item", payload: { text: "write to .factory/results/dispatch-1.json" } }),
    tokenCount({ input_tokens: 19622, cached_input_tokens: 9344, output_tokens: 191 }),
    "not json",
    // Cumulative: the LAST row is the session total.
    tokenCount({ input_tokens: 2_000_000, cached_input_tokens: 1_900_000, output_tokens: 20_000 }),
  ].join("\n"));
  return dir;
}

test("rollout usage takes the last cumulative total and separates cached from fresh input", () => {
  const dir = fixture();
  const usage = readRolloutUsage(join(dir, "2026", "09", "rollout-a.jsonl"));
  assert.deepEqual(usage, { tokensIn: 100_000, cachedInputTokens: 1_900_000, tokensOut: 20_000 });
});

test("a Codex dispatch whose envelope holds a 410/349 fragment books the session, not the fragment", () => {
  const dir = fixture();
  const fragment = parseAgentMeta({ stdout: JSON.stringify({ ok: true, provider: "openai", model: "gpt-5.6-sol", usage: { input: 410, output: 349 } }) });
  assert.equal(fragment.tokensIn, 410);
  const meta = withRolloutUsage(fragment, { agentId: "backend-builder", dispatchId: "dispatch-1", startedAtMs: 0, sessionsDir: dir });
  assert.equal(meta.cachedInputTokens, 1_900_000);
  const event = createCostEvent({ source: "t", sourceEventId: "1", provider: meta.provider, model: meta.model,
    inputTokens: meta.tokensIn, cachedInputTokens: meta.cachedInputTokens, outputTokens: meta.tokensOut });
  const pricing = loadPricing(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const [priced] = priceCostEvents([event], pricing).events;
  // 100k*$4/M + 1.9M*$0.4/M + 20k*$20/M = 0.4 + 0.76 + 0.4
  assert.equal(priced.costMicros, 1_560_000);
});

test("non-Codex or unreadable rollouts leave the meta untouched", () => {
  const meta = { provider: "anthropic", model: "claude-sonnet-5", tokensIn: 1, tokensOut: 1 };
  assert.equal(withRolloutUsage(meta, { agentId: "x", dispatchId: "dispatch-1", startedAtMs: 0, sessionsDir: fixture() }), meta);
  const codex = { provider: "openai", model: "gpt-5.6-sol", tokensIn: 5, tokensOut: 5 };
  assert.equal(withRolloutUsage(codex, { agentId: "x", dispatchId: "dispatch-1", startedAtMs: 0, sessionsDir: join(tmpdir(), "nope-missing") }), codex);
});

test("OpenClaw's cacheRead/cacheWrite spellings are counted as cached input", () => {
  const meta = parseAgentMeta({ stdout: JSON.stringify({ ok: true, provider: "openai", model: "gpt-5.6-sol", usage: { input: 5, output: 7, cacheRead: 1000, cacheWrite: 20 } }) });
  assert.equal(meta.cachedInputTokens, 1020);
});

// Two overlapping runs of the same agentId write rollouts into the same dir with
// mtimes after both starts. Each dispatch must book only its own rollout.
test("overlapping dispatches of the same agent each book only their own rollout", () => {
  const dir = mkdtempSync(join(tmpdir(), "rollout-overlap-"));
  const mk = (name, id, total) => writeFileSync(join(dir, name), [
    JSON.stringify({ type: "response_item", payload: { text: `write to /wt/results/${id}.json` } }),
    tokenCount(total),
  ].join("\n"));
  mk("rollout-a.jsonl", "dispatch-a", { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 10 });
  mk("rollout-b.jsonl", "dispatch-b", { input_tokens: 5000, cached_input_tokens: 0, output_tokens: 50 });
  const frag = { provider: "openai", model: "gpt-5.6-sol", tokensIn: 1, tokensOut: 1 };
  const a = withRolloutUsage(frag, { agentId: "x", dispatchId: "dispatch-a", startedAtMs: 0, sessionsDir: dir });
  const b = withRolloutUsage(frag, { agentId: "x", dispatchId: "dispatch-b", startedAtMs: 0, sessionsDir: dir });
  assert.deepEqual([a.tokensIn, a.cachedInputTokens, a.tokensOut], [600, 400, 10]);
  assert.deepEqual([b.tokensIn, b.cachedInputTokens, b.tokensOut], [5000, 0, 50]);
  // A dispatch whose rollout is missing keeps its fragment rather than inheriting a neighbour's.
  assert.equal(withRolloutUsage(frag, { agentId: "x", dispatchId: "dispatch-c", startedAtMs: 0, sessionsDir: dir }), frag);
  // Without a dispatch id nothing can be attributed.
  assert.equal(withRolloutUsage(frag, { agentId: "x", startedAtMs: 0, sessionsDir: dir }), frag);
});
