// The operator principal ("dot"): a Bearer token that can read founder views
// and file tasks, and nothing else.
//
// These run against a real express app over a real loopback socket, wired with
// the same middleware, in the same order, as dashboard/backend/server.mjs. The
// last tests pin that order in server.mjs itself, so the miniature here cannot
// drift from the real chain without a failure.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dashboardRequire = createRequire(new URL("../../dashboard/backend/package.json", import.meta.url));
let express = null;
let session = null;
try {
  express = dashboardRequire("express");
  session = dashboardRequire("express-session");
} catch { /* reported by the skip below */ }
const skip = express && session ? false : "dashboard dependencies are not installed";

import {
  OPERATOR_ROUTES,
  createOperator,
  findOperatorByToken,
  forwardingHeaderOf,
  hashToken,
  isLoopbackSocket,
  matchOperatorRoute,
  operatorAuthGate,
  readOperatorStore,
  revokeOperator,
  unlessOperator,
} from "../../dashboard/backend/lib/operatorAuth.mjs";
import { decideOperatorSubmission, operatorLedgerPath, OPERATOR_DAILY_CAP } from "../../dashboard/backend/lib/operatorSubmission.mjs";
import { csrfProtection, issueCsrfToken } from "../../dashboard/backend/lib/httpSecurity.mjs";
import { auditFromRequest, readSecurityEvents, recordSecurityEvent } from "../../dashboard/backend/lib/securityAudit.mjs";
import { buildFounderOverview, listFounderJobs, recordQuestion, saveFounderJob, setProjectPaused } from "../../dashboard/backend/lib/founderControlPlane.mjs";
import { readProjects } from "../../dashboard/backend/lib/hqStore.mjs";
import { buildOperatorOverview } from "../../dashboard/backend/lib/operatorViews.mjs";
import { DUPLICATE_JOB_WINDOW_MS } from "../../dashboard/backend/lib/founderControlPlane.mjs";
import { planRequest, run as runOperatorCli } from "../../scripts/hq-operator.mjs";
import { run as runTokenCli } from "../../scripts/hq-operator-token.mjs";

const SERVER = new URL("../../dashboard/backend/server.mjs", import.meta.url);
const serverSource = readFileSync(SERVER, "utf8");

// ── fixtures ─────────────────────────────────────────────────────────────────

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "operator-auth-"));
  const repo = join(root, "repos", "alpha");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(root, "factory"), { recursive: true });
  writeFileSync(join(root, "factory", "projects.json"), JSON.stringify({
    version: 1,
    projects: [
      { key: "alpha", name: "Alpha", repo, status: "active" },
      { key: "beta", name: "Beta", repo, status: "active" },
      { key: "frozen", name: "Frozen", repo, status: "paused" },
    ],
  }));
  const storePath = join(root, "secrets", "operators.json");
  const { token } = createOperator(storePath, { id: "dot" });
  return { root, repo, storePath, token };
}

function writeObjective(root, objectiveId, status, nodes = {}) {
  const dir = join(root, "dashboard", "backend", "data", "factory", "alpha", "objectives", objectiveId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "objective-state.json"), JSON.stringify({
    version: 1, objectiveId, objective: "Seeded objective", project: "alpha", repo: join(root, "repos", "alpha"), status, nodes,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [],
  }));
}

function writeTask(root, taskId, status) {
  const dir = join(root, "dashboard", "backend", "data", "factory", "alpha", "tasks", taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1, task: { id: taskId, outcome: "Seeded task" }, status, stages: {}, events: [] }));
}

// The miniature dashboard: server.mjs's chain, in server.mjs's order.
function buildApp(fx, { launches = [] } = {}) {
  const app = express();
  app.use(express.json());
  app.use(operatorAuthGate({ root: fx.root, storePath: () => fx.storePath }));
  app.use(session({ name: "agentlab.sid", secret: "test-secret-not-a-real-one", resave: false, saveUninitialized: false }));
  app.use(unlessOperator(csrfProtection({ exemptPaths: ["/api/auth/login"] })));
  app.post("/api/auth/login", (req, res) => {
    req.session.authenticated = true;
    res.json({ csrfToken: issueCsrfToken(req.session) });
  });
  app.use(unlessOperator((req, res, next) => (req.session?.authenticated ? next() : res.status(401).json({ error: "Unauthorized" }))));

  app.get("/api/founder/overview", (req, res) => {
    if (req.operator) return res.json(buildOperatorOverview(fx.root));
    const overview = buildFounderOverview(fx.root, readProjects(fx.root));
    res.json({ ...overview, jobs: listFounderJobs(fx.root) });
  });

  app.post("/api/founder/tasks", (req, res) => {
    if (req.operator) {
      const decision = decideOperatorSubmission({
        root: fx.root,
        operator: req.operator,
        body: req.body,
        idempotencyKey: req.get("idempotency-key"),
        launch: (input) => {
          launches.push(input);
          return saveFounderJob(fx.root, {
            id: `founder-${launches.length}`, kind: "task", projectId: input.projectId, objective: input.objective,
            repo: input.repo, status: "starting", submittedBy: input.submittedBy, createdAt: new Date().toISOString(),
          });
        },
      });
      for (const [name, value] of Object.entries(decision.headers || {})) res.setHeader(name, value);
      res.locals.operatorReason = decision.body?.reason || null;
      return res.status(decision.status).json(decision.body);
    }
    // The founder path: whatever it was before, including repo and allowDuplicate.
    auditFromRequest(fx.root, req, { action: "founder.task", outcome: "ok" });
    return res.status(202).json({ founder: true, repo: req.body?.repo || null, allowDuplicate: Boolean(req.body?.allowDuplicate) });
  });
  // Everything else answers 200, so a 401/403 can only have come from the gate.
  app.all(/.*/, (req, res) => res.json({ reached: req.path, operator: req.operator?.id || null, founderSession: Boolean(req.session?.authenticated) }));
  return app;
}

