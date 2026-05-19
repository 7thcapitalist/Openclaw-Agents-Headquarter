import { spawn } from "child_process";
import { closeSync, openSync, writeFileSync, mkdirSync, realpathSync, statSync } from "fs";
import { join, resolve, basename } from "path";

const SAFE_ENTRYPOINTS = new Set(["./run.sh", "run.sh"]);
const SHELL_META = /[`$&|;<>(){}[\]*?!\\\n\r]/;

/**
 * @param {string} agentDir resolved Agent Lab folder
 * @param {string} entrypoint must be ./run.sh
 * @param {Record<string, string>} [extraEnv]
 */
export function runEntrypoint(agentDir, entrypoint, extraEnv = {}) {
  const { realAgentDir, runPath } = resolveRunnable(agentDir, entrypoint);
  mkdirSync(join(realAgentDir, "logs"), { recursive: true });
  const logPath = join(realAgentDir, "logs", "latest.log");
  writeFileSync(
    logPath,
    Buffer.from(`\n--- dashboard run ${new Date().toISOString()} ---\n`),
    { flag: "a" }
  );
  const logFd = openSync(logPath, "a");
  const env = { ...process.env, ...extraEnv };
  return new Promise((resolve) => {
    const child = spawn("bash", [runPath], {
      cwd: realAgentDir,
      stdio: ["ignore", logFd, logFd],
      env,
      shell: false,
    });
    let errMsg = "";
    child.on("error", (e) => {
      errMsg = e.message;
    });
    child.on("close", (code, signal) => {
      try {
        closeSync(logFd);
      } catch {
        /* ignore */
      }
      resolve({ code: code ?? 0, signal, errMsg });
    });
  });
}

function resolveRunnable(agentDir, entrypoint) {
  const rawEntry = String(entrypoint || "./run.sh");
  if (!SAFE_ENTRYPOINTS.has(rawEntry) || rawEntry.includes("..") || SHELL_META.test(rawEntry)) {
    throw new Error("Invalid entrypoint: dashboard runs only ./run.sh");
  }

  const root = resolve(agentDir);
  const realAgentDir = realpathSync(root);
  const runPath = resolve(realAgentDir, basename(rawEntry));
  const realRunPath = realpathSync(runPath);
  if (realRunPath !== join(realAgentDir, "run.sh")) {
    throw new Error("Invalid run.sh path");
  }
  if (!realRunPath.startsWith(realAgentDir + "/")) {
    throw new Error("run.sh must stay inside the agent folder");
  }
  const runStat = statSync(realRunPath);
  if (!runStat.isFile()) {
    throw new Error("run.sh is not a file");
  }
  return { realAgentDir, runPath: realRunPath };
}
