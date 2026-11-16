// The guard an operator's POST /api/founder/tasks goes through before it is
// allowed to start anything. The founder's own route stays as it was; an
// operator gets a narrower one:
//
//   - no `repo` (the founder route accepts any path on disk) and no
//     `allowDuplicate` (the founder's escape hatch). The repo comes from
//     factory/projects.json and nowhere else.
//   - a required Idempotency-Key, so a retried submission never starts a
//     second build. Same key + same body replays the original response;
//     same key + a different body is 409.
//   - nothing starts while any founder job is live by canonical state, and the
//     existing duplicate check runs with no bypass.
//   - at most OPERATOR_DAILY_CAP accepted submissions per rolling 24h, across
//     all operators: the cap protects the seats, which are shared.
//
// High-risk work is not special-cased here, on purpose: the operator launches
// through the same `start` request the founder's route sends, with a fixed set
// of fields, so the workflow's founder-approval gate (Ed25519 assertion before
// builder) applies unchanged. Nothing an operator sends can reach that gate.

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  duplicateJobError,
  findCanonicallyActiveJob,
  findInFlightDuplicateJob,
  isProjectPaused,
  resolveProjectRepo,
} from "./founderControlPlane.mjs";

export const OPERATOR_DAILY_CAP = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const LEDGER_RETENTION_MS = 7 * DAY_MS;
const MAX_OBJECTIVE_CHARS = 8000;
const ALLOWED_FIELDS = new Set(["projectId", "objective", "issue"]);
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

export function operatorLedgerPath(root) {
  return join(root, "dashboard", "backend", "data", "factory", "operator-submissions.json");
}

