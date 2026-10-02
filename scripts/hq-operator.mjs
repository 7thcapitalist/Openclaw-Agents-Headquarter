#!/usr/bin/env node
// The operator's client for the Headquarters dashboard. Speaks only to the
// operator allowlist in dashboard/backend/lib/operatorAuth.mjs, prints JSON,
// and never prints the token.
//
//   hq-operator.mjs projects
//   hq-operator.mjs status
//   hq-operator.mjs submit --project <id> --objective <text> [--issue <n>] --key <idempotency-key>
//   hq-operator.mjs job <jobId>
//   hq-operator.mjs task <taskId> evidence|report|timeline
//
// The token is read from the file named by HQ_OPERATOR_TOKEN_FILE. Nothing
// here runs a shell or accepts a URL: the target is http://127.0.0.1:3211.

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BASE_URL = "http://127.0.0.1:3211";
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const TASK_VIEWS = new Set(["evidence", "report", "timeline"]);
const USAGE = [
  "usage:",
  "  hq-operator.mjs projects",
  "  hq-operator.mjs status",
  "  hq-operator.mjs submit --project <id> --objective <text> [--issue <n>] --key <idempotency-key>",
  "  hq-operator.mjs job <jobId>",
  "  hq-operator.mjs task <taskId> evidence|report|timeline",
].join("\n");

class UsageError extends Error {}

export function readToken(env = process.env) {
  const path = env.HQ_OPERATOR_TOKEN_FILE;
  if (!path) throw new UsageError("Set HQ_OPERATOR_TOKEN_FILE to the file holding the operator token.");
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`Token file ${path} is readable by other users (mode ${mode.toString(8)}); chmod 600 it.`);
  const token = readFileSync(path, "utf8").trim();
  if (!token) throw new Error(`Token file ${path} is empty.`);
  return token;
}

function parseFlags(args, allowed) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const name = arg.startsWith("--") ? arg.slice(2) : null;
    if (!name || !allowed.has(name)) throw new UsageError(`Unexpected argument: ${arg}\n${USAGE}`);
    const value = args[i + 1];
    if (value === undefined) throw new UsageError(`--${name} needs a value.`);
    flags[name] = value;
    i += 1;
  }
  return flags;
}

// argv -> the one request it maps to, or a UsageError. Pure, so the mapping can
// be tested without a server.
export function planRequest(argv) {
  const [command, ...args] = argv;
  if (command === "projects" || command === "status") {
    if (args.length) throw new UsageError(USAGE);
    return { method: "GET", path: "/api/founder/overview", view: command };
  }
  if (command === "job") {
    if (args.length !== 1 || !ID.test(args[0])) throw new UsageError(USAGE);
    return { method: "GET", path: "/api/founder/overview", view: "job", jobId: args[0] };
  }
  if (command === "task") {
    const [taskId, view, ...extra] = args;
    if (extra.length || !ID.test(taskId || "") || !TASK_VIEWS.has(view)) throw new UsageError(USAGE);
    return { method: "GET", path: `/api/founder/tasks/${taskId}/${view}` };
  }
  if (command === "submit") {
    const flags = parseFlags(args, new Set(["project", "objective", "issue", "key"]));
    if (!flags.project || !flags.objective || !flags.key) throw new UsageError(USAGE);
    const body = { projectId: flags.project, objective: flags.objective };
    if (flags.issue !== undefined) body.issue = flags.issue;
    return { method: "POST", path: "/api/founder/tasks", body, idempotencyKey: flags.key };
  }
  throw new UsageError(USAGE);
}

// The server already trims the overview for an operator (operatorViews.mjs);
// each subcommand prints the part it is about.
const LIVE_OBJECTIVE = new Set(["pending", "active", "running", "recovering", "blocked"]);

export function shapeResponse(plan, body) {
  if (plan.view === "projects") return { projects: body?.projects || [] };
  if (plan.view === "status") {
    return {
      jobs: (body?.jobs || []).slice(0, 10),
      objectives: (body?.objectives || []).filter((objective) => LIVE_OBJECTIVE.has(objective.status)),
    };
  }
  if (plan.view === "job") {
    const job = (body?.jobs || []).find((item) => item.id === plan.jobId);
    return job ? { job } : { error: `No job ${plan.jobId}.` };
  }
  return body;
}

export async function run(argv, { env = process.env, fetchImpl = fetch, baseUrl = BASE_URL } = {}) {
  const plan = planRequest(argv);
  const token = readToken(env);
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (plan.body) headers["Content-Type"] = "application/json";
  if (plan.idempotencyKey) headers["Idempotency-Key"] = plan.idempotencyKey;
  const response = await fetchImpl(`${baseUrl}${plan.path}`, {
    method: plan.method,
    headers,
    body: plan.body ? JSON.stringify(plan.body) : undefined,
    redirect: "error",
  });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) return { ok: false, status: response.status, body };
  return { ok: true, status: response.status, body: shapeResponse(plan, body) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2))
    .then((result) => {
      console.log(JSON.stringify(result.ok ? result.body : { status: result.status, ...(result.body || {}) }, null, 2));
      if (!result.ok) process.exit(1);
    })
    .catch((error) => {
      // Only the message: a fetch error's cause can carry request details.
      console.error(String(error instanceof UsageError ? error.message : `error: ${error.message || error}`));
      process.exit(2);
    });
}
