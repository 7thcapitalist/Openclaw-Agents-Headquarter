import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { sanitizeExcerpt } from "../common/redact.mjs";
import { defaultFactoryStateRoot } from "./evidence.mjs";
import { learningRootFor } from "./queue.mjs";
import { runLearningAnalysisPass } from "./run-analysis.mjs";

const { hqRoot, now } = workerData;
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
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  const message = sanitizeExcerpt(error?.message || error, { maxLength: 500 }).text;
  try {
    const path = join(learningRootFor(factoryStateRoot), "trigger-errors.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ at: now, error: message })}\n`, "utf8");
  } catch { /* learning telemetry must never affect objective completion */ }
  parentPort.postMessage({ ok: false, error: message });
}
