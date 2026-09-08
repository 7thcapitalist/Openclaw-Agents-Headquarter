import { execFile } from "child_process";
import { promisify } from "util";
import { mkdirSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { classifyDecision, loadDecisionProtocol } from "./intel/classify.mjs";
import { validateTaskContract } from "./task-workflow.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_HQ_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SURFACED_OUTCOMES = new Set(["decision-request", "ask", "block"]);

export async function createContractFromObjective({ objective, repo, issue, project, stateRoot, hqRoot = DEFAULT_HQ_ROOT, protocol = null, intakeAgentId = "main", execute = executeChiefOfStaff }) {
  if (typeof objective !== "string" || !objective.trim()) throw new Error("start requires a non-empty objective.");
  const id = `task-${randomUUID().slice(0, 8)}`;
  const prompt = `You are the Chief of Staff intake for a software factory. Convert the natural-language request below into one bounded task contract. Inspect the repository only when needed to classify it. Return ONLY a JSON object with exactly these fields: id, issue, outcome, acceptanceCriteria, project, workType, risk, preferredBuilder, constraints. Use id ${JSON.stringify(id)}. Use issue ${JSON.stringify(issue || `local:${id}`)}.${project ? ` Use project ${JSON.stringify(project)} exactly.` : ""} workType must be ui, backend, architecture, bugfix, research, or ops. risk must be low, medium, or high according to the repository operating rules. preferredBuilder must be auto, codex, claude, or frontend. Do not invent product scope. Acceptance criteria must be observable and include appropriate verification.\n\nRepository: ${resolve(repo)}\n\nFounder request:\n${objective.trim()}`;
  const raw = await execute({ prompt, repo, id, agentId: intakeAgentId });
  const contract = validateTaskContract(extractJsonObject(raw));
  if (contract.id !== id) throw new Error("Chief of Staff changed the assigned task id.");
  // This namespace is owned by the deterministic classifier, not model output.
  delete contract.advisory;
  const decisionProtocol = protocol || loadDecisionProtocol(hqRoot);
  const classification = classifyDecision({
    text: objective.trim(),
    fields: { risk: contract.risk, workType: contract.workType },
    protocol: decisionProtocol,
  });
  let advisory;
  if (SURFACED_OUTCOMES.has(classification.outcome)) {
    advisory = {
      decisionClassification: {
        advisory: true,
        blocksDispatch: false,
        label: "ADVISORY — founder sign-off recommended before merge; does not block dispatch.",
        outcome: classification.outcome,
        surfacedAs: classification.outcome === "block" ? "decision-request" : classification.outcome,
        trigger: classification.trigger,
        reason: classification.reason,
        matchedRule: findMatchedRule(classification, decisionProtocol),
        protocolVersion: decisionProtocol.version,
        classifier: "factory/lib/intel/classify.mjs",
        classifiedAt: new Date().toISOString(),
      },
    };
    contract.advisory = advisory;
  }
  const root = resolve(stateRoot);
  const intakeDir = join(root, "intake");
  mkdirSync(intakeDir, { recursive: true });
  const contractPath = join(intakeDir, `${id}.json`);
  writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
  return { contract, contractPath, advisory };
}

function findMatchedRule(classification, protocol) {
  const trigger = protocol.triggers?.find((rule) => rule.id === classification.trigger);
  if (trigger) return { ...structuredClone(trigger), source: "trigger" };
  if (classification.trigger === "risk:high") {
    return { id: "risk:high", outcome: "decision-request", reason: classification.reason, source: "riskBinding" };
  }
  if (classification.trigger === "blocking") {
    return { id: "blocking", outcome: "ask", reason: classification.reason, source: "blocking" };
  }
  return null;
}

export function buildIntakeInvocation({ agentId = "main", id, prompt }) {
  const sessionKey = `agent:${agentId}:factory-intake-${id}`;
  return {
    bin: "openclaw",
    sessionKey,
    args: ["agent", "--agent", agentId, "--session-key", sessionKey, "--message", prompt, "--json", "--timeout", "600"],
  };
}

export async function executeChiefOfStaff({ prompt, repo, id, agentId = "main" }) {
  const invocation = buildIntakeInvocation({ agentId, id, prompt });
  const { stdout } = await execFileAsync(invocation.bin, invocation.args,
    { cwd: resolve(repo), timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
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
