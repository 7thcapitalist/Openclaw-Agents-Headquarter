// Is the machine healthy? — the factory-side answer.
//
// `dashboard/backend/lib/readiness.mjs` already answers this and has done for
// months. It has never had a UI, on either surface, which is why the 2026-09-14
// outage was discovered by a founder noticing something felt wrong rather than
// by a panel saying so.
//
// It cannot simply be published. It takes the dashboard's SQLite handle as its
// first argument and reads `dashboard/backend/lib/`, and `factory/` must not
// import from `dashboard/` — the dependency runs the other way round, and
// inverting it would make the factory's libraries need the dashboard in order
// to load. So this is a deliberately smaller, factory-side equivalent, built
// from what the factory can see on its own.
//
// It checks the things that have actually gone wrong on this machine:
//
//   * DISK. On 2026-09-14 one task's state store reached 399 GiB with 14 GiB
//     free and about an hour left. Nothing on any screen said so. This is the
//     single check that would have bought that hour back.
//   * THE STATE STORES themselves, biggest first, because "the disk is filling"
//     and "this one task is why" are different facts and the founder needs the
//     second one to act.
//   * THE SERVICES, because a publisher that is down looks exactly like a
//     factory that is quiet.
//   * THE GATEWAY, because every agent dispatch goes through it, and it has
//     been OOM-killed three times.
//
// Everything here is read-only and degrades to a warning. A readiness report
// that throws is a readiness report that tells you nothing, which is worse than
// the silence it replaced.

import { existsSync, readdirSync, statSync, statfsSync } from "fs";
import { join, resolve, relative } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { defaultStateRoot } from "./tasks.mjs";

const execFileAsync = promisify(execFile);

export const READINESS_CONTRACT = "hq.readiness/1";

// The four services that make the HQ work. Named here rather than discovered,
// so a service that has vanished from pm2 entirely reads as missing instead of
// as an empty list that looks fine.
export const EXPECTED_SERVICES = ["hq-dashboard", "hq-publisher", "hq-intents", "hq-tunnel"];

// Thresholds. Deliberately generous: this panel exists to catch a machine on
// fire, not to nag. `warn` is "look at this today", `fail` is "act now".
const DISK_WARN_FREE_RATIO = 0.15;
const DISK_FAIL_FREE_RATIO = 0.05;
// A healthy seven-stage task's store is a few MiB. A gigabyte means something
// is looping.
const STORE_WARN_BYTES = 1024 ** 3;
const STORE_FAIL_BYTES = 16 * 1024 ** 3;

function bytesOf(path) {
  try { return statSync(path).size; } catch { return 0; }
}

// A task's store is the SQLite file plus its write-ahead log, which is where a
// runaway loop's bytes actually land first.
function storeBytes(dir) {
  return ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"]
    .reduce((total, name) => total + bytesOf(join(dir, name)), 0);
}

function walkTaskDirs(root, out = [], depth = 0) {
  if (depth > 4) return out;
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    if (existsSync(join(dir, "state.sqlite")) || existsSync(join(dir, "state.json"))) out.push(dir);
    else walkTaskDirs(dir, out, depth + 1);
  }
  return out;
}

export function checkDisk(path) {
  try {
    const fs = statfsSync(path);
    // bavail, not bfree: the reserved blocks are not ours to fill.
    const totalBytes = fs.blocks * fs.bsize;
    const freeBytes = fs.bavail * fs.bsize;
    const freeRatio = totalBytes > 0 ? freeBytes / totalBytes : 0;
    const status = freeRatio <= DISK_FAIL_FREE_RATIO ? "fail" : freeRatio <= DISK_WARN_FREE_RATIO ? "warn" : "ok";
    return {
      status,
      totalBytes,
      freeBytes,
      freePercent: Math.round(freeRatio * 1000) / 10,
      detail: `${formatBytes(freeBytes)} free of ${formatBytes(totalBytes)}`,
    };
  } catch (error) {
    return { status: "unknown", detail: `disk usage could not be read: ${error.message}` };
  }
}

export function checkStateStores({ hqRoot, stateRoot = null, limit = 5 }) {
  const root = resolve(stateRoot || defaultStateRoot(hqRoot));
  if (!existsSync(root)) {
    return { status: "unknown", totalBytes: 0, taskCount: 0, largest: [], detail: "no factory state root exists yet" };
  }
  const dirs = walkTaskDirs(root);
  const sized = dirs
    .map((dir) => ({ task: relative(root, dir), bytes: storeBytes(dir) }))
    .sort((a, b) => b.bytes - a.bytes);
  const totalBytes = sized.reduce((sum, entry) => sum + entry.bytes, 0);
  const biggest = sized[0]?.bytes || 0;
  const status = biggest >= STORE_FAIL_BYTES ? "fail" : biggest >= STORE_WARN_BYTES ? "warn" : "ok";
  return {
    status,
    totalBytes,
    taskCount: sized.length,
    largest: sized.slice(0, limit).map((entry) => ({ ...entry, size: formatBytes(entry.bytes) })),
    detail: sized.length
      ? `${sized.length} task store${sized.length === 1 ? "" : "s"}, ${formatBytes(totalBytes)} total, largest ${formatBytes(biggest)}`
      : "no task stores yet",
  };
}

