#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildFactoryReport } from "../dashboard/backend/lib/factory-report/engine.mjs";
import { writeFactoryReportSnapshot } from "../dashboard/backend/lib/factory-report/writer.mjs";

const hqRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateRoot = resolve(readOption("state-root") || resolve(hqRoot, "dashboard", "backend", "data", "factory"));

try {
  const snapshot = buildFactoryReport({ hqRoot, stateRoot });
  const path = writeFactoryReportSnapshot({ stateRoot, snapshot });
  const unavailable = snapshot.metrics.filter((metric) => metric.value === null);
  console.log(`Factory report written to ${path}`);
  if (unavailable.length) {
    console.error(`Factory report incomplete: ${unavailable.length} metric(s) are null.`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Factory report failed: ${error.message}`);
  process.exitCode = 1;
}

function readOption(name) {
  const exact = `--${name}`;
  const prefixed = `${exact}=`;
  const index = process.argv.findIndex((arg) => arg === exact || arg.startsWith(prefixed));
  if (index < 0) return null;
  const arg = process.argv[index];
  if (arg.startsWith(prefixed)) return arg.slice(prefixed.length);
  return process.argv[index + 1] || null;
}
