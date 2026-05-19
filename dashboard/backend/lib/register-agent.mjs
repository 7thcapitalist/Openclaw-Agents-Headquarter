import { readFileSync, existsSync } from "fs";
import { agentKey, configPath } from "./paths.mjs";

/**
 * @param {string} root
 * @param {string} project
 * @param {string} id
 * @param {import("better-sqlite3").Database} db
 */
export function registerAgent(root, project, id, db) {
  const path = configPath(root, project, id);
  if (!existsSync(path)) {
    throw new Error(`Missing config: ${path}`);
  }
  const config = JSON.parse(readFileSync(path, "utf8"));
  const key = agentKey(project, id);
  const now = new Date().toISOString();
  const tools = JSON.stringify(config.tools ?? []);
  const req = JSON.stringify(config.requiresApproval ?? []);

  db.prepare(
    `INSERT INTO agents (
      agent_key, project, id, name, description, type, status, schedule,
      entrypoint, working_directory, tools_json, requires_approval_json,
      logs_path, outputs_path, created_at, owner, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_key) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      type = excluded.type,
      status = excluded.status,
      schedule = excluded.schedule,
      entrypoint = excluded.entrypoint,
      working_directory = excluded.working_directory,
      tools_json = excluded.tools_json,
      requires_approval_json = excluded.requires_approval_json,
      logs_path = excluded.logs_path,
      outputs_path = excluded.outputs_path,
      created_at = excluded.created_at,
      owner = excluded.owner,
      updated_at = excluded.updated_at`
  ).run(
    key,
    project,
    id,
    config.name ?? id,
    config.description ?? "",
    config.type ?? "manual",
    config.status ?? "inactive",
    config.schedule ?? null,
    config.entrypoint ?? "./run.sh",
    config.workingDirectory ?? "",
    tools,
    req,
    config.logsPath ?? "./logs/latest.log",
    config.outputsPath ?? "./outputs",
    config.createdAt ?? now.slice(0, 10),
    config.owner ?? "",
    now
  );
  return key;
}
