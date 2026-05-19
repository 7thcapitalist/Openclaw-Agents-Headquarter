import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * @returns {Promise<Record<string, { status: string, pm_uptime?: number }>>}
 */
export async function pm2StatusMap() {
  try {
    const { stdout } = await execFileAsync("pm2", ["jlist"], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15000,
    });
    const list = JSON.parse(stdout);
    /** @type {Record<string, { status: string, pm_uptime?: number }>} */
    const map = {};
    for (const proc of list) {
      const name = proc.name;
      const st = proc.pm2_env?.status || "unknown";
      const pm_uptime = proc.pm2_env?.pm_uptime;
      if (name) map[name] = { status: st, pm_uptime };
    }
    return map;
  } catch {
    return {};
  }
}
