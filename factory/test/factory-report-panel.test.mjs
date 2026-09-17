import test from "node:test";
import assert from "node:assert/strict";
import { factoryHealthPanel } from "../../dashboard/backend/public/lib/factoryHealthView.mjs";

function metric(overrides = {}) {
  return {
    id: "objectives-complete.overall",
    group: "objectives-complete",
    label: "Objectives complete",
    unit: "fraction",
    value: 0.75,
    direction: "up",
    target: 0.9,
    sourcePath: ["dashboard/backend/data/factory/project/objectives"],
    reason: null,
    series: [
      { date: "2026-09-14", value: 0.5 },
      { date: "2026-09-15", value: null },
      { date: "2026-09-16", value: 0.75 },
    ],
    ...overrides,
  };
}

const SNAPSHOT = {
  version: 1,
  available: true,
  generatedDates: ["2026-09-14", "2026-09-15", "2026-09-16"],
  latest: "2026-09-16",
  metrics: [metric()],
};

test("renders a quiet state for a failed fetch and missing snapshot history", () => {
  assert.match(factoryHealthPanel(undefined), /Factory health data is not available yet/);
  const html = factoryHealthPanel({ available: false, reason: "run the report", metrics: [] });
  assert.match(html, /Awaiting history/);
  assert.match(html, /run the report/);
});

test("renders current value, direction, target, source, and a gap-aware trend", () => {
  const html = factoryHealthPanel(SNAPSHOT);
  assert.match(html, />75%</);
  assert.match(html, /Direction: up/);
  assert.match(html, /Campaign target/);
  assert.match(html, />90%</);
  assert.match(html, /14-day trend/);
  assert.match(html, /factory-health-sparkline/);
  assert.match(html, /2 reported days, 1 gap/);
  assert.match(html, /dashboard\/backend\/data\/factory\/project\/objectives/);
  assert.equal((html.match(/<circle/g) || []).length, 2, "a null day must split the trend rather than interpolate it");
});

test("known groups use the required order and unknown groups are appended", () => {
  const groups = [
    ["future-quality", "Future"],
    ["wall-time-per-objective", "Wall"],
    ["founder-interruptions", "Interruptions"],
    ["no-verdict", "No verdict"],
    ["dispatches-per-merged-task", "Dispatches"],
    ["cycle-time", "Cycle"],
    ["objectives-complete", "Objectives"],
  ];
  const html = factoryHealthPanel({ ...SNAPSHOT, metrics: groups.map(([group, label], index) => metric({ id: `${group}.${index}`, group, label })) });
  const headings = [...html.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)].map((match) => match[1]);
  assert.deepEqual(headings, [
    "Objectives complete",
    "Dispatches per merged task",
    "No-verdict counts",
    "Founder interruptions",
    "Cycle time by stage",
    "Wall time per objective",
    "Future Quality",
  ]);
});

test("null metrics render an em dash and the supplied reason, never zero", () => {
  const html = factoryHealthPanel({ ...SNAPSHOT, metrics: [metric({ value: null, reason: "No merged objectives in the window" })] });
  assert.match(html, /factory-health-null/);
  assert.match(html, /No merged objectives in the window/);
  assert.doesNotMatch(html, /factory-health-sparkline/);
  assert.doesNotMatch(html, />0%</);
});

test("a malformed null metric gets an explicit fallback reason", () => {
  const html = factoryHealthPanel({ ...SNAPSHOT, metrics: [metric({ value: "", target: "", reason: "" })] });
  assert.match(html, /no reason given/);
  assert.match(html, /<dt>Campaign target<\/dt><dd>—<\/dd>/);
});

test("formats fractions, counts, ratios, and durations from supplied values", () => {
  const html = factoryHealthPanel({
    ...SNAPSHOT,
    metrics: [
      metric({ id: "fraction", label: "Fraction", value: 0.42, target: 0.5 }),
      metric({ id: "count", label: "Count", unit: "count", value: 7.4, target: 2 }),
      metric({ id: "ratio", label: "Ratio", unit: "ratio", value: 3.2, target: 1 }),
      metric({ id: "duration", label: "Duration", unit: "ms", value: 5_400_000, target: 3_600_000 }),
    ],
  });
  assert.match(html, />42%</);
  assert.match(html, />7</);
  assert.match(html, />3</);
  assert.match(html, />1\.5h</);
  assert.match(html, />1\.0h</);
});

test("normal, all-null, single-point, and constant series render without invalid geometry", () => {
  const variants = [
    metric(),
    metric({ id: "null-series", series: [{ date: "a", value: null }] }),
    metric({ id: "one", series: [{ date: "a", value: 2 }] }),
    metric({ id: "flat", series: [{ date: "a", value: 2 }, { date: "b", value: 2 }] }),
  ];
  const html = factoryHealthPanel({ ...SNAPSHOT, metrics: variants });
  assert.match(html, /No trend data/);
  assert.match(html, /<circle/);
  assert.match(html, /<polyline/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test("untrusted labels, reasons, source paths, and group names are escaped", () => {
  const payload = `<script>alert("x")</script>`;
  const html = factoryHealthPanel({
    ...SNAPSHOT,
    metrics: [metric({ id: "unsafe", group: payload, label: payload, value: null, reason: payload, sourcePath: [payload] })],
  });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /id="factory-health-<script/);
});
