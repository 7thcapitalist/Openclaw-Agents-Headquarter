/**
 * PM2 process definitions for the Headquarters dashboard + its public tunnel.
 *
 *   pm2 start dashboard/backend/ecosystem.config.cjs
 *   pm2 save
 *
 * - hq-dashboard : the Express control plane (dashboard/backend/server.mjs),
 *   bound to 127.0.0.1 only. Reads its secrets/config from <repo-root>/.env
 *   (server.mjs loads dotenv from $AGENT_LAB_ROOT/.env).
 * - hq-publisher : pushes the Headquarters mirror to the Vercel control plane
 *   (SFD-2026-012). Outbound only — it opens connections and never accepts
 *   them. Reads HQ_CONTROL_PLANE_URL and HQ_WRITE_TOKEN from <repo-root>/.env.
 *   Stopping it is rollback level 1: the hosted view goes stale and says so,
 *   and the factory is unaffected.
 * - hq-intents   : polls the control plane for founder intents and runs them
 *   locally through the existing gates. Outbound only. The closed handler map
 *   in scripts/hq-intents.mjs is the whole of what a founder intent can cause
 *   on this machine; `node scripts/hq-intents.mjs peek` prints it.
 * - hq-tunnel    : the cloudflared tunnel that publishes the dashboard on the
 *   public internet. Two modes, chosen by CLOUDFLARE_TUNNEL_NAME in <repo-root>/.env:
 *     unset -> a *quick* tunnel on an ephemeral https://<random>.trycloudflare.com
 *              URL that changes every time this process restarts. Recover it with:
 *                  curl -s http://127.0.0.1:20241/quicktunnel
 *     set   -> a *named* tunnel on a stable hostname, reading ingress rules from
 *              ~/.cloudflared/config.yml. Survives restarts and reboots, and can
 *              serve several hostnames from the one tunnel.
 *   Setup for the named mode: docs/mini-pc/CLOUDFLARE_TUNNEL.md
 *
 * No secrets live in this file — it is safe to commit.
 */
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ENV_FILE = path.join(REPO_ROOT, ".env");

/** Minimal .env reader (KEY=VALUE, ignores comments/blank lines, strips quotes). */
function readEnvFile(file) {
  const out = {};
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const raw of text.split("\n")) {
    const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

const env = readEnvFile(ENV_FILE);
const PORT = env.DASHBOARD_PORT || "3211";
const METRICS_PORT = env.CLOUDFLARED_METRICS_PORT || "20241";
const CLOUDFLARED = path.join(process.env.HOME || "/home/joao-vitor", ".local/bin/cloudflared");

// Named tunnel vs quick tunnel.
//
// Set CLOUDFLARE_TUNNEL_NAME in .env once `cloudflared tunnel login` and
// `cloudflared tunnel create <name>` have run and the hostname is routed. Until
// then this stays empty and the quick tunnel keeps working exactly as before —
// so this file is safe to merge before the domain exists.
//
// The named tunnel reads its ingress rules from config.yml (see
// docs/mini-pc/CLOUDFLARE_TUNNEL.md) rather than taking an origin on the command
// line, which is what lets one tunnel serve several hostnames later.
const TUNNEL_NAME = env.CLOUDFLARE_TUNNEL_NAME || "";
const TUNNEL_CONFIG =
  env.CLOUDFLARE_TUNNEL_CONFIG ||
  path.join(process.env.HOME || "/home/joao-vitor", ".cloudflared", "config.yml");

// --metrics is kept in BOTH modes: scripts/hq-status.mjs reads that port, and in
// quick-tunnel mode it is also the only way to recover the random hostname.
const tunnelArgs = TUNNEL_NAME
  ? [
      "tunnel",
      "--no-autoupdate",
      "--config",
      TUNNEL_CONFIG,
      "--metrics",
      `127.0.0.1:${METRICS_PORT}`,
      "run",
      TUNNEL_NAME,
    ]
  : [
      "tunnel",
      "--no-autoupdate",
      "--url",
      `http://127.0.0.1:${PORT}`,
      "--metrics",
      `127.0.0.1:${METRICS_PORT}`,
    ];

module.exports = {
  apps: [
    {
      name: "hq-dashboard",
      cwd: __dirname,
      script: "server.mjs",
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        // server.mjs computes labRoot() from this BEFORE loading .env, so it
        // must be a real process env var, not something from .env itself.
        AGENT_LAB_ROOT: REPO_ROOT,
      },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      min_uptime: 5000,
      kill_timeout: 8000,
      time: true,
    },
    {
      name: "hq-publisher",
      cwd: REPO_ROOT,
      script: "scripts/hq-publish.mjs",
      args: ["loop"],
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        AGENT_LAB_ROOT: REPO_ROOT,
        HQ_CONTROL_PLANE_URL: env.HQ_CONTROL_PLANE_URL || "",
        HQ_WRITE_TOKEN: env.HQ_WRITE_TOKEN || "",
        HQ_PUBLISH_INTERVAL_MS: env.HQ_PUBLISH_INTERVAL_MS || "30000",
      },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      min_uptime: 5000,
      kill_timeout: 25000,
      time: true,
    },
    {
      name: "hq-intents",
      cwd: REPO_ROOT,
      script: "scripts/hq-intents.mjs",
      args: ["loop"],
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        AGENT_LAB_ROOT: REPO_ROOT,
        HQ_CONTROL_PLANE_URL: env.HQ_CONTROL_PLANE_URL || "",
        HQ_WRITE_TOKEN: env.HQ_WRITE_TOKEN || "",
        HQ_INTENT_INTERVAL_MS: env.HQ_INTENT_INTERVAL_MS || "30000",
        // One factory run at a time from intents. Takes effect only when this
        // process is next started from this file (pm2 start/reload --update-env).
        FACTORY_MAX_CONCURRENT: "1",
      },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      min_uptime: 5000,
      kill_timeout: 25000,
      time: true,
    },
    {
      name: "hq-tunnel",
      script: CLOUDFLARED,
      interpreter: "none",
      // Quick tunnel by default; named tunnel when CLOUDFLARE_TUNNEL_NAME is set
      // in .env. Either way the origin is loopback, because the dashboard binds
      // 127.0.0.1 and the tunnel is the only path in from the internet.
      args: tunnelArgs,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      min_uptime: 5000,
      time: true,
    },
  ],
};
