import { createHash, timingSafeEqual } from "crypto";
import dotenv from "dotenv";
import express from "express";
import session from "express-session";
import { renderUntrustedMarkdown } from "./lib/safeMarkdown.mjs";
import { withRenderedReplies } from "./lib/threadMarkdown.mjs";
import {
  LoginThrottle,
  clientKey,
  csrfProtection,
  issueCsrfToken,
  regenerateSession,
  securityHeaders,
} from "./lib/httpSecurity.mjs";
import { auditFromRequest } from "./lib/securityAudit.mjs";
import { requestLog } from "./lib/requestLog.mjs";
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
import { buildReadinessSnapshot, rollUp as rollUpReadiness } from "../../factory/lib/hq/readiness.mjs";
import { buildThreadsPanel } from "../../factory/lib/hq/threads.mjs";
import {
  buildFounderOverview,
  buildObjectivesView,
  buildObjectiveExecutionView,
  buildTaskExecutionView,
  buildRolePolicy,
  discoverFactoryTasks,
  findQuestion,
  findObjectiveStatePath,
  findTaskStatePath,
  handleObjectiveRetry,
  isProjectPaused,
  listFounderJobs,
  findInFlightDuplicateJob,
  duplicateJobError,
  readObjectiveReport,
  readTaskCompletionReport,
  readTaskEvidence,
  askFounderQuestion,
  answerFounderQuestion,
  listPendingQuestions,
  acceptProposal,
  createThread,
  deleteThread,
  findThread,
  listThreads,
  postFounderTurn,
  runThreadTurn,
  FOUNDER_THREAD_TIMEOUT_MS,
  failStrandedThreads,
  settleProposal,
  postTaskComment,
  resolveFounderDecision,
  resumeObjectiveAfterDecision,
  resolveProjectRepo,
  resolveRepoInput,
  saveFounderJob,
  finishFounderJob,
  setInboxItemDismissed,
  setObjectiveArchived,
  setProjectPaused,
} from "./lib/founderControlPlane.mjs";
import { buildHqCostsPayload, buildHqPlanLimitsPayload } from "./lib/hq-cost-limits.mjs";
import { deriveObjectiveTitle } from "../../factory/lib/hq/presenter.mjs";
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
import { readAutoRetryHalt } from "../../factory/lib/hq/state-watchdog.mjs";
import { resumeStrandedObjectives } from "../../factory/lib/hq/objective-reconciler.mjs";
import { reconcileMergedTasks } from "../../factory/lib/hq/merge-reconciler.mjs";
import { resumeState as resumeTaskState, readState as readTaskState, writeState as writeTaskState } from "../../factory/lib/task-workflow.mjs";
import { runToTerminal as runTaskToTerminal, recordRunnerCrash } from "../../factory/lib/openclaw-runner.mjs";
import { buildCompanyState } from "../../factory/lib/hq/company-state.mjs";
import { readLearningFindings } from "../../factory/lib/hq/chief-of-staff.mjs";
import { handleRequest as handleFactoryRequest } from "../../scripts/openclaw-factory.mjs";
import { decomposeObjective } from "../../factory/lib/objective/decompose.mjs";
import { runObjective, cancelObjective } from "../../factory/lib/objective/orchestrator.mjs";
import { founderApprovalSetupBlocker } from "../../factory/lib/hq/blocker-class.mjs";
import { defaultStateRoot } from "../../factory/lib/natural-language-intake.mjs";
import { readDeploymentStatus } from "../../factory/lib/deploy/status.mjs";
import { buildDeploymentsSnapshot } from "../../factory/lib/hq/deployments.mjs";
import { addOvernightItem, readOvernightQueue, removeOvernightItem, startOvernight, stopOvernight, overnightLimit } from "./lib/overnightQueue.mjs";
import { buildOperationsSnapshot } from "../../factory/lib/hq/operations.mjs";
import { appendInteraction, buildInteractionThread, createInteraction, interactionsPath, mentionWakeups } from "../../factory/lib/hq/interactions.mjs";
import { enqueueWakeup } from "../../factory/lib/wakeups/queue.mjs";
import { buildRetentionSnapshot } from "../../factory/lib/hq/retention.mjs";
import { buildRunTimeline } from "../../factory/lib/hq/run-timeline.mjs";
import { buildDecisionHistory } from "../../factory/lib/hq/decision-history.mjs";
import { buildAgentScorecards } from "../../factory/lib/hq/agent-scorecards.mjs";
import { buildPermissionsSnapshot } from "../../factory/lib/hq/permissions-snapshot.mjs";
import { buildBlastRadiusReport } from "../../factory/lib/hq/blast-radius.mjs";
import { buildGoalsSnapshot } from "../../factory/lib/hq/goals.mjs";
import { buildFactoryReportSnapshot } from "../../factory/lib/hq/factory-report.mjs";
import { buildWorkProposals } from "../../factory/lib/hq/proposer.mjs";
import { parseLayers, searchHq } from "../../factory/lib/hq/search.mjs";
import { buildBudgetSnapshot } from "../../factory/lib/hq/budget-snapshot.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const ROOT = labRoot(process.env.AGENT_LAB_ROOT);
dotenv.config({ path: join(ROOT, ".env") });
const FOUNDER_QUESTION_TIMEOUT_MS = Math.max(10_000, Number(process.env.FOUNDER_QUESTION_TIMEOUT_MS) || 90_000);

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

// First in the chain so nothing is invisible: 401s, 404s and static assets all
// get recorded. `authed` is read when the response finishes, by which point the
// session middleware below has run.
app.use(
  requestLog({
    file: process.env.DASHBOARD_REQUEST_LOG || join(dataDir, "requests.ndjson"),
    stdout: process.env.DASHBOARD_REQUEST_LOG_STDOUT !== "0",
  })
);

