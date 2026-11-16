#!/usr/bin/env node
// Idle self-improvement worker. Intentionally has no process.argv[1] entry
// guard: pm2 owns argv[1] when it wraps a process, and such a guard would make
// an apparently-online worker silently do nothing.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleObjectiveStart } from "../dashboard/backend/lib/founderControlPlane.mjs";
import { decomposeObjective } from "../factory/lib/objective/decompose.mjs";
import { runObjective } from "../factory/lib/objective/orchestrator.mjs";
import { activeSelfImprovementObjectives, tickIdleTrigger } from "../factory/lib/idle/trigger.mjs";
import { shouldYieldSelfImprovement } from "../factory/lib/idle/yield-gate.mjs";

const hqRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateRoot = join(hqRoot, "dashboard", "backend", "data", "factory", "hq-runtime");
const intervalMs = Math.max(60_000, Number(process.env.HQ_IDLE_TRIGGER_INTERVAL_MS) || 60_000);

const runWithYield = (options) => runObjective({ ...options, shouldYield: shouldYieldSelfImprovement });
const startObjective = (request) => handleObjectiveStart({
  root: hqRoot, hqRoot, ...request, decompose: decomposeObjective, runObjective: runWithYield,
});

export async function tick() {
  const deps = { startObjective };
  if (process.env.HQ_IDLE_TRIGGER_TEST_OFF === "1") deps.config = { learning: { idleTrigger: { mode: "off" } } };
  const result = await tickIdleTrigger({ hqRoot, stateRoot, deps });
  if (result.action === "off") return result;
  // A yielded learning objective is an idempotent resume. If founder work is
  // still present the same gate immediately yields again without a node start.
  for (const item of activeSelfImprovementObjectives({ stateRoot })) {
    if (item.state.status !== "yielded") continue;
    if (!shouldYieldSelfImprovement({ objective: item.state, objectivePath: item.path, hqRoot, stateRoot })) {
      void runWithYield({ hqRoot, objectivePath: item.path, stateRoot });
    }
  }
  return result;
}

try {
  const result = await tick();
  console.log(`[idle-trigger] ${result.action}${result.idleReason ? `: ${result.idleReason}` : ""}`);
  if (!process.env.HQ_IDLE_TRIGGER_ONCE) setInterval(() => tick().catch((error) => console.error(`[idle-trigger] ${error.message}`)), intervalMs);
} catch (error) {
  console.error(`[idle-trigger] ${String(error?.message || error)}`);
  if (process.env.HQ_IDLE_TRIGGER_ONCE) process.exitCode = 1;
}
