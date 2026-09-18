import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { defaultFactoryStateRoot } from "./evidence.mjs";
import { learningRootFor } from "./queue.mjs";
import { runLearningAnalysisPass } from "./run-analysis.mjs";
import { sanitizeExcerpt } from "../common/redact.mjs";

export async function triggerObjectiveLearningRun({ hqRoot, now = new Date().toISOString() } = {}) {
  if (!hqRoot) return { ok: false, skipped: true, error: "hqRoot is required" };
  const factoryStateRoot = defaultFactoryStateRoot(hqRoot);
  try {
    let config = {};
    try { config = JSON.parse(readFileSync(join(hqRoot, "factory", "factory.config.json"), "utf8")); } catch { /* defaults below */ }
    const result = runLearningAnalysisPass({
      factoryStateRoot,
      now,
      maxAttemptsPerStage: config.openclawIntegration?.maxAttemptsPerStage || 3,
      patternThreshold: config.learning?.patternThreshold || 2,
    });
    return { ok: true, result };
  } catch (error) {
    try {
      const path = join(learningRootFor(factoryStateRoot), "trigger-errors.jsonl");
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify({ at: now, error: sanitizeExcerpt(error?.message || error, { maxLength: 500 }).text })}\n`, "utf8");
    } catch { /* learning telemetry must never affect objective completion */ }
    return { ok: false, error: String(error?.message || error) };
  }
}
