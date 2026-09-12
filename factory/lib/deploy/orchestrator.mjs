import { execFile } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { promisify } from "util";
import { sanitizeExcerpt } from "../common/redact.mjs";
import { readDeployManifest, validateDeployManifest } from "./manifest.mjs";
import { selectProvider, defaultAdapters } from "./provider.mjs";
import { MissingCredentialError } from "./adapters/vercel.mjs";
import { readDeploymentState, writeDeploymentState } from "./store.mjs";

const HISTORY_LIMIT = 40;

const execFileAsync = promisify(execFile);

async function defaultExec(command, { cwd, env }) {
  try {
    const result = await execFileAsync("/bin/sh", ["-lc", command], { cwd, env, maxBuffer: 10 * 1024 * 1024 });
    return { code: 0, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error) {
    return { code: Number.isInteger(error.code) ? error.code : 1, stdout: error.stdout || "", stderr: error.stderr || error.message || "" };
  }
}

function at(now) {
  const value = now();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function redactExact(text, env) {
  let result = String(text ?? "");
  for (const [key, value] of Object.entries(env || {})) {
    if (/(TOKEN|SECRET|PASSWORD|KEY|DATABASE_URL|CREDENTIAL)/i.test(key) && value) {
      result = result.split(String(value)).join(`[redacted: ${key}]`);
    }
  }
  return sanitizeExcerpt(result, { maxLength: 1000 }).text;
}

function baseState(projectKey) {
  return {
    version: 1,
    projectKey,
    state: "not_deployed",
    provider: null,
    productionUrl: null,
    providerDeploymentId: null,
    lastDeploymentAt: null,
    health: null,
    founderActionRequired: false,
    founderActionReason: null,
    lastError: null,
    history: [],
  };
}

// Seed a run from the last persisted record so a new attempt (including the
// default dry run) never erases the known-good production URL, deployment
// timestamp, provider id, last health, or the step/outcome audit trail that HQ
// serves. Only the durable facts carry forward; run-scoped fields
// (state/founderAction*/lastError) always start clean.
function seedState(projectKey, prior) {
  const fresh = baseState(projectKey);
  if (!prior || prior.projectKey !== projectKey) return fresh;
  return {
    ...fresh,
    provider: prior.provider ?? null,
    productionUrl: prior.productionUrl ?? null,
    providerDeploymentId: prior.providerDeploymentId ?? null,
    lastDeploymentAt: prior.lastDeploymentAt ?? null,
    health: prior.health ?? null,
    history: Array.isArray(prior.history) ? prior.history.slice(-HISTORY_LIMIT) : [],
  };
}

function projectTestCommand(repoPath, rootDirectory) {
  const packagePath = join(resolve(repoPath, rootDirectory || "."), "package.json");
  if (!existsSync(packagePath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    return typeof pkg.scripts?.test === "string" && pkg.scripts.test.trim() ? "npm test" : null;
  } catch {
    return null;
  }
}

function isFounderActionError(error) {
  return error instanceof MissingCredentialError || /auth|credential|unauthori[sz]ed|forbidden/i.test(String(error?.message || error));
}

function joinUrl(origin, path) {
  return new URL(path, origin.endsWith("/") ? origin : `${origin}/`).toString();
}

export async function runDeployment({
  hqRoot,
  projectKey,
  repoPath,
  manifest: suppliedManifest,
  adapters = defaultAdapters,
  config = null,
  provider: suppliedProvider = null,
  env = process.env,
  now = () => new Date(),
  exec = defaultExec,
  fetchFn = globalThis.fetch,
  logger = () => {},
  allowRealDeploy = false,
}) {
  let prior = null;
  try {
    prior = readDeploymentState({ hqRoot, projectKey });
  } catch {
    // An unreadable/invalid prior record must not brick a deploy; start clean.
    prior = null;
  }
  let state = seedState(projectKey, prior);
  const persist = () => writeDeploymentState({ hqRoot, projectKey, state });
  const record = (step, outcome, detail = null) => {
    const item = { at: at(now), step, outcome };
    if (detail) item.detail = redactExact(detail, env);
    state.history.push(item);
    persist();
  };
  const finish = (nextState, { error = null, founderReason = null } = {}) => {
    state.state = nextState;
    state.founderActionRequired = nextState === "needs_founder_action";
    state.founderActionReason = founderReason ? redactExact(founderReason, env) : null;
    state.lastError = error ? redactExact(error.message || error, env) : null;
    persist();
    return state;
  };
  const runCommand = async (step, command, cwd) => {
    const result = await exec(command, { cwd, env });
    if (Number(result?.code || 0) !== 0) {
      const detail = redactExact(result?.stderr || result?.stdout || `exit ${result?.code}`, env);
      record(step, "fail", detail);
      throw new Error(`${step} failed: ${detail}`);
    }
    record(step, "pass");
  };

  state.state = "deploying";
  persist();

  let manifest;
  let provider;
  try {
    manifest = suppliedManifest ? validateDeployManifest(suppliedManifest) : readDeployManifest(repoPath);
    if (!manifest) throw new Error("deploy manifest: deploy.config.json was not found.");
    for (const declaration of manifest.env) {
      if (declaration.required && !env[declaration.key]) throw new Error(`Required environment variable ${declaration.key} is missing.`);
    }
    provider = suppliedProvider || selectProvider(manifest, { adapters, config });
    state.provider = provider.id;
    record("validate", "pass");
  } catch (error) {
    record("validate", "fail", error.message);
    return finish("failed", { error });
  }

  const cwd = resolve(repoPath, manifest.build.rootDirectory || ".");
  try {
    if (manifest.build.installCommand) await runCommand("install", manifest.build.installCommand, cwd);
    await runCommand("build", manifest.build.command, cwd);
    const testCommand = projectTestCommand(repoPath, manifest.build.rootDirectory);
    if (testCommand) await runCommand("test", testCommand, cwd);
    else record("test", "skipped", "no project test script");
  } catch (error) {
    return finish("failed", { error });
  }

  if (!allowRealDeploy) {
    record("deploy", "skipped", "dry run: real deploy requires founder action");
    return finish("needs_founder_action", { founderReason: "dry run: real deploy requires founder action" });
  }

  // preDeploy and migrate hooks can mutate external systems (e.g. run
  // migrations against a production DATABASE_URL), so they only run once the
  // founder has explicitly authorised a real deploy — never on a dry run.
  try {
    for (const command of manifest.hooks?.preDeploy || []) await runCommand("preDeploy", command, cwd);
    if (manifest.hooks?.migrate) await runCommand("migrate", manifest.hooks.migrate, cwd);
  } catch (error) {
    return finish("failed", { error });
  }

  let deployment;
  try {
    deployment = await provider.deploy({ repoPath, manifest, env, logger: (line) => logger(redactExact(line, env)) });
    if (deployment?.notConfigured) {
      const reason = `provider '${provider.id}' is a stub — configure a real provider in deploy.config.json`;
      record("deploy", "needs_founder_action", reason);
      return finish("needs_founder_action", { founderReason: reason });
    }
    if (!deployment?.url) throw new Error(`Deployment provider "${provider.id}" did not return a production URL.`);
    state.productionUrl = deployment.url;
    state.providerDeploymentId = deployment.providerDeploymentId || null;
    record("deploy", "pass", deployment.providerDeploymentId || deployment.url);
  } catch (error) {
    record("deploy", isFounderActionError(error) ? "needs_founder_action" : "fail", error.message);
    return finish(isFounderActionError(error) ? "needs_founder_action" : "failed", {
      error: isFounderActionError(error) ? null : error,
      founderReason: isFounderActionError(error) ? error.message : null,
    });
  }

  try {
    for (const command of manifest.hooks?.postDeploy || []) await runCommand("postDeploy", command, cwd);
  } catch (error) {
    state.lastDeploymentAt = at(now);
    return finish("failed", { error });
  }

  try {
    const checkedAt = at(now);
    const healthResponse = await fetchFn(joinUrl(state.productionUrl, manifest.healthCheck.path), {
      method: "GET",
      signal: AbortSignal.timeout(manifest.healthCheck.timeoutMs ?? 10000),
    });
    const expectedHealth = manifest.healthCheck.expectStatus ?? 200;
    state.health = { checkedAt, ok: healthResponse.status === expectedHealth, status: healthResponse.status };
    if (!state.health.ok) throw new Error(`health check expected HTTP ${expectedHealth}, received ${healthResponse.status}.`);
    record("health", "pass", `HTTP ${healthResponse.status}`);
  } catch (error) {
    state.health = state.health || { checkedAt: at(now), ok: false, status: null };
    record("health", "fail", error.message);
    state.lastDeploymentAt = at(now);
    return finish("failed", { error });
  }

  try {
    if (manifest.smokeTest) {
      const smokeResponse = await fetchFn(joinUrl(state.productionUrl, manifest.smokeTest.path), {
        method: manifest.smokeTest.method || "GET",
        signal: AbortSignal.timeout(manifest.healthCheck.timeoutMs ?? 10000),
      });
      const expected = manifest.smokeTest.expectStatus ?? 200;
      if (smokeResponse.status !== expected) throw new Error(`functional smoke test expected HTTP ${expected}, received ${smokeResponse.status}.`);
      const body = manifest.smokeTest.bodyIncludes === undefined ? null : await smokeResponse.text();
      if (body !== null && !body.includes(manifest.smokeTest.bodyIncludes)) throw new Error("functional smoke test response body did not include the expected text.");
      record("smoke", "pass", `HTTP ${smokeResponse.status}`);
    } else {
      record("smoke", "skipped", "no functional smoke test configured");
    }
  } catch (error) {
    record("smoke", "fail", error.message);
    state.lastDeploymentAt = at(now);
    return finish("failed", { error });
  }

  state.lastDeploymentAt = at(now);
  record("complete", "pass");
  return finish("deployed");
}
