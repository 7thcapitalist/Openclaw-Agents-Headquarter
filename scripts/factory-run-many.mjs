#!/usr/bin/env node
// Run several INDEPENDENT factory tasks at once. Each task keeps the normal
// sequential-plus-concurrent-review pipeline; the parallelism here is across
// tasks. Every task already gets its own state.json, worktree and `factory/<id>`
// branch (factory/lib/task-initializer.mjs), so there is no shared mutable state
// — the only contended resource is the model seats, which
// scripts/apply-review-model-routing.mjs spreads.
//
// Input: a JSON array on stdin (or --file <path>) of
//   { "objective": "...", "repo": "/abs/path", "project": "key", "issue": "42" }
// objective + repo are required; project/issue optional.
//
//   echo '[{"objective":"Add a health endpoint","repo":"/srv/app","project":"app"}]' \
//     | node scripts/factory-run-many.mjs --concurrency 2

import { readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { handleRequest } from "./openclaw-factory.mjs";

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const CONCURRENCY = Math.max(1, Number(arg("--concurrency", "2")));
const FILE = arg("--file", null);
const STATE_ROOT = arg("--state-root", null);

function readInput() {
  const raw = FILE ? readFileSync(resolve(FILE), "utf8") : readFileSync(0, "utf8");
  const list = JSON.parse(raw);
  if (!Array.isArray(list) || !list.length) throw new Error("Input must be a non-empty JSON array of tasks.");
  for (const [i, t] of list.entries()) {
    if (!t || typeof t.objective !== "string" || !t.objective.trim()) throw new Error(`tasks[${i}] needs an objective.`);
    if (!t.repo) throw new Error(`tasks[${i}] needs a repo.`);
  }
  return list;
}

export async function runPool(items, size, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i).catch((error) => ({ error: error.message || String(error) }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, lane));
  return results;
}

// Run every task through `handle` (defaults to the real factory adapter),
// `concurrency` at a time. Exported for tests; the CLI wraps it. A per-task
// `stateRoot` (or one from the task object) keeps factory state out of the HQ
// repo's own data dir.
export async function runMany({ tasks, concurrency = 2, handle = handleRequest, dependencies = {}, stateRoot = null }) {
  return runPool(tasks, concurrency, async (t) => {
    const started = Date.now();
    const res = await handle({
      version: 1, action: "start",
      objective: t.objective, repo: resolve(t.repo),
      project: t.project || undefined, issue: t.issue || undefined,
      stateRoot: t.stateRoot || stateRoot || undefined,
    }, dependencies);
    return { objective: t.objective, elapsedMs: Date.now() - started, ...res };
  });
}

async function main() {
  const tasks = readInput();
  console.log(`Running ${tasks.length} task(s), ${CONCURRENCY} at a time...\n`);

  const results = await runMany({ tasks, concurrency: CONCURRENCY, stateRoot: STATE_ROOT ? resolve(STATE_ROOT) : null });

  console.log("\n=== results ===");
  let ok = 0;
  for (const r of results) {
    const status = r.error ? `ERROR: ${r.error}` : `${r.status}${r.blocker ? ` (${r.blocker.stage}: ${r.blocker.summary})` : ""}`;
    if (r.status === "merge-ready") ok += 1;
    console.log(`- ${String(r.taskId || "?").padEnd(16)} ${Math.round((r.elapsedMs || 0) / 1000)}s  ${status}  ${r.objective.slice(0, 60)}`);
  }
  console.log(`\n${ok}/${results.length} reached merge-ready.`);
  process.exitCode = ok === results.length ? 0 : 1;
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
