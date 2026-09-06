// Read-only GitHub awareness.
//
// The company should understand external reality: what actually landed, what is
// open, what is waiting. This is NOT a GitHub management system — it only reads,
// and only through the `gh` CLI (which carries the operator's own auth).
//
// Every call is guarded and independent: an offline `gh`, a missing repo, or a
// rate-limit degrades that one section, never the whole result. `exec` is
// injectable so this is testable without a network.

import { execFile } from "child_process";

const DEFAULT_LIMITS = { commits: 10, prs: 20, issues: 20 };

// Default runner: never throws, returns { stdout, stderr, code }.
function defaultExec(args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolvePromise) => {
    execFile("gh", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolvePromise({
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
      });
    });
  });
}

export async function githubAvailable(exec = defaultExec) {
  try {
    const res = await exec(["auth", "status"]);
    return res.code === 0;
  } catch {
    return false;
  }
}

/**
 * @param {object}   input
 * @param {string}   input.owner
 * @param {string}   input.repo
 * @param {Function}[input.exec]     (args:string[]) => Promise<{stdout,stderr,code}>
 * @param {object}  [input.limits]   { commits, prs, issues }
 * @param {boolean} [input.enabled=true]
 * @returns {Promise<object>} awareness object; `available:false` when `gh` cannot be used
 */
export async function readRepoAwareness({ owner, repo, exec = defaultExec, limits = {}, enabled = true }) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const warnings = [];
  const base = {
    owner, repo, slug: `${owner}/${repo}`,
    available: false, repoInfo: null, commits: [], branches: [],
    pullRequests: [], issues: [], warnings,
  };

  if (!enabled) {
    warnings.push({ code: "github-disabled", message: "GitHub awareness is disabled in factory/hq.config.json." });
    return base;
  }
  if (!owner || !repo) {
    warnings.push({ code: "github-coordinates-missing", message: "Project has no github { owner, repo }." });
    return base;
  }
  if (!(await githubAvailable(exec))) {
    warnings.push({ code: "gh-unavailable", message: "`gh` CLI is not installed or not authenticated." });
    return base;
  }

  base.available = true;
  const slug = `${owner}/${repo}`;

  const repoView = await runJson(exec, [
    "repo", "view", slug, "--json",
    "name,description,url,defaultBranchRef,pushedAt,isPrivate,isArchived",
  ], warnings, "repo-view");
  if (repoView) {
    base.repoInfo = {
      name: repoView.name,
      description: repoView.description || "",
      url: repoView.url,
      defaultBranch: repoView.defaultBranchRef?.name || null,
      pushedAt: repoView.pushedAt || null,
      isPrivate: Boolean(repoView.isPrivate),
      isArchived: Boolean(repoView.isArchived),
    };
  }

  const commits = await runJson(exec, [
    "api", `repos/${slug}/commits?per_page=${lim.commits}`,
  ], warnings, "commits");
  if (Array.isArray(commits)) {
    base.commits = commits.slice(0, lim.commits).map((c) => ({
      sha: (c.sha || "").slice(0, 10),
      message: firstLine(c.commit?.message),
      author: c.commit?.author?.name || c.author?.login || "unknown",
      date: c.commit?.author?.date || null,
    }));
  }

  const branches = await runJson(exec, [
    "api", `repos/${slug}/branches?per_page=50`,
  ], warnings, "branches");
  if (Array.isArray(branches)) {
    base.branches = branches.map((b) => b.name).filter(Boolean);
  }

  const prs = await runJson(exec, [
    "pr", "list", "--repo", slug, "--state", "open", "--limit", String(lim.prs),
    "--json", "number,title,author,isDraft,headRefName,baseRefName,createdAt,updatedAt,url",
  ], warnings, "pull-requests");
  if (Array.isArray(prs)) {
    base.pullRequests = prs.map((p) => ({
      number: p.number,
      title: p.title,
      author: p.author?.login || "unknown",
      isDraft: Boolean(p.isDraft),
      headRefName: p.headRefName,
      baseRefName: p.baseRefName,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      url: p.url,
    }));
  }

  const issues = await runJson(exec, [
    "issue", "list", "--repo", slug, "--state", "open", "--limit", String(lim.issues),
    "--json", "number,title,author,labels,createdAt,updatedAt,url",
  ], warnings, "issues");
  if (Array.isArray(issues)) {
    base.issues = issues.map((it) => ({
      number: it.number,
      title: it.title,
      author: it.author?.login || "unknown",
      labels: (it.labels || []).map((l) => l.name).filter(Boolean),
      createdAt: it.createdAt,
      updatedAt: it.updatedAt,
      url: it.url,
    }));
  }

  return base;
}

// A one-line human summary of a repo's external state, for the company view.
export function summariseRepoAwareness(awareness) {
  if (!awareness || !awareness.available) {
    return awareness?.warnings?.[0]?.message || "No GitHub awareness.";
  }
  const parts = [];
  if (awareness.commits[0]) {
    parts.push(`latest: "${truncate(awareness.commits[0].message, 60)}" (${awareness.commits[0].author})`);
  }
  if (awareness.pullRequests.length) {
    const waiting = awareness.pullRequests.filter((p) => !p.isDraft).length;
    parts.push(`${awareness.pullRequests.length} open PR(s)${waiting ? `, ${waiting} ready for review` : ""}`);
  }
  if (awareness.issues.length) parts.push(`${awareness.issues.length} open issue(s)`);
  return parts.join(" · ") || "No open PRs or issues.";
}

// ---- helpers ----

async function runJson(exec, args, warnings, code) {
  let res;
  try {
    res = await exec(args);
  } catch (error) {
    warnings.push({ code: `gh-${code}-failed`, message: error.message || String(error) });
    return null;
  }
  if (!res || res.code !== 0) {
    warnings.push({ code: `gh-${code}-failed`, message: trimErr(res?.stderr) || `gh exited ${res?.code}` });
    return null;
  }
  try {
    return JSON.parse(res.stdout || "null");
  } catch (error) {
    warnings.push({ code: `gh-${code}-unparseable`, message: error.message });
    return null;
  }
}

function firstLine(text) {
  return String(text || "").split("\n")[0].trim();
}

function trimErr(text) {
  return String(text || "").split("\n").filter(Boolean).slice(0, 2).join(" ").slice(0, 300);
}

function truncate(text, n) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, "")}…`;
}
