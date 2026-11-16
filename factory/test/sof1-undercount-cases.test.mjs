// SOF-59: edge cases behind the ~1,150x under-booking of SOF-1 (zero/absent
// usage and price). Each case failed, or silently booked ~$0, before the fix.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readRolloutUsage, withRolloutUsage } from "../lib/hq/codex-rollout-usage.mjs";
import { parseAgentMeta } from "../lib/hq/agent-meta.mjs";
import { priceUsage, normalizePricing } from "../lib/hq/cost.mjs";

const PRICING = normalizePricing({
  models: {
    "openai/gpt-x": { provider: "openai", model: "gpt-x", inputUsdPerMillion: 4, cachedInputUsdPerMillion: 0.4, outputUsdPerMillion: 20 },
  },
});
const TAG = JSON.stringify({ type: "response_item", payload: { text: "results/d1.json" } });
const row = (total) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: total } } });
function rollout(lines) {
  const dir = mkdtempSync(join(tmpdir(), "sof59-"));
  writeFileSync(join(dir, "rollout-a.jsonl"), [TAG, ...lines].join("\n"));
  return dir;
}
const fragment = { provider: "openai", model: "gpt-x", tokensIn: 410, tokensOut: 349 };

test("cached tokens are priced at the cached rate, not dropped and not at the input rate", () => {
  const q = priceUsage({ provider: "openai", model: "gpt-x", tokensIn: 0, cachedTokensIn: 150_000_000, tokensOut: 0 }, PRICING);
  assert.equal(q.costUsd, 60);
});

test("all-cached usage (fresh input 0) still books a non-zero cost", () => {
  const q = priceUsage({ provider: "openai", model: "gpt-x", tokensIn: 0, cachedTokensIn: 1_000_000, tokensOut: 0 }, PRICING);
  assert.ok(q.costUsd > 0);
});

test("unknown model is unpriced (null), never zero", () => {
  const q = priceUsage({ provider: "openai", model: "nope", tokensIn: 1_000_000, tokensOut: 1_000_000 }, PRICING);
  assert.equal(q.costUsd, null);
});

test("rollout with cached > input clamps and never yields negative fresh input", () => {
  const dir = rollout([row({ input_tokens: 100, cached_input_tokens: 500, output_tokens: 5 })]);
  const file = join(dir, "rollout-a.jsonl");
  const u = readRolloutUsage(file);
  assert.equal(u.tokensIn, 0);
  assert.equal(u.cachedInputTokens, 100);
});

test("rollout without any total_token_usage leaves the fragment meta untouched", () => {
  const dir = rollout(["not json", JSON.stringify({ type: "message" })]);
  const out = withRolloutUsage(fragment, { agentId: "a", dispatchId: "d1", startedAtMs: 0, sessionsDir: dir });
  assert.deepEqual(out, fragment);
});

test("missing sessions dir leaves the fragment meta untouched", () => {
  const out = withRolloutUsage(fragment, { agentId: "a", dispatchId: "d1", startedAtMs: 0, sessionsDir: join(tmpdir(), "sof59-does-not-exist") });
  assert.deepEqual(out, fragment);
});

test("rollout total replaces the fragment (fresh = input - cached)", () => {
  const dir = rollout([row({ input_tokens: 2_000_000, cached_input_tokens: 1_000_000, output_tokens: 9 })]);
  const out = withRolloutUsage(fragment, { agentId: "a", dispatchId: "d1", startedAtMs: 0, sessionsDir: dir });
  assert.equal(out.tokensIn, 1_000_000);
  assert.equal(out.cachedInputTokens, 1_000_000);
  assert.equal(out.tokensOut, 9);
});

test("non-openai providers are not rewritten from a rollout", () => {
  const dir = rollout([row({ input_tokens: 9, cached_input_tokens: 0, output_tokens: 9 })]);
  const meta = { ...fragment, provider: "anthropic" };
  assert.deepEqual(withRolloutUsage(meta, { agentId: "a", dispatchId: "d1", startedAtMs: 0, sessionsDir: dir }), meta);
});

test("OpenClaw cacheRead/cacheWrite spellings count as cached input", () => {
  const meta = parseAgentMeta({ stdout: JSON.stringify({ ok: true, provider: "openai", model: "gpt-x", usage: { input: 10, output: 5, cacheRead: 7000, cacheWrite: 300 } }) });
  assert.equal(meta.cachedInputTokens, 7300);
});
