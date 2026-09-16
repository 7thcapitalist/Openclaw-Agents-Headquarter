import { execFile } from "child_process";
import { promisify } from "util";
import { readHqState } from "./hqStore.mjs";
import { buildEnrichedAgents } from "./commandCenter.mjs";
import { countConceptualAgents, enrichHqAgentsWithLifecycle } from "./agentLifecycle.mjs";

const execFileAsync = promisify(execFile);

export async function buildReadinessReport(db, root) {
  const warnings = [];
  const checks = {
    dashboard: { ok: true },
    db: { ok: false },
    hqData: { ok: false },
    pm2: { ok: false },
    openclaw: { ok: false },
    tailscale: { ok: false, detected: false },
    // `advisory`: reported, never fatal. The tunnel is how the founder reaches
    // Headquarters from outside; it is not something Headquarters needs in
    // order to be healthy. A box with no tunnel is local-only, which is a fact
    // to show, not a reason to call the whole control plane unready.
    tunnel: { ok: false, url: null, connections: 0, advisory: true },
  };

  try {
    db.prepare("SELECT 1 AS ok").get();
    checks.db.ok = true;
  } catch (e) {
    checks.db.error = String(e.message || e);
  }

  let hqAgents = [];
  let labAgents = [];
  try {
    const state = readHqState(root);
    labAgents = await buildEnrichedAgents(db, root);
    hqAgents = enrichHqAgentsWithLifecycle(root, state.agents, labAgents);
    checks.hqData.ok = true;
  } catch (e) {
    checks.hqData.error = String(e.message || e);
  }

  try {
    await execFileAsync("pm2", ["jlist"], { timeout: 5000, maxBuffer: 1024 * 1024 });
    checks.pm2.ok = true;
  } catch (e) {
    checks.pm2.error = summarizeExecError(e);
    warnings.push("PM2 is not available to the dashboard process.");
  }

  // The tunnel's address, read from cloudflared itself.
  //
  // The tunnel runs as a QUICK tunnel — `cloudflared tunnel --url`, with no
  // Cloudflare account — so it is issued a NEW random *.trycloudflare.com
  // hostname every single time it starts. Four different addresses have been
  // handed out on this machine already. After the reboot on 2026-09-15 the
  // only record of the live one was a banner buried in a 70 MB log file.
  //
  // cloudflared publishes it on its own metrics server, so this asks the
  // process rather than parsing its output. Two localhost calls, ~10ms, and
  // the founder's console can show a link that is actually current.
  //
  // This does not make the address STABLE — only discoverable. A stable
  // hostname needs a named tunnel, which needs a Cloudflare account and a
  // domain. See DEPLOY.md.
  const tunnelMetrics = process.env.HQ_TUNNEL_METRICS || "127.0.0.1:20241";
  try {
    const [quick, ready] = await Promise.all([
      fetchTunnelJson(`http://${tunnelMetrics}/quicktunnel`),
      fetchTunnelJson(`http://${tunnelMetrics}/ready`),
    ]);
    if (quick?.hostname) checks.tunnel.url = `https://${quick.hostname}`;
    checks.tunnel.connections = Number(ready?.readyConnections) || 0;
    // Up means reachable from outside: an address AND a live connection. A
    // cloudflared that is running but has zero connections is not serving.
    checks.tunnel.ok = Boolean(checks.tunnel.url) && checks.tunnel.connections > 0;
    if (checks.tunnel.url && !checks.tunnel.connections) {
      warnings.push("The tunnel has an address but no live connection — it is not reachable from outside yet.");
    }
    checks.tunnel.quick = true;
  } catch (e) {
    // Never fatal. A missing tunnel does not make Headquarters unhealthy; it
    // makes it local-only, which is a fact to report, not an error to throw.
    checks.tunnel.error = String(e?.message || e).slice(0, 200);
  }

  try {
    await execFileAsync("openclaw", ["health"], { timeout: 25000, maxBuffer: 5 * 1024 * 1024 });
    checks.openclaw.ok = true;
  } catch (e) {
    checks.openclaw.error = summarizeExecError(e);
    warnings.push("OpenClaw health check failed or timed out.");
  }

  try {
    const { stdout } = await execFileAsync("tailscale", ["status", "--json"], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    checks.tailscale.ok = true;
    checks.tailscale.detected = true;
    const parsed = JSON.parse(stdout);
    checks.tailscale.self = parsed?.Self?.DNSName || parsed?.Self?.TailscaleIPs?.[0] || "detected";
  } catch (e) {
    checks.tailscale.error = summarizeExecError(e);
    warnings.push("Tailscale was not detected from the dashboard process.");
  }

  const realRunnableAgents = hqAgents.filter((a) => a.executable).length;
  const conceptualHqAgents = countConceptualAgents(hqAgents);

  if (realRunnableAgents === 0) {
    warnings.push("No HQ persona is currently backed by a runnable Agent Lab folder.");
  }
  const unregisteredFolders = hqAgents.filter(
    (a) => a.promotion?.runnableFolder && !a.promotion?.registered
  );
  if (unregisteredFolders.length) {
    warnings.push(`${unregisteredFolders.length} runnable folder(s) are not registered in SQLite.`);
  }

  return {
    ok: Object.values(checks).every((check) => check.advisory || check.ok || check.detected === false),
    checkedAt: new Date().toISOString(),
    root,
    checks,
    counts: {
      realRunnableAgents,
      conceptualHqAgents,
      registeredLabAgents: labAgents.length,
      hqAgents: hqAgents.length,
    },
    warnings,
  };
}

// Deliberately tiny: a localhost metrics endpoint that is either there or not.
// A short timeout because this sits on the Today tab's critical path.
async function fetchTunnelJson(url, { timeoutMs = 1500 } = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: abort.signal });
    if (!response.ok) throw new Error(`${url} -> ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function summarizeExecError(error) {
  const pieces = [
    error?.code ? `code=${error.code}` : "",
    error?.signal ? `signal=${error.signal}` : "",
    error?.killed ? "killed=true" : "",
    error?.message || "",
  ].filter(Boolean);
  return pieces.join(" ");
}
