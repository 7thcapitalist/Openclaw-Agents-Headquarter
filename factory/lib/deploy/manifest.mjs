import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

const TOP_LEVEL_KEYS = new Set(["version", "provider", "build", "env", "hooks", "healthCheck", "smokeTest"]);
const PROVIDERS = new Set(["vercel", "none"]);
const ENV_SCOPES = new Set(["build", "runtime", "both"]);
const ENV_SOURCES = new Set(["env", "secret-store"]);
const SMOKE_METHODS = new Set(["GET", "POST", "HEAD"]);
const ENV_KEYS = new Set(["key", "required", "scope", "source"]);

function object(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateRelativePath(value, name) {
  if (!nonEmpty(value) || value.startsWith("/") || value.split(/[\\/]/).includes("..")) {
    throw new Error(`deploy manifest: ${name} must be a repo-relative path without "..".`);
  }
}

function validateCommand(value, name) {
  if (!nonEmpty(value)) throw new Error(`deploy manifest: ${name} must be a non-empty string.`);
}

function validateCommandList(value, name) {
  if (!Array.isArray(value) || value.some((command) => !nonEmpty(command))) {
    throw new Error(`deploy manifest: ${name} must be an array of non-empty strings.`);
  }
}

function rejectUnknown(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`deploy manifest: ${name} property "${key}" is not allowed.`);
  }
}

export function validateDeployManifest(value) {
  if (!object(value)) throw new Error("deploy manifest: must be a JSON object.");
  if (value.version !== 1) throw new Error("deploy manifest: version must be 1.");
  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.has(key)) throw new Error(`deploy manifest: unknown top-level property "${key}".`);
  }
  if (value.provider !== undefined && !PROVIDERS.has(value.provider)) {
    throw new Error(`deploy manifest: unknown provider "${value.provider}".`);
  }
  if (!object(value.build)) throw new Error("deploy manifest: build must be an object.");
  rejectUnknown(value.build, ["command", "installCommand", "outputDir", "rootDirectory"], "build");
  if (!nonEmpty(value.build.command)) throw new Error("deploy manifest: build.command is required.");
  for (const key of ["installCommand", "outputDir", "rootDirectory"]) {
    if (value.build[key] !== undefined && !nonEmpty(value.build[key])) {
      throw new Error(`deploy manifest: build.${key} must be a non-empty string.`);
    }
  }
  for (const key of ["outputDir", "rootDirectory"]) {
    if (value.build[key] !== undefined) validateRelativePath(value.build[key], `build.${key}`);
  }
  if (!Array.isArray(value.env)) throw new Error("deploy manifest: env must be an array.");
  for (const [index, declaration] of value.env.entries()) {
    if (!object(declaration)) throw new Error(`deploy manifest: env[${index}] must be an object.`);
    for (const key of Object.keys(declaration)) {
      if (!ENV_KEYS.has(key)) throw new Error(`deploy manifest: env[${index}] property "${key}" is not allowed.`);
    }
    if (!/^[A-Z][A-Z0-9_]*$/.test(String(declaration.key || ""))) {
      throw new Error(`deploy manifest: env[${index}].key must be SCREAMING_SNAKE_CASE.`);
    }
    if (typeof declaration.required !== "boolean") {
      throw new Error(`deploy manifest: env[${index}].required must be a boolean.`);
    }
    if (!ENV_SCOPES.has(declaration.scope)) throw new Error(`deploy manifest: env[${index}].scope is invalid.`);
    if (!ENV_SOURCES.has(declaration.source)) throw new Error(`deploy manifest: env[${index}].source is invalid.`);
  }
  if (value.hooks !== undefined) {
    if (!object(value.hooks)) throw new Error("deploy manifest: hooks must be an object.");
    for (const key of Object.keys(value.hooks)) {
      if (!["migrate", "preDeploy", "postDeploy"].includes(key)) {
        throw new Error(`deploy manifest: hooks property "${key}" is not allowed.`);
      }
    }
    if (value.hooks.migrate !== undefined) validateCommand(value.hooks.migrate, "hooks.migrate");
    if (value.hooks.preDeploy !== undefined) validateCommandList(value.hooks.preDeploy, "hooks.preDeploy");
    if (value.hooks.postDeploy !== undefined) validateCommandList(value.hooks.postDeploy, "hooks.postDeploy");
  }
  if (!object(value.healthCheck)) throw new Error("deploy manifest: healthCheck must be an object.");
  rejectUnknown(value.healthCheck, ["path", "expectStatus", "timeoutMs"], "healthCheck");
  if (!nonEmpty(value.healthCheck.path) || !value.healthCheck.path.startsWith("/")) {
    throw new Error("deploy manifest: healthCheck.path must start with '/'.");
  }
  if (value.healthCheck.expectStatus !== undefined && (!Number.isInteger(value.healthCheck.expectStatus) || value.healthCheck.expectStatus < 100 || value.healthCheck.expectStatus > 599)) {
    throw new Error("deploy manifest: healthCheck.expectStatus must be an HTTP status code.");
  }
  if (value.healthCheck.timeoutMs !== undefined && (!Number.isInteger(value.healthCheck.timeoutMs) || value.healthCheck.timeoutMs <= 0)) {
    throw new Error("deploy manifest: healthCheck.timeoutMs must be a positive integer.");
  }
  if (value.smokeTest !== undefined) {
    if (!object(value.smokeTest)) throw new Error("deploy manifest: smokeTest must be an object.");
    rejectUnknown(value.smokeTest, ["path", "method", "expectStatus", "bodyIncludes"], "smokeTest");
    if (!nonEmpty(value.smokeTest.path) || !value.smokeTest.path.startsWith("/")) {
      throw new Error("deploy manifest: smokeTest.path must start with '/'.");
    }
    if (value.smokeTest.method !== undefined && !SMOKE_METHODS.has(value.smokeTest.method)) {
      throw new Error("deploy manifest: smokeTest.method must be GET, POST, or HEAD.");
    }
    if (value.smokeTest.expectStatus !== undefined && (!Number.isInteger(value.smokeTest.expectStatus) || value.smokeTest.expectStatus < 100 || value.smokeTest.expectStatus > 599)) {
      throw new Error("deploy manifest: smokeTest.expectStatus must be an HTTP status code.");
    }
    if (value.smokeTest.bodyIncludes !== undefined && typeof value.smokeTest.bodyIncludes !== "string") {
      throw new Error("deploy manifest: smokeTest.bodyIncludes must be a string.");
    }
  }
  return value;
}

export function readDeployManifest(repoPath) {
  const path = join(resolve(repoPath), "deploy.config.json");
  if (!existsSync(path)) return null;
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`deploy manifest: ${path} is not valid JSON: ${error.message}`);
  }
  return validateDeployManifest(value);
}
