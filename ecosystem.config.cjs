// How the HQ control plane actually runs.
//
// Until this file existed, the answer lived only in pm2's memory. Each process
// had been started by hand from whichever shell was open at the time, so it
// inherited that shell's environment — including, in the live snapshot taken on
// 2026-09-15, the CLAUDE_CODE_SESSION_ID and CODEX_SESSION_ID of the agent
// session that happened to start it. Worse, settings that exist NOWHERE else
// were only in that memory: HQ_AUTO_RETRY=0 is not in .env and not in the repo,
// so reading either one told you the opposite of what was running.
//
// A process list you cannot reconstruct is a process list you cannot restore.
// This file is the reconstruction.
//
// Secrets are NOT in here. `.env` stays the only place they live, and is read
// at load time by the tiny parser below rather than by a dependency, so this
// file works from a checkout with nothing installed at the root.
//
// Deploy is: git pull in THIS checkout, then `pm2 reload ecosystem.config.cjs`.
// Nothing else may point pm2 at a different directory — see DEPLOY.md.
//
// MEMORY CEILINGS, AND WHAT THEY DO NOT COVER
//
// Every app carries a `max_memory_restart`. On 2026-09-15 the machine died of
// global OOM: the kernel killed `PM2 v7.0.4: God` at 4.5 GB, taking all four
// services with it, and the box had TWO God daemons running at once — 8.4 GB of
// a 14 GB machine spent on process management. Before that the dashboard had
// been starved for minutes, serving requests in 6-8 minutes until clients gave
// up. Nothing had a ceiling, so nothing was restarted before everything died.
//
// The ceilings below are sized where "something is wrong", not where "this is
// busy" — steady state is dashboard ~120 MB, publisher ~125 MB, intents ~90 MB,
// tunnel ~38 MB.
//
// BUT: pm2 does not apply `max_memory_restart` to its own daemon, and God is
// what actually died. A ceiling here would not have prevented that incident.
// The only guard that reaches God is a cgroup limit on the systemd unit that
// starts it (`pm2-hq.service`, a systemd --user unit). That lives on the
// machine, not in this repo — DEPLOY.md records it.

const { readFileSync } = require("node:fs");
const { join } = require("node:path");

// The runtime checkout is wherever this file is. Nothing is hardcoded to a
// path, so the same file serves a restore onto another machine.
const ROOT = __dirname;

// A deliberately small .env reader: KEY=VALUE, `export ` tolerated, quotes
// stripped, `#` comments and blank lines skipped. It does not interpolate and
// it does not overwrite anything already in the environment.
function readEnvFile(path) {
  let raw;
  try { raw = readFileSync(path, "utf8"); } catch { return {}; }
  const out = {};
  for (const line of raw.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.split(" #")[0].trim();
    }
    out[match[1]] = value;
  }
  return out;
}

const file = readEnvFile(join(ROOT, ".env"));

// Only the variables a given app actually reads are passed to it. The publisher
// and the intent worker hold the write token; the dashboard does not need it,
// and not handing it over is the same credential split the control plane
// already enforces on the wire.
const pick = (...names) => Object.fromEntries(
  names.filter((name) => file[name] !== undefined).map((name) => [name, file[name]]),
);

const common = { NODE_ENV: "production", AGENT_LAB_ROOT: ROOT };