function readLedger(root) {
  const path = operatorLedgerPath(root);
  if (!existsSync(path)) return { version: 1, submissions: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return { version: 1, submissions: Array.isArray(parsed?.submissions) ? parsed.submissions : [] };
}

function writeLedger(root, ledger) {
  const path = operatorLedgerPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

// Key order must not make two identical bodies look different.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function bodyHash(body) {
  return createHash("sha256").update(canonicalJson(body ?? {})).digest("hex");
}

function readRegistryProject(root, projectId) {
  try {
    const registry = JSON.parse(readFileSync(join(root, "factory", "projects.json"), "utf8"));
    return (registry?.projects || []).find((project) => project.key === projectId) || null;
  } catch {
    return null;
  }
}

function reject(status, reason, error, extra = {}) {
  return { status, body: { error, reason, ...extra } };
}

/**
 * Decide an operator's task submission. Synchronous from the first check to
 * the ledger write, so two concurrent requests cannot both pass the key, busy
 * or cap checks.
 *
 * @param {object} options
 * @param {string} options.root
 * @param {{id: string, actor: string}} options.operator
 * @param {object} options.body
 * @param {string|undefined} options.idempotencyKey
 * @param {(input: {projectId, objective, repo, issue, submittedBy, requestId}) => object} options.launch
 *        Creates and saves the founder job, starts the work, returns the job.
 * @returns {{status: number, body: object, headers?: object}}
 */
export function decideOperatorSubmission({ root, operator, body, idempotencyKey, launch, now = Date.now() }) {
  const input = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  if (!input) return reject(400, "invalid_body", "Send a JSON object.");
  if (Object.hasOwn(input, "repo")) return reject(400, "repo_not_allowed", "Operators cannot choose a repo; it is resolved from the project registry.");
  if (Object.hasOwn(input, "allowDuplicate")) return reject(400, "allow_duplicate_not_allowed", "Operators cannot bypass the duplicate check.");
  const unknown = Object.keys(input).find((key) => !ALLOWED_FIELDS.has(key));
  if (unknown) return reject(400, "unknown_field", `Unsupported field: ${unknown}.`);

  const key = typeof idempotencyKey === "string" ? idempotencyKey.trim() : "";
  if (!key) return reject(400, "idempotency_key_required", "An Idempotency-Key header is required.");
  if (!IDEMPOTENCY_KEY.test(key)) return reject(400, "idempotency_key_invalid", "Idempotency-Key must be 8-128 characters of A-Z a-z 0-9 . _ : -");

  const hash = bodyHash(input);
  const ledger = readLedger(root);
  const prior = ledger.submissions.find((entry) => entry.key === key);
  if (prior) {
    if (prior.principal !== operator.actor || prior.bodyHash !== hash) {
      return reject(409, "idempotency_key_reused", "This Idempotency-Key was already used for a different request.");
    }
    return { status: prior.statusCode, body: prior.response, headers: { "Idempotent-Replay": "true" } };
  }

  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  const objective = typeof input.objective === "string" ? input.objective.trim() : "";
  if (!projectId) return reject(400, "project_required", "projectId is required.");
  if (!objective) return reject(400, "objective_required", "objective is required.");
  if (objective.length > MAX_OBJECTIVE_CHARS) return reject(400, "objective_too_long", `objective is limited to ${MAX_OBJECTIVE_CHARS} characters.`);
  let issue;
  if (input.issue !== undefined && input.issue !== null) {
    if (!/^[1-9]\d{0,8}$/.test(String(input.issue))) return reject(400, "invalid_issue", "issue must be a positive issue number.");
    issue = Number(input.issue);
  }

  const project = readRegistryProject(root, projectId);
  if (!project) return reject(400, "unknown_project", `No registered project "${projectId}" in factory/projects.json.`);
  if (project.status === "paused" || isProjectPaused(root, projectId)) return reject(409, "project_paused", "This project is paused.");
  if (project.status && project.status !== "active") return reject(409, "project_not_active", `This project is ${project.status}.`);
  const repo = resolveProjectRepo(root, projectId);
  if (!repo || !existsSync(join(repo, ".git"))) return reject(400, "project_repo_unavailable", "The registered repo for this project is not a git working tree.");

  const recent = ledger.submissions.filter((entry) => entry.accepted && now - (Date.parse(entry.createdAt) || 0) < DAY_MS);
  if (recent.length >= OPERATOR_DAILY_CAP) {
    const oldest = Math.min(...recent.map((entry) => Date.parse(entry.createdAt) || now));
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + DAY_MS - now) / 1000));
    return { ...reject(429, "daily_cap_reached", `Operators may submit ${OPERATOR_DAILY_CAP} tasks per 24 hours.`, { retryAfterSeconds }), headers: { "Retry-After": String(retryAfterSeconds) } };
  }

  const active = findCanonicallyActiveJob(root, { now });
  if (active) {
    const { job, liveness } = active;
    return {
      status: 409,
      body: {
        status: "busy",
        reason: "factory_busy",
        activeJob: { id: job.id, kind: job.kind || null, projectId: job.projectId || null, status: job.status, objectiveId: job.objectiveId || null, taskId: job.taskId || null, createdAt: job.createdAt || null, canonical: liveness },
      },
    };
  }
  const duplicate = findInFlightDuplicateJob(root, { projectId, objective, now });
  if (duplicate) {
    const err = duplicateJobError(duplicate);
    return reject(409, "duplicate_request", err.message, { duplicateOf: err.duplicateOf });
  }

  const requestId = randomUUID();
  const job = launch({ projectId, objective, repo, issue, submittedBy: operator.actor, requestId });
  const response = {
    requestId,
    jobId: job.id,
    status: job.status,
    ...(job.objectiveId ? { objectiveId: job.objectiveId } : {}),
    ...(job.taskId ? { taskId: job.taskId } : {}),
  };
  ledger.submissions = ledger.submissions.filter((entry) => now - (Date.parse(entry.createdAt) || 0) < LEDGER_RETENTION_MS);
  ledger.submissions.push({
    key, principal: operator.actor, bodyHash: hash, requestId, jobId: job.id, accepted: true,
    statusCode: 202, response, createdAt: new Date(now).toISOString(),
  });
  writeLedger(root, ledger);
  return { status: 202, body: response };
}
