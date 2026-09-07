#!/usr/bin/env node
// One command: is Headquarters up, and where can I reach it?
//
//   node scripts/hq-status.mjs        (or: npm run hq:status)
//
// Read-only. Reports pm2 apps, the current public tunnel URL, the OpenClaw
// gateway probe, and the dashboard readiness endpoint.

import { execFileSync } from "child_process";

const g = { ok: "✓", warn: "!", fail: "✗" };
let failed = false;
const line = (level, text, detail) => { if (level === "fail") failed = true; console.log(`${g[level]} ${text}`); if (detail) console.log(`    ${detail}`); };

function sh(cmd, args, { timeout = 8000 } = {}) {
  try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout }).trim(); }
  catch (e) { return { error: String(e.stdout || "") + String(e.stderr || e.message || "") }; }
}

console.log("\nHeadquarters status\n===================\n");

// pm2 apps
const pm2 = sh("pm2", ["jlist"]);
if (pm2.error) line("warn", "pm2 not reachable", pm2.error.split("\n")[0]);
else {
  let apps = [];
  try { apps = JSON.parse(pm2); } catch { /* ignore */ }
  for (const name of ["hq-dashboard", "hq-tunnel"]) {
    const a = apps.find((x) => x.name === name);
    if (!a) { line("warn", `pm2 app ${name} not found`); continue; }
    const st = a.pm2_env?.status;
    line(st === "online" ? "ok" : "fail", `pm2 ${name}: ${st}`, `pid ${a.pid} · uptime ${a.pm2_env?.pm_uptime ? Math.round((Date.now() - a.pm2_env.pm_uptime) / 3600000) + "h" : "?"} · restarts ${a.pm2_env?.restart_time ?? "?"}`);
  }
}

// public tunnel URL
let url = null;
const quick = sh("curl", ["-s", "--max-time", "4", "http://127.0.0.1:20241/quicktunnel"]);
if (typeof quick === "string" && quick) { try { url = JSON.parse(quick).hostname; } catch { /* ignore */ } }
if (!url) {
  const logs = sh("pm2", ["logs", "hq-tunnel", "--lines", "80", "--nostream"]);
  if (typeof logs === "string") { const m = logs.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i); if (m) url = m[0].replace(/^https:\/\//, ""); }
}
if (url) line("ok", "public URL", `https://${url}  (quick tunnel — changes when hq-tunnel restarts; see DEPLOY.md for a stable named tunnel)`);
else line("warn", "public URL unknown", "hq-tunnel may be down or between URLs");

// OpenClaw gateway
const gw = sh("openclaw", ["daemon", "status"], { timeout: 15000 });
if (typeof gw === "string" && /Runtime:\s*running/i.test(gw)) line("ok", "OpenClaw gateway running", /probe:\s*ok/i.test(gw) ? "connectivity probe ok" : "probe not confirmed");
else line("fail", "OpenClaw gateway not confirmed running", typeof gw === "string" ? gw.split("\n").find((l) => /Runtime:/i.test(l)) : gw.error?.split("\n")[0]);

// dashboard readiness (loopback)
const port = process.env.DASHBOARD_PORT || "3211";
const ready = sh("curl", ["-s", "--max-time", "4", `http://127.0.0.1:${port}/api/system/readiness`]);
if (typeof ready === "string" && ready) {
  try { const r = JSON.parse(ready); line(r.ok === false ? "warn" : "ok", `dashboard on :${port} responding`, r.summary || ""); }
  catch { line("ok", `dashboard on :${port} responding`); }
} else line("warn", `dashboard on :${port} not answering readiness`, "may just require auth — check pm2 hq-dashboard logs");

console.log(`\n${failed ? "Something is down — see ✗ above." : "Headquarters is up."}\n`);
process.exitCode = failed ? 1 : 0;