module.exports = {
  apps: [
    {
      // The founder's control room, and the process the orchestrator runs
      // inside. Restarting it stops any objective that is mid-flight.
      name: "hq-dashboard",
      script: join(ROOT, "dashboard", "backend", "server.mjs"),
      cwd: join(ROOT, "dashboard", "backend"),
      interpreter: "node",
      exec_mode: "fork",
      autorestart: true,
      // Deliberately generous. Restarting this process abandons any objective
      // mid-flight, so the ceiling is set where "something is wrong" rather
      // than where "this is busy" — steady state is ~120 MB. It exists for the
      // pathological case only; the boot reconciler picks the work back up.
      max_memory_restart: "2G",
      env: {
        ...common,
        // Not in .env, not in the repo, and load-bearing: with auto-retry on,
        // infra-class failures recover on their own instead of waiting in the
        // Founder Inbox. It is OFF deliberately — see the gate-integrity
        // campaign, which requires verdict attribution to land before anything
        // retries automatically.
        HQ_AUTO_RETRY: "0",
        HQ_AUTO_RETRY_INTERVAL_MS: "90000",
        HQ_AUTO_RETRY_MAX: "3",
        // The orchestrator runs inside THIS process and every node it schedules
        // becomes a live agent session on the gateway. On 2026-09-15 the gateway
        // was OOM-killed twice in twenty minutes (status=9/KILL, peaks of 5.5G
        // and 4.3G against MemoryHigh=5G/MemoryMax=6G) while running the default
        // of 3. Each kill severs every in-flight dispatch, which the factory
        // records as "wrote no result file" and charges to recovery budget — two
        // objectives burned eleven attempts between them on work that was fine.
        // Dropped to 1 (with agents.defaults.maxConcurrent 4->2 in the OpenClaw
        // config); the gateway then held at 1-3G across both objectives running
        // to merge-ready. Raise it only with the gateway's memory in view.
        FACTORY_MAX_CONCURRENT: "1",
      },
    },
    {
      // Outbound only: builds a snapshot and PUTs it. Nothing listens here.
      name: "hq-publisher",
      script: join(ROOT, "scripts", "hq-publish.mjs"),
      args: ["loop"],
      cwd: ROOT,
      // REQUIRED, not cosmetic. Without an explicit interpreter pm2 loads the
      // script inside its own fork container, which makes process.argv[1]
      // pm2's wrapper rather than the script. hq-intents.mjs guards its entry
      // point on `resolve(process.argv[1]) === fileURLToPath(import.meta.url)`
      // — a guard that exists so the wiring test can import the handler map
      // without starting a poller — so under the container it matches nothing,
      // runs nothing, prints nothing, and pm2's IPC channel keeps the silent
      // process alive and `online` forever. Observed on 2026-09-15: alive, 0
      // restarts, an empty log, and not one intent polled.
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      // Builds a snapshot every 30s and sends it. Steady state ~125 MB; a
      // publisher past 768 MB is leaking, not working.
      max_memory_restart: "768M",
      // hq-publish.mjs reads process.env directly and never loads .env itself,
      // which is exactly why these must be passed in rather than assumed.
      env: { ...common, ...pick("HQ_CONTROL_PLANE_URL", "HQ_WRITE_TOKEN", "HQ_PUBLISH_INTERVAL_MS") },
    },
    {
      // Also outbound only: polls for founder intents and runs them here.
      name: "hq-intents",
      script: join(ROOT, "scripts", "hq-intents.mjs"),
      args: ["loop"],
      cwd: ROOT,
      // REQUIRED, not cosmetic. Without an explicit interpreter pm2 loads the
      // script inside its own fork container, which makes process.argv[1]
      // pm2's wrapper rather than the script. hq-intents.mjs guards its entry
      // point on `resolve(process.argv[1]) === fileURLToPath(import.meta.url)`
      // — a guard that exists so the wiring test can import the handler map
      // without starting a poller — so under the container it matches nothing,
      // runs nothing, prints nothing, and pm2's IPC channel keeps the silent
      // process alive and `online` forever. Observed on 2026-09-15: alive, 0
      // restarts, an empty log, and not one intent polled.
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      // A poll loop. Steady state ~90 MB. It can detach an objective run, so
      // this is looser than a pure poller would need, but far below the
      // dashboard's.
      max_memory_restart: "1G",
      env: {
        ...common,
        ...pick("HQ_CONTROL_PLANE_URL", "HQ_WRITE_TOKEN"),
        HQ_INTENT_INTERVAL_MS: file.HQ_INTENT_INTERVAL_MS || "30000",
      },
    },
    {
      // The public way in. --no-autoupdate because an unattended binary swap
      // under a live tunnel is not a thing to discover during an incident.
      name: "hq-tunnel",
      script: join(require("node:os").homedir(), ".local", "bin", "cloudflared"),
      args: [
        "tunnel", "--no-autoupdate",
        "--url", `http://127.0.0.1:${file.DASHBOARD_PORT || 3211}`,
        "--metrics", "127.0.0.1:20241",
      ],
      cwd: ROOT,
      interpreter: "none",
      exec_mode: "fork",
      autorestart: true,
      // Steady state ~38 MB. Restarting the tunnel is cheap in itself but
      // issues a NEW quick-tunnel URL — see the header note.
      max_memory_restart: "512M",
      env: {},
    },
  ],
};
