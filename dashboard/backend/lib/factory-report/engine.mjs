import { resolve } from "node:path";
import { buildFactoryReportSnapshot } from "../../../../factory/lib/hq/report/snapshot.mjs";
import { discoverFactoryReportInputs } from "./discovery.mjs";

export function buildFactoryReport({ hqRoot, stateRoot = null, now = new Date().toISOString() }) {
  const root = resolve(stateRoot || resolve(hqRoot, "dashboard", "backend", "data", "factory"));
  const input = discoverFactoryReportInputs({ stateRoot: root, hqRoot });
  return buildFactoryReportSnapshot(input, { now });
}
