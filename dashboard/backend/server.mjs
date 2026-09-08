import { createHash, timingSafeEqual } from "crypto";
import dotenv from "dotenv";
import express from "express";
import session from "express-session";
import { marked } from "marked";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";

import { openDb, logEvent } from "./lib/db.mjs";
import { pm2StatusMap } from "./lib/pm2.mjs";
import {
  labRoot,
  agentDir,
  agentKey,
  pm2Name,
  assertSafeSlug,
  configPath,
} from "./lib/paths.mjs";
import {
  tailLog,
  latestOutputFile,
  preferredMarkdownOutput,
} from "./lib/scan.mjs";
import {
  buildEnrichedAgents,
  buildNeedsAttention,
  buildHomeCards,
  buildProjectSummary,
  buildQuickActions,
  recentRunsRows,
  runDurationMs,
} from "./lib/commandCenter.mjs";
import { splitAgentKey } from "./lib/health.mjs";
import { registerAgent } from "./lib/register-agent.mjs";
import { runEntrypoint } from "./lib/runAgent.mjs";
import {
  collectArtifactsAfterRun,
  parseArtifactsJson,
} from "./lib/runArtifacts.mjs";
import {
  buildCommandCenter,
  readHqCollection,
  readHqState,
  readProject,
  readProjects,
  writeHqCollection,
  writeProject,
} from "./lib/hqStore.mjs";
import { SQLiteSessionStore } from "./lib/sessionStore.mjs";
import {
  formatZodError,
  parseCollectionForWrite,
  parseProjectForWrite,
} from "./lib/hqSchemas.mjs";
import { enrichHqAgentsWithLifecycle } from "./lib/agentLifecycle.mjs";
import { buildReadinessReport } from "./lib/readiness.mjs";
import {
  buildFounderOverview,
  buildObjectivesView,
  buildRolePolicy,
  discoverFactoryTasks,
  findObjectiveStatePath,
  findTaskStatePath,
  handleObjectiveRetry,
  isProjectPaused,
  listFounderJobs,
  readObjectiveReport,
  readTaskCompletionReport,
  readTaskEvidence,
  recordQuestion,
  resolveFounderDecision,
  resolveProjectRepo,
  resolveRepoInput,
  saveFounderJob,
  setObjectiveArchived,
  setProjectPaused,
} from "./lib/founderControlPlane.mjs";
import { buildHqCostsPayload, buildHqPlanLimitsPayload } from "./lib/hq-cost-limits.mjs";
import {
  enrollFounderKey,
  getEnrolledFounderKey,
  prepareFounderApproval,
  rejectFounderApproval,
  rekeyPendingApproval,
  submitFounderApproval,
} from "./lib/founderApproval.mjs";
import { readAutonomy } from "../../factory/lib/hq/autonomy.mjs";
import { retryStuckTasks } from "../../factory/lib/hq/auto-retry.mjs";
import { resumeState as resumeTaskState, readState as readTaskState, writeState as writeTaskState } from "../../factory/lib/task-workflow.mjs";
import { runToTerminal as runTaskToTerminal } from "../../factory/lib/openclaw-runner.mjs";
import { buildCompanyState } from "../../factory/lib/hq/company-state.mjs";
import { readLearningFindings } from "../../factory/lib/hq/chief-of-staff.mjs";
import { handleRequest as handleFactoryRequest } from "../../scripts/openclaw-factory.mjs";
import { decomposeObjective } from "../../factory/lib/objective/decompose.mjs";
import { runObjective } from "../../factory/lib/objective/orchestrator.mjs";
import { founderApprovalSetupBlocker } from "../../factory/lib/hq/blocker-class.mjs";
import { defaultStateRoot } from "../../factory/lib/natural-language-intake.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const ROOT = labRoot(process.env.AGENT_LAB_ROOT);
dotenv.config({ path: join(ROOT, ".env") });

const PORT = Number(process.env.DASHBOARD_PORT || 3000);
const HOST = process.env.DASHBOARD_HOST || "127.0.0.1";
const PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const SESSION_SECRET = process.env.DASHBOARD_SESSION_SECRET || "";
const TRUST_PROXY = process.env.DASHBOARD_TRUST_PROXY === "1";
const PLAN_LIMITS_SOURCE = parsePlanLimitsSource(process.env.DASHBOARD_PLAN_LIMITS_SOURCE_JSON);

function hashPass(p) {
  return createHash("sha256").update(p, "utf8").digest();
}

