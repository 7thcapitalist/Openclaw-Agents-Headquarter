// Hand-rolled validators, same style as validateTaskContract / validateAgentResult.
// The *.schema.json files are the reference contract; these are the runtime check.
// No dependency.

const PROJECT_STATUS = new Set(["active", "paused", "archived"]);
const SEVERITY = new Set(["low", "medium", "high"]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateRegistry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("registry: must be a JSON object.");
  }
  if (value.version !== 1) throw new Error("registry: version must be 1.");
  if (!Array.isArray(value.projects)) throw new Error("registry: projects must be an array.");
  const seen = new Set();
  for (const [i, entry] of value.projects.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`registry: projects[${i}] must be an object.`);
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(String(entry.key || ""))) {
      throw new Error(`registry: projects[${i}].key must be a lowercase slug.`);
    }
    if (seen.has(entry.key)) throw new Error(`registry: duplicate key ${entry.key}.`);
    seen.add(entry.key);
    if (!isNonEmptyString(entry.repo)) {
      throw new Error(`registry: projects[${i}].repo is required.`);
    }
    if (entry.contextDir !== undefined && entry.contextDir !== null) {
      if (typeof entry.contextDir !== "string" || entry.contextDir.startsWith("/") ||
        entry.contextDir.split(/[\\/]/).includes("..")) {
        throw new Error(`registry: projects[${i}].contextDir must be a repo-relative path without "..".`);
      }
    }
    if (entry.status !== undefined && !PROJECT_STATUS.has(entry.status)) {
      throw new Error(`registry: projects[${i}].status is invalid.`);
    }
    if (entry.name !== undefined && typeof entry.name !== "string") {
      throw new Error(`registry: projects[${i}].name must be a string.`);
    }
    // Integration-layer optional fields. Absent is fine; present must be well shaped.
    if (entry.mission !== undefined && typeof entry.mission !== "string") {
      throw new Error(`registry: projects[${i}].mission must be a string.`);
    }
    if (entry.owner !== undefined && typeof entry.owner !== "string") {
      throw new Error(`registry: projects[${i}].owner must be a string.`);
    }
    if (entry.github !== undefined && entry.github !== null) {
      const gh = entry.github;
      if (typeof gh !== "object" || Array.isArray(gh) ||
        !isNonEmptyString(gh.owner) || !isNonEmptyString(gh.repo)) {
        throw new Error(`registry: projects[${i}].github must be { owner, repo } with non-empty strings.`);
      }
    }
    if (entry.responsibleAgents !== undefined) {
      if (!Array.isArray(entry.responsibleAgents) ||
        !entry.responsibleAgents.every((x) => typeof x === "string")) {
        throw new Error(`registry: projects[${i}].responsibleAgents must be an array of strings.`);
      }
    }
  }
  return value;
}

export function validateOwnership(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ownership: must be a JSON object.");
  }
  if (value.version !== 1) throw new Error("ownership: version must be 1.");
  if (!isNonEmptyString(value.mission)) throw new Error("ownership: mission is required.");

  assertArrayOfShape(value.successMetrics, "successMetrics", (item, where) => {
    for (const field of ["id", "name", "target", "current"]) {
      if (!isNonEmptyString(item[field])) throw new Error(`ownership: ${where}.${field} is required.`);
    }
  });
  assertArrayOfShape(value.currentPriorities, "currentPriorities", (item, where) => {
    if (!isNonEmptyString(item.id)) throw new Error(`ownership: ${where}.id is required.`);
    if (!isNonEmptyString(item.title)) throw new Error(`ownership: ${where}.title is required.`);
  });
  assertArrayOfShape(value.risks, "risks", (item, where) => {
    if (!isNonEmptyString(item.id)) throw new Error(`ownership: ${where}.id is required.`);
    if (!isNonEmptyString(item.title)) throw new Error(`ownership: ${where}.title is required.`);
    if (item.severity !== undefined && !SEVERITY.has(item.severity)) {
      throw new Error(`ownership: ${where}.severity is invalid.`);
    }
  });

  if (value.openDecisions !== undefined) {
    if (!Array.isArray(value.openDecisions) || !value.openDecisions.every((x) => typeof x === "string")) {
      throw new Error("ownership: openDecisions must be an array of strings.");
    }
  }
  if (value.responsibleAgents !== undefined) {
    const ra = value.responsibleAgents;
    if (!ra || typeof ra !== "object" || Array.isArray(ra) ||
      !Object.values(ra).every((x) => typeof x === "string")) {
      throw new Error("ownership: responsibleAgents must be an object of string values.");
    }
  }
  return value;
}

// Non-throwing check for `lint`.
export function isOwnershipShape(value) {
  try {
    validateOwnership(value);
    return true;
  } catch {
    return false;
  }
}

function assertArrayOfShape(value, name, checkItem) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`ownership: ${name} must be an array.`);
  value.forEach((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`ownership: ${name}[${i}] must be an object.`);
    }
    checkItem(item, `${name}[${i}]`);
  });
}
