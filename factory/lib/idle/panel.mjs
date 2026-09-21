import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readQueue, learningRootFor } from "../learning/queue.mjs";
import { evaluateFinding } from "./decide.mjs";
import { effectiveMode } from "./mode.mjs";
import { readIdleState } from "./state.mjs";
import { canonicalEvidenceExists } from "./trigger.mjs";

function readConfig(hqRoot) {
  try { return JSON.parse(readFileSync(join(hqRoot, "factory", "factory.config.json"), "utf8")); } catch { return {}; }
}

export function buildIdleTriggerState({ hqRoot, stateRoot = join(hqRoot, "dashboard", "backend", "data", "factory", "hq-runtime") } = {}) {
  try {
    const config = readConfig(hqRoot);
    const mode = effectiveMode(config, stateRoot);
    const state = readIdleState(stateRoot);
    const queue = readQueue(learningRootFor(resolve(stateRoot, "..")));
    const evidenceExists = (path) => canonicalEvidenceExists(resolve(stateRoot, ".."), path);
    const findings = (queue.findings || []).map((finding) => {
      const result = evaluateFinding(finding, { patternThreshold: config?.learning?.patternThreshold || 2, evidenceExists });
      return { id: finding.id, title: finding.title, eligible: result.eligible, ineligibleReason: result.reason, evidence: (finding.evidence || []).map((entry) => typeof entry === "string" ? entry : entry?.path).filter(Boolean) };
    });
    return { contract: "hq.idle-trigger/1", available: true, mode: mode.mode, modeSource: mode.source, idleReason: state.idleReason, launches: state.launches, wouldHaveLaunched: state.wouldHaveLaunched, proposals: state.proposals, credit: state.credit, findings };
  } catch (error) {
    return { contract: "hq.idle-trigger/1", available: false, mode: "on", idleReason: "state-unavailable", launches: [], wouldHaveLaunched: [], proposals: [], credit: { usedBySelfImprovement: 0, wouldHaveExpired: 0, basis: "estimate" }, findings: [], error: String(error?.message || error) };
  }
}
