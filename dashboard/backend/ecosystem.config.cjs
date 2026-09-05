/**
 * PM2 process definitions for the Headquarters dashboard + its public tunnel.
 *
 *   pm2 start dashboard/backend/ecosystem.config.cjs
 *   pm2 save
 *
 * - hq-dashboard : the Express control plane (dashboard/backend/server.mjs),
 *   bound to 127.0.0.1 only. Reads its secrets/config from <repo-root>/.env
 *   (server.mjs loads dotenv from $AGENT_LAB_ROOT/.env).
 * - hq-tunnel    : a Cloudflare *quick* tunnel (cloudflared) that publishes the
 *   dashboard on an ephemeral https://<random>.trycloudflare.com URL. The URL
 *   changes every time this process restarts; find the current one with:
 *       curl -s http://127.0.0.1:20241/quicktunnel
 *       pm2 logs hq-tunnel --lines 50 --nostream | grep trycloudflare.com
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
      name: "hq-tunnel",
      script: CLOUDFLARED,
      interpreter: "none",
      // Quick tunnel to the dashboard's real port (from .env, default 3211).
      // Origin host is loopback because the dashboard binds 127.0.0.1.
      args: [
        "tunnel",
        "--no-autoupdate",
        "--url",
        `http://127.0.0.1:${PORT}`,
        "--metrics",
        `127.0.0.1:${METRICS_PORT}`,
      ],
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      min_uptime: 5000,
      time: true,
    },
  ],
};