// The tunnel's address, asked of cloudflared rather than parsed out of its log.
//
// The tunnel runs as a QUICK tunnel — `cloudflared tunnel --url`, no Cloudflare
// account — so it is issued a new random *.trycloudflare.com hostname on every
// restart. Four have been handed out on this machine, and after the reboot on
// 2026-09-15 the only record of the live one was a banner inside a 70 MB log
// file, which meant no direct route into Headquarters at all.
//
// This lives here, in factory/, because BOTH readiness builders need it: the
// dashboard's own route and the snapshot published to the hosted console. The
// first version of this shipped into the dashboard module only, so the console
// — the page you open from a phone, the one place the address actually matters
// — went on reporting "No direct link". One probe, imported by both, is the
// only arrangement where that cannot happen again.
//
// `ok` requires an address AND a live connection: a cloudflared that is running
// with zero connections is not serving, and offering a link that fails without
// saying so is worse than offering none.
export async function checkTunnel({
  metricsAddr = process.env.HQ_TUNNEL_METRICS || "127.0.0.1:20241",
  fetchImpl = fetch,
  timeoutMs = 1500,
} = {}) {
  const read = async (path) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`http://${metricsAddr}${path}`, { signal: abort.signal });
      if (!response.ok) throw new Error(`${path} -> ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const [quick, ready] = await Promise.all([read("/quicktunnel"), read("/ready")]);
    const url = quick?.hostname ? `https://${quick.hostname}` : null;
    const connections = Number(ready?.readyConnections) || 0;
    if (!url) {
      return { status: "warn", detail: "cloudflared is running but has not been given an address", url: null, connections, quick: true };
    }
    if (!connections) {
      return { status: "warn", detail: "the address has no live connection — it will not answer yet", url, connections, quick: true };
    }
    return { status: "ok", detail: `reachable at ${url}`, url, connections, quick: true };
  } catch (error) {
    // `unknown`, not `warn`, and the distinction is this report's contract:
    // warn means something was OBSERVED to be wrong, unknown means it could not
    // be observed at all — the same category as pm2 missing. A machine with no
    // cloudflared is not a broken Headquarters, it is one this check cannot see
    // from here, and calling that a warning would make every deployment without
    // a tunnel report a problem it does not have.
    return {
      status: "unknown",
      detail: `no tunnel reachable: ${String(error?.message || error).slice(0, 120)}`,
      url: null,
      connections: 0,
    };
  }
}

