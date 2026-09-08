// Turn one founder objective into a dependency-aware task graph.
//
// A configured planning agent is asked, in ONE call, to split the
// objective into build sub-tasks with explicit dependencies. Every sub-task is
// validated as a real factory task contract; the graph is validated as a DAG.
// The orchestrator then runs it. An integration node that depends on all build
// nodes is added automatically — the model does not design it.

import { execFile } from "child_process";
import { promisify } from "util";
import { resolve, join } from "path";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { setTimeout as delay } from "timers/promises";
import { sanitizeExcerpt } from "../common/redact.mjs";
import { randomUUID } from "crypto";
import { validateTaskContract } from "../task-workflow.mjs";
import { assertAcyclic } from "./graph.mjs";

const execFileAsync = promisify(execFile);

// MVP: nodes are build tasks. Integration + independent review/QA/security are
// added by the orchestrator, not the model.
const BUILD_ROLES = new Set(["backend-builder", "frontend-builder"]);
const WORK_TYPES = new Set(["ui", "backend", "architecture", "bugfix", "research", "ops"]);
const RISKS = new Set(["low", "medium", "high"]);

const HARNESS_FOR_ROLE = { "backend-builder": "codex", "frontend-builder": "frontend" };

export function buildDecomposeInvocation({ agentId = "main", objectiveId, prompt }) {
  const sessionKey = `agent:${agentId}:factory-decompose-${objectiveId}`;
  return {
    bin: "openclaw",
    sessionKey,
    args: ["agent", "--agent", agentId, "--session-key", sessionKey, "--message", prompt, "--json", "--timeout", "900"],
  };
}

export function decompositionError(error) {
  // execFile's message embeds its full command; never persist the founder prompt.
  const detail = error?.stderr?.trim() || error?.stdout?.trim()
    || (error?.killed ? `process killed (${error.signal || "timeout"})` : error?.code)
    || error?.message || String(error);
  const safe = sanitizeExcerpt(detail, { maxLength: 1800 }).text;
  const failure = new Error(`decomposition call failed: ${safe}`);
  failure.transient = /network connection|fetch failed|idle timeout|timed out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|rate.?limit|429|quota|temporarily unavailable|overloaded|usage limit/i.test(safe);
  return failure;
}

