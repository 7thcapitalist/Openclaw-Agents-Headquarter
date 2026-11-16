#!/usr/bin/env node
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { ingestResult, prepareDispatch, readResultFile } from "../factory/lib/openclaw-protocol.mjs";
import { runOneStage, runToTerminal } from "../factory/lib/openclaw-runner.mjs";
import { createContractFromObjective, defaultStateRoot } from "../factory/lib/natural-language-intake.mjs";
import { readState, recordFounderApproval, resumeState, verifyEvidence, writeState } from "../factory/lib/task-workflow.mjs";
import { writeHandoff } from "../factory/lib/handoff.mjs";
import { initializeTask } from "../factory/lib/task-initializer.mjs";

const hqRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    const request = await readRequest(process.argv.slice(2));
    const response = await handleRequest(request);
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ version: 1, status: "error", error: error.message || String(error) }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

export async function handleRequest(request, dependencies = {}) {
  validateRequest(request);
  if (request.action === "intake") return inspectObjective(request, dependencies);
  if (request.action === "start") return startFromObjective(request, dependencies);
  if (request.action === "init") return initialize(request, dependencies.initializeTask || initializeTask);
  if (request.action === "next") return prepareDispatch({ hqRoot, statePath: requiredPath(request) });
  if (request.action === "ingest") {
    const statePath = requiredPath(request);
    const state = readState(statePath);
    const resultPath = request.resultPath || state.currentDispatch?.resultPath;
    if (!resultPath) throw new Error("No active dispatch result path.");
    if (resolve(resultPath) !== resolve(state.currentDispatch?.resultPath || "")) {
      throw new Error("resultPath does not match the active dispatch.");
    }
    return ingestResult({ statePath, result: readResultFile(resolve(resultPath)) });
  }
  if (request.action === "run-one" || request.action === "run") {
    const config = JSON.parse(readFileSync(resolve(hqRoot, "factory", "factory.config.json"), "utf8"));
    const options = {
      hqRoot,
      statePath: requiredPath(request),
      agentIds: { ...(config.openclawIntegration?.agentIds || {}), ...(request.agentIds || {}) },
      maxAttemptsPerStage: config.openclawIntegration?.maxAttemptsPerStage || 3,
      maxInfraAttemptsPerStage: config.openclawIntegration?.maxInfraAttemptsPerStage || 6,
      concurrentGroups: config.openclawIntegration?.concurrentGroups,
    };
    return request.action === "run" ? runToTerminal(options) : runOneStage(options);
  }
  if (request.action === "resume") {
    const statePath = requiredPath(request);
    const next = resumeState(readState(statePath));
    writeState(statePath, next);
    writeHandoff({ hqRoot, statePath, state: next });
    return stateResponse(next);
  }
  if (request.action === "approve") {
    const statePath = requiredPath(request);
    const state = readState(statePath);
    const [evidence] = verifyEvidence([request.evidence], state.worktree);
    if (!request.approvalAssertionPath) throw new Error("approve requires approvalAssertionPath.");
    const assertion = JSON.parse(readFileSync(resolve(request.approvalAssertionPath), "utf8"));
    const next = recordFounderApproval(state, { assertion, evidence });
    writeState(statePath, next);
    if (next.status === "active") writeHandoff({ hqRoot, statePath, state: next });
    return stateResponse(next);
  }
  if (request.action === "status") return stateResponse(readState(requiredPath(request)));
  throw new Error(`Unsupported action: ${request.action}`);
}