function passOk(input, secret) {
  if (!secret || !input) return false;
  try {
    const a = hashPass(input);
    const b = hashPass(secret);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function parsePlanLimitsSource(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const dataDir = join(__dirname, "data");
mkdirSync(dataDir, { recursive: true });
const db = openDb(dataDir);
const sessionStore = new SQLiteSessionStore(db);
sessionStore.pruneExpired();
setInterval(() => sessionStore.pruneExpired(), 60 * 60 * 1000).unref();

const app = express();
if (TRUST_PROXY) app.set("trust proxy", 1);

app.use(express.json({ limit: "2mb" }));
app.use(
  session({
    name: "agentlab.sid",
    secret: SESSION_SECRET || "unsafe-dev-only",
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.DASHBOARD_HTTPS === "1",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return res.redirect("/login.html");
}

function checkBootConfig() {
  if (!PASSWORD || !SESSION_SECRET) {
    console.warn(
      "[agent-lab] Set DASHBOARD_PASSWORD and DASHBOARD_SESSION_SECRET in ~/agent-lab/.env"
    );
  }
  if (SESSION_SECRET.length < 16) {
    console.warn("[agent-lab] DASHBOARD_SESSION_SECRET should be at least 16 characters.");
  }
}

/** @type {express.RequestHandler} */
function loginGate(req, res, next) {
  const publicPaths = new Set(["/login.html", "/login.js", "/styles.css"]);
  if (publicPaths.has(req.path) || req.path.startsWith("/api/auth/")) return next();
  if (req.path.startsWith("/assets/")) return next();
  if (!PASSWORD || !SESSION_SECRET) {
    if (req.path.startsWith("/api/")) {
      return res.status(503).json({
        error: "Dashboard not configured: set DASHBOARD_PASSWORD and DASHBOARD_SESSION_SECRET in .env",
      });
    }
    return res
      .status(503)
      .type("html")
      .send(
        "<p>Set <code>DASHBOARD_PASSWORD</code> and <code>DASHBOARD_SESSION_SECRET</code> in <code>~/agent-lab/.env</code>, then restart.</p>"
      );
  }
  return requireAuth(req, res, next);
}

app.use(loginGate);

app.post("/api/auth/login", (req, res) => {
  const body = req.body || {};
  const password = typeof body.password === "string" ? body.password : "";
  if (!PASSWORD) {
    return res.status(503).json({ error: "Password not configured on server" });
  }
  if (!passOk(password, PASSWORD)) {
    return res.status(401).json({ error: "Invalid password" });
  }
  req.session.authenticated = true;
  req.session.touch();
  return res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

marked.setOptions({ gfm: true, breaks: true });

app.get("/api/auth/me", (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

app.get("/api/founder/overview", (_req, res) => {
  try {
    const overview = buildFounderOverview(ROOT, readProjects(ROOT));
    res.json({ ...overview, jobs: listFounderJobs(ROOT) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Decomposed objectives + their live task graphs (factory/lib/objective/).
// Read-only, machine-readable.
app.get("/api/founder/objectives", (_req, res) => {
  try {
    res.json(buildObjectivesView(ROOT));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Headquarters Integration Layer — one read-only "state of the company" object.
// Additive: composes the unified project registry, the agent registry + live
// activity, founder decisions, risks, and (with ?github=1) read-only GitHub
// awareness. Writes nothing.
app.get("/api/hq/company", async (req, res) => {
  try {
    const withGithub = req.query.github === "1" || req.query.github === "true";
    const withRuntime = req.query.runtime === "1" || req.query.runtime === "true";
    const state = await buildCompanyState({
      hqRoot: ROOT,
      tasks: discoverFactoryTasks(ROOT),
      hqProjects: readProjects(ROOT),
      withGithub,
      withRuntime,
    });
    res.json(state);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Real, already-computed learning findings — the analysis pipeline in
// factory/lib/learning/ writes these; this route only reads what already
// exists (dashboard/backend/data/factory/_learning/findings.json + the
// committed factory/knowledge/ files). It generates nothing.
app.get("/api/hq/learning", (_req, res) => {
  try {
    res.json(readLearningFindings(ROOT));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/hq/costs", async (_req, res) => {
  try {
    res.json(await buildHqCostsPayload({ hqRoot: ROOT }));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/hq/plan-limits", async (_req, res) => {
  try {
    res.json(await buildHqPlanLimitsPayload({ hqRoot: ROOT, authoritativeSource: PLAN_LIMITS_SOURCE }));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/founder/projects", (req, res) => {
  try {
    const id = String(req.body?.id || "").trim();
    const name = String(req.body?.name || "").trim();
    const mission = String(req.body?.mission || "").trim();
    if (!id || !name || !mission) return res.status(400).json({ error: "id, name, and mission are required." });
    if (readProject(ROOT, id)) return res.status(409).json({ error: "Project already exists." });
    const project = parseProjectForWrite(id, {
      id, name, description: mission, mission, currentStatus: "Active", currentPhase: "Discovery",
      currentGoals: [], keyMetrics: [], mainWorkflows: [], existingAssets: [], currentBlockers: [],
      relatedAgents: [], approvalRules: [], nextRecommendedActions: [], projectCEO: "chief-of-staff",
      mainMetric: "Founder-defined outcome", bottleneck: "None recorded", latestReport: "No report yet",
      repoPath: resolveRepoInput(ROOT, req.body?.repoPath),
    });
    res.status(201).json({ project: writeProject(ROOT, id, project) });
  } catch (e) {
    res.status(400).json({ error: formatZodError(e) });
  }
});

app.post("/api/founder/projects/:id/:action", (req, res) => {
  try {
    const action = req.params.action;
    if (!new Set(["pause", "resume"]).has(action)) return res.status(400).json({ error: "Action must be pause or resume." });
    if (!readProject(ROOT, req.params.id) && !buildFounderOverview(ROOT, readProjects(ROOT)).projects.some((p) => p.id === req.params.id)) {
      return res.status(404).json({ error: "Project not found." });
    }
    res.json({ projectId: req.params.id, ...setProjectPaused(ROOT, req.params.id, action === "pause") });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// Resolve the repo path: an explicit body value (normalized against the HQ root,
// so "." / a relative path / "~" all behave like a registered project's `repo`),
// else the registered project's path (factory/projects.json) — so the founder
// can launch work by project name.
function resolveLaunchRepo(req, projectId) {
  return resolveRepoInput(ROOT, req.body?.repo) || resolveProjectRepo(ROOT, projectId);
}

app.post("/api/founder/tasks", (req, res) => {
  let job;
  try {
    const objective = String(req.body?.objective || "").trim();
    const projectId = String(req.body?.projectId || "").trim();
    const repo = resolveLaunchRepo(req, projectId) || "";
    if (!objective || !repo || !projectId) return res.status(400).json({ error: "objective and projectId are required (repo is auto-resolved for registered projects)." });
    if (isProjectPaused(ROOT, projectId)) return res.status(409).json({ error: "Resume this project before starting a task." });
    if (!existsSync(join(repo, ".git"))) return res.status(400).json({ error: `Not a git working tree: ${repo}` });
    const jobId = `founder-${Date.now().toString(36)}`;
    job = { id: jobId, kind: "task", projectId, objective, repo, status: "starting", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    saveFounderJob(ROOT, job);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
  handleFactoryRequest({ version: 1, action: "start", repo: job.repo, objective: job.objective, project: job.projectId, issue: req.body?.issue || undefined })
    .then((result) => saveFounderJob(ROOT, Object.assign(job, { status: result.status, result, updatedAt: new Date().toISOString() })))
    .catch((error) => saveFounderJob(ROOT, Object.assign(job, { status: "error", error: error.message || String(error), updatedAt: new Date().toISOString() })));
  res.status(202).json({ job });
});

// Decompose one founder objective into a dependency-aware task graph and run the
// independent parts concurrently. Detached, tracked as a founder job — same
// pattern as /api/founder/tasks. Reuses factory/lib/objective/.
app.post("/api/founder/objectives", async (req, res) => {
  let job;
  let cfg = {};
  try {
    const objective = String(req.body?.objective || "").trim();
    const projectId = String(req.body?.projectId || "").trim();
    const repo = resolveLaunchRepo(req, projectId) || "";
    if (!objective || !projectId || !repo) return res.status(400).json({ error: "objective and projectId are required (repo is auto-resolved for registered projects)." });
    if (isProjectPaused(ROOT, projectId)) return res.status(409).json({ error: "Resume this project before starting an objective." });
    if (!existsSync(join(repo, ".git"))) return res.status(400).json({ error: `Not a git working tree: ${repo}` });

    const jobId = `founder-${Date.now().toString(36)}`;
    job = { id: jobId, kind: "objective", projectId, objective, repo, status: "decomposing", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    saveFounderJob(ROOT, job);

    try { cfg = JSON.parse(readFileSync(join(ROOT, "factory", "factory.config.json"), "utf8")); } catch { /* defaults */ }
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
  const { objective, projectId, repo } = job;

  (async () => {
    try {
      const graph = await decomposeObjective({ hqRoot: ROOT, objective, project: projectId, repo, decomposeAgentId: cfg.openclawIntegration?.agentIds?.decompose });
      const dir = join(defaultStateRoot(ROOT, repo), "objectives", graph.objectiveId);
      mkdirSync(dir, { recursive: true });
      const objectivePath = join(dir, "objective-state.json");

      // Preflight: a high-risk node cannot initialize without the founder
      // approval key. Rather than let the orchestrator hard-fail on the first
      // node, record the objective as blocked on a founder action so it lands
      // in the Founder Inbox immediately with the exact remediation.
      const highRiskNodes = Object.values(graph.nodes).filter((n) => n.contract?.risk === "high");
      if (highRiskNodes.length && !process.env.FACTORY_FOUNDER_PUBLIC_KEY) {
        const at = new Date().toISOString();
        for (const n of highRiskNodes) {
          n.status = "blocked";
          n.finishedAt = at;
          n.blocker = founderApprovalSetupBlocker({ at });
        }
        for (const n of Object.values(graph.nodes)) {
          if (n.status === "pending" && (n.dependsOn || []).some((d) => highRiskNodes.find((h) => h.id === d))) {
            n.status = "blocked-by-dep";
          }
        }
        graph.status = "blocked";
        graph.events.push({ at, type: "objective-blocked", detail: "high-risk objective needs founder approval key" });
        writeFileSync(objectivePath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
        saveFounderJob(ROOT, Object.assign(job, {
          status: "blocked", objectiveId: graph.objectiveId, nodeCount: Object.keys(graph.nodes).length,
          note: "High-risk objective — configure FACTORY_FOUNDER_PUBLIC_KEY, then continue it from the Founder Inbox.",
          updatedAt: at,
        }));
        return;
      }

      writeFileSync(objectivePath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
      saveFounderJob(ROOT, Object.assign(job, { status: "running", objectiveId: graph.objectiveId, nodeCount: Object.keys(graph.nodes).length, updatedAt: new Date().toISOString() }));
      const result = await runObjectiveJob(job, { objectivePath, cfg });
      saveFounderJob(ROOT, Object.assign(job, { status: result.status, objectiveId: graph.objectiveId, updatedAt: new Date().toISOString() }));
    } catch (error) {
      saveFounderJob(ROOT, Object.assign(job, { status: "error", error: error.message || String(error), updatedAt: new Date().toISOString() }));
    }
  })();

  res.status(202).json({ job });
});

// Detached objective orchestrator — shared by create + recovery retry.
async function runObjectiveJob(job, { objectivePath, cfg = {}, stateRoot, ...rest } = {}) {
  return runObjective({
    hqRoot: ROOT,
    objectivePath,
    maxConcurrent: Number(process.env.FACTORY_MAX_CONCURRENT) || 3,
    agentIds: cfg.openclawIntegration?.agentIds || rest.agentIds || {},
    maxAttemptsPerStage: cfg.openclawIntegration?.maxAttemptsPerStage || rest.maxAttemptsPerStage || 3,
    concurrentGroups: cfg.openclawIntegration?.concurrentGroups || rest.concurrentGroups,
    stateRoot: stateRoot || defaultStateRoot(ROOT, job?.repo || rest.repo),
    ...rest,
  });
}

// One click: retry every safely-retryable infrastructure failure in a blocked
// objective and resume the orchestrator. Never touches decision / approval /
// hard-fail / live nodes. Mirrors POST /api/founder/tasks/:id/retry.
app.post("/api/founder/objectives/:id/retry", async (req, res) => {
  try {
    if (!/^obj-[a-z0-9-]+$/i.test(req.params.id)) return res.status(400).json({ error: "Invalid objective id." });
    const out = await handleObjectiveRetry({
      root: ROOT,
      hqRoot: ROOT,
      objectiveId: req.params.id,
      // Options-shaped seam; runObjectiveJob also serves POST /objectives.
      runObjective: (opts) => runObjectiveJob(null, {
        objectivePath: opts.objectivePath,
        stateRoot: opts.stateRoot,
        agentIds: opts.agentIds,
        maxAttemptsPerStage: opts.maxAttemptsPerStage,
        concurrentGroups: opts.concurrentGroups,
      }),
    });
    res.status(202).json(out);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: String(e.message || e) });
  }
});

// Founder presentation control: dismiss a decomposed objective from the main
// Today view (archive), or restore it (unarchive). Writes only the archive flag
// in control-plane.json — the objective's state, metrics, report, evidence, and
// GitHub history are never touched, and the action is fully reversible.
app.post("/api/founder/objectives/:id/:action", (req, res) => {
  try {
    const action = req.params.action;
    if (!new Set(["archive", "unarchive"]).has(action)) {
      return res.status(400).json({ error: "Action must be archive or unarchive." });
    }
    if (!/^obj-[a-z0-9-]+$/i.test(req.params.id)) return res.status(400).json({ error: "Invalid objective id." });
    if (!findObjectiveStatePath(ROOT, req.params.id)) return res.status(404).json({ error: "No such objective." });
    res.json(setObjectiveArchived(ROOT, req.params.id, action === "archive", { reason: req.body?.reason }));
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// role -> harness / model policy (the honest "what runs each role" table).
app.get("/api/hq/role-policy", (_req, res) => {
  try { res.json({ roles: buildRolePolicy(ROOT) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post("/api/founder/questions", async (req, res) => {
  try {
    const agentId = String(req.body?.agentId || "main").trim();
    const question = String(req.body?.question || "").trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(agentId) || !question) return res.status(400).json({ error: "A valid agentId and question are required." });
    const askedAt = new Date().toISOString();
    const { stdout } = await execFileAsync("openclaw", ["agent", "--agent", agentId, "--session-key", `agent:${agentId}:founder-control-plane`, "--message", question, "--json", "--timeout", "600"], { timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
    const envelope = JSON.parse(stdout);
    const answer = envelope.result?.payloads?.map((item) => item.text).filter(Boolean).join("\n") || envelope.summary || "No answer returned.";
    const item = recordQuestion(ROOT, { id: `question-${Date.now().toString(36)}`, agentId, question, answer, askedAt, answeredAt: new Date().toISOString() });
    res.json({ question: item });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/founder/decisions/resolve", (req, res) => {
  try {
    const direction = String(req.body?.direction || "").trim();
    if (!req.body?.statePath || !direction) return res.status(400).json({ error: "statePath and direction are required." });
    res.json({ task: resolveFounderDecision({ root: ROOT, hqRoot: ROOT, statePath: req.body.statePath, direction }) });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post("/api/founder/decisions/approve", async (req, res) => {
  try {
    const { statePath, approvalAssertionPath, evidence } = req.body || {};
    if (!statePath || !approvalAssertionPath || !evidence) return res.status(400).json({ error: "statePath, approvalAssertionPath, and evidence are required." });
    res.json(await handleFactoryRequest({ version: 1, action: "approve", statePath, approvalAssertionPath, evidence }));
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// ── One-click founder approval ──────────────────────────────────────────────
// The founder enrolls a non-extractable Ed25519 key from their browser, then
// Approve = prepare (server writes the evidence, returns the bytes to sign) →
// browser signs with the browser-held key → submit (existing gate verifies +
// records + resumes). The private key never reaches the server or the agents.

const APPROVAL_ID = /^[a-z0-9][a-z0-9-]*$/;
const approvalRunObjective = (opts) => runObjectiveJob(null, { objectivePath: opts.objectivePath, stateRoot: opts.stateRoot });
const approvalRunTask = ({ statePath }) => handleFactoryRequest({ version: 1, action: "run", statePath });
const approvalError = (res, e) => res.status(e.statusCode || 400).json({ error: String(e.message || e), code: e.code, details: e.details });

app.get("/api/founder/approval-key", (_req, res) => {
  try {
    const k = getEnrolledFounderKey(ROOT);
    res.json({ enrolled: k.enrolled, source: k.source, algorithm: "Ed25519", fingerprint: k.fingerprint, enrolledAt: k.enrolledAt });
  } catch (e) { approvalError(res, e); }
});

app.post("/api/founder/approval-key", (req, res) => {
  try {
    const { publicKeyPem, rotationSignature } = req.body || {};
    if (!publicKeyPem) return res.status(400).json({ error: "publicKeyPem is required." });
    res.json(enrollFounderKey(ROOT, { publicKeyPem, rotationSignature }));
  } catch (e) { approvalError(res, e); }
});

// `statePath` is the absolute task-state path the Founder Inbox already carries
// for this approval item; the lib containment-checks it and confirms task.id,
// falling back to an id lookup when absent. See founderApproval.locateTask().
app.post("/api/founder/approvals/:taskId/prepare", (req, res) => {
  try {
    if (!APPROVAL_ID.test(req.params.taskId)) return res.status(400).json({ error: "Invalid task id." });
    res.json(prepareFounderApproval(ROOT, req.params.taskId, { note: req.body?.note || "", statePath: req.body?.statePath }));
  } catch (e) { approvalError(res, e); }
});

app.post("/api/founder/approvals/:taskId/submit", async (req, res) => {
  try {
    if (!APPROVAL_ID.test(req.params.taskId)) return res.status(400).json({ error: "Invalid task id." });
    const out = await submitFounderApproval(ROOT, ROOT, req.params.taskId, { assertion: req.body?.assertion, statePath: req.body?.statePath },
      { runObjective: approvalRunObjective, runTask: approvalRunTask });
    res.json(out);
  } catch (e) { approvalError(res, e); }
});

app.post("/api/founder/approvals/:taskId/reject", (req, res) => {
  try {
    if (!APPROVAL_ID.test(req.params.taskId)) return res.status(400).json({ error: "Invalid task id." });
    res.json(rejectFounderApproval(ROOT, req.params.taskId, { reason: req.body?.reason || "", statePath: req.body?.statePath }));
  } catch (e) { approvalError(res, e); }
});

app.post("/api/founder/approvals/:taskId/rekey", (req, res) => {
  try {
    if (!APPROVAL_ID.test(req.params.taskId)) return res.status(400).json({ error: "Invalid task id." });
    res.json(rekeyPendingApproval(ROOT, req.params.taskId, { statePath: req.body?.statePath }));
  } catch (e) { approvalError(res, e); }
});

// The founder-readable completion report for one factory task (markdown + html),
// generated by the runner when the task settled. 404 if the task is unknown.
app.get("/api/founder/tasks/:id/report", (req, res) => {
  try {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(req.params.id)) return res.status(400).json({ error: "Invalid task id." });
    const report = readTaskCompletionReport(ROOT, req.params.id);
    if (!report) return res.status(404).json({ error: "No such factory task." });
    res.json({ ...report, html: report.markdown ? marked.parse(report.markdown) : null });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Per-stage evidence (redacted excerpts + verdicts), full event timeline,
// retry/failure counts, and the GitHub result for one task — the report drill-down.
app.get("/api/founder/tasks/:id/evidence", (req, res) => {
  try {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(req.params.id)) return res.status(400).json({ error: "Invalid task id." });
    const ev = readTaskEvidence(ROOT, req.params.id);
    if (!ev) return res.status(404).json({ error: "No such factory task." });
    res.json(ev);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Manually kick a stuck task back into motion — one click, no free-text. Resets
// the failed stage and drives the task to its next terminal state in the
// background. For infra failures the auto-retry sweep normally does this on its
// own; this is the founder's "just try again now" button.
app.post("/api/founder/tasks/:id/retry", (req, res) => {
  let statePath;
  try {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(req.params.id)) return res.status(400).json({ error: "Invalid task id." });
    statePath = findTaskStatePath(ROOT, req.params.id);
    if (!statePath) return res.status(404).json({ error: "No such factory task." });
    const state = readTaskState(statePath);
    if (state.status !== "blocked") return res.status(409).json({ error: `Task is ${state.status}, not blocked — nothing to retry.` });
    const at = new Date().toISOString();
    const resumed = resumeTaskState(state, at);
    resumed.autoRetries = state.autoRetries || 0; // manual retries don't consume the auto budget
    resumed.events.push({ at, type: "manual-retry", stage: resumed.currentStage, actor: "founder" });
    writeTaskState(statePath, resumed);
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(join(ROOT, "factory", "factory.config.json"), "utf8")); } catch { /* defaults */ }
  runTaskToTerminal({
    hqRoot: ROOT, statePath,
    agentIds: cfg.openclawIntegration?.agentIds || {},
    maxAttemptsPerStage: cfg.openclawIntegration?.maxAttemptsPerStage || 3,
    concurrentGroups: cfg.openclawIntegration?.concurrentGroups,
  }).catch((error) => console.error("[hq] manual retry failed:", error?.message || error));
  res.status(202).json({ taskId: req.params.id, status: "retrying" });
});

// The founder-readable summary for a whole decomposed objective.
app.get("/api/founder/objectives/:id/report", (req, res) => {
  try {
    if (!/^obj-[a-z0-9-]+$/i.test(req.params.id)) return res.status(400).json({ error: "Invalid objective id." });
    const report = readObjectiveReport(ROOT, req.params.id);
    if (!report) return res.status(404).json({ error: "No such objective." });
    res.json({ ...report, html: report.markdown ? marked.parse(report.markdown) : null });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// What the factory is doing autonomously right now vs. what is merely configured.
app.get("/api/hq/autonomy", async (_req, res) => {
  try {
    const tasks = discoverFactoryTasks(ROOT);
    const objectives = buildObjectivesView(ROOT).objectives;
    const jobs = listFounderJobs(ROOT);
    const running = {
      tasks: tasks.filter((t) => t.status === "active").length,
      objectives: objectives.filter((o) => o.status === "active").length,
      jobs: jobs.filter((j) => ["starting", "running", "decomposing"].includes(j.status)).length,
    };
    res.json(await readAutonomy({ hqRoot: ROOT, running }));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/command-center/home", async (_req, res) => {
  try {
    const agents = await buildEnrichedAgents(db, ROOT);
    const recent = recentRunsRows(db, 25);
    const cards = buildHomeCards(agents, recent);
    res.json({
      root: ROOT,
      cards,
      needsAttention: buildNeedsAttention(agents),
      recentActivity: recent,
      projects: buildProjectSummary(agents),
      quickActions: buildQuickActions(agents),
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/command-center/health", async (_req, res) => {
  try {
    const { stdout, stderr } = await execFileAsync("openclaw", ["health"], {
      timeout: 25000,
      maxBuffer: 5 * 1024 * 1024,
    });
    res.type("text/plain").send(stdout || stderr || "(empty)");
  } catch (e) {
    res.status(500).type("text/plain").send(String(e.message || e));
  }
});

app.get("/api/overview", async (_req, res) => {
  try {
    const agents = await buildEnrichedAgents(db, ROOT);
    const recent = recentRunsRows(db, 30);
    const byProject = {};
    for (const a of agents) {
      byProject[a.project] = (byProject[a.project] || 0) + 1;
    }
    res.json({
      root: ROOT,
      projectCount: Object.keys(byProject).length,
      agentCount: agents.length,
      byProject,
      cards: buildHomeCards(agents, recent),
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/hq", async (_req, res) => {
  try {
    const state = readHqState(ROOT);
    const labAgents = await buildEnrichedAgents(db, ROOT);
    const agents = enrichHqAgentsWithLifecycle(ROOT, state.agents, labAgents);
    res.json({
      ...state,
      agents,
      commandCenter: buildCommandCenter({
        projects: state.projects,
        agents,
        tasks: state.tasks,
        reports: state.reports,
        logs: state.logs,
      }),
      labAgents,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/hq/command-center", async (_req, res) => {
  try {
    const state = readHqState(ROOT);
    const labAgents = await buildEnrichedAgents(db, ROOT);
    const agents = enrichHqAgentsWithLifecycle(ROOT, state.agents, labAgents);
    res.json({
      ...buildCommandCenter({
        projects: state.projects,
        agents,
        tasks: state.tasks,
        reports: state.reports,
        logs: state.logs,
      }),
      labAgents,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/system/readiness", async (_req, res) => {
  try {
    res.json(await buildReadinessReport(db, ROOT));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/hq/projects", (_req, res) => {
  try {
    res.json({ projects: readProjects(ROOT) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/hq/projects/:id", (req, res) => {
  try {
    const project = readProject(ROOT, req.params.id);
    if (!project) return res.status(404).json({ error: "Not found" });
    res.json({ project });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get("/api/hq/projects/:id/profile", async (req, res) => {
  try {
    const projectId = req.params.id;
    const project = readProject(ROOT, projectId);
    if (!project) return res.status(404).json({ error: "Not found" });

    const state = readHqState(ROOT);
    const labAgents = await buildEnrichedAgents(db, ROOT);
    const allHqAgents = enrichHqAgentsWithLifecycle(ROOT, state.agents, labAgents);

    const ceo = allHqAgents.find((a) => a.id === project.projectCEO) || null;

    // Agents whose projectId matches — excludes global-hq agents
    const projectHqAgents = allHqAgents.filter((a) => a.projectId === projectId);

    // Global HQ agents referenced by relatedAgents (shared support)
    const relatedIds = new Set(Array.isArray(project.relatedAgents) ? project.relatedAgents : []);
    const sharedSupport = allHqAgents.filter(
      (a) => a.layer === "global-hq" && relatedIds.has(a.id)
    );

    // Workers = project agents that aren't the CEO
    const workers = projectHqAgents.filter((a) => a.id !== project.projectCEO);
    const realWorkers = workers.filter((a) => a.executable);
    const conceptualWorkers = workers.filter((a) => !a.executable);

    // Tasks scoped to this project
    const allTasks = state.tasks || [];
    const projectTasks = allTasks.filter((t) => t.projectId === projectId);
    const activeTasks = projectTasks.filter((t) => !["Done", "Blocked"].includes(t.status));
    const blockedTasks = projectTasks.filter((t) => t.status === "Blocked");
    const needsJoao = projectTasks.filter((t) => t.approvalRequired && t.status !== "Done");
    const doneTasks = projectTasks.filter((t) => t.status === "Done");

    // Recent runs for lab agents in this project
    const projectLabKeys = new Set(
      labAgents.filter((a) => a.project === projectId).map((a) => a.agentKey)
    );
    const recentRuns = recentRunsRows(db, 60)
      .filter((r) => projectLabKeys.has(r.agent_key))
      .slice(0, 6);

    // Reports scoped to this project
    const recentReports = (state.reports || [])
      .filter((r) => r.projectId === projectId)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .slice(0, 3);

    const ceoIsExecutable = Boolean(ceo?.executable);
    const ceoIsConceptual = ceo && !ceoIsExecutable;

    res.json({
      project,
      ceo,
      agents: { ceo: ceo ? [ceo] : [], sharedSupport, realWorkers, conceptualWorkers },
      tasks: { active: activeTasks, blocked: blockedTasks, needsJoao, done: doneTasks },
      recentRuns,
      recentReports,
      stats: {
        activeTasks: activeTasks.length,
        blockedTasks: blockedTasks.length,
        needsJoao: needsJoao.length,
        realAgents: realWorkers.length + (ceoIsExecutable ? 1 : 0),
        conceptualAgents: conceptualWorkers.length + (ceoIsConceptual ? 1 : 0),
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.put("/api/hq/projects/:id", (req, res) => {
  try {
    const project = parseProjectForWrite(req.params.id, req.body?.project);
    if (!project || typeof project !== "object") {
      return res.status(400).json({ error: "Expected { project: { ... } }" });
    }
    res.json({ project: writeProject(ROOT, req.params.id, project) });
  } catch (e) {
    res.status(400).json({ error: formatZodError(e) });
  }
});

app.get("/api/hq/agents", async (_req, res) => {
  try {
    const state = readHqState(ROOT);
    const labAgents = await buildEnrichedAgents(db, ROOT);
    res.json({ agents: enrichHqAgentsWithLifecycle(ROOT, state.agents, labAgents) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

for (const name of ["agents", "tasks", "sops", "reports", "logs"]) {
  app.get(`/api/hq/${name}`, (_req, res) => {
    try {
      res.json({ [name]: readHqCollection(ROOT, name) });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  app.put(`/api/hq/${name}`, (req, res) => {
    try {
      const value = parseCollectionForWrite(name, req.body?.[name]);
      if (!Array.isArray(value)) {
        return res.status(400).json({ error: `Expected { ${name}: [...] }` });
      }
      res.json({ [name]: writeHqCollection(ROOT, name, value) });
    } catch (e) {
      res.status(400).json({ error: formatZodError(e) });
    }
  });
}

app.get("/api/agents", async (req, res) => {
  const project = typeof req.query.project === "string" ? req.query.project : "";
  try {
    let agents = await buildEnrichedAgents(db, ROOT);
    if (project) agents = agents.filter((a) => a.project === project);
    res.json({ agents });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/agents/:project/:id", async (req, res) => {
  try {
    assertSafeSlug(req.params.project, req.params.id);
    const agents = await buildEnrichedAgents(db, ROOT);
    const row = agents.find(
      (a) => a.project === req.params.project && a.id === req.params.id
    );
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get("/api/agents/:project/:id/logs", (req, res) => {
  try {
    assertSafeSlug(req.params.project, req.params.id);
    const dir = agentDir(ROOT, req.params.project, req.params.id);
    const lines = Math.min(200, Math.max(1, Number(req.query.lines) || 30));
    res.type("text/plain").send(tailLog(dir, lines));
  } catch (e) {
    res.status(400).send(String(e.message || e));
  }
});

app.get("/api/agents/:project/:id/outputs/latest", (req, res) => {
  try {
    assertSafeSlug(req.params.project, req.params.id);
    const dir = agentDir(ROOT, req.params.project, req.params.id);
    const latest = preferredMarkdownOutput(dir) || latestOutputFile(dir);
    if (!latest) return res.status(404).json({ error: "No outputs" });
    res.json({ name: latest.name, path: latest.path });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get("/api/runs", (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 80));
    const project = typeof req.query.project === "string" ? req.query.project : "";
    const agentId = typeof req.query.agentId === "string" ? req.query.agentId : "";
    const status = typeof req.query.status === "string" ? req.query.status : "all";
    const rows = db
      .prepare(`SELECT * FROM agent_runs ORDER BY id DESC LIMIT ?`)
      .all(limit * 2);
    let filtered = rows.map((r) => {
      const parts = splitAgentKey(r.agent_key);
      const artifacts = parseArtifactsJson(r.artifacts_json);
      const { artifacts_json: _aj, ...rest } = r;
      return {
        ...rest,
        project: parts?.project,
        agentId: parts?.id,
        duration_ms: runDurationMs(r.started_at, r.ended_at),
        artifacts,
        artifactsPreview:
          artifacts.length > 0
            ? artifacts.map((x) => x.title).join(" · ")
            : null,
      };
    });
    if (project) {
      filtered = filtered.filter((r) => String(r.agent_key).startsWith(`${project}/`));
    }
    if (agentId && project) {
      const key = `${project}/${agentId}`;
      filtered = filtered.filter((r) => r.agent_key === key);
    }
    if (status !== "all") {
      filtered = filtered.filter((r) => r.status === status);
    }
    filtered = filtered.slice(0, limit);
    res.json({ runs: filtered });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/runs/:runId", (req, res) => {
  try {
    const id = Number(req.params.runId);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid run id" });
    const row = db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ error: "Not found" });
    const parts = splitAgentKey(row.agent_key);
    const dir =
      parts && existsSync(agentDir(ROOT, parts.project, parts.id))
        ? agentDir(ROOT, parts.project, parts.id)
        : null;
    const logTail = dir ? tailLog(dir, 80) : "";
    let outputMarkdown = null;
    let outputHtml = null;
    if (dir && row.output_file) {
      const safeName = row.output_file.replace(/[/\\]/g, "");
      const p = join(dir, "outputs", safeName);
      const outRoot = join(dir, "outputs");
      if (existsSync(p) && p.startsWith(outRoot)) {
        try {
          const md = readFileSync(p, "utf8").slice(0, 400000);
          outputMarkdown = md;
          if (p.endsWith(".md")) outputHtml = marked.parse(md);
        } catch {
          /* ignore */
        }
      }
    }
    const artifacts = parseArtifactsJson(row.artifacts_json);
    const { artifacts_json: _ar, ...runRow } = row;
    res.json({
      run: {
        ...runRow,
        project: parts?.project,
        agentId: parts?.id,
        duration_ms: runDurationMs(row.started_at, row.ended_at),
        artifacts,
      },
      logTail,
      outputMarkdown,
      outputHtml,
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get("/api/outputs/cards", async (_req, res) => {
  try {
    const agents = await buildEnrichedAgents(db, ROOT);
    const cards = [];
    for (const a of agents) {
      const dir = agentDir(ROOT, a.project, a.id);
      const md = preferredMarkdownOutput(dir);
      if (!md) continue;
      let title = md.name;
      let preview = "";
      try {
        const text = readFileSync(md.path, "utf8").slice(0, 1500);
        preview = text;
        const line = text.split("\n").find((l) => l.trim()) || "";
        title = line.replace(/^#+\s*/, "").slice(0, 140) || md.name;
      } catch {
        /* */
      }
      cards.push({
        project: a.project,
        id: a.id,
        agentName: a.config.name || a.id,
        fileName: md.name,
        mtime: md.mtime,
        title,
        preview,
      });
    }
    cards.sort((a, b) => b.mtime - a.mtime);
    res.json({ cards });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/agents/:project/:id/markdown", (req, res) => {
  try {
    assertSafeSlug(req.params.project, req.params.id);
    const file = typeof req.query.file === "string" ? req.query.file : "latest.md";
    const base = file.replace(/[/\\]/g, "");
    if (!base.endsWith(".md")) return res.status(400).json({ error: "Only .md files" });
    const dir = agentDir(ROOT, req.params.project, req.params.id);
    const p = join(dir, "outputs", base);
    if (!p.startsWith(join(dir, "outputs"))) return res.status(400).json({ error: "Bad path" });
    if (!existsSync(p)) return res.status(404).json({ error: "Not found" });
    const md = readFileSync(p, "utf8");
    res.json({
      markdown: md,
      html: marked.parse(md),
      fileName: base,
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

const READ_FILES = new Set(["prompt.md", "README.md", "agent.config.json", "run.sh"]);
const WRITE_FILES = new Set(["prompt.md", "README.md", "agent.config.json"]);

app.get("/api/agents/:project/:id/workspace/:file", (req, res) => {
  try {
    assertSafeSlug(req.params.project, req.params.id);
    const file = req.params.file;
    if (!READ_FILES.has(file)) return res.status(400).json({ error: "File not readable here" });
    const dir = agentDir(ROOT, req.params.project, req.params.id);
    const p = join(dir, file);
    if (!p.startsWith(dir)) return res.status(400).json({ error: "Bad path" });
    if (!existsSync(p)) return res.status(404).json({ error: "Not found" });
    res.type("text/plain; charset=utf-8").send(readFileSync(p, "utf8"));
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.put("/api/admin/agents/:project/:id/workspace/:file", (req, res) => {
  try {
    assertSafeSlug(req.params.project, req.params.id);
    const file = req.params.file;
    if (!WRITE_FILES.has(file)) {
      return res.status(400).json({ error: "This file cannot be edited from the browser" });
    }
    const dir = agentDir(ROOT, req.params.project, req.params.id);
    const p = join(dir, file);
    if (!p.startsWith(dir)) return res.status(400).json({ error: "Bad path" });
    const body = req.body;
    const content = typeof body?.content === "string" ? body.content : null;
    if (content === null) return res.status(400).json({ error: "Expected { content: string }" });
    if (file === "agent.config.json") {
      JSON.parse(content);
    }
    writeFileSync(p, content, "utf8");
    if (file === "agent.config.json") {
      registerAgent(ROOT, req.params.project, req.params.id, db);
    }
    const key = agentKey(req.params.project, req.params.id);
    logEvent(db, key, "file_update", file);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get("/api/settings", (req, res) => {
  res.json({
    root: ROOT,
    host: HOST,
    port: PORT,
    trustProxy: TRUST_PROXY,
  });
});

// --- Admin (same session; single operator) ---

app.post("/api/admin/agents/:project/:id/run", async (req, res) => {
  try {
    assertSafeSlug(req.params.project, req.params.id);
    const wait =
      req.query.wait === "1" ||
      req.query.wait === "true" ||
      (req.body && req.body.wait === true);
    const dir = agentDir(ROOT, req.params.project, req.params.id);
    const cfgPath = join(dir, "agent.config.json");
    if (!existsSync(cfgPath)) return res.status(404).json({ error: "Not found" });
    const config = JSON.parse(readFileSync(cfgPath, "utf8"));
    const entry = config.entrypoint || "./run.sh";
    const key = agentKey(req.params.project, req.params.id);
    const started = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO agent_runs (agent_key, status, started_at) VALUES (?, ?, ?)`
      )
      .run(key, "running", started);
    const runId = info.lastInsertRowid;
    logEvent(db, key, "run_start", `run id ${runId}`);

    const extraEnv = wait ? { AGENT_LAB_RUN_WAIT: "1" } : {};
    const { code, errMsg } = await runEntrypoint(dir, entry, extraEnv);
    const ended = new Date().toISOString();
    const ok = code === 0 && !errMsg;
    const out = preferredMarkdownOutput(dir) || latestOutputFile(dir);
    const artifacts = collectArtifactsAfterRun(dir, dir);
    const artifactsJson =
      artifacts.length > 0 ? JSON.stringify(artifacts) : null;
    db.prepare(
      `UPDATE agent_runs SET status = ?, ended_at = ?, summary = ?, output_file = ?, error_message = ?, artifacts_json = ? WHERE id = ?`
    ).run(
      ok ? "success" : "failed",
      ended,
      ok ? `exit ${code}${wait ? " (wait)" : ""}` : `exit ${code}`,
      out ? out.name : null,
      ok ? null : errMsg || `exit code ${code}`,
      artifactsJson,
      runId
    );
    logEvent(
      db,
      key,
      ok ? "run_ok" : "run_fail",
      ok ? `exit ${code}` : errMsg || `exit ${code}`
    );
    res.json({ ok, runId, code, ended_at: ended, waited: wait });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post("/api/admin/agents/:project/:id/pm2/:action", async (req, res) => {
  const action = req.params.action;
  if (!["start", "stop", "restart"].includes(action)) {
    return res.status(400).json({ error: "Invalid action" });
  }
  try {
    assertSafeSlug(req.params.project, req.params.id);
    const dir = agentDir(ROOT, req.params.project, req.params.id);
    const name = pm2Name(req.params.project, req.params.id);
    const runSh = join(dir, "run.sh");
    if (!existsSync(runSh)) return res.status(404).json({ error: "Missing run.sh" });

    if (action === "start") {
      try {
        await execFileAsync(
          "pm2",
          ["start", runSh, "--name", name, "--cwd", dir, "--interpreter", "bash"],
          { timeout: 60000 }
        );
      } catch (e) {
        // may already exist
        await execFileAsync("pm2", ["restart", name], { timeout: 60000 }).catch(
          () => {
            throw e;
          }
        );
      }
    } else {
      await execFileAsync("pm2", [action, name], { timeout: 60000 });
    }
    const key = agentKey(req.params.project, req.params.id);
    logEvent(db, key, `pm2_${action}`, name);
    res.json({ ok: true, pm2: name });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.patch("/api/admin/agents/:project/:id/config", (req, res) => {
  try {
    assertSafeSlug(req.params.project, req.params.id);
    const dir = agentDir(ROOT, req.params.project, req.params.id);
    const cfgPath = configPath(ROOT, req.params.project, req.params.id);
    const body = req.body;
    if (!body || typeof body.config !== "object" || body.config === null) {
      return res.status(400).json({ error: "Expected { config: { ... } }" });
    }
    const json = JSON.stringify(body.config, null, 2);
    JSON.parse(json); // validate
    writeFileSync(cfgPath, json + "\n", "utf8");
    registerAgent(ROOT, req.params.project, req.params.id, db);
    const key = agentKey(req.params.project, req.params.id);
    logEvent(db, key, "config_update", "agent.config.json saved from dashboard");
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api")) {
    return res.status(404).json({ error: "Not found", path: req.path });
  }
  next();
});

app.use((err, req, res, next) => {
  const url = req.originalUrl || req.url || "";
  if (url.startsWith("/api")) {
    console.error("[agent-lab] API error:", err);
    if (res.headersSent) return next(err);
    return res.status(500).json({ error: err.message || String(err) });
  }
  next(err);
});

app.use(express.static(join(__dirname, "public")));

app.get("/", (_req, res) => {
  res.redirect("/index.html");
});

checkBootConfig();

app.listen(PORT, HOST, () => {
  console.log(`[agent-lab] dashboard http://${HOST}:${PORT} (root=${ROOT})`);
});

// ── Auto-retry sweep ─────────────────────────────────────────────────────────
// Infra failures (no result file, timeout, provider 5xx) should recover on
// their own, not sit in the Founder Inbox. Every few minutes, resume tasks
// blocked on an infra-class failure and drive them again — bounded per task.
// Disable with HQ_AUTO_RETRY=0.
if (process.env.HQ_AUTO_RETRY !== "0") {
  const FACTORY_STATE_ROOT = join(ROOT, "dashboard", "backend", "data", "factory");
  const intervalMs = Math.max(60_000, Number(process.env.HQ_AUTO_RETRY_INTERVAL_MS) || 180_000);
  const maxPerTask = Math.max(1, Number(process.env.HQ_AUTO_RETRY_MAX) || 3);
  let sweeping = false;
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const out = await retryStuckTasks({ hqRoot: ROOT, stateRoot: FACTORY_STATE_ROOT, max: maxPerTask, log: (m) => console.log(m) });
      if (out.retried.length) console.log(`[auto-retry] swept ${out.scanned} state files, retried ${out.retried.length}`);
    } catch (error) {
      console.error("[auto-retry] sweep failed:", error?.message || error);
    } finally {
      sweeping = false;
    }
  };
  setTimeout(sweep, 20_000).unref();
  setInterval(sweep, intervalMs).unref();
  console.log(`[auto-retry] enabled — every ${Math.round(intervalMs / 1000)}s, up to ${maxPerTask} attempts per task`);
}
