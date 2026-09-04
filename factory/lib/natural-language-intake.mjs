import { execFile } from "child_process";
import { promisify } from "util";
import { mkdirSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";
import { randomUUID } from "crypto";
import { validateTaskContract } from "./task-workflow.mjs";

const execFileAsync = promisify(execFile);

export async function createContractFromObjective({ objective, repo, issue, project, stateRoot, execute = executeChiefOfStaff }) {
  if (typeof objective !== "string" || !objective.trim()) throw new Error("start requires a non-empty objective.");
  const id = `task-${randomUUID().slice(0, 8)}`;
  const prompt = `You are the Chief of Staff intake for a software factory. Convert the natural-language request below into one bounded task contract. Inspect the repository only when needed to classify it. Return ONLY a JSON object with exactly these fields: id, issue, outcome, acceptanceCriteria, project, workType, risk, preferredBuilder, constraints. Use id ${JSON.stringify(id)}. Use issue ${JSON.stringify(issue || `local:${id}`)}.${project ? ` Use project ${JSON.stringify(project)} exactly.` : ""} workType must be ui, backend, architecture, bugfix, research, or ops. risk must be low, medium, or high according to the repository operating rules. preferredBuilder must be auto, codex, claude, or cursor. Do not invent product scope. Acceptance criteria must be observable and include appropriate verification.\n\nRepository: ${resolve(repo)}\n\nFounder request:\n${objective.trim()}`;
  const raw = await execute({ prompt, repo, id });
  const contract = validateTaskContract(extractJsonObject(raw));
  if (contract.id !== id) throw new Error("Chief of Staff changed the assigned task id.");
  const root = resolve(stateRoot);
  const intakeDir = join(root, "intake");
  mkdirSync(intakeDir, { recursive: true });
  const contractPath = join(intakeDir, `${id}.json`);
  writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
  return { contract, contractPath };
}

export async function executeChiefOfStaff({ prompt, repo, id }) {
  const { stdout } = await execFileAsync("openclaw", [
    "agent", "--agent", "main", "--session-key", `agent:main:factory-intake-${id}`,
    "--message", prompt, "--json", "--timeout", "600",
  ], { cwd: resolve(repo), timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
  const envelope = JSON.parse(stdout);
  if (envelope.status !== "ok") throw new Error(`Chief of Staff intake failed: ${envelope.summary || envelope.status}`);
  const text = envelope.result?.payloads?.map((item) => item.text).filter(Boolean).join("\n");
  if (!text) throw new Error("Chief of Staff intake returned no text.");
  return text;
}

function extractJsonObject(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Chief of Staff intake did not return a JSON object.");
  try { return JSON.parse(cleaned.slice(start, end + 1)); }
  catch (error) { throw new Error(`Chief of Staff returned invalid task JSON: ${error.message}`); }
}

export function defaultStateRoot(hqRoot, repo) {
  return join(resolve(hqRoot), "dashboard", "backend", "data", "factory", basename(resolve(repo)));
}