export async function executeDecomposition({ prompt, repo, objectiveId, agentId = "main", run = execFileAsync, wait = delay }) {
  const dir = mkdtempSync(join(tmpdir(), "factory-decompose-"));
  const messageFile = join(dir, "prompt.txt");
  writeFileSync(messageFile, prompt, { mode: 0o600 });
  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let stdout;
      try {
        ({ stdout } = await run("openclaw", [
          "agent", "--agent", agentId, "--session-key", `agent:${agentId}:factory-decompose-${objectiveId}`,
          "--message-file", messageFile, "--json", "--timeout", "900",
        ], { cwd: resolve(repo), timeout: 16 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }));
      } catch (error) {
        const failure = decompositionError(error);
        if (!failure.transient || attempt === 3) throw failure;
        await wait(attempt * 15_000);
        continue;
      }
      const envelope = JSON.parse(stdout);
      if (envelope.status !== "ok") {
        const failure = decompositionError(new Error(envelope.summary || envelope.status || "unsuccessful response"));
        if (!failure.transient || attempt === 3) throw failure;
        await wait(attempt * 15_000);
        continue;
      }
      const text = envelope.result?.payloads?.map((p) => p.text).filter(Boolean).join("\n");
      if (!text) throw new Error("decomposition returned no text");
      return text;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function buildPrompt({ objective, project, repo, objectiveId }) {
  return [
    "You are the Chief of Staff for a software factory. Split ONE founder objective into",
    "the SMALLEST set of build sub-tasks that can be implemented in parallel where safe.",
    "",
    "Rules:",
    "- Planning only: return the JSON graph. Do not dispatch agents, start objectives, edit files, or execute the proposed tasks.",
    "- 1 to 4 nodes. Prefer 2 (e.g. one backend, one frontend) when the objective spans both.",
    "- Only these roles: backend-builder, frontend-builder.",
    "- `dependsOn` lists node ids that must fully finish (pass review/QA/security) before this one starts. Independent nodes have [].",
    "- Do NOT create review/qa/security/integration/release nodes — those run automatically after your build nodes.",
    "- acceptanceCriteria must be observable and include the relevant automated check.",
    "- risk: low | medium | high per the repository operating rules.",
    "- If the objective is investigative or open-ended (\"find the bottleneck\", \"improve X\",",
    "  \"make Y easier\"), still produce concrete build nodes: put the investigation in a node's",
    "  `constraints` (e.g. \"first inspect factory/lib/objective/ and the dashboard for the slow",
    "  path, then implement the smallest fix\"). The builder does the analysis inside its stage.",
    "- When the repository IS this factory itself, treat it like any other codebase: real files,",
    "  real tests, a normal PR. Do not add a self-modification shortcut.",
    "",
    "Return ONLY a JSON object, no prose, no code fence:",
    '{ "nodes": [ { "id": "<lowercase-slug>", "role": "backend-builder|frontend-builder",',
    '  "objective": "<one sentence>", "acceptanceCriteria": ["..."], "workType": "backend|ui|bugfix|ops",',
    '  "risk": "low|medium|high", "dependsOn": ["<id>"],',
    '  "expectedOutputs": ["..."], "constraints": ["..."] } ] }',
    "",
    `Objective id: ${objectiveId}`,
    `Project: ${project}`,
    `Repository: ${repo}`,
    "",
    "Founder objective:",
    objective.trim(),
  ].join("\n");
}

function extractJsonObject(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("decomposition did not return a JSON object");
  try { return JSON.parse(cleaned.slice(start, end + 1)); }
  catch (error) { throw new Error(`decomposition returned invalid JSON: ${error.message}`); }
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

function normalise({ parsed, objective, project, repo, objectiveId, now }) {
  if (!parsed || !Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
    throw new Error("decomposition must contain a non-empty `nodes` array");
  }
  if (parsed.nodes.length > 4) throw new Error(`decomposition produced ${parsed.nodes.length} nodes; the MVP cap is 4`);

  const rawIds = parsed.nodes.map((n) => String(n?.id || ""));
  if (new Set(rawIds).size !== rawIds.length) throw new Error("duplicate node ids in decomposition");

  const nodeId = (raw) => `${objectiveId}-${raw}`;
  const nodes = {};
  for (const raw of parsed.nodes) {
    const rid = String(raw.id || "");
    if (!SLUG.test(rid)) throw new Error(`node id "${rid}" is not a lowercase slug`);
    if (!BUILD_ROLES.has(raw.role)) throw new Error(`node "${rid}" role "${raw.role}" not supported (backend-builder | frontend-builder)`);
    if (!WORK_TYPES.has(raw.workType)) throw new Error(`node "${rid}" workType "${raw.workType}" invalid`);
    if (!RISKS.has(raw.risk)) throw new Error(`node "${rid}" risk "${raw.risk}" invalid`);

    const id = nodeId(rid);
    const contract = validateTaskContract({
      id,
      issue: `local:${id}`,
      outcome: String(raw.objective || "").trim(),
      acceptanceCriteria: Array.isArray(raw.acceptanceCriteria) ? raw.acceptanceCriteria : [],
      project,
      workType: raw.workType,
      risk: raw.risk,
      preferredBuilder: HARNESS_FOR_ROLE[raw.role] || "auto",
      constraints: Array.isArray(raw.constraints) ? raw.constraints : [],
    });

    nodes[id] = {
      id,
      role: raw.role,
      harness: HARNESS_FOR_ROLE[raw.role] || "auto",
      dependsOn: (raw.dependsOn || []).map((d) => nodeId(String(d))),
      expectedOutputs: Array.isArray(raw.expectedOutputs) ? raw.expectedOutputs : [],
      contract,
      status: "pending",
      statePath: null,
      branch: `factory/${id}`,
      worktree: null,
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      blocker: null,
    };
  }

  assertAcyclic(nodes);
  if (!Object.values(nodes).some((n) => BUILD_ROLES.has(n.role))) {
    throw new Error("decomposition has no build node");
  }

  const integrationId = `${objectiveId}-integration`;
  return {
    version: 1,
    objectiveId,
    objective: objective.trim(),
    project,
    repo,
    status: "active",
    createdAt: now(),
    updatedAt: now(),
    nodes,
    integration: {
      id: integrationId,
      dependsOn: Object.keys(nodes),
      status: "pending",
      statePath: null,
      branch: `factory/integration-${objectiveId}`,
      worktree: null,
      startedAt: null,
      finishedAt: null,
      mergeLog: [],
      githubPublish: null,
      blocker: null,
    },
    events: [{ at: now(), type: "objective-decomposed", detail: `${Object.keys(nodes).length} build node(s)` }],
  };
}

export async function decomposeObjective({ hqRoot, objective, project, repo, decomposeAgentId = "main", execute = executeDecomposition, now = () => new Date().toISOString() }) {
  if (!objective || !String(objective).trim()) throw new Error("decompose requires an objective");
  if (!project || !String(project).trim()) throw new Error("decompose requires a project key");
  if (!repo) throw new Error("decompose requires a repo path");
  const objectiveId = `obj-${randomUUID().slice(0, 8)}`;
  const resolvedRepo = resolve(repo);
  const prompt = buildPrompt({ objective, project, repo: resolvedRepo, objectiveId });
  const raw = await execute({ prompt, repo: resolvedRepo, objectiveId, agentId: decomposeAgentId });
  return normalise({ parsed: extractJsonObject(raw), objective, project, repo: resolvedRepo, objectiveId, now });
}

// Exposed for tests that want to validate a graph without a model call.
export function buildObjectiveStateFromNodes({ objective, project, repo, nodes, objectiveId = `obj-${randomUUID().slice(0, 8)}`, now = () => new Date().toISOString() }) {
  return normalise({ parsed: { nodes }, objective, project, repo: resolve(repo), objectiveId, now });
}
