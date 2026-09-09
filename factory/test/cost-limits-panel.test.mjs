import test from "node:test";
import assert from "node:assert/strict";
import {
  costLimitsPanel,
  fmtCount,
  fmtTokens,
  fmtUsd,
  normalizeCosts,
  normalizeAiUsage,
  normalizePlanLimits,
} from "../../dashboard/backend/public/cost-limits.mjs";

const FULL_COSTS = {
  recentTasks: [{
    taskId: "obj-1234-panel",
    objective: "Build & verify <panel>",
    project: "openclaw-factory",
    tokensIn: 120000,
    tokensOut: 30000,
    estimatedUsd: 1.83,
    stages: [{ stage: "builder", provider: "openai", model: "gpt-5.4-mini", totalTokens: 110000, estimatedUsd: 1.4 }],
  }],
  totals: {
    today: { totalTokens: 150000, estimatedUsd: 1.83, taskCount: 1 },
    last7Days: { totalTokens: 550000, estimatedUsd: 8.25, taskCount: 5 },
    byProject: [{ project: "openclaw-factory", totalTokens: 150000, estimatedUsd: 1.83, taskCount: 1 }],
  },
};

test("renders official plan headroom, totals, and expandable per-stage costs", () => {
  const html = costLimitsPanel(FULL_COSTS, {
    providers: [{
      provider: "openai",
      label: "OpenAI (Codex seat)",
      confidence: "official",
      asOf: "2026-09-07T19:55:00.000Z",
      official: { limit: 1000000, remaining: 240000, used: 760000, unit: "tokens", percentRemaining: 24, resetsAt: "2026-09-08T00:00:00.000Z" },
    }],
  });

  assert.match(html, /Cost &amp; Limits/);
  assert.match(html, /obj-1234-panel/);
  assert.match(html, /Build &amp; verify &lt;panel&gt;/);
  assert.match(html, /openclaw-factory/);
  assert.match(html, /150,000/);
  assert.match(html, /\$1\.83/);
  assert.match(html, /<details class="drill cost-drill">/);
  assert.match(html, /builder/);
  assert.match(html, /official/);
  assert.match(html, /24% remaining/);
  assert.match(html, /Resets 2026-09-08 00:00 UTC/);
});

test("renders inferred calls, tokens, window, and latest cooldown", () => {
  const html = costLimitsPanel(FULL_COSTS, {
    providers: [{
      provider: "anthropic",
      confidence: "inferred",
      inferred: { window: "5h rolling", calls: 42, tokens: 5300000, note: "dashboard dispatches only" },
      lastCooldown: { at: "2026-09-07T14:03:00.000Z", kind: "rate_limit", detail: "profile temporarily unavailable" },
    }],
  });

  assert.match(html, /inferred/);
  assert.match(html, /42 calls \/ ~5,300,000 tokens in 5h rolling/);
  assert.match(html, /dashboard dispatches only/);
  assert.match(html, /Latest cooldown: rate_limit at 2026-09-07 14:03 UTC/);
  assert.match(html, /profile temporarily unavailable/);
});

test("normalizers and rendering tolerate missing fields", () => {
  const costs = normalizeCosts({
    recentTasks: [{ taskId: "partial", tokensIn: 10, tokensOut: 5, stages: [{ stage: "qa" }] }],
    totals: { today: { taskCount: 1 } },
  });
  const plans = normalizePlanLimits({
    providers: [{ provider: "openai", confidence: "official", official: { remaining: 10 } }],
  });
  const html = costLimitsPanel({
    recentTasks: [{ taskId: "partial", tokensIn: 10, tokensOut: 5, stages: [{ stage: "qa" }] }],
    totals: { today: { taskCount: 1 } },
  }, { providers: [{ provider: "openai", confidence: "official", official: { remaining: 10 } }] });

  assert.equal(costs.recentTasks[0].totalTokens, 15);
  assert.equal(plans.providers[0].state, "official");
  assert.match(html, /Global HQ/);
  assert.match(html, />15</);
  assert.match(html, /n\/a/);
  assert.match(html, /<td>—<\/td>/);
  assert.doesNotMatch(html, /undefined|NaN|\$NaN/);
});

