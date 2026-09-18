import { computeReportMetrics } from "./metrics.mjs";

export function buildFactoryReportSnapshot(input, { now = new Date().toISOString() } = {}) {
  const parsed = new Date(now);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`Invalid report time: ${now}`);
  const date = parsed.toISOString().slice(0, 10);
  return {
    version: 1,
    date,
    // Day precision is intentional: unchanged inputs must produce identical
    // bytes on repeated runs, including the generatedAt contract field.
    generatedAt: `${date}T00:00:00.000Z`,
    metrics: computeReportMetrics(input),
  };
}
