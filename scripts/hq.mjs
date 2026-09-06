#!/usr/bin/env node
// Headquarters Integration Layer CLI.
//
// One JSON request in (flags, a JSON arg, --request <file>, or stdin), one JSON
// response out — same envelope style as scripts/project-intel.mjs.
//
//   node scripts/hq.mjs state [--github]
//   node scripts/hq.mjs projects
//   node scripts/hq.mjs agents
//   node scripts/hq.mjs discover
//   node scripts/hq.mjs github [--project <key>]
//   node scripts/hq.mjs chief-of-staff [--github]

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { listCompanyProjects } from "../factory/lib/hq/registry.mjs";
import { listAgents } from "../factory/lib/hq/agents.mjs";
import { buildAgentActivity } from "../factory/lib/hq/activity.mjs";
import { discoverProjects } from "../factory/lib/hq/discovery.mjs";
import { readRepoAwareness, summariseRepoAwareness } from "../factory/lib/hq/github.mjs";
import { buildCompanyState } from "../factory/lib/hq/company-state.mjs";
import { buildChiefOfStaffContext } from "../factory/lib/hq/chief-of-staff.mjs";
import { readHqConfig } from "../factory/lib/hq/config.mjs";
import { discoverTaskViews } from "../factory/lib/hq/tasks.mjs";

const hqRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    const request = await readRequest(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(await handleRequest(request), null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ version: 1, status: "error", error: error.message || String(error) }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

export async function handleRequest(request) {
  if (!request || request.version !== 1) throw new Error("Unsupported or missing request version.");
  const tasks = () => discoverTaskViews({ hqRoot, stateRoot: request.stateRoot || null });
  switch (request.action) {
    case "state": {
      const state = await buildCompanyState({ hqRoot, tasks: tasks(), withGithub: Boolean(request.github) });
      return { version: 1, status: "ok", state };
    }
    case "projects": {
      const { projects, warnings } = listCompanyProjects({ hqRoot });
      return { version: 1, status: "ok", projects, warnings };
    }
    case "agents": {
      const { agents, warnings } = listAgents(hqRoot);
      const activity = buildAgentActivity({ agents, tasks: tasks() });
      return { version: 1, status: "ok", warnings, ...activity };
    }
    case "discover": {
      const result = discoverProjects({ hqRoot });
      return { version: 1, status: "ok", ...result };
    }
    case "github": {
      const config = readHqConfig(hqRoot);
      const { projects } = listCompanyProjects({ hqRoot, withIntelligence: false });
      const targets = projects.filter((p) => p.github && (!request.project || p.key === request.project));
      if (!targets.length) {
        return { version: 1, status: "ok", repos: [], note: "No registered project has a github { owner, repo } entry." };
      }
      const repos = [];
      for (const p of targets) {
        const awareness = await readRepoAwareness({
          owner: p.github.owner,
          repo: p.github.repo,
          enabled: config.github.enabled !== false,
          limits: { commits: config.github.commitLimit, prs: config.github.prLimit, issues: config.github.issueLimit },
        });
        repos.push({ project: p.key, ...awareness, summary: summariseRepoAwareness(awareness) });
      }
      return { version: 1, status: "ok", repos };
    }
    case "chief-of-staff": {
      const context = await buildChiefOfStaffContext({ hqRoot, tasks: tasks(), withGithub: Boolean(request.github) });
      return { version: 1, status: "ok", context };
    }
    default:
      throw new Error(`Unsupported action: ${request.action}`);
  }
}

// ---- request parsing (same shape as scripts/project-intel.mjs) ----

function requestFromFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i += 1; }
    } else if (!out.action) {
      out.action = arg;
    }
  }
  return out;
}

function readRequest(argv) {
  if (argv[0] === "--request" && argv[1]) return JSON.parse(readFileSync(resolve(argv[1]), "utf8"));
  if (argv[0] && argv[0].trim().startsWith("{")) return JSON.parse(argv[0]);
  if (argv[0] && !argv[0].startsWith("-")) return { version: 1, ...requestFromFlags(argv) };
  if (process.stdin.isTTY) return { version: 1, ...requestFromFlags(argv) };
  const chunks = [];
  process.stdin.setEncoding("utf8");
  return new Promise((resolveRequest, reject) => {
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      const body = chunks.join("").trim();
      if (!body) return resolveRequest({ version: 1, ...requestFromFlags(argv) });
      try { resolveRequest(JSON.parse(body)); } catch (error) { reject(new Error(`Invalid JSON request: ${error.message}`)); }
    });
  });
}