test("renders an explicit empty state for empty payloads", () => {
  const html = costLimitsPanel({ recentTasks: [], totals: {} }, { providers: [] });

  assert.match(html, /Cost &amp; Limits/);
  assert.match(html, /class="empty-state"/);
  assert.match(html, /No cost or limit data yet/);
  assert.doesNotMatch(html, /undefined|NaN|\$NaN/);
});

test("keeps successful plan data when costs fail and shows unavailable reason", () => {
  const html = costLimitsPanel(null, {
    providers: [{ provider: "openai", available: false, reason: "no official endpoint and no dispatches in window" }],
  });

  assert.match(html, /class="gap-banner"/);
  assert.match(html, /Cost data is temporarily unavailable/);
  assert.match(html, /unavailable/);
  assert.match(html, /no official endpoint and no dispatches in window/);
});

test("shows the endpoint-level reason when no provider rows are available", () => {
  const html = costLimitsPanel({}, { providers: [], unavailableReason: "provider status command timed out" });

  assert.match(html, /provider status command timed out/);
  assert.doesNotMatch(html, /No cost or limit data yet/);
});

test("keeps successful cost data when plan limits fail", () => {
  const html = costLimitsPanel(FULL_COSTS, { __error: true });

  assert.match(html, /Plan limits are temporarily unavailable/);
  assert.match(html, /obj-1234-panel/);
});

test("formatters reject unusable values and preserve zero", () => {
  assert.equal(fmtUsd(0), "$0.00");
  assert.equal(fmtUsd(1.234, true), "~$1.23");
  assert.equal(fmtUsd(undefined), "n/a");
  assert.equal(fmtTokens(0), "0");
  assert.equal(fmtTokens(NaN), "—");
  assert.equal(fmtCount(42), "42");
});

test("founder AI usage view keeps multiple windows, attribution, and unavailable capacity explicit", () => {
  const aiUsage = normalizeAiUsage({
    asOf: "2026-09-08T12:00:00Z",
    capacity: [{
      provider: "openai",
      label: "Codex / OpenAI",
      status: "healthy",
      confidence: "authoritative",
      source: "provider API",
      windows: [
        { name: "5-hour window", used: 100, remaining: 0, limit: 100, percentRemaining: 0, resetAt: "2026-09-08T13:00:00Z", confidence: "authoritative", source: "provider API" },
        { name: "Daily window", note: "not exposed", confidence: "unavailable", source: "unavailable" },
      ],
    }, {
      provider: "anthropic", label: "Claude / Anthropic", status: "unavailable", confidence: "unavailable", reason: "No supported quota source",
    }],
    runtime: { status: "healthy", source: "OpenClaw sessions command", updatedAt: "2026-09-08T11:59:00Z" },
    factory: { totalTokens: 100, records: 1, usageConfidence: "recorded", byProvider: [{ provider: "openai", totalTokens: 100 }], byModel: [], byAgent: [{ agent: "builder", totalTokens: 100 }], byProject: [{ project: "LifeMax", totalTokens: 100 }], byObjective: [], byTask: [], byStage: [] },
    otherLocal: { available: true, summary: { totalTokens: 20, byProvider: [], byModel: [], byAgent: [], byProject: [], byObjective: [], byTask: [], byStage: [] } },
    dataQuality: [{ label: "Provider remaining capacity", confidence: "authoritative" }, { label: "Factory usage", confidence: "recorded" }],
  });
  assert.equal(aiUsage.capacity[0].windows.length, 2);
  const html = costLimitsPanel({ aiUsage, recentTasks: [], totals: {} }, { providers: [] });
  assert.match(html, /Can the Factory keep running/);
  assert.match(html, /5-hour window/);
  assert.match(html, /0% remaining/);
  assert.match(html, /Daily window/);
  assert.match(html, /No supported quota source/);
  assert.match(html, /By agent/);
  assert.match(html, /LifeMax/);
  assert.match(html, /OpenClaw runtime/);
});
