import { existsSync, readFileSync } from "fs";
import { isAbsolute, relative, resolve, sep } from "path";

export const PROVENANCE_VERSION = 1;
export const PROVENANCE_CLASSIFICATIONS = Object.freeze(["copied", "adapted", "inspired", "reference"]);

export function provenancePath(hqRoot) {
  return resolve(hqRoot, "factory", "third-party", "provenance.json");
}

export function readProvenance(hqRoot, path = provenancePath(hqRoot)) {
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`Cannot read third-party provenance manifest: ${error.message}`); }
  return validateProvenance(value, { hqRoot });
}

export function validateProvenance(value, { hqRoot = null } = {}) {
  const errors = [];
  if (!isRecord(value)) return fail(["manifest must be an object"]);
  if (value.version !== PROVENANCE_VERSION) errors.push(`version must be ${PROVENANCE_VERSION}`);
  if (!Array.isArray(value.sources) || value.sources.length === 0) errors.push("sources must be a non-empty array");
  if (!Array.isArray(value.artifacts)) errors.push("artifacts must be an array");
  const sourceIds = new Set();
  for (const [index, source] of (value.sources || []).entries()) {
    const at = `sources[${index}]`;
    if (!isRecord(source)) { errors.push(`${at} must be an object`); continue; }
    checkKeys(source, ["id", "name", "repository", "commit", "license", "licenseNotice"], at, errors);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(source.id || "")) errors.push(`${at}.id must be a lowercase slug`);
    if (sourceIds.has(source.id)) errors.push(`${at}.id duplicates '${source.id}'`);
    sourceIds.add(source.id);
    if (!/^https:\/\//.test(source.repository || "")) errors.push(`${at}.repository must use https`);
    if (!/^[0-9a-f]{40}$/.test(source.commit || "")) errors.push(`${at}.commit must be a full lowercase Git SHA`);
    validateRepoPath(source.licenseNotice, `${at}.licenseNotice`, { hqRoot, mustExist: true }, errors);
  }
  const localPaths = new Set();
  for (const [index, artifact] of (value.artifacts || []).entries()) {
    const at = `artifacts[${index}]`;
    if (!isRecord(artifact)) { errors.push(`${at} must be an object`); continue; }
    checkKeys(artifact, ["localPath", "sourceId", "sourcePath", "classification", "notes"], at, errors);
    validateRepoPath(artifact.localPath, `${at}.localPath`, { hqRoot, mustExist: true }, errors);
    validateRelativePath(artifact.sourcePath, `${at}.sourcePath`, errors);
    if (!sourceIds.has(artifact.sourceId)) errors.push(`${at}.sourceId references unknown source '${artifact.sourceId}'`);
    if (!PROVENANCE_CLASSIFICATIONS.includes(artifact.classification)) errors.push(`${at}.classification is invalid`);
    if (typeof artifact.notes !== "string" || !artifact.notes.trim()) errors.push(`${at}.notes must be non-empty`);
    if (localPaths.has(artifact.localPath)) errors.push(`${at}.localPath duplicates '${artifact.localPath}'`);
    localPaths.add(artifact.localPath);
  }
  if (errors.length) return fail(errors);
  return value;
}

function validateRepoPath(path, label, { hqRoot, mustExist }, errors) {
  validateRelativePath(path, label, errors);
  if (!hqRoot || typeof path !== "string" || isAbsolute(path) || path.split(/[\\/]/).includes("..")) return;
  const root = resolve(hqRoot);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) errors.push(`${label} escapes the repository`);
  else if (mustExist && !existsSync(target)) errors.push(`${label} does not exist: ${path}`);
}

function validateRelativePath(path, label, errors) {
  if (typeof path !== "string" || !path.trim()) errors.push(`${label} must be non-empty`);
  else if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) errors.push(`${label} must be repository-relative without '..'`);
}

function checkKeys(value, keys, at, errors) {
  const allowed = new Set(keys);
  for (const key of keys) if (!(key in value)) errors.push(`${at}.${key} is required`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${at}.${key} is not allowed`);
}

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function fail(errors) { throw new Error(`Invalid third-party provenance manifest:\n- ${errors.join("\n- ")}`); }
