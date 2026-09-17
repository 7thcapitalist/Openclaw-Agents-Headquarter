import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildFactoryReportSnapshot, defaultMetricsRoot } from "../lib/hq/factory-report.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hq-factory-report-"));
  const metricsRoot = join(root, "metrics");
  mkdirSync(metricsRoot, { recursive: true });
  return { root, metricsRoot };
}

function metric(overrides = {}) {
  return {
    id: "no-verdict.reviewer",
    group: "no-verdict",
    label: "Reviewer",
    unit: "count",
    value: 3,
    direction: "down",
    target: 0,
    sourcePath: ["dashboard/backend/data/factory/project/tasks/task/results/result.json"],
    reason: null,
    ...overrides,
  };
}

function writeDay(root, date, metrics, overrides = {}) {
  writeFileSync(join(root, `${date}.json`), JSON.stringify({
    version: 1,
    date,
    generatedAt: `${date}T12:00:00.000Z`,
    metrics,
    ...overrides,
  }));
}

test("uses the dashboard factory metrics directory by default", () => {
  assert.equal(defaultMetricsRoot("/repo"), "/repo/dashboard/backend/data/factory/_metrics");
});

test("missing or empty history returns the documented empty state", () => {
  const missing = buildFactoryReportSnapshot({ hqRoot: "/does-not-exist", now: "2026-09-17T00:00:00.000Z" });
  assert.equal(missing.available, false);
  assert.equal(missing.reason, "no factory:report snapshots found — run npm run factory:report");
  assert.deepEqual(missing.metrics, []);

  const { metricsRoot } = fixture();
  assert.equal(buildFactoryReportSnapshot({ metricsRoot }).available, false);
});

test("reads a snapshot without recomputing its metric fields", () => {
  const { metricsRoot } = fixture();
  const input = metric({ value: 27, direction: "up", target: 0 });
  writeDay(metricsRoot, "2026-09-17", [input]);
  const result = buildFactoryReportSnapshot({ metricsRoot, now: "2026-09-17T20:00:00.000Z" });

  assert.equal(result.available, true);
  assert.equal(result.latest, "2026-09-17");
  assert.deepEqual(result.generatedDates, ["2026-09-17"]);
  assert.deepEqual(result.metrics[0], { ...input, series: [{ date: "2026-09-17", value: 27 }] });
});

test("merges latest fields by id and represents missing days as null gaps", () => {
  const { metricsRoot } = fixture();
  writeDay(metricsRoot, "2026-09-14", [metric({ value: 8, direction: "flat", target: 4 })]);
  writeDay(metricsRoot, "2026-09-15", [metric({ id: "other", group: "future", label: "Other", value: 1 })]);
  writeDay(metricsRoot, "2026-09-16", [metric({ value: 6, direction: "down", target: 2 })]);

  const result = buildFactoryReportSnapshot({ metricsRoot });
  const reviewer = result.metrics.find((item) => item.id === "no-verdict.reviewer");
  assert.equal(reviewer.value, 6);
  assert.equal(reviewer.direction, "down");
  assert.equal(reviewer.target, 2);
  assert.deepEqual(reviewer.series, [
    { date: "2026-09-14", value: 8 },
    { date: "2026-09-15", value: null },
    { date: "2026-09-16", value: 6 },
  ]);
});

test("a metric that disappears keeps its last supplied fields", () => {
  const { metricsRoot } = fixture();
  writeDay(metricsRoot, "2026-09-14", [metric({ value: 5, label: "Last known reviewer" })]);
  writeDay(metricsRoot, "2026-09-15", []);
  const result = buildFactoryReportSnapshot({ metricsRoot });
  assert.equal(result.metrics[0].label, "Last known reviewer");
  assert.equal(result.metrics[0].value, 5);
  assert.deepEqual(result.metrics[0].series.at(-1), { date: "2026-09-15", value: null });
});

test("limits history to the newest 14 dated files and ignores unrelated names", () => {
  const { metricsRoot } = fixture();
  for (let day = 1; day <= 16; day += 1) {
    const date = `2026-09-${String(day).padStart(2, "0")}`;
    writeDay(metricsRoot, date, [metric({ value: day })]);
  }
  writeFileSync(join(metricsRoot, "latest.json"), "not a dated snapshot");
  writeFileSync(join(metricsRoot, "2026-09-17.txt"), "not a JSON snapshot");
  const result = buildFactoryReportSnapshot({ metricsRoot });
  assert.equal(result.generatedDates.length, 14);
  assert.equal(result.generatedDates[0], "2026-09-03");
  assert.equal(result.latest, "2026-09-16");
  assert.equal(result.metrics[0].series.length, 14);
});

test("corrupt, malformed, and future-version days degrade to gaps", () => {
  const { metricsRoot } = fixture();
  writeDay(metricsRoot, "2026-09-14", [metric({ value: 9 })]);
  writeFileSync(join(metricsRoot, "2026-09-15.json"), "{ broken");
  writeDay(metricsRoot, "2026-09-16", [metric({ value: 7 })], { version: 2 });
  writeDay(metricsRoot, "2026-09-17", null);
  const result = buildFactoryReportSnapshot({ metricsRoot });

  assert.equal(result.available, true);
  assert.deepEqual(result.metrics[0].series.map((point) => point.value), [9, null, null, null]);
  assert.equal(result.warnings.length, 3);
  assert.match(result.warnings.join("\n"), /unreadable/);
  assert.match(result.warnings.join("\n"), /unsupported version 2/);
  assert.match(result.warnings.join("\n"), /no metrics array/);
});

test("entries without a usable id are skipped instead of becoming merge keys", () => {
  const { metricsRoot } = fixture();
  writeDay(metricsRoot, "2026-09-17", [{ value: 1 }, metric()]);
  const result = buildFactoryReportSnapshot({ metricsRoot });
  assert.equal(result.metrics.length, 1);
  assert.match(result.warnings[0], /without an id/);
});
