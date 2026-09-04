// Integration-layer configuration.
//
// factory/hq.config.json is optional. It tells discovery which workspace folders
// to scan and carries GitHub defaults. A missing or malformed file is not an
// error — the Integration Layer must keep working with defaults.

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";

export const DEFAULT_HQ_CONFIG = {
  version: 1,
  discovery: {
    // Where to look for sibling project repositories. `~` is expanded.
    workspaceRoots: ["~/projects"],
    // Directory names never treated as a project even if they hold a .git dir.
    ignore: ["node_modules", "worktrees", ".openclaw-worktrees", "archive", "tmp"],
    maxDepth: 2,
  },
  github: {
    // Read-only awareness only. `enabled: false` disables every `gh` call.
    enabled: true,
    commitLimit: 10,
    prLimit: 20,
    issueLimit: 20,
  },
};

export function hqConfigPath(hqRoot) {
  return join(resolve(hqRoot), "factory", "hq.config.json");
}

export function expandHome(p) {
  if (typeof p !== "string" || !p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// Read + normalise the config. Never throws.
export function readHqConfig(hqRoot) {
  const path = hqConfigPath(hqRoot);
  let raw = {};
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, "utf8")) || {};
    } catch {
      raw = {};
    }
  }
  return mergeConfig(DEFAULT_HQ_CONFIG, raw && typeof raw === "object" ? raw : {});
}

// Resolve the configured workspace roots to absolute paths.
export function workspaceRoots(hqRoot, config = readHqConfig(hqRoot)) {
  const roots = Array.isArray(config?.discovery?.workspaceRoots)
    ? config.discovery.workspaceRoots
    : DEFAULT_HQ_CONFIG.discovery.workspaceRoots;
  const out = [];
  for (const entry of roots) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    const expanded = expandHome(entry.trim());
    out.push(isAbsolute(expanded) ? expanded : resolve(hqRoot, expanded));
  }
  return [...new Set(out)];
}

function mergeConfig(base, override) {
  const out = { ...base, ...override };
  out.discovery = { ...base.discovery, ...(override.discovery || {}) };
  out.github = { ...base.github, ...(override.github || {}) };
  if (!Array.isArray(out.discovery.workspaceRoots) || out.discovery.workspaceRoots.length === 0) {
    out.discovery.workspaceRoots = base.discovery.workspaceRoots;
  }
  if (!Array.isArray(out.discovery.ignore)) out.discovery.ignore = base.discovery.ignore;
  return out;
}
