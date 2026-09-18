import { isInfraBlockerText } from "../blocker-class.mjs";
import { median } from "../statistics.mjs";
import { isNoVerdictContent } from "./no-verdict.mjs";

const COMPLETE_OBJECTIVE = new Set(["complete", "completed"]);
const MERGED_TASK = "gate-satisfied";

export function computeReportMetrics({ objectives = [], dispatches = [], objectiveIssues = [], resultIssues = [] } = {}) {
  const rows = [];
  const objectivePaths = sources(objectives.map((item) => item.path), objectiveIssues.map((item) => item.path));
  const resultPaths = sources(dispatches.map((item) => item.path), resultIssues.map((item) => item.path));
  const allPaths = sources(objectivePaths, resultPaths);
  const objectiveFailure = issueReason(objectiveIssues);
  const resultFailure = issueReason(resultIssues);
  const nodes = objectives.flatMap((objective) => objective.nodes || []);
  const merged = nodes.filter((node) => node.status === MERGED_TASK);

  add(rows, {
    id: "objectives-complete", group: "objectives-complete", label: "Objectives complete",
    unit: "fraction", direction: "up", target: 1, sourcePath: objectivePaths,
    value: objectiveFailure || objectives.length === 0
      ? null
      : round(objectives.filter((item) => COMPLETE_OBJECTIVE.has(item.status)).length / objectives.length),
    reason: objectiveFailure || (objectives.length === 0 ? "No readable objective-state.sqlite databases were found." : null),
  });

  const dispatchCounts = merged.map((node) => dispatchCount(node, dispatches));
  add(rows, {
    id: "dispatches-per-merged-task", group: "dispatches-per-merged-task", label: "Dispatches per merged task",
    unit: "count", direction: "down", target: 7, sourcePath: allPaths,
    value: objectiveFailure || resultFailure || merged.length === 0 ? null : median(dispatchCounts),
    reason: objectiveFailure || resultFailure || (merged.length === 0 ? "No merged tasks were found." : null),
  });

  const noVerdict = dispatches.filter((item) => isNoVerdictContent(item.content));
  add(rows, {
    id: "no-verdict.overall", group: "no-verdict", label: "No-verdict dispatches",
    unit: "count", direction: "down", target: 0, sourcePath: allPaths,
    value: resultFailure || dispatches.length === 0 ? null : noVerdict.length,
    reason: resultFailure || (dispatches.length === 0 ? "No dispatch result evidence was found." : null),
  });
  for (const stage of [...new Set(dispatches.map((item) => item.stage))].sort()) {
    const stageDispatches = dispatches.filter((item) => item.stage === stage);
    add(rows, {
      id: `no-verdict.${stage}`, group: "no-verdict", label: `${title(stage)} no-verdict dispatches`,
      unit: "count", direction: "down", target: 0, sourcePath: sources(stageDispatches.map((item) => item.path)),
      value: resultFailure ? null : stageDispatches.filter((item) => isNoVerdictContent(item.content)).length,
      reason: resultFailure,
    });
  }

  const interruptions = objectives.flatMap((objective) => (objective.events || [])
    .filter((event) => event?.type === "node-blocked")
    .map((event) => ({ kind: isInfraBlockerText(event.detail || event.summary || event.reason) ? "infra" : "product", path: objective.path })));
  for (const kind of ["infra", "product"]) {
    add(rows, {
      id: `founder-interruptions.${kind}`, group: "founder-interruptions",
      label: kind === "infra" ? "Infrastructure interruptions per merged task" : "Product/spend interruptions per merged task",
      unit: "per-merged-task", direction: "down", target: 0,
      sourcePath: sources(objectivePaths, interruptions.filter((item) => item.kind === kind).map((item) => item.path)),
      value: objectiveFailure || merged.length === 0 ? null : round(interruptions.filter((item) => item.kind === kind).length / merged.length),
      reason: objectiveFailure || (merged.length === 0 ? "No merged tasks were found, so the interruption rate has no denominator." : null),
    });
  }

  for (const stage of [...new Set(dispatches.map((item) => item.stage))].sort()) {
    const durations = stageDurations(stage, dispatches, nodes);
    add(rows, {
      id: `cycle-time.${stage}`, group: "cycle-time", label: `${title(stage)} cycle time`,
      unit: "ms", direction: "down", target: null,
      sourcePath: sources(objectivePaths, dispatches.filter((item) => item.stage === stage).map((item) => item.path)),
      value: objectiveFailure || resultFailure || durations.length === 0 ? null : median(durations),
      reason: objectiveFailure || resultFailure || (durations.length === 0 ? `No valid timing interval was available for the ${stage} stage.` : null),
    });
  }

  const wallTimes = objectives.map(objectiveWallTime).filter((value) => value != null);
  add(rows, {
    id: "wall-time-per-objective", group: "wall-time-per-objective", label: "Wall time per objective",
    unit: "ms", direction: "down", target: null, sourcePath: objectivePaths,
    value: objectiveFailure || wallTimes.length === 0 ? null : median(wallTimes),
    reason: objectiveFailure || (wallTimes.length === 0 ? "No objective has both decomposition and terminal timestamps." : null),
  });

  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

function dispatchCount(node, dispatches) {
  return Math.max(integer(node.attempts), taskDispatches(node.id, dispatches).length);
}

function taskDispatches(taskId, dispatches) {
  return dispatches.filter((item) => item.taskId === taskId);
}

function stageDurations(stage, dispatches, nodes) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const byTask = new Map();
  for (const dispatch of dispatches) {
    if (!byTask.has(dispatch.taskId)) byTask.set(dispatch.taskId, []);
    byTask.get(dispatch.taskId).push(dispatch);
  }
  const durations = [];
  for (const [taskId, items] of byTask) {
    items.sort((a, b) => a.mtimeMs - b.mtimeMs || a.stage.localeCompare(b.stage) || a.attempt - b.attempt);
    let prior = Date.parse(nodeById.get(taskId)?.startedAt || "");
    for (const item of items) {
      if (item.stage === stage && Number.isFinite(prior) && Number.isFinite(item.mtimeMs) && item.mtimeMs >= prior) durations.push(Math.round(item.mtimeMs - prior));
      prior = item.mtimeMs;
    }
  }
  return durations;
}

function objectiveWallTime(objective) {
  const start = Date.parse(objective.createdAt || "");
  const terminal = [...(objective.events || [])].reverse().find((event) => event?.type === "objective-finished" || event?.type === "objective-cancelled");
  const end = Date.parse(terminal?.at || "");
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round(end - start) : null;
}

function add(rows, metric) {
  rows.push({ ...metric, sourcePath: sources(metric.sourcePath), reason: metric.value === null ? (metric.reason || "Metric unavailable.") : null });
}

function issueReason(issues) {
  if (!issues.length) return null;
  return `Authoritative input unavailable: ${issues.map((item) => `${item.path}: ${item.reason}`).sort().join("; ")}`;
}

function sources(...groups) {
  return [...new Set(groups.flat(Infinity).filter(Boolean))].sort();
}

function integer(value) {
  return Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function title(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}
