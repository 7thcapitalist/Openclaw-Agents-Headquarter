import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { analyzeTasks } from "./analyze.mjs";
import { collectObjectiveNodeBlockers, collectTaskRecords } from "./evidence.mjs";
import { learningRootFor, reconcile, selectFindings, updateQueue } from "./queue.mjs";

export function runLearningAnalysisPass({
  factoryStateRoot,
  project = null,
  since = null,
  task = null,
  includeActive = false,
  now = new Date().toISOString(),
  maxAttemptsPerStage = 3,
  patternThreshold = 2,
} = {}) {
  const learningRoot = learningRootFor(factoryStateRoot);
  const { records, skipped } = collectTaskRecords({ factoryStateRoot, project, since, includeActive });
  const objectiveBlockers = collectObjectiveNodeBlockers({ factoryStateRoot });
  const enriched = records.map((record) => ({
    ...record,
    objectiveNodeBlocker: objectiveBlockers.get(record.id) || null,
  }));
  const filtered = task ? enriched.filter((record) => record.id === task) : enriched;
  const analysis = analyzeTasks(filtered, { now, maxAttemptsPerStage, patternThreshold });
  const incoming = [...analysis.failures, ...analysis.successes, ...analysis.patterns, ...analysis.agentImprovements];
  const { store, added, updated, recurred } = updateQueue(learningRoot, (current) => reconcile(current, incoming, { now }));

  const runsDir = join(learningRoot, "runs");
  mkdirSync(runsDir, { recursive: true });
  const runPath = join(runsDir, `${now.replace(/[:.]/g, "-")}.json`);
  writeFileSync(runPath, `${JSON.stringify({ version: 1, generatedAt: now, analysis, skipped, added, updated, recurred }, null, 2)}\n`, "utf8");

  return {
    version: 1,
    status: "ok",
    analyzedTasks: analysis.analyzedTasks,
    skipped,
    findings: {
      failures: analysis.failures.length,
      successes: analysis.successes.length,
      patterns: analysis.patterns.length,
      agentImprovements: analysis.agentImprovements.length,
    },
    queue: { added, updated, recurred, open: selectFindings(store, { status: "open" }).length },
    runPath,
  };
}
