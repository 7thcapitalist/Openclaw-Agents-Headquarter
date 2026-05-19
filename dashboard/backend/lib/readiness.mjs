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
    ok: Object.values(checks).every((check) => check.ok || check.detected === false),
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

function summarizeExecError(error) {
  const pieces = [
    error?.code ? `code=${error.code}` : "",
    error?.signal ? `signal=${error.signal}` : "",
    error?.killed ? "killed=true" : "",
    error?.message || "",
  ].filter(Boolean);
  return pieces.join(" ");
}
