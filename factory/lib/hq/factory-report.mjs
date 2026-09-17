// Read-only projection of the daily factory health snapshots written by
// `factory:report`. This module reshapes those files for the founder console;
// it never derives a metric from underlying workflow state.

import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { defaultStateRoot } from "./tasks.mjs";

const SNAPSHOT_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;
const EMPTY_REASON = "no factory:report snapshots found — run npm run factory:report";

export function defaultMetricsRoot(hqRoot) {
  return join(defaultStateRoot(hqRoot), "_metrics");
}

export function buildFactoryReportSnapshot({ hqRoot, metricsRoot = null, now = new Date().toISOString(), maxDays = 14 } = {}) {
  const root = resolve(metricsRoot || defaultMetricsRoot(hqRoot));
  const limit = Number.isInteger(maxDays) && maxDays > 0 ? maxDays : 14;
  const files = datedFiles(root).slice(-limit);
  if (!files.length) return emptySnapshot(now);

  const warnings = [];
  const days = files.map((file) => readDay(root, file, warnings));
  const latestById = new Map();

  for (const day of days) {
    for (const metric of day.metrics) {
      if (typeof metric?.id !== "string" || !metric.id.trim()) {
        warnings.push(`snapshot ${day.date} contains a metric without an id`);
        continue;
      }
      latestById.set(metric.id, {
        id: metric.id,
        group: metric.group,
        label: metric.label,
        unit: metric.unit,
        value: metric.value,
        direction: metric.direction,
        target: metric.target,
        sourcePath: metric.sourcePath,
        reason: metric.reason,
      });
    }
  }

  const metrics = [...latestById.values()].map((latest) => ({
    ...latest,
    series: days.map((day) => {
      const metric = day.metrics.find((candidate) => candidate?.id === latest.id);
      return { date: day.date, value: typeof metric?.value === "number" && Number.isFinite(metric.value) ? metric.value : null };
    }),
  }));

  return {
    version: 1,
    asOf: now,
    available: true,
    generatedDates: days.map((day) => day.date),
    latest: days.at(-1)?.date || null,
    warnings,
    metrics,
  };
}

function datedFiles(root) {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && SNAPSHOT_FILE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function readDay(root, file, warnings) {
  const date = file.slice(0, -".json".length);
  try {
    const parsed = JSON.parse(readFileSync(join(root, file), "utf8"));
    if (Number(parsed?.version) > 1) {
      warnings.push(`snapshot ${date} uses unsupported version ${parsed.version}`);
      return { date, metrics: [] };
    }
    if (!Array.isArray(parsed?.metrics)) {
      warnings.push(`snapshot ${date} has no metrics array`);
      return { date, metrics: [] };
    }
    return { date, metrics: parsed.metrics };
  } catch (error) {
    warnings.push(`snapshot ${date} is unreadable: ${error.message}`);
    return { date, metrics: [] };
  }
}

function emptySnapshot(asOf) {
  return {
    version: 1,
    asOf,
    available: false,
    reason: EMPTY_REASON,
    generatedDates: [],
    latest: null,
    warnings: [],
    metrics: [],
  };
}