export async function checkServices({ exec = execFileAsync, expected = EXPECTED_SERVICES } = {}) {
  let list;
  try {
    const { stdout } = await exec("pm2", ["jlist"], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    list = JSON.parse(stdout);
  } catch (error) {
    return { status: "unknown", services: [], detail: `pm2 is not reachable from this process: ${summarizeExecError(error)}` };
  }
  if (!Array.isArray(list)) return { status: "unknown", services: [], detail: "pm2 returned something that is not a process list" };

  const byName = new Map(list.map((entry) => [entry?.name, entry]));
  const services = expected.map((name) => {
    const entry = byName.get(name);
    if (!entry) return { name, state: "missing", restarts: null, uptimeMs: null, startedAt: null };
    return {
      name,
      state: entry.pm2_env?.status || "unknown",
      restarts: Number(entry.pm2_env?.restart_time ?? 0),
      uptimeMs: entry.pm2_env?.pm_uptime ? Math.max(0, Date.now() - entry.pm2_env.pm_uptime) : null,
      // The moment it started. Changes only on a restart, so a viewer can derive
      // uptime from it and a publish-on-change fingerprint still sees restarts —
      // which `uptimeMs`, growing every second, cannot be allowed to decide.
      startedAt: entry.pm2_env?.pm_uptime ? new Date(entry.pm2_env.pm_uptime).toISOString() : null,
    };
  });
  const down = services.filter((service) => service.state !== "online");
  return {
    status: down.length ? "fail" : "ok",
    services,
    detail: down.length
      ? `${down.map((service) => `${service.name} is ${service.state}`).join(", ")}`
      : `all ${services.length} services online`,
  };
}

export async function checkGateway({ exec = execFileAsync } = {}) {
  try {
    // `openclaw health` shells out to the gateway and has taken 25s on this
    // host. `gateway status` reads configuration and probes, and is the check
    // whose output the founder is already used to reading.
    const { stdout, stderr } = await exec("openclaw", ["gateway", "status"], { timeout: 10000, maxBuffer: 1024 * 1024 });
    // Both streams. `openclaw gateway status` prints its configuration to
    // stdout and its COMPLAINTS to stderr, so a check that reads stdout alone
    // reports "ok" straight through a real drift — which is the failure mode
    // this whole panel exists to stop.
    const output = `${stdout || ""}\n${stderr || ""}`;
    const outOfDate = /looks out of date or non-standard|doctor --repair/i.test(output);
    return {
      status: outOfDate ? "warn" : "ok",
      detail: outOfDate ? "the gateway service config is out of date or non-standard" : "gateway service configuration is current",
    };
  } catch (error) {
    return { status: "unknown", detail: `gateway status could not be read: ${summarizeExecError(error)}` };
  }
}

// The overall answer. `unknown` never fails the report: a check this process
// could not run is not evidence that anything is wrong, and treating it as one
// trains the founder to ignore the panel.
export function rollUp(checks) {
  const statuses = Object.values(checks).map((check) => check?.status);
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  if (statuses.every((status) => status === "ok")) return "ok";
  return "degraded";
}

// Why the subprocess checks are cached and the file checks are not.
//
// The publisher calls this on a 30-second floor, forever. `pm2 jlist` and
// `openclaw gateway status` cost about 1.8 seconds between them — two process
// spawns every half minute on a host whose gateway has already been OOM-killed
// three times — while reading the disk and walking 21 task directories costs
// 1.4 milliseconds.
//
// So the two execs are cached and the file checks never are. That is not only
// a cost decision: disk and store size are the fast-moving numbers (399 GiB
// accumulated in hours) and the ones the founder acts on, whereas a service
// going down or a gateway config drifting is not a thing that needs
// sub-minute resolution. The freshest answers are the ones that matter most.
const EXEC_CACHE_MS = 60_000;
const execCache = new Map();

async function cachedExecChecks({ exec, ttlMs, nowMs }) {
  // The cache key is the exec function itself, so an injected fake in a test
  // never reads or writes the real one's entry.
  const cached = execCache.get(exec);
  if (ttlMs > 0 && cached && nowMs - cached.at < ttlMs) return cached.value;
  const value = {
    services: await checkServices({ exec }),
    gateway: await checkGateway({ exec }),
  };
  if (ttlMs > 0) execCache.set(exec, { at: nowMs, value });
  return value;
}

export function clearReadinessCache() {
  execCache.clear();
}

export async function buildReadinessSnapshot({
  hqRoot,
  stateRoot = null,
  now = new Date().toISOString(),
  exec = execFileAsync,
  // 0 disables caching, for a test or a caller that wants a fresh look.
  ttlMs = EXEC_CACHE_MS,
  nowMs = Date.now(),
  fetchImpl = fetch,
} = {}) {
  const warnings = [];
  const root = resolve(stateRoot || defaultStateRoot(hqRoot));

  const settle = async (name, produce) => {
    try { return await produce(); } catch (error) {
      warnings.push(`${name} check failed: ${error.message}`);
      return { status: "unknown", detail: `${name} could not be checked` };
    }
  };

  const fromExec = await settle("services and gateway", () => cachedExecChecks({ exec, ttlMs, nowMs }));
  const checks = {
    // Disk is measured at the state root, not at "/", because that is the
    // filesystem the factory actually writes to.
    disk: await settle("disk", () => checkDisk(existsSync(root) ? root : resolve(hqRoot))),
    stateStores: await settle("state store", () => checkStateStores({ hqRoot, stateRoot })),
    services: fromExec.services || { status: "unknown", detail: "services could not be checked" },
    gateway: fromExec.gateway || { status: "unknown", detail: "gateway could not be checked" },
    // How to reach this machine at all. Published, so the hosted console can
    // show an address that is actually current.
    tunnel: await settle("tunnel", () => checkTunnel({ fetchImpl })),
  };

  for (const [name, check] of Object.entries(checks)) {
    if (check.status === "fail" || check.status === "warn") warnings.push(`${name}: ${check.detail}`);
  }

  return {
    version: 1,
    contract: READINESS_CONTRACT,
    asOf: now,
    available: true,
    readOnly: true,
    status: rollUp(checks),
    checks,
    warnings,
  };
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

function summarizeExecError(error) {
  return [
    error?.code ? `code=${error.code}` : "",
    error?.killed ? "killed=true" : "",
    String(error?.message || "").slice(0, 120),
  ].filter(Boolean).join(" ");
}
