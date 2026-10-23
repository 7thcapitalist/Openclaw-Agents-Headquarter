// SOF-46: regression for SOF-1. A 36-attempt Codex builder node was booked at
// ~$0.085 against ~$98 of real work (~1,150x under). Two defects stacked: the
// ledger kept the envelope's per-message fragment (in=410 out=349) instead of
// the rollout's cumulative total_token_usage, and the write path priced cached
// input at the full input rate. This drives the real write path
// (observeDispatchState) with a rollout fixture and pins the booked cost.
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

import { observeDispatchState, telemetryPaths } from "../lib/telemetry/dispatch.mjs";
import { withRolloutUsage } from "../lib/hq/codex-rollout-usage.mjs";
import { parseAgentMeta } from "../lib/hq/agent-meta.mjs";
import { readCostEvents } from "../lib/hq/cost-ledger.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/codex-rollout-sof1-36-attempts.jsonl", import.meta.url));
const PRICING = fileURLToPath(new URL("../pricing.json", import.meta.url));

// Last cumulative row: input 155M (150M cached), output 0.9M at gpt-5.6-sol
// rates ($4 in / $0.4 cached / $20 out per M): 5M*4 + 150M*0.4 + 0.9M*20 = $98.
const REAL_COST_MICROS = 98_000_000;
const ENVELOPE = { stdout: JSON.stringify({ ok: true, provider: "openai", model: "gpt-5.6-sol", usage: { input: 410, output: 349 } }) };

function book(agentMeta) {
  const root = mkdtempSync(join(tmpdir(), "hq-sof46-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  copyFileSync(PRICING, join(root, "factory", "pricing.json"));
  const taskDir = join(root, ".openclaw-factory", "tasks", "task-1");
  mkdirSync(taskDir, { recursive: true });
  const statePath = join(taskDir, "state.json");
  const dispatch = { id: "task-1-builder-36", stage: "builder", actor: "codex", agentId: "backend-builder", status: "completed", createdAt: "2026-09-09T10:00:00.000Z", startedAt: "2026-09-09T10:01:00.000Z", completedAt: "2026-09-09T10:02:00.000Z", outcome: "pass", summary: "36 attempts." };
  writeFileSync(statePath, JSON.stringify({ task: { id: "task-1", project: "hq" }, status: "active", currentStage: "reviewer", events: [], dispatches: [dispatch] }));
  observeDispatchState({ hqRoot: root, statePath, phase: "completed", dispatchId: dispatch.id, agentMeta });
  const [event] = readCostEvents(telemetryPaths({ hqRoot: root, statePath }).costs);
  return event;
}

function rolloutMeta() {
  const sessionsDir = mkdtempSync(join(tmpdir(), "hq-sof46-sessions-"));
  copyFileSync(FIXTURE, join(sessionsDir, "rollout-36-attempts.jsonl"));
  return withRolloutUsage(parseAgentMeta(ENVELOPE), { agentId: "backend-builder", startedAtMs: 0, sessionsDir });
}

test("36-attempt Codex node books ~$98 from the rollout, not the 410/349 fragment", () => {
  const event = book(rolloutMeta());
  assert.equal(event.inputTokens, 5_000_000);
  assert.equal(event.cachedInputTokens, 150_000_000);
  assert.equal(event.outputTokens, 900_000);
  assert.equal(event.costMicros, REAL_COST_MICROS);
});

test("the old fragment booking is at least 1,000x under the corrected booking", () => {
  const fragment = book(parseAgentMeta(ENVELOPE));
  const corrected = book(rolloutMeta());
  assert.ok(corrected.costMicros / fragment.costMicros >= 1000, `ratio ${corrected.costMicros / fragment.costMicros}`);
});

test("cached input is priced at the cached rate on the write path, not the input rate", () => {
  const event = book(rolloutMeta());
  // Billing the 150M cached tokens at $4/M would add $540 to the $98.
  assert.ok(event.costMicros < 100_000_000, `costMicros ${event.costMicros}`);
});
