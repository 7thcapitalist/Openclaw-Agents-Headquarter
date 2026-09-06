// Project discovery.
//
// The founder should not hand-maintain every project forever. This scans the
// configured workspace folders for Git repositories that are not in
// factory/projects.json and *proposes* them. It never writes the registry —
// discovery proposes, the founder approves.

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, join, resolve } from "path";
import { readRegistry, resolveRepoPath } from "../intel/registry.mjs";
import { readHqConfig, workspaceRoots } from "./config.mjs";

/**
 * @param {object}  input
 * @param {string}  input.hqRoot
 * @param {string[]}[input.roots]  override the configured workspace roots
 * @param {Date}   [input.now]
 * @returns {{ proposals: Array, scannedRoots: string[], warnings: Array }}
 */
export function discoverProjects({ hqRoot, roots = null, now = new Date() }) {
  const warnings = [];
  const config = readHqConfig(hqRoot);
  const ignore = new Set(config.discovery.ignore || []);
  const maxDepth = Number(config.discovery.maxDepth) || 2;
  const scanRoots = (roots && roots.length ? roots : workspaceRoots(hqRoot, config))
    .map((r) => resolve(r));

  let registeredPaths = new Set();
  try {
    registeredPaths = new Set(
      readRegistry(hqRoot).projects.map((entry) => {
        try { return resolveRepoPath(hqRoot, entry); } catch { return null; }
      }).filter(Boolean)
    );
  } catch (error) {
    warnings.push({ code: "registry-invalid", message: error.message });
  }
  registeredPaths.add(resolve(hqRoot));

  const found = new Map();
  for (const root of scanRoots) {
    if (!existsSync(root)) {
      warnings.push({ code: "root-missing", message: `Workspace root not found: ${root}` });
      continue;
    }
    walk(root, 0, maxDepth, ignore, (repoDir) => {
      if (!found.has(repoDir)) found.set(repoDir, describeRepo(repoDir));
    });
  }

  const proposals = [];
  for (const [repoDir, info] of found) {
    if (registeredPaths.has(repoDir)) continue;
    const key = slugify(basename(repoDir));
    proposals.push({
      key,
      name: titleCase(basename(repoDir)),
      repo: repoDir,
      github: info.github,
      lastCommitAt: info.lastCommitAt,
      reason: `Unregistered Git repository at ${repoDir}`,
      proposedEntry: {
        key,
        name: titleCase(basename(repoDir)),
        repo: repoDir,
        contextDir: "context",
        status: "active",
        owner: "founder",
        ...(info.github ? { github: info.github } : {}),
      },
    });
  }
  proposals.sort((a, b) => a.key.localeCompare(b.key));
  return { proposals, scannedRoots: scanRoots, warnings };
}

// ---- filesystem walk ----

function walk(dir, depth, maxDepth, ignore, onRepo) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.isDirectory() && e.name === ".git")) {
    onRepo(resolve(dir));
    return; // do not descend into a repo looking for nested repos
  }
  if (depth >= maxDepth) return;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || ignore.has(entry.name)) continue;
    walk(join(dir, entry.name), depth + 1, maxDepth, ignore, onRepo);
  }
}

function describeRepo(repoDir) {
  return {
    github: parseGithubRemote(readOriginUrl(repoDir)),
    lastCommitAt: lastCommitAt(repoDir),
  };
}

// Read the origin URL straight from .git/config — no subprocess.
export function readOriginUrl(repoDir) {
  const configPath = join(repoDir, ".git", "config");
  if (!existsSync(configPath)) return null;
  let text;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  let inOrigin = false;
  for (const line of lines) {
    const section = line.match(/^\s*\[(.+?)\]\s*$/);
    if (section) {
      inOrigin = /^remote\s+"origin"$/.test(section[1].trim());
      continue;
    }
    if (inOrigin) {
      const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
      if (url) return url[1];
    }
  }
  return null;
}

export function parseGithubRemote(url) {
  if (!url || typeof url !== "string") return null;
  // git@github.com:owner/repo.git  or  https://github.com/owner/repo(.git)
  const ssh = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  const https = url.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  const m = ssh || https;
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

function lastCommitAt(repoDir) {
  const head = join(repoDir, ".git", "logs", "HEAD");
  try {
    if (!existsSync(head)) return null;
    const text = readFileSync(head, "utf8").trim();
    const last = text.split("\n").filter(Boolean).pop();
    if (!last) return null;
    const ts = last.match(/>\s(\d{9,})\s/);
    return ts ? new Date(Number(ts[1]) * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

// ---- string helpers ----

export function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
}

function titleCase(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || value;
}
