import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { STAGES } from "../../../../factory/lib/task-workflow.mjs";
import { readObjectiveDatabase } from "./sqlite-reader.mjs";

export function discoverFactoryReportInputs({ stateRoot, hqRoot }) {
  const root = resolve(stateRoot);
  const objectives = [];
  const dispatches = [];
  const objectiveIssues = [];
  const resultIssues = [];

  if (!existsSync(root)) {
    objectiveIssues.push({ path: display(root, hqRoot), reason: "factory state root does not exist" });
    resultIssues.push({ path: display(root, hqRoot), reason: "factory state root does not exist" });
    return { objectives, dispatches, objectiveIssues, resultIssues };
  }

  for (const project of dirs(root).filter((entry) => entry.name !== "_metrics")) {
    const projectRoot = resolve(root, project.name);
    const objectivesRoot = resolve(projectRoot, "objectives");
    for (const objectiveDir of dirs(objectivesRoot)) {
      const dbPath = resolve(objectivesRoot, objectiveDir.name, "objective-state.sqlite");
      const shown = display(dbPath, hqRoot);
      if (!existsSync(dbPath)) {
        objectiveIssues.push({ path: shown, reason: "objective database is missing" });
        continue;
      }
      try {
        const { state, events } = readObjectiveDatabase(dbPath);
        const rawNodes = Object.values(state.nodes || {});
        if (state.integration) rawNodes.push(state.integration);
        objectives.push({
          id: state.objectiveId || objectiveDir.name,
          status: String(state.status || "").toLowerCase(),
          createdAt: state.createdAt || null,
          events,
          path: shown,
          nodes: rawNodes.filter(Boolean).map((node) => ({
            id: node.id,
            status: node.status,
            attempts: node.attempts,
            startedAt: node.startedAt,
            blocker: node.blocker || null,
            sourcePath: shown,
          })).filter((node) => node.id),
        });
      } catch (error) {
        objectiveIssues.push({ path: shown, reason: error.message });
      }
    }

    const tasksRoot = resolve(projectRoot, "tasks");
    for (const taskDir of dirs(tasksRoot)) {
      const resultsRoot = resolve(tasksRoot, taskDir.name, "results");
      if (!existsSync(resultsRoot)) continue;
      let entries;
      try {
        entries = readdirSync(resultsRoot, { withFileTypes: true });
      } catch (error) {
        resultIssues.push({ path: display(resultsRoot, hqRoot), reason: error.message });
        continue;
      }
      const escaped = escapeRegExp(taskDir.name);
      const pattern = new RegExp(`^${escaped}-(${STAGES.join("|")})-(\\d+)\\.json$`);
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile()) continue;
        const match = entry.name.match(pattern);
        if (!match) continue;
        const path = resolve(resultsRoot, entry.name);
        const shown = display(path, hqRoot);
        try {
          dispatches.push({
            taskId: taskDir.name,
            stage: match[1],
            attempt: Number(match[2]),
            path: shown,
            content: readFileSync(path, "utf8"),
            mtimeMs: statSync(path).mtimeMs,
          });
        } catch (error) {
          resultIssues.push({ path: shown, reason: error.message });
        }
      }
    }
  }

  // Absence is itself unavailable input, not a measured zero. Point at the
  // exact root inspected so every null metric still carries a hand-checkable
  // source location.
  if (objectives.length === 0 && objectiveIssues.length === 0) {
    objectiveIssues.push({ path: display(root, hqRoot), reason: "no objective-state.sqlite databases were found" });
  }
  if (dispatches.length === 0 && resultIssues.length === 0) {
    resultIssues.push({ path: display(root, hqRoot), reason: "no dispatch result files were found" });
  }

  objectives.sort((a, b) => a.path.localeCompare(b.path));
  dispatches.sort((a, b) => a.path.localeCompare(b.path));
  objectiveIssues.sort((a, b) => a.path.localeCompare(b.path));
  resultIssues.sort((a, b) => a.path.localeCompare(b.path));
  return { objectives, dispatches, objectiveIssues, resultIssues };
}

function dirs(path) {
  if (!existsSync(path)) return [];
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function display(path, hqRoot) {
  const absolute = resolve(path);
  const base = resolve(hqRoot);
  const rel = relative(base, absolute);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) ? rel.split(sep).join("/") : absolute;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