async function startFromObjective(request, dependencies) {
  if (!request.repo) throw new Error("start requires repo.");
  const config = JSON.parse(readFileSync(resolve(hqRoot, "factory", "factory.config.json"), "utf8"));
  const stateRoot = resolve(request.stateRoot || defaultStateRoot(hqRoot, request.repo));
  const intake = await createContractFromObjective({
    objective: request.objective,
    repo: request.repo,
    issue: request.issue,
    project: request.project,
    stateRoot,
    hqRoot,
    intakeAgentId: config.openclawIntegration?.agentIds?.intake,
    founderAnswers: Array.isArray(request.answers) ? request.answers : [],
    execute: dependencies.executeChiefOfStaff,
  });
  if (intake.questions?.length) return { version: 1, status: "needs-founder-input", taskId: intake.contract.id, questions: intake.questions };
  const decisionClassification = intake.advisory?.decisionClassification;
  if (decisionClassification) {
    console.warn(
      `[decision-${decisionClassification.advisory ? "advisory" : "blocking"}] ${intake.contract.id}: `
      + `${decisionClassification.surfacedAs} / ${decisionClassification.trigger} — `
      + (decisionClassification.advisory ? "advisory only, not blocking" : "BLOCKING — waiting for the founder before dispatch"),
    );
  }
  // The task is created either way, so a blocking decision is a visible,
  // resumable task rather than a request that evaporates. What a blocking
  // classification changes is that it does NOT run to terminal: the founder is
  // asked first. Previously this flag was logged and then ignored, so a
  // `decision-request / risk:high` dispatched anyway.
  const created = initialize({ ...request, action: "init", contractPath: intake.contractPath, stateRoot }, dependencies.initializeTask || initializeTask);
  // The task id exists from here on, but this function only returns when the
  // run ends — hours later. A caller that needs to follow the live task (the
  // dashboard's founder job, its busy check) learns it now. A failing callback
  // is the caller's problem, never a reason to abandon the run.
  try {
    dependencies.onTaskCreated?.({ taskId: intake.contract.id, statePath: created.statePath });
  } catch (error) {
    console.warn(`[openclaw-factory] onTaskCreated failed for ${intake.contract.id}: ${error.message || error}`);
  }
  if (decisionClassification?.blocksDispatch) {
    return {
      version: 1,
      status: "needs-founder-decision",
      taskId: intake.contract.id,
      statePath: created.statePath,
      worktree: created.worktree,
      branch: created.branch,
      contract: intake.contract,
      advisory: intake.advisory,
      decision: {
        trigger: decisionClassification.trigger,
        reason: decisionClassification.reason,
        surfacedAs: decisionClassification.surfacedAs,
      },
    };
  }
  const result = await runToTerminal({
    hqRoot,
    statePath: created.statePath,
    agentIds: config.openclawIntegration?.agentIds || {},
    maxAttemptsPerStage: config.openclawIntegration?.maxAttemptsPerStage || 3,
    maxInfraAttemptsPerStage: config.openclawIntegration?.maxInfraAttemptsPerStage || 6,
    concurrentGroups: config.openclawIntegration?.concurrentGroups,
    execute: dependencies.execute,
  });
  return { ...result, statePath: created.statePath, worktree: created.worktree, branch: created.branch, contract: intake.contract, advisory: intake.advisory };
}

async function inspectObjective(request, dependencies) {
  if (!request.repo || !request.objective) throw new Error("intake requires repo and objective.");
  const config = JSON.parse(readFileSync(resolve(hqRoot, "factory", "factory.config.json"), "utf8"));
  const stateRoot = resolve(request.stateRoot || defaultStateRoot(hqRoot, request.repo));
  const intake = await createContractFromObjective({
    objective: request.objective, repo: request.repo, issue: request.issue, project: request.project,
    stateRoot, hqRoot, preview: true, founderAnswers: Array.isArray(request.answers) ? request.answers : [],
    intakeAgentId: config.openclawIntegration?.agentIds?.intake, execute: dependencies.executeChiefOfStaff,
  });
  return { version: 1, status: intake.questions?.length ? "needs-founder-input" : "ready", questions: intake.questions || [], contract: intake.contract };
}

function initialize(request, initializer) {
  if (!request.contractPath || !request.repo) throw new Error("init requires contractPath and repo.");
  const created = initializer({
    hqRoot,
    contractPath: request.contractPath,
    repo: request.repo,
    branch: request.branch,
    worktree: request.worktree,
    stateRoot: request.stateRoot,
  });
  return {
    version: 1,
    status: "active",
    taskId: created.task,
    statePath: created.state,
    branch: created.branch,
    worktree: created.worktree,
    currentStage: created.next,
  };
}

function readRequest(argv) {
  if (argv[0] === "--request" && argv[1]) return JSON.parse(readFileSync(resolve(argv[1]), "utf8"));
  const chunks = [];
  process.stdin.setEncoding("utf8");
  return new Promise((resolveRequest, reject) => {
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      try { resolveRequest(JSON.parse(chunks.join(""))); } catch (error) { reject(new Error(`Invalid JSON request: ${error.message}`)); }
    });
  });
}

function validateRequest(request) {
  if (!request || request.version !== 1) throw new Error("Unsupported or missing request version.");
  if (typeof request.action !== "string") throw new Error("Request is missing action.");
}

function requiredPath(request) {
  if (!request.statePath) throw new Error(`${request.action} requires statePath.`);
  return resolve(request.statePath);
}

function stateResponse(state) {
  return { version: 1, status: state.status, taskId: state.task.id, currentStage: state.currentStage, blocker: state.blocker || null, recovery: state.recovery || null, failures: state.failures || [] };
}
