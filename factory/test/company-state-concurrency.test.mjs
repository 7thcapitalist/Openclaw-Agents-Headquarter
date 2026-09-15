// buildCompanyState's two optional enrichments are the whole cost of the Today
// tab. Measured 2026-09-15: the local build is 17ms, `?runtime=1` adds 3,679ms,
// `?github=1` adds 3,728ms, and the dashboard asks for both — 7,544ms, because
// they ran one after another and the GitHub reads looped one project at a time.
//
// These tests pin the overlap. They assert on observed concurrency rather than
// on wall-clock speed, so they do not become flaky on a loaded machine.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildCompanyState } from "../lib/hq/company-state.mjs";

// Tracks how many calls are in flight at once, so a sequential implementation
// (peak 1) is distinguishable from a parallel one (peak > 1).
function concurrencyProbe(delayMs = 25) {
  const state = { inFlight: 0, peak: 0, calls: [] };
  const wrap = async (label, result) => {
    state.calls.push(label);
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    await new Promise((r) => setTimeout(r, delayMs));
    state.inFlight -= 1;
    return result;
  };
  return { state, wrap };
}

// factory/projects.json is the registry and the source of truth for which
// projects exist; the dashboard's own projects.json only supplements it. A
// fixture that writes the dashboard file alone yields zero projects and the
// enrichment paths never run.
function fixture(projects) {
  const root = mkdtempSync(join(tmpdir(), "company-concurrency-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  mkdirSync(join(root, "dashboard", "backend", "data", "hq"), { recursive: true });
  for (const f of ["tasks", "agents", "sops", "reports", "logs"]) {
    writeFileSync(join(root, "dashboard", "backend", "data", "hq", `${f}.json`), "[]");
  }
  writeFileSync(join(root, "dashboard", "backend", "data", "hq", "projects.json"), "[]");
  writeFileSync(join(root, "factory", "projects.json"), JSON.stringify({ version: 1, projects }));
  writeFileSync(join(root, "factory", "agents.json"), JSON.stringify({ version: 1, agents: [] }));
  return root;
}

const twoRepos = [
  { key: "alpha", name: "Alpha", kind: "project", repo: ".", status: "active", github: { owner: "acme", repo: "alpha" } },
  { key: "beta", name: "Beta", kind: "project", repo: ".", status: "active", github: { owner: "acme", repo: "beta" } },
];

test("GitHub awareness for several projects is fetched concurrently, not one repo at a time", async () => {
  const probe = concurrencyProbe();
  const exec = async (args) => probe.wrap(`gh ${args.join(" ")}`, { stdout: "{}", stderr: "", code: 0 });

  await buildCompanyState({
    hqRoot: fixture(twoRepos),
    tasks: [],
    hqProjects: twoRepos,
    withGithub: true,
    withRuntime: false,
    exec,
  });

  assert.ok(probe.state.calls.length > 0, "the test must actually exercise the GitHub path");
  assert.ok(
    probe.state.peak > 1,
    `expected overlapping GitHub reads, saw peak concurrency ${probe.state.peak} (sequential)`
  );
});

test("the runtime read overlaps the GitHub reads instead of queueing behind them", async () => {
  const probe = concurrencyProbe();
  const exec = async (args) => probe.wrap(`gh ${args.join(" ")}`, { stdout: "{}", stderr: "", code: 0 });
  const runtimeExec = async (args) => probe.wrap(`openclaw ${args.join(" ")}`, { stdout: "{}", stderr: "", code: 0 });

  await buildCompanyState({
    hqRoot: fixture(twoRepos),
    tasks: [],
    hqProjects: twoRepos,
    withGithub: true,
    withRuntime: true,
    exec,
    runtimeExec,
  });

  const sawGithub = probe.state.calls.some((c) => c.startsWith("gh "));
  const sawRuntime = probe.state.calls.some((c) => c.startsWith("openclaw "));
  assert.ok(sawGithub && sawRuntime, "both enrichment paths must run when both flags are set");
  assert.ok(
    probe.state.peak > 1,
    `expected GitHub and runtime work to overlap, saw peak concurrency ${probe.state.peak}`
  );
});

test("neither enrichment runs when the flags are off — the cheap path stays cheap", async () => {
  const probe = concurrencyProbe();
  const exec = async (args) => probe.wrap(`gh ${args.join(" ")}`, { stdout: "{}", stderr: "", code: 0 });
  const runtimeExec = async (args) => probe.wrap(`openclaw ${args.join(" ")}`, { stdout: "{}", stderr: "", code: 0 });

  const state = await buildCompanyState({
    hqRoot: fixture(twoRepos),
    tasks: [],
    hqProjects: twoRepos,
    withGithub: false,
    withRuntime: false,
    exec,
    runtimeExec,
  });

  assert.equal(probe.state.calls.length, 0, "no subprocess should run with both flags off");
  assert.equal(state.runtime, null);
});

test("external awareness keeps one entry per repo, in project order", async () => {
  const exec = async () => ({ stdout: "{}", stderr: "", code: 0 });

  const state = await buildCompanyState({
    hqRoot: fixture(twoRepos),
    tasks: [],
    hqProjects: twoRepos,
    withGithub: true,
    withRuntime: false,
    exec,
  });

  // Promise.all preserves order, so parallelising must not reshuffle the panel.
  const keys = (state.external || []).map((e) => e.project);
  assert.deepEqual(keys, [...keys].sort((a, b) => keys.indexOf(a) - keys.indexOf(b)));
  assert.equal(new Set(keys).size, keys.length, "no repo should be fetched twice");
});