async function withServer(fx, fn, options) {
  const app = buildApp(fx, options);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withEnabled(value, fn) {
  const previous = process.env.HQ_OPERATOR_ENABLED;
  if (value === undefined) delete process.env.HQ_OPERATOR_ENABLED;
  else process.env.HQ_OPERATOR_ENABLED = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.HQ_OPERATOR_ENABLED;
    else process.env.HQ_OPERATOR_ENABLED = previous;
  }
}

function bearer(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

async function submit(base, token, body, key, extra = {}) {
  const headers = bearer(token, { "Content-Type": "application/json", ...extra });
  if (key) headers["Idempotency-Key"] = key;
  const response = await fetch(`${base}/api/founder/tasks`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

// Every route server.mjs registers, with sample values for its params.
function serverRoutes() {
  const routes = [];
  const pattern = /app\.(get|post|put|patch|delete)\(\s*[`"]([^`"]+)[`"]/g;
  for (const match of serverSource.matchAll(pattern)) {
    const path = match[2]
      .replace("${name}", "agents")
      .replace(/:taskId|:id/g, "task-abc123")
      .replace(/:project/g, "alpha")
      .replace(/:action/g, "restart")
      .replace(/:file/g, "AGENTS.md")
      .replace(/:turnId|:proposalId/g, "x1");
    routes.push({ method: match[1].toUpperCase(), path, source: match[2] });
  }
  return routes;
}

// ── authentication ───────────────────────────────────────────────────────────

test("no token, a bad token and a revoked token are all 401", { skip }, async () => {
  const fx = makeRoot();
  await withEnabled("1", () => withServer(fx, async (base) => {
    const url = `${base}/api/founder/overview`;
    assert.equal((await fetch(url, { headers: { Authorization: "Bearer" } })).status, 401, "empty bearer");
    assert.equal((await fetch(url, { headers: bearer("hqop_not-a-real-token") })).status, 401, "bad token");
    assert.equal((await fetch(url, { headers: bearer(fx.token) })).status, 200, "valid token");
    revokeOperator(fx.storePath, "dot");
    assert.equal((await fetch(url, { headers: bearer(fx.token) })).status, 401, "revoked token, without a restart");
  }));
  // And no header at all is the cookie path, which has no session: 401 there too.
  await withEnabled("1", () => withServer(fx, async (base) => {
    assert.equal((await fetch(`${base}/api/founder/overview`)).status, 401);
  }));
});

test("with HQ_OPERATOR_ENABLED unset (or anything but 1) a valid token is 401", { skip }, async () => {
  const fx = makeRoot();
  for (const value of [undefined, "0", "true", ""]) {
    await withEnabled(value, () => withServer(fx, async (base) => {
      const response = await fetch(`${base}/api/founder/overview`, { headers: bearer(fx.token) });
      assert.equal(response.status, 401, `HQ_OPERATOR_ENABLED=${value}`);
      assert.equal((await response.json()).reason, "operator_disabled");
    }));
  }
});

test("a valid token with any forwarding header is refused", { skip }, async () => {
  const fx = makeRoot();
  await withEnabled("1", () => withServer(fx, async (base) => {
    for (const header of ["X-Forwarded-For", "X-Forwarded-Proto", "X-Forwarded-Host", "Forwarded", "Cf-Connecting-Ip", "CF-Ray", "X-Real-Ip"]) {
      const response = await fetch(`${base}/api/founder/overview`, { headers: bearer(fx.token, { [header]: "127.0.0.1" }) });
      assert.equal(response.status, 403, header);
      assert.equal((await response.json()).reason, "forwarded_request", header);
    }
  }));
});

test("loopback is judged by the socket address, never req.ip or a header", () => {
  assert.equal(isLoopbackSocket({ socket: { remoteAddress: "127.0.0.1" } }), true);
  assert.equal(isLoopbackSocket({ socket: { remoteAddress: "::1" } }), true);
  assert.equal(isLoopbackSocket({ socket: { remoteAddress: "::ffff:127.0.0.1" } }), true);
  assert.equal(isLoopbackSocket({ ip: "127.0.0.1", socket: { remoteAddress: "192.168.1.20" } }), false);
  assert.equal(isLoopbackSocket({ socket: {} }), false);
  assert.equal(forwardingHeaderOf({ headers: { "cf-ipcountry": "BR" } }), "cf-ipcountry");
  assert.equal(forwardingHeaderOf({ headers: { host: "127.0.0.1" } }), null);
});

test("a token on a non-loopback socket is 403", async () => {
  const fx = makeRoot();
  let status = null;
  let body = null;
  const res = {
    statusCode: 200, locals: {}, on() {},
    status(code) { status = code; this.statusCode = code; return this; },
    json(value) { body = value; return this; },
  };
  await withEnabled("1", async () => {
    operatorAuthGate({ root: fx.root, storePath: () => fx.storePath })(
      { method: "GET", path: "/api/founder/overview", headers: { authorization: `Bearer ${fx.token}` }, socket: { remoteAddress: "10.0.0.5" } },
      res,
      () => assert.fail("must not reach the route"),
    );
  });
  assert.equal(status, 403);
  assert.equal(body.reason, "not_loopback");
});

// ── default deny ─────────────────────────────────────────────────────────────

test("a valid token reaches the nine allowlisted routes", { skip }, async () => {
  const fx = makeRoot();
  await withEnabled("1", () => withServer(fx, async (base) => {
    for (const route of OPERATOR_ROUTES.filter((r) => r.method === "GET")) {
      const path = route.path.replace(":id", route.path.includes("objectives/") ? "obj-1234abcd" : "task-abc123");
      const response = await fetch(`${base}${path}`, { headers: bearer(fx.token) });
      assert.equal(response.status, 200, path);
      const body = await response.json();
      if (path === "/api/founder/overview") assert.deepEqual(Object.keys(body).sort(), ["jobs", "objectives", "projects"]);
      else assert.equal(body.operator, "dot", path);
    }
  }));
  assert.equal(OPERATOR_ROUTES.length, 9);
});

test("a valid token on every other route server.mjs registers is 403", { skip }, async () => {
  const fx = makeRoot();
  const routes = serverRoutes();
  // Sanity: the parse found the server's real surface, including the routes
  // this design exists to keep out of reach.
  assert.ok(routes.length > 80, `parsed ${routes.length} routes`);
  for (const must of ["/api/founder/tasks/:id/retry", "/api/founder/objectives/:id/cancel", "/api/founder/decisions/approve",
    "/api/admin/agents/:project/:id/pm2/:action", "/api/hq/company", "/api/founder/approvals/:taskId/submit"]) {
    assert.ok(routes.some((r) => r.source === must), `route list includes ${must}`);
  }
  const denied = routes.filter((r) => !matchOperatorRoute(r.method, r.path));
  assert.equal(routes.length - denied.length, 9, "exactly the nine allowlisted routes match");
  await withEnabled("1", () => withServer(fx, async (base) => {
    for (const route of denied) {
      const response = await fetch(`${base}${route.path}`, {
        method: route.method,
        headers: bearer(fx.token, { "Content-Type": "application/json" }),
        body: route.method === "GET" ? undefined : "{}",
      });
      assert.equal(response.status, 403, `${route.method} ${route.source}`);
    }
    // Method, case and suffix variations of allowlisted paths are denied too.
    for (const [method, path] of [["HEAD", "/api/founder/overview"], ["POST", "/api/founder/overview"], ["GET", "/API/founder/overview"],
      ["GET", "/api/founder/overview/"], ["PUT", "/api/founder/tasks"], ["GET", "/api/founder/tasks/x/evidence/extra"],
      ["POST", "/api/founder/tasks/task-abc123/retry"], ["GET", "/api/founder/tasks/..%2Fx/report"]]) {
      const response = await fetch(`${base}${path}`, { method, headers: bearer(fx.token) });
      assert.equal(response.status, 403, `${method} ${path}`);
    }
  }));
});

test("a token never rides a founder session cookie", { skip }, async () => {
  const fx = makeRoot();
  await withEnabled("1", () => withServer(fx, async (base) => {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST" });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    // With a founder cookie, a retry is reachable — but not once a token is attached.
    assert.equal((await fetch(`${base}/api/founder/tasks/t-1/retry`, { method: "GET", headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/founder/tasks/t-1/retry`, { method: "GET", headers: bearer(fx.token, { Cookie: cookie }) })).status, 403);
    // On an allowed route the handler sees the operator, and no founder session.
    const allowed = await (await fetch(`${base}/api/founder/tasks/t-1/report`, { headers: bearer(fx.token, { Cookie: cookie }) })).json();
    assert.deepEqual([allowed.operator, allowed.founderSession], ["dot", false]);
    assert.equal((await fetch(`${base}/api/hq/company`, { headers: bearer("hqop_bogus", { Cookie: cookie }) })).status, 401);
  }));
  await withEnabled(undefined, () => withServer(fx, async (base) => {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST" });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal((await fetch(`${base}/api/founder/overview`, { headers: bearer(fx.token, { Cookie: cookie }) })).status, 401);
  }));
});

// ── the submission guard ─────────────────────────────────────────────────────

test("repo, allowDuplicate, unknown fields, unknown and paused projects are rejected by name", { skip }, async () => {
  const fx = makeRoot();
  setProjectPaused(fx.root, "beta", true);
  await withEnabled("1", () => withServer(fx, async (base) => {
    const cases = [
      [{ projectId: "alpha", objective: "x", repo: "/etc" }, 400, "repo_not_allowed"],
      [{ projectId: "alpha", objective: "x", allowDuplicate: true }, 400, "allow_duplicate_not_allowed"],
      [{ projectId: "alpha", objective: "x", allowDuplicate: false }, 400, "allow_duplicate_not_allowed"],
      [{ projectId: "alpha", objective: "x", stateRoot: "/tmp" }, 400, "unknown_field"],
      [{ projectId: "nope", objective: "x" }, 400, "unknown_project"],
      [{ projectId: "frozen", objective: "x" }, 409, "project_paused"],
      [{ projectId: "beta", objective: "x" }, 409, "project_paused"],
      [{ projectId: "alpha", objective: "x", issue: "1; rm -rf /" }, 400, "invalid_issue"],
      [{ projectId: "alpha" }, 400, "objective_required"],
    ];
    for (const [body, status, reason] of cases) {
      const response = await submit(base, fx.token, body, `key-${reason}-${status}`);
      assert.equal(response.status, status, JSON.stringify(body));
      assert.equal(response.body.reason, reason, JSON.stringify(body));
    }
    const noKey = await submit(base, fx.token, { projectId: "alpha", objective: "x" }, null);
    assert.equal(noKey.status, 400);
    assert.equal(noKey.body.reason, "idempotency_key_required");
  }));
  assert.equal(listFounderJobs(fx.root).length, 0, "nothing was started");
});

test("the same Idempotency-Key twice creates exactly one job; a different body is 409", { skip }, async () => {
  const fx = makeRoot();
  const launches = [];
  await withEnabled("1", () => withServer(fx, async (base) => {
    const body = { projectId: "alpha", objective: "Add a health endpoint", issue: 12 };
    const first = await submit(base, fx.token, body, "dot-req-0001");
    assert.equal(first.status, 202);
    assert.deepEqual(Object.keys(first.body).sort(), ["jobId", "requestId", "status"]);
    // Key order does not change the body.
    const replay = await submit(base, fx.token, { issue: 12, objective: "Add a health endpoint", projectId: "alpha" }, "dot-req-0001");
    assert.equal(replay.status, 202);
    assert.deepEqual(replay.body, first.body);
    assert.equal(replay.headers.get("idempotent-replay"), "true");
    const conflict = await submit(base, fx.token, { ...body, objective: "Something else" }, "dot-req-0001");
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.reason, "idempotency_key_reused");
  }, { launches }));
  assert.equal(launches.length, 1);
  assert.equal(listFounderJobs(fx.root).length, 1);
  // The launch is repo-from-registry and carries the principal.
  assert.equal(launches[0].repo, fx.repo);
  assert.equal(launches[0].submittedBy, "operator:dot");
  assert.equal(listFounderJobs(fx.root)[0].submittedBy, "operator:dot");
  const ledger = JSON.parse(readFileSync(operatorLedgerPath(fx.root), "utf8"));
  assert.equal(ledger.submissions.length, 1);
  assert.equal(ledger.submissions[0].principal, "operator:dot");
  assert.equal(ledger.submissions[0].key, "dot-req-0001");
  assert.match(ledger.submissions[0].bodyHash, /^[0-9a-f]{64}$/);
  assert.equal(statSync(operatorLedgerPath(fx.root)).mode & 0o777, 0o600);
});

test("busy: refused while a founder job is live by canonical state, allowed once it is canonically finished", { skip }, async () => {
  const fx = makeRoot();
  writeObjective(fx.root, "obj-0000live", "active");
  saveFounderJob(fx.root, { id: "founder-live", kind: "objective", projectId: "beta", objective: "other work", status: "running", objectiveId: "obj-0000live", createdAt: new Date().toISOString() });
  await withEnabled("1", () => withServer(fx, async (base) => {
    const response = await submit(base, fx.token, { projectId: "alpha", objective: "New work" }, "dot-busy-0001");
    assert.equal(response.status, 409);
    assert.equal(response.body.status, "busy");
    assert.equal(response.body.activeJob.id, "founder-live");
    assert.equal(response.body.activeJob.canonical.source, "objective");
  }));
  assert.equal(listFounderJobs(fx.root).length, 1, "nothing new started");

  // A stranded record: the job still SAYS running, but its objective is complete.
  const stale = makeRoot();
  writeObjective(stale.root, "obj-0000done", "complete");
  saveFounderJob(stale.root, { id: "founder-stale", kind: "objective", projectId: "beta", objective: "old work", status: "running", objectiveId: "obj-0000done", createdAt: new Date().toISOString() });
  saveFounderJob(stale.root, { id: "founder-old", kind: "task", projectId: "beta", objective: "older", status: "starting", createdAt: new Date(Date.now() - 7 * 3600_000).toISOString() });
  saveFounderJob(stale.root, { id: "founder-finished", kind: "task", projectId: "beta", objective: "done", status: "complete", createdAt: new Date().toISOString() });
  await withEnabled("1", () => withServer(stale, async (base) => {
    const response = await submit(base, stale.token, { projectId: "alpha", objective: "New work" }, "dot-busy-0002");
    assert.equal(response.status, 202, JSON.stringify(response.body));
  }));
});

test("the existing duplicate check runs with no bypass", () => {
  const fx = makeRoot();
  // A job with no state yet (still in intake) on another project would also be
  // busy; seed one that is NOT live so only the duplicate check can fire.
  saveFounderJob(fx.root, { id: "founder-dup", kind: "task", projectId: "alpha", objective: "Same thing", status: "running", objectiveId: "obj-0000gone", createdAt: new Date().toISOString() });
  writeObjective(fx.root, "obj-0000gone", "complete");
  const decision = decideOperatorSubmission({
    root: fx.root, operator: { id: "dot", actor: "operator:dot" }, body: { projectId: "alpha", objective: "  same   THING " },
    idempotencyKey: "dot-dup-0001", launch: () => assert.fail("must not launch"),
  });
  assert.equal(decision.status, 409);
  assert.equal(decision.body.reason, "duplicate_request");
});

test(`at most ${OPERATOR_DAILY_CAP} accepted submissions per rolling 24h, then 429`, () => {
  const fx = makeRoot();
  const now = Date.now();
  const launch = (input) => saveFounderJob(fx.root, { id: `founder-${input.requestId}`, kind: "task", ...input, status: "complete", createdAt: new Date(now).toISOString() });
  const operator = { id: "dot", actor: "operator:dot" };
  for (let i = 0; i < OPERATOR_DAILY_CAP; i += 1) {
    const decision = decideOperatorSubmission({ root: fx.root, operator, body: { projectId: "alpha", objective: `work ${i}` }, idempotencyKey: `dot-cap-${i}-xxxx`, launch, now });
    assert.equal(decision.status, 202, `submission ${i}`);
  }
  const over = decideOperatorSubmission({ root: fx.root, operator, body: { projectId: "alpha", objective: "one more" }, idempotencyKey: "dot-cap-over-xxxx", launch, now });
  assert.equal(over.status, 429);
  assert.equal(over.body.reason, "daily_cap_reached");
  assert.ok(Number(over.headers["Retry-After"]) > 0);
  // A replay of an accepted key is not a new submission and still answers.
  const replay = decideOperatorSubmission({ root: fx.root, operator, body: { projectId: "alpha", objective: "work 0" }, idempotencyKey: "dot-cap-0-xxxx", launch, now });
  assert.equal(replay.status, 202);
  // The window rolls.
  const tomorrow = decideOperatorSubmission({ root: fx.root, operator, body: { projectId: "alpha", objective: "next day" }, idempotencyKey: "dot-cap-next-xxxx", launch, now: now + 24 * 3600_000 + 1000 });
  assert.equal(tomorrow.status, 202);
});

// ── audit ────────────────────────────────────────────────────────────────────

test("every operator request is audited as operator:<id>, denials included, and the token is never written", { skip }, async () => {
  const fx = makeRoot();
  await withEnabled("1", () => withServer(fx, async (base) => {
    await fetch(`${base}/api/founder/overview`, { headers: bearer(fx.token) });
    await fetch(`${base}/api/founder/tasks/t-1/retry`, { method: "POST", headers: bearer(fx.token) });
    await fetch(`${base}/api/founder/overview`, { headers: bearer(fx.token, { "X-Forwarded-For": "1.2.3.4" }) });
    await fetch(`${base}/api/founder/overview`, { headers: bearer("hqop_wrong-token-value-here") });
    await submit(base, fx.token, { projectId: "alpha", objective: "x", repo: "/" }, "dot-audit-0001");
    // Responses are flushed before "finish" fires on the server; let it land.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }));
  const rows = readSecurityEvents(fx.root, { action: "operator.request" }).reverse();
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => [r.actor, r.outcome, r.reason || null, r.details.status]), [
    ["operator:dot", "ok", null, 200],
    ["operator:dot", "denied", "route_not_allowed", 403],
    ["operator:unknown", "denied", "forwarded_request", 403],
    ["operator:unknown", "denied", "unknown_token", 401],
    ["operator:dot", "denied", "repo_not_allowed", 400],
  ]);
  const raw = readFileSync(join(fx.root, "dashboard", "backend", "data", "factory", "security-audit.jsonl"), "utf8");
  assert.ok(!raw.includes(fx.token), "token never in the audit file");
  assert.ok(!raw.includes(fx.token.slice(5, 25)), "no fragment of it either");
});

test("securityAudit takes the actor as a parameter; the founder default is unchanged", () => {
  const fx = makeRoot();
  assert.equal(recordSecurityEvent(fx.root, { action: "a" }).actor, "founder");
  assert.equal(recordSecurityEvent(fx.root, { action: "b" }, { actor: "operator:dot" }).actor, "operator:dot");
  assert.equal(auditFromRequest(fx.root, { operator: { actor: "operator:dot" }, socket: { remoteAddress: "127.0.0.1" }, headers: {} }, { action: "c" }).actor, "operator:dot");
  assert.equal(auditFromRequest(fx.root, { ip: "127.0.0.1", headers: {} }, { action: "d" }).actor, "founder");
});

// ── cookie behaviour is unchanged ────────────────────────────────────────────

test("cookie-authenticated founder behaviour is unchanged", { skip }, async () => {
  const fx = makeRoot();
  for (const enabled of ["1", undefined]) {
    await withEnabled(enabled, () => withServer(fx, async (base) => {
      const login = await fetch(`${base}/api/auth/login`, { method: "POST" });
      const cookie = login.headers.get("set-cookie").split(";")[0];
      const { csrfToken } = await login.json();
      const headers = { Cookie: cookie, "Content-Type": "application/json", Origin: base };
      // The founder may still send repo and allowDuplicate, with no Idempotency-Key.
      const ok = await fetch(`${base}/api/founder/tasks`, { method: "POST", headers: { ...headers, "X-CSRF-Token": csrfToken }, body: JSON.stringify({ projectId: "alpha", objective: "x", repo: "/srv/r", allowDuplicate: true }) });
      assert.equal(ok.status, 202);
      assert.deepEqual(await ok.json(), { founder: true, repo: "/srv/r", allowDuplicate: true });
      // CSRF still applies to the founder.
      const noCsrf = await fetch(`${base}/api/founder/tasks`, { method: "POST", headers, body: "{}" });
      assert.equal(noCsrf.status, 403);
      // Every other route is still reachable with the cookie, and only with it.
      assert.equal((await fetch(`${base}/api/admin/agents/a/b/pm2/restart`, { headers: { Cookie: cookie } })).status, 200);
      assert.equal((await fetch(`${base}/api/hq/company`)).status, 401);
      // A non-Bearer Authorization header is not an operator request.
      assert.equal((await fetch(`${base}/api/hq/company`, { headers: { Cookie: cookie, Authorization: "Basic Zm9vOmJhcg==" } })).status, 200);
    }));
  }
  const founderRows = readSecurityEvents(fx.root, { action: "founder.task" });
  assert.equal(founderRows.length, 2);
  assert.ok(founderRows.every((r) => r.actor === "founder"));
  assert.equal(readSecurityEvents(fx.root, { action: "operator.request" }).length, 0, "cookie requests are not operator requests");
});

// ── token store ──────────────────────────────────────────────────────────────

test("the store holds only hashes, is 0600, and an over-permissive store fails closed", { skip }, async () => {
  const fx = makeRoot();
  const text = readFileSync(fx.storePath, "utf8");
  assert.ok(!text.includes(fx.token));
  assert.ok(text.includes(hashToken(fx.token)));
  assert.equal(statSync(fx.storePath).mode & 0o777, 0o600);
  const store = readOperatorStore(fx.storePath);
  assert.deepEqual(Object.keys(store.operators[0]).sort(), ["createdAt", "id", "revokedAt", "scopes", "tokenHash"]);
  assert.equal(findOperatorByToken(store, fx.token).id, "dot");
  assert.equal(findOperatorByToken(store, "hqop_x"), null);
  chmodSync(fx.storePath, 0o644);
  await withEnabled("1", () => withServer(fx, async (base) => {
    const response = await fetch(`${base}/api/founder/overview`, { headers: bearer(fx.token) });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).reason, "store_insecure");
  }));
});

test("hq-operator-token: create writes the token only to --out (0600), never to stdout; revoke and list work", () => {
  const dir = mkdtempSync(join(tmpdir(), "operator-token-cli-"));
  const storePath = join(dir, "store", "operators.json");
  const outPath = join(dir, "dot", "token");
  const printed = [];
  runTokenCli(["create", "--id", "dot", "--out", outPath], { storePath, out: (v) => printed.push(JSON.stringify(v)) });
  const token = readFileSync(outPath, "utf8").trim();
  assert.match(token, /^hqop_[A-Za-z0-9_-]{43}$/);
  assert.equal(statSync(outPath).mode & 0o777, 0o600);
  assert.equal(statSync(storePath).mode & 0o777, 0o600);
  assert.ok(!printed.join("").includes(token));
  assert.ok(!readFileSync(storePath, "utf8").includes(token));
  assert.throws(() => runTokenCli(["create", "--id", "dot", "--out", outPath], { storePath, out() {} }), /already exists/);
  assert.throws(() => runTokenCli(["create", "--id", "dot", "--out", join(dir, "second")], { storePath, out() {} }), /already has an active token/);
  assert.equal(existsSync(join(dir, "second")), false, "a refused create leaves no token file behind");
  runTokenCli(["revoke", "--id", "dot"], { storePath, out: (v) => printed.push(JSON.stringify(v)) });
  let listed;
  runTokenCli(["list"], { storePath, out: (v) => { listed = v; } });
  assert.equal(listed.operators.length, 1);
  assert.ok(listed.operators[0].revokedAt);
  assert.ok(!JSON.stringify(listed).includes("tokenHash"));
  assert.throws(() => runTokenCli(["create", "--id", "Bad Id", "--out", join(dir, "x")], { storePath, out() {} }));
  assert.throws(() => runTokenCli(["rotate"], { storePath, out() {} }));
});

test("hq-operator: only the documented subcommands, the token goes in a header and nowhere else", async () => {
  for (const argv of [[], ["retry", "t-1"], ["cancel"], ["task", "t-1", "retry"], ["task", "../x", "report"], ["status", "--url", "http://evil"],
    ["submit", "--project", "a", "--objective", "b"], ["submit", "--project", "a", "--objective", "b", "--key", "k", "--repo", "/"], ["sh", "-c", "id"]]) {
    assert.throws(() => planRequest(argv), undefined, JSON.stringify(argv));
  }
  assert.deepEqual(planRequest(["task", "task-1", "evidence"]), { method: "GET", path: "/api/founder/tasks/task-1/evidence" });
  assert.deepEqual(planRequest(["submit", "--project", "alpha", "--objective", "Do it", "--issue", "3", "--key", "k-12345678"]), {
    method: "POST", path: "/api/founder/tasks", body: { projectId: "alpha", objective: "Do it", issue: "3" }, idempotencyKey: "k-12345678",
  });

  const dir = mkdtempSync(join(tmpdir(), "operator-cli-"));
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "hqop_secret-value-for-test\n", { mode: 0o600 });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ jobs: [{ id: "founder-1", status: "running", submittedBy: "operator:dot" }], projects: [] }) };
  };
  const result = await runOperatorCli(["job", "founder-1"], { env: { HQ_OPERATOR_TOKEN_FILE: tokenFile }, fetchImpl });
  assert.equal(calls[0].url, "http://127.0.0.1:3211/api/founder/overview");
  assert.equal(calls[0].init.headers.Authorization, "Bearer hqop_secret-value-for-test");
  assert.equal(result.body.job.id, "founder-1");
  assert.ok(!JSON.stringify(result).includes("secret-value"));

  chmodSync(tokenFile, 0o644);
  await assert.rejects(() => runOperatorCli(["status"], { env: { HQ_OPERATOR_TOKEN_FILE: tokenFile }, fetchImpl }), /readable by other users/);
  await assert.rejects(() => runOperatorCli(["status"], { env: {}, fetchImpl }), /HQ_OPERATOR_TOKEN_FILE/);

  // The real CLI process: a usage error prints usage, not the token.
  chmodSync(tokenFile, 0o600);
  let stderr = "";
  try {
    execFileSync(process.execPath, [new URL("../../scripts/hq-operator.mjs", import.meta.url).pathname, "nope"], { env: { ...process.env, HQ_OPERATOR_TOKEN_FILE: tokenFile }, stdio: "pipe" });
  } catch (error) {
    stderr = String(error.stderr) + String(error.stdout);
  }
  assert.match(stderr, /usage:/);
  assert.ok(!stderr.includes("secret-value"));
});

// ── server.mjs wiring ────────────────────────────────────────────────────────

test("server.mjs: operator gate before the session, CSRF and the login gate behind unlessOperator", () => {
  const at = (needle) => {
    const index = serverSource.indexOf(needle);
    assert.ok(index >= 0, `server.mjs contains ${needle}`);
    return index;
  };
  const gate = at("app.use(operatorAuthGate({ root: ROOT }))");
  const sessionUse = at("session({");
  const csrf = at("app.use(unlessOperator(\n  csrfProtection({");
  const login = at("app.use(unlessOperator(loginGate))");
  assert.ok(gate < sessionUse && sessionUse < csrf && csrf < login, "gate -> session -> csrf -> login gate");
  // Neither session-bound middleware is mounted bare anywhere else.
  assert.equal((serverSource.match(/app\.use\(loginGate\)/g) || []).length, 0);
  assert.equal((serverSource.match(/app\.use\(\s*csrfProtection\(/g) || []).length, 0);
  // No route handler is registered before the login gate except auth itself.
  const beforeLogin = serverSource.slice(0, login);
  assert.equal((beforeLogin.match(/app\.(get|post|put|patch|delete)\(/g) || []).length, 0);
});

test("server.mjs: the task route sends operators through the guard, and the launch request has fixed fields", () => {
  const route = serverSource.slice(serverSource.indexOf('app.post("/api/founder/tasks"'));
  const operatorBranch = route.slice(0, route.indexOf("let job;"));
  assert.match(operatorBranch, /if \(req\.operator\) \{[\s\S]*decideOperatorSubmission\(\{[\s\S]*launch: launchFounderTask/);
  assert.match(operatorBranch, /return res\.status\(decision\.status\)/);
  const launch = serverSource.slice(serverSource.indexOf("function launchFounderTask"), serverSource.indexOf('app.post("/api/founder/tasks"'));
  const [, call, dependencies] = launch.match(/handleFactoryRequest\(\{([^}]*)\}, \{([^}]*)\}\)/);
  assert.equal(dependencies.trim(), "onTaskCreated", "the only dependency passed is the task-id hook; nothing overrides intake, init or dispatch");
  const fields = call.split(",").map((part) => part.trim().split(":")[0].trim()).filter(Boolean);
  assert.deepEqual(fields, ["version", "action", "repo", "objective", "project", "issue"], "no approval, stateRoot, answers or contractPath can reach the start request");
  assert.match(call, /action: "start"/);
});

// ── task jobs are judged by their real task state ────────────────────────────

test("busy: a task job running longer than the window still counts; a stranded one over a terminal task does not", () => {
  const operator = { id: "dot", actor: "operator:dot" };
  const old = new Date(Date.now() - DUPLICATE_JOB_WINDOW_MS - 3600_000).toISOString();
  const attempt = (fx, key) => decideOperatorSubmission({
    root: fx.root, operator, body: { projectId: "alpha", objective: "New work" }, idempotencyKey: key,
    launch: (input) => saveFounderJob(fx.root, { id: "founder-new", kind: "task", ...input, status: "starting", createdAt: new Date().toISOString() }),
  });

  const live = makeRoot();
  writeTask(live.root, "task-longrun", "active");
  saveFounderJob(live.root, { id: "founder-longrun", kind: "task", projectId: "beta", objective: "long", status: "running", taskId: "task-longrun", createdAt: old });
  const refused = attempt(live, "dot-task-0001");
  assert.equal(refused.status, 409);
  assert.equal(refused.body.activeJob.id, "founder-longrun");
  assert.deepEqual(refused.body.activeJob.canonical, { live: true, source: "task", status: "active" });

  const stranded = makeRoot();
  writeTask(stranded.root, "task-finished", "merge-ready");
  saveFounderJob(stranded.root, { id: "founder-stranded", kind: "task", projectId: "beta", objective: "done", status: "running", taskId: "task-finished", createdAt: new Date().toISOString() });
  assert.equal(attempt(stranded, "dot-task-0002").status, 202, "a fresh record over a merge-ready task is not busy");

  // The window applies only while there is no state file yet.
  const intake = makeRoot();
  saveFounderJob(intake.root, { id: "founder-intake", kind: "task", projectId: "beta", objective: "intake", status: "starting", createdAt: new Date().toISOString() });
  assert.equal(attempt(intake, "dot-task-0003").body.activeJob.canonical.source, "window");
});

test("server.mjs records the task id on the founder job when the task is created", () => {
  const launch = serverSource.slice(serverSource.indexOf("function launchFounderTask"), serverSource.indexOf('app.post("/api/founder/tasks"'));
  assert.match(launch, /const onTaskCreated = \(\{ taskId \}\) => saveFounderJob\(ROOT, Object\.assign\(job, \{ taskId/);
});

// ── the operator's overview ──────────────────────────────────────────────────

function seedOverview(fx) {
  writeObjective(fx.root, "obj-0000view", "running", {
    a: { id: "obj-0000view-a", role: "backend-builder", status: "running", dependsOn: [], statePath: "/secret/path/state.json" },
    b: { id: "obj-0000view-b", role: "frontend-builder", status: "pending", dependsOn: ["a"] },
  });
  setProjectPaused(fx.root, "beta", true);
  saveFounderJob(fx.root, { id: "founder-view", kind: "objective", projectId: "alpha", objective: "Seeded objective", repo: fx.repo, status: "running", objectiveId: "obj-0000view", submittedBy: "operator:dot", createdAt: "2026-10-01T00:00:00.000Z", result: { statePath: "/secret/x" } });
  recordQuestion(fx.root, { id: "q-1", question: "What is our runway, privately?", status: "answered", createdAt: new Date().toISOString() });
}

test("an operator's overview is only projects, jobs and objective summaries", { skip }, async () => {
  const fx = makeRoot();
  seedOverview(fx);
  const body = await withEnabled("1", () => withServer(fx, async (base) => (await fetch(`${base}/api/founder/overview`, { headers: bearer(fx.token) })).json()));
  assert.deepEqual(Object.keys(body).sort(), ["jobs", "objectives", "projects"]);
  assert.deepEqual(body.projects, [
    { id: "alpha", name: "Alpha", paused: false },
    { id: "beta", name: "Beta", paused: true },
    { id: "frozen", name: "Frozen", paused: true },
  ]);
  assert.deepEqual(body.jobs, [{
    id: "founder-view", status: "running", storedStatus: null, objectiveId: "obj-0000view", taskId: null,
    projectId: "alpha", createdAt: "2026-10-01T00:00:00.000Z", submittedBy: "operator:dot",
  }]);
  assert.deepEqual(body.objectives, [{ id: "obj-0000view", status: "running", nodes: [
    { id: "obj-0000view-a", status: "running" }, { id: "obj-0000view-b", status: "pending" },
  ] }]);
  const text = JSON.stringify(body);
  for (const leak of [fx.root, "/secret", "statePath", "repo", "runway", "question", "decision", "inbox", "approval", "company", "thread"]) {
    assert.ok(!text.includes(leak), `operator overview must not contain ${leak}`);
  }
});

test("the founder's overview is unchanged: the full view, paths and questions included", { skip }, async () => {
  const fx = makeRoot();
  seedOverview(fx);
  const body = await withEnabled("1", () => withServer(fx, async (base) => {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST" });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    return (await fetch(`${base}/api/founder/overview`, { headers: { Cookie: cookie } })).json();
  }));
  const expected = JSON.parse(JSON.stringify({ ...buildFounderOverview(fx.root, readProjects(fx.root)), jobs: listFounderJobs(fx.root) }));
  assert.deepEqual(body, expected);
  for (const key of ["projects", "tasks", "decisions", "openDecisions", "inbox", "company", "questions", "activity", "jobs"]) {
    assert.ok(Object.hasOwn(body, key), `founder overview keeps ${key}`);
  }
  assert.equal(body.jobs[0].repo, fx.repo, "the founder still sees the full job record");
  assert.ok(body.questions.some((q) => q.question.includes("runway")));
});

test("server.mjs: the overview's founder branch is byte-for-byte what it was; operators return before it", () => {
  const route = serverSource.slice(serverSource.indexOf('app.get("/api/founder/overview"'));
  const body = route.slice(0, route.indexOf("\n});") + 4);
  const operatorAt = body.indexOf("if (req.operator) return res.json(buildOperatorOverview(ROOT));");
  const founderAt = body.indexOf("const overview = buildFounderOverview(ROOT, readProjects(ROOT));\n    res.json({ ...overview, jobs: listFounderJobs(ROOT) });");
  assert.ok(operatorAt > 0 && founderAt > operatorAt);
});

// ── the cap is the operator's, never the founder's ───────────────────────────

test("the 24h operator cap can never block a cookie-authenticated founder submission", { skip }, async () => {
  const fx = makeRoot();
  const now = Date.now();
  const launch = (input) => saveFounderJob(fx.root, { id: `founder-${input.requestId}`, kind: "task", ...input, status: "complete", createdAt: new Date(now).toISOString() });
  for (let i = 0; i < OPERATOR_DAILY_CAP; i += 1) {
    decideOperatorSubmission({ root: fx.root, operator: { id: "dot", actor: "operator:dot" }, body: { projectId: "alpha", objective: `w${i}` }, idempotencyKey: `dot-fcap-${i}-xxx`, launch, now });
  }
  const ledgerBefore = readFileSync(operatorLedgerPath(fx.root), "utf8");
  await withEnabled("1", () => withServer(fx, async (base) => {
    // The operator is capped...
    assert.equal((await submit(base, fx.token, { projectId: "alpha", objective: "more" }, "dot-fcap-over")).status, 429);
    // ...and the founder is not, however many times they submit.
    const login = await fetch(`${base}/api/auth/login`, { method: "POST" });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const { csrfToken } = await login.json();
    for (let i = 0; i < OPERATOR_DAILY_CAP + 2; i += 1) {
      const response = await fetch(`${base}/api/founder/tasks`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json", Origin: base, "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ projectId: "alpha", objective: `founder ${i}` }),
      });
      assert.equal(response.status, 202, `founder submission ${i}`);
    }
  }));
  assert.equal(readFileSync(operatorLedgerPath(fx.root), "utf8"), ledgerBefore, "founder submissions never touch the operator ledger");
  // In server.mjs the cap lives only behind req.operator: the founder branch and
  // the shared launcher never reach the guard or its ledger.
  const route = serverSource.slice(serverSource.indexOf('app.post("/api/founder/tasks"'));
  const founderBranch = route.slice(route.indexOf("let job;"), route.indexOf("\n});"));
  const launcher = serverSource.slice(serverSource.indexOf("function launchFounderTask"), serverSource.indexOf('app.post("/api/founder/tasks"'));
  for (const code of [founderBranch, launcher]) {
    assert.ok(!/decideOperatorSubmission|OPERATOR_DAILY_CAP|operatorLedger|operator-submissions/.test(code));
  }
  assert.equal((serverSource.match(/decideOperatorSubmission\(/g) || []).length, 1, "the guard is called from exactly one place");
  assert.match(route.slice(0, route.indexOf("let job;")), /^app\.post\("\/api\/founder\/tasks", \(req, res\) => \{\n  if \(req\.operator\) \{/);
});
