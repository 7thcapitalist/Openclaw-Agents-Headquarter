import { execFile } from "child_process";
import { promisify } from "util";
import { scrubText } from "../../common/redact.mjs";

const execFileAsync = promisify(execFile);

export class MissingCredentialError extends Error {
  constructor(name) {
    super(`Missing required deployment credential: ${name}`);
    this.name = "MissingCredentialError";
    this.credential = name;
  }
}

async function defaultExec(file, args, options) {
  try {
    const result = await execFileAsync(file, args, options);
    return { stdout: result.stdout || "", stderr: result.stderr || "", code: 0 };
  } catch (error) {
    return {
      stdout: error.stdout || "",
      stderr: error.stderr || error.message || "",
      code: Number.isInteger(error.code) ? error.code : 1,
    };
  }
}

function redact(text, env) {
  let output = String(text || "");
  for (const key of ["VERCEL_TOKEN", "VERCEL_PROJECT_ID", "VERCEL_ORG_ID"]) {
    const value = env[key];
    if (value) output = output.split(String(value)).join(`[redacted: ${key}]`);
  }
  return scrubText(output).text;
}

function deploymentUrl(text) {
  return String(text || "").match(/https:\/\/[^\s]+/g)?.at(-1)?.replace(/[),.;]+$/, "") || null;
}

export function createVercelAdapter({ exec = defaultExec } = {}) {
  return {
    id: "vercel",
    validateConfig() {},
    async deploy({ repoPath, env = process.env, logger = () => {} }) {
      if (!env.VERCEL_TOKEN) throw new MissingCredentialError("VERCEL_TOKEN");
      const options = { cwd: repoPath, env, maxBuffer: 10 * 1024 * 1024 };
      const commands = [
        ["pull", "--yes", "--environment", "production"],
        ["build", "--prod"],
        ["deploy", "--prebuilt", "--prod"],
      ];
      let last = { stdout: "", stderr: "" };
      for (const args of commands) {
        last = await exec("npx", ["vercel", ...args], options);
        const safeOutput = redact(`${last.stdout || ""}\n${last.stderr || ""}`, env).trim();
        if (safeOutput) logger(safeOutput);
        if (Number(last.code || 0) !== 0) throw new Error(`Vercel ${args[0]} failed: ${safeOutput}`);
      }
      const url = deploymentUrl(last.stdout);
      if (!url) throw new Error("Vercel deploy did not return a production URL.");
      return { url, providerDeploymentId: null, logsUrl: null };
    },
  };
}

export const vercelAdapter = createVercelAdapter();
