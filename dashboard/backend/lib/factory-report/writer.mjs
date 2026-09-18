import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Stable snapshot contract consumed directly by the dashboard:
// { version, date, generatedAt, metrics: [{ id, group, label, unit, value,
//   direction, target, sourcePath: string[], reason: string|null }] }
// Metrics are already id-sorted by the pure builder. The temporary sibling is
// renamed atomically, and this is the report command's only write path.
export function writeFactoryReportSnapshot({ stateRoot, snapshot }) {
  const path = resolve(stateRoot, "_metrics", `${snapshot.date}.json`);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  return path;
}