// Security headers go on every response, including static assets and errors.
app.use(securityHeaders());

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

// Every mutating request must prove it came from Headquarters itself.
// `/api/auth/login` is exempt: the browser has no session-bound token yet, and
// that endpoint is protected by throttling plus the password instead.
app.use(
  csrfProtection({
    allowedOrigins: (process.env.DASHBOARD_ALLOWED_ORIGINS || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    exemptPaths: ["/api/auth/login"],
    // Only honour x-forwarded-host when this deployment actually trusts a proxy.
    trustProxy: Boolean(TRUST_PROXY),
  })
);

const loginThrottle = new LoginThrottle({
  maxAttempts: Number(process.env.DASHBOARD_LOGIN_MAX_ATTEMPTS || 5),
  windowMs: Number(process.env.DASHBOARD_LOGIN_WINDOW_MS || 15 * 60 * 1000),
});
setInterval(() => loginThrottle.prune(), 10 * 60 * 1000).unref();

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

app.post("/api/auth/login", async (req, res) => {
  const body = req.body || {};
  const password = typeof body.password === "string" ? body.password : "";
  const key = clientKey(req);

  if (!PASSWORD) {
    return res.status(503).json({ error: "Password not configured on server" });
  }

  const gate = loginThrottle.check(key);
  if (!gate.allowed) {
    auditFromRequest(ROOT, req, { action: "login.throttled", outcome: "denied", reason: gate.reason });
    res.setHeader("Retry-After", String(gate.retryAfterSeconds));
    // Deliberately the same shape as a wrong password, plus the wait, so the
    // response does not reveal whether the guess itself was close.
    return res.status(429).json({
      error: "Too many attempts. Try again later.",
      retryAfterSeconds: gate.retryAfterSeconds,
    });
  }

  if (!passOk(password, PASSWORD)) {
    const state = loginThrottle.recordFailure(key);
    auditFromRequest(ROOT, req, {
      action: "login.failed",
      outcome: "denied",
      details: { failures: state.failures },
    });
    return res.status(401).json({ error: "Invalid password" });
  }

  loginThrottle.recordSuccess(key);
  // Session fixation: a session id fixed by an attacker before login must not
  // be the id that ends up authenticated.
  try {
    await regenerateSession(req);
  } catch (error) {
    auditFromRequest(ROOT, req, { action: "login.error", outcome: "error", reason: String(error.message || error) });
    return res.status(500).json({ error: "Could not establish a session." });
  }
  req.session.authenticated = true;
  req.session.loggedInAt = new Date().toISOString();
  const csrfToken = issueCsrfToken(req.session);
  req.session.touch();
  auditFromRequest(ROOT, req, { action: "login.succeeded", outcome: "ok" });
  return res.json({ ok: true, csrfToken });
});

app.post("/api/auth/logout", (req, res) => {
  auditFromRequest(ROOT, req, { action: "logout", outcome: "ok" });
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/api/auth/me", (req, res) => {
  const authenticated = !!(req.session && req.session.authenticated);
  // The SPA reads its CSRF token from here on boot. Only an authenticated
  // session gets one — an unauthenticated caller learns nothing.
  res.json({
    authenticated,
    csrfToken: authenticated ? issueCsrfToken(req.session) : null,
  });
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

// One objective's durable execution record: objective events joined with the
// underlying task states for every node. The browser may poll this while work
// is active; it never creates or mutates execution state.
app.get("/api/founder/objectives/:id/execution", (req, res) => {
  try {
    if (!/^obj-[a-z0-9-]+$/i.test(req.params.id)) return res.status(400).json({ error: "Invalid objective id." });
    const execution = buildObjectiveExecutionView(ROOT, req.params.id);
    if (!execution) return res.status(404).json({ error: "No such objective." });
    res.json(execution);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/founder/tasks/:id/execution", (req, res) => {
  try {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(req.params.id)) return res.status(400).json({ error: "Invalid task id." });
    const execution = buildTaskExecutionView(ROOT, req.params.id);
    if (!execution) return res.status(404).json({ error: "No such factory task." });
    res.json(execution);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Headquarters Integration Layer — one read-only "state of the company" object.
// Additive: composes the unified project registry, the agent registry + live
// activity, founder decisions, risks, and (with ?github=1) read-only GitHub
// awareness. Writes nothing.
// Cached because the enrichments are slow and the Today tab is chatty. Measured
// 2026-09-15: the local build is 17ms, but `?github=1&runtime=1` — which is what
// app.js asks for — cost 7,544ms before the reads were parallelised and ~2,700ms
// after. Today polls every 15s and re-renders on navigation, so that was being
// paid over and over for data that does not move that fast.
//
// 45s is set against what the enrichments actually report: GitHub commits/PRs/
// issues and the openclaw roster. A founder who needs the current instant has
// ?force=1, and every response says how old it is.
const COMPANY_CACHE_TTL_MS = Number(process.env.DASHBOARD_COMPANY_TTL_MS || 45_000);
const companyCache = new Map();

app.get("/api/hq/company", async (req, res) => {
  try {
    const withGithub = req.query.github === "1" || req.query.github === "true";
    const withRuntime = req.query.runtime === "1" || req.query.runtime === "true";
    const force = req.query.force === "1" || req.query.force === "true";

    // The flags change the payload, so they are part of the key — a cheap
    // no-enrichment read must never be served to a caller that asked for GitHub.
    const key = `${withGithub ? "g" : ""}${withRuntime ? "r" : ""}` || "plain";
    const now = Date.now();
    const hit = companyCache.get(key);
    if (!force && hit && now - hit.builtAt < COMPANY_CACHE_TTL_MS) {
      res.json({ ...hit.value, cache: "fresh", cachedAt: new Date(hit.builtAt).toISOString() });
      return;
    }

    const state = await buildCompanyState({
      hqRoot: ROOT,
      tasks: discoverFactoryTasks(ROOT),
      hqProjects: readProjects(ROOT),
      withGithub,
      withRuntime,
    });
    companyCache.set(key, { builtAt: now, value: state });
    res.json({ ...state, cache: "miss", cachedAt: new Date(now).toISOString() });
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
    res.json(await buildHqCostsPayload({ hqRoot: ROOT, authoritativeSource: PLAN_LIMITS_SOURCE }));
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
    const duplicate = req.body?.allowDuplicate ? null : findInFlightDuplicateJob(ROOT, { projectId, objective });
    if (duplicate) {
      const err = duplicateJobError(duplicate);
      return res.status(409).json({ error: err.message, duplicateOf: err.duplicateOf });
    }
    const jobId = `founder-${Date.now().toString(36)}`;
    job = { id: jobId, kind: "task", projectId, objective, repo, status: "starting", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    saveFounderJob(ROOT, job);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
  // The 202 is already out; this promise is the only thing that knows how the
  // run really ended. Both settlements land in finishFounderJob so the outcome
  // is typed, classified, and reachable from the Founder Inbox — a rejection
  // here used to be recorded as a raw string no view read.
  handleFactoryRequest({ version: 1, action: "start", repo: job.repo, objective: job.objective, project: job.projectId, issue: req.body?.issue || undefined })
    .then((result) => finishFounderJob(ROOT, Object.assign(job, { result, taskId: result?.taskId || result?.task?.id || job.taskId }), {
      result,
      whatFailed: `Your request "${deriveObjectiveTitle(job.objective)}"`,
      whatTheFactoryTried: "Chief of Staff intake, then the seven-stage pipeline",
    }))
    .catch((error) => finishFounderJob(ROOT, job, {
      error,
      whatFailed: `Your request "${deriveObjectiveTitle(job.objective)}"`,
      whatTheFactoryTried: "Chief of Staff intake",
    }));
  res.status(202).json({ job });
});

// Chief of Staff preflight. Most requests return ready immediately; only a
// genuinely material ambiguity returns one short question before work starts.
app.post("/api/founder/intake", async (req, res) => {
  try {
    const objective = String(req.body?.objective || "").trim();
    const projectId = String(req.body?.projectId || "").trim();
    const repo = resolveLaunchRepo(req, projectId) || "";
    if (!objective || !repo || !projectId) return res.status(400).json({ error: "objective and projectId are required (repo is auto-resolved for registered projects)." });
    if (isProjectPaused(ROOT, projectId)) return res.status(409).json({ error: "Resume this project before starting work." });
    if (!existsSync(join(repo, ".git"))) return res.status(400).json({ error: `Not a git working tree: ${repo}` });
    const result = await handleFactoryRequest({
      version: 1, action: "intake", repo, objective, project: projectId,
      issue: req.body?.issue || undefined,
      answers: Array.isArray(req.body?.answers) ? req.body.answers : [],
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// Founder-planned overnight work. The queue is persisted separately from task
// state, runs objectives one at a time, and delegates every objective to the
// normal factory gates. Stop leaves the current worktree/state inspectable.
app.get("/api/founder/overnight", (_req, res) => res.json({ ...readOvernightQueue(ROOT), limit: overnightLimit }));
app.post("/api/founder/overnight/items", (req, res) => {
  try {
    const projectId = String(req.body?.projectId || "").trim();
    const repo = resolveLaunchRepo(req, projectId) || "";
    if (!existsSync(join(repo, ".git"))) return res.status(400).json({ error: "Choose a registered project with a valid git repository." });
    res.status(201).json(addOvernightItem(ROOT, { objective: req.body?.objective, projectId, repo }));
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.delete("/api/founder/overnight/items/:id", (req, res) => {
  try { res.json(removeOvernightItem(ROOT, req.params.id)); }
  catch (e) { res.status(409).json({ error: String(e.message || e) }); }
});
app.post("/api/founder/overnight/start", (req, res) => {
  try {
    const scriptPath = join(ROOT, "scripts", "factory-objective.mjs");
    res.status(202).json(startOvernight(ROOT, { scriptPath }));
  } catch (e) { res.status(409).json({ error: String(e.message || e) }); }
});
app.post("/api/founder/overnight/stop", (_req, res) => res.json(stopOvernight(ROOT)));

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
    const duplicate = req.body?.allowDuplicate ? null : findInFlightDuplicateJob(ROOT, { projectId, objective });
    if (duplicate) {
      const err = duplicateJobError(duplicate);
      return res.status(409).json({ error: err.message, duplicateOf: err.duplicateOf });
    }

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
      finishFounderJob(ROOT, Object.assign(job, { objectiveId: graph.objectiveId }), {
        result,
        whatFailed: `Your objective "${deriveObjectiveTitle(job.objective)}"`,
        whatTheFactoryTried: `${Object.keys(graph.nodes).length} build node(s) through the seven-stage pipeline`,
        evidencePaths: [objectivePath],
      });
    } catch (error) {
      // Decomposition is a first-class failure site: when the planning call
      // fails there is no objective state file at all, so this record is the
      // ONLY thing standing between the founder and a silently dead request.
      finishFounderJob(ROOT, job, {
        error,
        whatFailed: job.objectiveId
          ? `Your objective "${deriveObjectiveTitle(job.objective)}"`
          : `Planning your objective "${deriveObjectiveTitle(job.objective)}"`,
        whatTheFactoryTried: job.objectiveId
          ? "decomposition succeeded, then the pipeline stopped"
          : "3 planning attempts with backoff",
      });
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

// Founder stop control: end a decomposed objective for good. Unlike archive,
// this writes a terminal `cancelled` status into the objective's own state, so
// the orchestrator will not schedule it, recovery will not resume it, a wakeup
// will not restart it overnight, and it stops counting as active work. The
// objective is archived in the same call so the founder's one click both stops
// the work and clears it off Today. Its state, report, evidence, and GitHub
// history are kept — cancelling ends the work, it does not erase the record.
// Registered before the :action route below so "cancel" reaches this handler.
app.post("/api/founder/objectives/:id/cancel", (req, res) => {
  try {
    if (!/^obj-[a-z0-9-]+$/i.test(req.params.id)) return res.status(400).json({ error: "Invalid objective id." });
    const statePath = findObjectiveStatePath(ROOT, req.params.id);
    if (!statePath) return res.status(404).json({ error: "No such objective." });
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
    const cancelled = cancelObjective(statePath, { reason });
    const archived = setObjectiveArchived(ROOT, req.params.id, true, { reason: reason || "cancelled by the founder" });
    res.json({ ...cancelled, archived: archived.archived, archivedAt: archived.archivedAt });
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

// Founder presentation control: dismiss a single Founder Inbox entry from
// "Needs you" (it moves to the "Dismissed" fold), or restore it. Writes only
// the dismissedInbox flag in control-plane.json — the underlying decision,
// approval, or blocked task is never resolved, and the action is reversible.
app.post("/api/founder/inbox/dismiss", (req, res) => {
  try {
    const id = String(req.body?.id || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,200}$/.test(id)) return res.status(400).json({ error: "Invalid inbox item id." });
    const restore = req.body?.restore === true;
    res.json(setInboxItemDismissed(ROOT, id, !restore, { reason: req.body?.reason }));
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// role -> harness / model policy (the honest "what runs each role" table).
app.get("/api/hq/role-policy", (_req, res) => {
  try { res.json({ roles: buildRolePolicy(ROOT) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Answering lives in founderControlPlane.mjs so this route and the console's
// `question.ask` intent run the same code. It was inline here, and a second
// copy in the intent worker is how two surfaces start answering differently.
async function runFounderQuestion(questionRecord) {
  return answerFounderQuestion(ROOT, questionRecord, { timeoutMs: FOUNDER_QUESTION_TIMEOUT_MS });
}

function resumePendingFounderQuestions() {
  for (const question of listPendingQuestions(ROOT)) void runFounderQuestion(question);
}

app.post("/api/founder/questions", (req, res) => {
  try {
    const item = askFounderQuestion(ROOT, {
      question: req.body?.question,
      agentId: String(req.body?.agentId || "main").trim(),
    });
    void runFounderQuestion(item);
    res.status(202).json({ question: item });
  } catch (e) {
    res.status(e?.statusCode || 500).json({ error: String(e.message || e) });
  }
});

// ── conversations ────────────────────────────────────────────────────────────
//
// The founder wanted the OpenClaw Control UI's chat, but here, where the
// factory is — so that the agent he is talking to can propose work and he can
// start it from the same page.
//
// What an agent may propose is exactly what the console's intent allowlist
// permits, and a proposal is inert until the founder clicks. The accept route
// below then runs it through `handlers()` — literally the same closed map the
// intent worker uses — so every gate that applies to a founder intent applies
// here too. See factory/lib/hq/threads.mjs.

const THREAD_ID_RE = /^thread-[a-z0-9]+-[a-f0-9]{8}$/;

function threadIdOr400(req, res) {
  if (THREAD_ID_RE.test(req.params.id)) return true;
  res.status(400).json({ error: "Invalid conversation id." });
  return false;
}

app.get("/api/founder/threads", (_req, res) => {
  try { res.json(buildThreadsPanel(listThreads(ROOT))); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post("/api/founder/threads", (req, res) => {
  try {
    res.status(201).json({ thread: createThread(ROOT, { agentId: String(req.body?.agentId || "main").trim() }) });
  } catch (e) {
    res.status(e?.statusCode || 500).json({ error: String(e.message || e) });
  }
});

app.get("/api/founder/threads/:id", (req, res) => {
  if (!threadIdOr400(req, res)) return;
  const thread = findThread(ROOT, req.params.id);
  if (!thread) return res.status(404).json({ error: "Conversation not found." });
  res.json(withRenderedReplies(buildThreadsPanel(listThreads(ROOT), { detailId: req.params.id })));
});

app.delete("/api/founder/threads/:id", (req, res) => {
  if (!threadIdOr400(req, res)) return;
  if (!deleteThread(ROOT, req.params.id)) return res.status(404).json({ error: "Conversation not found." });
  res.json({ deleted: req.params.id });
});

// Records the message, then answers in a detached promise — the same shape as
// the question route, because a model turn takes tens of seconds and holding
// the request open for it makes the page look hung.
app.post("/api/founder/threads/:id/turns", (req, res) => {
  if (!threadIdOr400(req, res)) return;
  try {
    const thread = postFounderTurn(ROOT, req.params.id, req.body?.message);
    void runThreadTurn(ROOT, req.params.id, { timeoutMs: FOUNDER_THREAD_TIMEOUT_MS });
    res.status(202).json({ thread });
  } catch (e) {
    res.status(e?.statusCode || 500).json({ error: String(e.message || e) });
  }
});

// The founder's click. `acceptProposal` re-validates and hands back the intent;
// nothing is executed until the handler map — the console's, not a second one —
// is asked for it by name.
app.post("/api/founder/threads/:id/proposals/:turnId/:proposalId/accept", async (req, res) => {
  if (!threadIdOr400(req, res)) return;
  const { id, turnId, proposalId } = req.params;
  try {
    const intent = acceptProposal(ROOT, id, turnId, proposalId);
    const { handlers } = await import("../../scripts/hq-intents.mjs");
    const map = await handlers();
    const handler = Object.prototype.hasOwnProperty.call(map, intent.kind) ? map[intent.kind] : null;
    if (typeof handler !== "function") {
      settleProposal(ROOT, id, turnId, proposalId, { status: "failed", detail: `no handler for ${intent.kind}` });
      return res.status(501).json({ error: `Nothing here can run "${intent.kind}" yet.` });
    }
    try {
      const detail = await handler(intent.args);
      res.json({ thread: settleProposal(ROOT, id, turnId, proposalId, { status: "accepted", detail: String(detail || "done") }) });
    } catch (error) {
      const detail = String(error?.message || error).slice(0, 300);
      settleProposal(ROOT, id, turnId, proposalId, { status: "failed", detail });
      res.status(500).json({ error: detail });
    }
  } catch (e) {
    res.status(e?.statusCode || 500).json({ error: String(e.message || e) });
  }
});

app.get("/api/founder/questions/:id", (req, res) => {
  if (!/^question-[a-z0-9-]+$/i.test(req.params.id)) return res.status(400).json({ error: "Invalid question id." });
  const question = findQuestion(ROOT, req.params.id);
  if (!question) return res.status(404).json({ error: "Question not found." });
  res.json({ question });
});

app.post("/api/founder/decisions/resolve", (req, res) => {
  try {
    const direction = String(req.body?.direction || "").trim();
    if (!req.body?.statePath || !direction) return res.status(400).json({ error: "statePath and direction are required." });
    const task = resolveFounderDecision({ root: ROOT, hqRoot: ROOT, statePath: req.body.statePath, direction });
    res.json({ task });
    // Answering the question has to release the team, not just record the
    // answer. resolveFounderDecision clears the objective node; without this
    // the released node then waits for a sweep, so the founder still sees
    // nothing happen. Detached and after the response, exactly like the
    // recovery-retry route: the orchestrator runs for as long as the pipeline
    // takes and must never hold the HTTP request open.
    // Shared with the intent worker so the hosted console and this route
    // resume identically — see resumeObjectiveAfterDecision.
    resumeObjectiveAfterDecision({ root: ROOT, hqRoot: ROOT, objectiveResume: task?.objectiveResume, runObjective });
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
    const out = enrollFounderKey(ROOT, { publicKeyPem, rotationSignature });
    auditFromRequest(ROOT, req, {
      action: out.rotated ? "approval-key.rotated" : "approval-key.enrolled",
      outcome: "ok",
      details: { fingerprint: out.fingerprint, previousSource: out.previousSource },
    });
    res.json(out);
  } catch (e) {
    auditFromRequest(ROOT, req, { action: "approval-key.enroll", outcome: "denied", reason: String(e.message || e) });
    approvalError(res, e);
  }
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
    // The assertion and its signature are deliberately NOT recorded here; the
    // audit trail attributes the authorization, it does not copy the credential.
    auditFromRequest(ROOT, req, {
      action: "approval.granted",
      outcome: "ok",
      taskId: req.params.taskId,
      details: { status: out.status, currentStage: out.currentStage, resume: out.resume?.kind },
    });
    res.json(out);
  } catch (e) {
    auditFromRequest(ROOT, req, {
      action: "approval.rejected-by-gate",
      outcome: "denied",
      taskId: req.params.taskId,
      reason: String(e.message || e),
    });
    approvalError(res, e);
  }
});

app.post("/api/founder/approvals/:taskId/reject", (req, res) => {
  try {
    if (!APPROVAL_ID.test(req.params.taskId)) return res.status(400).json({ error: "Invalid task id." });
    const out = rejectFounderApproval(ROOT, req.params.taskId, { reason: req.body?.reason || "", statePath: req.body?.statePath });
    auditFromRequest(ROOT, req, {
      action: "approval.declined",
      outcome: "ok",
      taskId: req.params.taskId,
      reason: req.body?.reason || null,
    });
    res.json(out);
  } catch (e) { approvalError(res, e); }
});

app.post("/api/founder/approvals/:taskId/rekey", (req, res) => {
  try {
    if (!APPROVAL_ID.test(req.params.taskId)) return res.status(400).json({ error: "Invalid task id." });
    const out = rekeyPendingApproval(ROOT, req.params.taskId, { statePath: req.body?.statePath });
    auditFromRequest(ROOT, req, {
      action: "approval.rekeyed",
      outcome: "ok",
      taskId: req.params.taskId,
      details: { from: out.from, to: out.to, rekeyed: out.rekeyed },
    });
    res.json(out);
  } catch (e) { approvalError(res, e); }
});

// The founder-readable completion report for one factory task (markdown + html),
// generated by the runner when the task settled. 404 if the task is unknown.
// One merged record of a single run: workflow, audit, liveness, ownership,
// wakeups, cost and graph findings, each entry naming its source. Read-only,
// and evidence is referenced by path — never by content.
app.get("/api/founder/tasks/:id/timeline", (req, res) => {
  try {
    const timeline = buildRunTimeline({ hqRoot: ROOT, taskId: req.params.id });
    if (!timeline) return res.status(404).json({ error: "No such factory task." });
    res.json(timeline);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// The founder's thread on a task. Interaction text is untrusted data: it is
// stored, redacted and attributed here, and nothing in the dispatch path reads
// it. See docs/software-factory/PAPERCLIP_TASK_INTERACTIONS.md.
app.get("/api/founder/tasks/:id/interactions", (req, res) => {
  try {
    const statePath = findTaskStatePath(ROOT, req.params.id);
    if (!statePath) return res.status(404).json({ error: "No such factory task." });
    res.json(buildInteractionThread({ taskDir: dirname(statePath) }));
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// Posting a comment records it and, for a mention of an agent HQ actually has,
// enqueues an identifier-only wakeup. It cannot enqueue anything else: the
// wakeup queue rejects any item carrying a command or payload.
app.post("/api/founder/tasks/:id/interactions", (req, res) => {
  try {
    // Shared with the console's `task.comment` intent so the two cannot drift.
    const result = postTaskComment({
      root: ROOT, hqRoot: ROOT,
      taskId: req.params.id,
      kind: req.body?.kind || "comment",
      body: req.body?.body,
      idempotencyKey: req.body?.idempotencyKey,
    });
    res.status(result.accepted ? 201 : 200).json(result);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: String(e.message || e) });
  }
});

app.get("/api/founder/tasks/:id/report", (req, res) => {
  try {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(req.params.id)) return res.status(400).json({ error: "Invalid task id." });
    const report = readTaskCompletionReport(ROOT, req.params.id);
    if (!report) return res.status(404).json({ error: "No such factory task." });
    res.json({ ...report, html: report.markdown ? renderUntrustedMarkdown(report.markdown) : null });
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
    auditFromRequest(ROOT, req, {
      action: "task.retried",
      outcome: "ok",
      taskId: req.params.id,
      details: { stage: resumed.currentStage },
    });
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(join(ROOT, "factory", "factory.config.json"), "utf8")); } catch { /* defaults */ }
  // Detached on purpose — the 202 below is the answer to this request, and the
  // run outlives it. That is exactly why the failure path has to settle the
  // task here: nothing downstream is waiting on this promise, so a throw that
  // only reaches `console.error` leaves the task `active` with no blocker,
  // looking alive to every founder surface, forever. `recordRunnerCrash` puts
  // it in the Founder Inbox instead; the log line stays for the operator.
  runTaskToTerminal({
    hqRoot: ROOT, statePath,
    agentIds: cfg.openclawIntegration?.agentIds || {},
    maxAttemptsPerStage: cfg.openclawIntegration?.maxAttemptsPerStage || 3,
    concurrentGroups: cfg.openclawIntegration?.concurrentGroups,
  }).catch((error) => {
    console.error("[hq] manual retry failed:", error?.message || error);
    try {
      recordRunnerCrash({ statePath, error });
    } catch (settleError) {
      console.error("[hq] manual retry could not be settled:", settleError?.message || settleError);
    }
  });
  res.status(202).json({ taskId: req.params.id, status: "retrying" });
});

// The founder-readable summary for a whole decomposed objective.
app.get("/api/founder/objectives/:id/report", (req, res) => {
  try {
    if (!/^obj-[a-z0-9-]+$/i.test(req.params.id)) return res.status(400).json({ error: "Invalid objective id." });
    const report = readObjectiveReport(ROOT, req.params.id);
    if (!report) return res.status(404).json({ error: "No such objective." });
    res.json({ ...report, html: report.markdown ? renderUntrustedMarkdown(report.markdown) : null });
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

app.get("/api/hq/operations", (_req, res) => {
  try { res.json(buildOperationsSnapshot({ hqRoot: ROOT })); }
  catch (e) { res.status(500).json({ version: 1, available: false, error: String(e.message || e) }); }
});

// Read-only. Goal definitions are tracked in factory/goals.json and change by
// pull request; there is deliberately no write route, so the dashboard cannot
// become a second place where company intent is edited without review.
// Read-only. Grants live in factory/permissions.json and change by pull
// request; there is no route that can grant a capability to anything.
// Read-only and alert-only. #141 bounds WHICH work an agent may touch; this
// reports HOW MUCH one run actually touched. Nothing here refuses anything --
// the threshold has to be observed against real objective runs before it can
// stop any of them, and enforcement is a separate change with its own evidence.
app.get("/api/hq/blast-radius", (_req, res) => {
  try { res.json(buildBlastRadiusReport({ hqRoot: ROOT })); }
  catch (e) { res.status(500).json({ version: 1, available: false, enforcement: "alert-only", error: String(e.message || e) }); }
});

app.get("/api/hq/permissions", (_req, res) => {
  try { res.json(buildPermissionsSnapshot({ hqRoot: ROOT })); }
  catch (e) { res.status(500).json({ version: 1, available: false, enforcement: "unknown", error: String(e.message || e) }); }
});

// Read-only, and deliberately has no POST sibling. The authority is the
// founder's signed assertion verified in task-workflow.mjs; this only reports
// what already happened.
app.get("/api/hq/decisions", (_req, res) => {
  try { res.json(buildDecisionHistory({ hqRoot: ROOT })); }
  catch (e) { res.status(500).json({ version: 1, available: false, error: String(e.message || e) }); }
});

// Read-only and advisory. Routing lives in factory/factory.config.json; nothing
// here can change where work is sent.
app.get("/api/hq/scorecards", (_req, res) => {
  try { res.json(buildAgentScorecards({ hqRoot: ROOT })); }
  catch (e) { res.status(500).json({ version: 1, available: false, usage: "advisory-only", error: String(e.message || e) }); }
});

// Read-only. Reports what could be pruned and never prunes; deletion is an
// operator action at the terminal with an exact confirmed count.
app.get("/api/hq/retention", (_req, res) => {
  try { res.json(buildRetentionSnapshot({ hqRoot: ROOT, backupDir: process.env.FACTORY_BACKUP_DIR || null })); }
  catch (e) { res.status(500).json({ version: 1, available: false, destructiveActionsRequireOperator: true, error: String(e.message || e) }); }
});

// Read-only, and a filter rather than a reader: every layer is an existing
// projection, searched with the same sanitisation the corresponding panel
// applies. Nothing here can surface a prompt, an agent's raw result, or any
// file the panels do not already show. A bad query is a 400 with the reason,
// never a 500 and never a wider read.
app.get("/api/hq/search", (req, res) => {
  let layers;
  try {
    layers = parseLayers(req.query.layers);
  } catch (e) {
    return res.status(400).json({ version: 1, available: false, error: String(e.message || e) });
  }
  try {
    res.json(searchHq({ hqRoot: ROOT, query: req.query.q, layers, limit: req.query.limit }));
  } catch (e) {
    // A rejected query is the caller's problem to fix, so say which.
    const message = String(e.message || e);
    const badQuery = /query (must be|has no)/.test(message);
    res.status(badQuery ? 400 : 500).json({ version: 1, available: false, error: message });
  }
});

app.get("/api/hq/goals", (_req, res) => {
  try { res.json(buildGoalsSnapshot({ hqRoot: ROOT })); }
  catch (e) { res.status(500).json({ version: 1, available: false, error: String(e.message || e) }); }
});

app.get("/api/hq/factory-report", (_req, res) => {
  try { res.json(buildFactoryReportSnapshot({ hqRoot: ROOT })); }
  catch (e) { res.status(500).json({ version: 1, available: false, metrics: [], error: String(e.message || e) }); }
});

// Read-only and alert-only. Policies are tracked in factory/budgets.json and
// change by pull request; nothing here can raise a limit, and crossing one
// reports rather than stopping any work.
// Report-only. Ranks work that already exists in canonical state; it proposes
// and never promotes, so there is deliberately no write route here — queueing a
// proposal stays the founder's action through the overnight queue.
app.get("/api/hq/proposals", (_req, res) => {
  try { res.json(buildWorkProposals({ hqRoot: ROOT })); }
  catch (e) { res.status(500).json({ version: 1, available: false, reportOnly: true, proposals: [], error: String(e.message || e) }); }
});

app.get("/api/hq/budgets", (_req, res) => {
  try { res.json(buildBudgetSnapshot({ hqRoot: ROOT })); }
  catch (e) { res.status(500).json({ version: 1, available: false, enforcement: "alert-only", error: String(e.message || e) }); }
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

// The health report both surfaces render.
//
// `/api/system/readiness` above is the dashboard's own, deeper check and stays
// as it is. It cannot be the published one: it takes this process's SQLite
// handle and reads `dashboard/backend/lib/`, and `factory/` must not import
// from `dashboard/`. So the factory-side snapshot is the shared base — it is
// what the publisher sends to the console — and this route adds the one check
// only the dashboard can make, so the local panel is a superset rather than a
// second, differently-shaped answer to the same question.
app.get("/api/hq/readiness", async (_req, res) => {
  try {
    const snapshot = await buildReadinessSnapshot({ hqRoot: ROOT });
    let database = { status: "ok", detail: "the dashboard database answers queries" };
    try {
      db.prepare("SELECT 1 AS ok").get();
    } catch (e) {
      database = { status: "fail", detail: `the dashboard database did not answer: ${String(e.message || e)}` };
    }
    const checks = { ...snapshot.checks, database };
    res.json({
      ...snapshot,
      checks,
      status: rollUpReadiness(checks),
      warnings: database.status === "fail" ? [...snapshot.warnings, `database: ${database.detail}`] : snapshot.warnings,
    });
  } catch (e) {
    res.status(500).json({ version: 1, available: false, readOnly: true, status: "unknown", checks: {}, warnings: [], error: String(e.message || e) });
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

// The whole estate in one read. The per-project route below answers for one
// project and needs the caller to know which; the Today view needs the opposite.
// Read-only: deploying is a gated factory action, and nothing here can start one.
app.get("/api/hq/deployments", (_req, res) => {
  try { res.json(buildDeploymentsSnapshot({ hqRoot: ROOT })); }
  catch (e) { res.status(500).json({ version: 1, available: false, readOnly: true, deployments: [], error: String(e.message || e) }); }
});

app.get("/api/hq/projects/:id/deployment", (req, res) => {
  try {
    res.json(readDeploymentStatus({ hqRoot: ROOT, projectKey: req.params.id }));
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

// `agents` is the only collection left: a fallback roster for an install with
// no factory/agents.json. `tasks`, `sops`, `reports` and `logs` were retired
// on 2026-09-15 along with the four pages that read them — each was a 3-byte
// empty array that nothing ever wrote to.
for (const name of ["agents"]) {
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

// `/api/runs` and `/api/runs/:runId` were removed on 2026-09-15 with the Runs
// and Logs pages that were their only callers. Both read `agent_runs`, a
// pre-factory table holding a single row; the factory records its work in the
// task state store, and the execution view renders that. Agent Lab's own
// last-run lookup (`/api/agents/:project/:id`) is unaffected and still reads
// the table directly.
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
      html: renderUntrustedMarkdown(md),
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
    auditFromRequest(ROOT, req, {
      action: `process.${action}`,
      outcome: "ok",
      details: { project: req.params.project, agent: req.params.id },
    });

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
    auditFromRequest(ROOT, req, {
      action: "config.updated",
      outcome: "ok",
      details: { project: req.params.project, agent: req.params.id, keys: Object.keys(body.config).slice(0, 40) },
    });
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

// The founder-facing vocabulary is ONE physical file, shared with the hosted
// console rather than copied into it. Vercel serves it from control-plane/public/;
// this maps the same path on disk into the local dashboard's module space. A
// copy kept in step by discipline is how the two consoles came to disagree —
// the local one said "Shaping the outcome" while the hosted one said "product".
app.get("/lib/board.mjs", (req, res) => {
  res.type("text/javascript").sendFile(join(ROOT, "control-plane", "public", "board.mjs"));
});

app.get("/lib/stage-vocabulary.mjs", (req, res) => {
  res.type("text/javascript").sendFile(join(ROOT, "control-plane", "public", "stage-vocabulary.mjs"));
});

app.use(express.static(join(__dirname, "public")));

app.get("/", (_req, res) => {
  res.redirect("/index.html");
});

checkBootConfig();

app.listen(PORT, HOST, () => {
  console.log(`[agent-lab] dashboard http://${HOST}:${PORT} (root=${ROOT})`);
  resumePendingFounderQuestions();
  const strandedThreads = failStrandedThreads(ROOT);
  if (strandedThreads) console.log(`[chat] ${strandedThreads} conversation(s) were mid-answer at restart; marked failed`);
  resumeStrandedObjectivesOnBoot();
});

// The orchestrator runs inside THIS process, so restarting it abandons every
// objective that was mid-flight — their nodes keep the status they held when
// the process died and nothing looks at them again. The task-level auto-retry
// sweep cannot see them: a node that was never dispatched has no state file,
// and a node abandoned mid-run is not `blocked`.
//
// It used to run only at boot, on the theory that boot is the one moment
// nothing can be running. That left two holes, and obj-154e9b39 fell into the
// first on 2026-09-16: a stage written three minutes before a restart read as
// "still live", and with no second look the objective sat "Running" for eleven
// hours. Every run now records its owning process (objective/runner-lease.mjs),
// so a dead owner is recognised at once and a live one is never adopted — which
// is also what makes it safe to repeat the sweep on a timer.
//
// It also used to report only "none stranded", which hid exactly that case.
// Every unfinished objective it leaves alone is now logged with the reason.
//
// Disable with HQ_RESUME_OBJECTIVES=0.
const QUIET_SKIP = /^objective is (cancelled|complete|completed|superseded)$|^no node is ready to run$|^run in progress|^left for boot/;

function resumeStrandedObjectivesSweep(when) {
  const stateRoot = join(ROOT, "dashboard", "backend", "data", "factory");
  return resumeStrandedObjectives({
    hqRoot: ROOT,
    stateRoot,
    runObjective,
    mode: when === "boot" ? "boot" : "periodic",
    max: Math.max(1, Number(process.env.HQ_RESUME_OBJECTIVES_MAX) || 10),
    log: (message) => console.log(message),
  })
    .then(({ scanned, resumed, skipped }) => {
      for (const entry of skipped) {
        if (!QUIET_SKIP.test(entry.reason || "")) {
          console.log(`[objective-reconcile] left ${entry.objectiveId || entry.objectivePath} alone: ${entry.reason}`);
        }
      }
      if (resumed.length) {
        console.log(`[objective-reconcile] ${when}: resumed ${resumed.length} of ${scanned} objective(s); ${skipped.length} left alone`);
      } else if (when === "boot") {
        console.log(`[objective-reconcile] ${when}: ${scanned} objective(s) scanned, none to resume`);
      }
    })
    .catch((error) => console.error(`[objective-reconcile] ${when} sweep failed:`, error?.message || error));
}

function resumeStrandedObjectivesOnBoot() {
  if (process.env.HQ_RESUME_OBJECTIVES === "0") {
    console.log("[objective-reconcile] disabled by HQ_RESUME_OBJECTIVES=0");
    return;
  }
  resumeStrandedObjectivesSweep("boot");
  const intervalMs = Math.max(60_000, Number(process.env.HQ_RESUME_OBJECTIVES_INTERVAL_MS) || 10 * 60_000);
  let sweeping = false;
  setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    resumeStrandedObjectivesSweep("periodic").finally(() => { sweeping = false; });
  }, intervalMs).unref();
  console.log(`[objective-reconcile] re-checking every ${Math.round(intervalMs / 60_000)} min`);
}

// ── Auto-retry sweep ─────────────────────────────────────────────────────────
// Infra failures (no result file, timeout, provider 5xx) should recover on
// their own, not sit in the Founder Inbox. Every few minutes, resume tasks
// blocked on an infra-class failure and drive them again — bounded per task.
// Disable with HQ_AUTO_RETRY=0. hq-state-watchdog can also halt it at runtime
// by writing AUTO_RETRY_HALTED.json into the state root; delete it to resume.
if (process.env.HQ_AUTO_RETRY !== "0") {
  const FACTORY_STATE_ROOT = join(ROOT, "dashboard", "backend", "data", "factory");
  const intervalMs = Math.max(60_000, Number(process.env.HQ_AUTO_RETRY_INTERVAL_MS) || 180_000);
  const maxPerTask = Math.max(1, Number(process.env.HQ_AUTO_RETRY_MAX) || 3);
  let sweeping = false;
  const sweep = async () => {
    if (sweeping) return;
    const halt = readAutoRetryHalt(FACTORY_STATE_ROOT);
    if (halt) {
      console.warn(`[auto-retry] halted by watchdog since ${halt.haltedAt || "unknown"}: ${halt.reason}`);
      return;
    }
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

// Human-merge mode ends outside the factory: the founder merges the pull
// request on GitHub. Without this the task never learns, stays `merge-ready`
// forever, and the founder's view of the company fills up with work that
// shipped days ago. The sweep only reads GitHub and only settles tasks that
// are already finished — it merges nothing and advances no stage.
if (process.env.HQ_MERGE_RECONCILE !== "0") {
  const FACTORY_STATE_ROOT = join(ROOT, "dashboard", "backend", "data", "factory");
  const intervalMs = Math.max(60_000, Number(process.env.HQ_MERGE_RECONCILE_INTERVAL_MS) || 300_000);
  let reconciling = false;
  const reconcile = async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      const out = await reconcileMergedTasks({ stateRoot: FACTORY_STATE_ROOT, log: (m) => console.log(m) });
      if (out.merged.length) console.log(`[merge-reconcile] settled ${out.merged.length} merged task(s) of ${out.scanned} state files`);
    } catch (error) {
      console.error("[merge-reconcile] sweep failed:", error?.message || error);
    } finally {
      reconciling = false;
    }
  };
  setTimeout(reconcile, 30_000).unref();
  setInterval(reconcile, intervalMs).unref();
  console.log(`[merge-reconcile] enabled — every ${Math.round(intervalMs / 1000)}s`);
}
