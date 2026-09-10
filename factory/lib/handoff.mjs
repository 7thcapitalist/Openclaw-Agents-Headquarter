import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { assembleAgentContext } from "./hq/company-context.mjs";
import { buildKnowledgeBlock } from "./learning/handoff-inject.mjs";

export function writeHandoff({ hqRoot, statePath, state, companyState = null, resultPath = null, dispatchId = null, stage: stageOverride = null }) {
  // `stageOverride` lets the concurrent review fan-out write a handoff for a
  // group member that is not yet `state.currentStage`. Defaults to the normal
  // linear behaviour.
  const stage = stageOverride || state.currentStage;
  if (!stage) throw new Error("Task has no pending handoff; it is merge-ready.");
  const recovery = state.recovery?.active;
  const promptName = recovery ? (recovery.phase === "diagnose" ? "recovery" : "recovery-verifier") : (stage === "builder" ? "builder" : stage);
  const resultActor = recovery ? (recovery.phase === "diagnose" ? "recovery" : state.assignments[recovery.verificationStage || "qa"]) : state.assignments[stage];
  const prompt = readFileSync(join(hqRoot, "factory", "prompts", `${promptName}.md`), "utf8");
  const completed = Object.entries(state.stages)
    .filter(([, result]) => result.status === "pass")
    .map(([name, result]) => `- ${name}: ${result.summary} (${result.evidence.map((e) => e.path).join(", ")})`)
    .join("\n") || "- none";
  const returned = (state.dispatches || [])
    .filter((item) => item.outcome === "fail" || item.status === "failed")
    .slice(-3)
    .map((item) => `- ${item.stage} attempt ${item.attempt}: ${item.summary || item.error || "failed"}`)
    .join("\n") || "- none";
  const founderDecisions = (state.founderDecisions || [])
    .slice(-3)
    .map((item) => `- ${item.direction}`)
    .join("\n") || "- none";
  const resultInstructions = resultPath
    ? `\n## Machine result contract\n\nBefore ending, write exactly one JSON object to:\n\n${resultPath}\n\n` +
      `Schema: {"version":1,"dispatchId":"${dispatchId}","stage":"${stage}","actor":"${resultActor}","outcome":"pass|fail|decision-required|decision-deferred","summary":"...","evidence":["relative/path"],"decision":{"question":"...","options":["A ...","B ...","Other"]}}\n\n` +
    `Copy "dispatchId", "stage" and "actor" verbatim from the schema above. "actor" is this dispatch's routing token, not your agent name — write "${resultActor}" even if you know yourself by another id.\n\n` +
    "Evidence paths must be relative, non-empty files inside the assigned worktree, written under `evidence/` (e.g. `evidence/qa-test-output.log`). `evidence/` is git-ignored — it holds your gate proof, not product files, so never place code, tests, or docs there. Do not report PASS unless the evidence exists. You must write this result file even when returning FAIL or decision-required.\n"
    : "";
  let contextBlock;
  try {
    contextBlock = `${assembleAgentContext({ hqRoot, state, companyState }).text}\n\n`;
  } catch (error) {
    contextBlock = "## Factory context (global)\n\n" +
      `- project & factory context assembly unavailable: ${error.message}\n` +
      "- proceed using the task context below; note this in your summary.\n\n";
  }
  let knowledgeBlock = "";
  try {
    const block = buildKnowledgeBlock({ hqRoot, role: stage });
    if (block) knowledgeBlock = `${block}\n`;
  } catch {
    knowledgeBlock = "";
  }
  const advisory = state.task.advisory?.decisionClassification;
  const advisoryBlock = advisory
    ? "## Advisory decision classification\n\n" +
      `**${advisory.label || "ADVISORY — this does not block dispatch."}**\n\n` +
      `- Surfaced as: ${advisory.surfacedAs}\n` +
      `- Classifier outcome: ${advisory.outcome}\n` +
      `- Trigger: ${advisory.trigger || "unknown"}\n` +
      `- Reason: ${advisory.reason}\n` +
      `- Matched rule: ${advisory.matchedRule?.id || "unknown"}\n` +
      `- Blocks dispatch: ${advisory.blocksDispatch === true ? "yes" : "no"}\n\n`
    : "";
  const body = `# Factory handoff: ${state.task.id} -> ${stage}\n\n` +
    `Assigned harness: ${state.assignments[stage]} (this is also your "actor" routing token in the result contract below)\n\nRepository: ${state.repo}\nWorktree: ${state.worktree}\nBranch: ${state.branch}\nIssue: ${state.task.issue}\n\n` +
    contextBlock +
    advisoryBlock +
    `## Outcome\n\n${state.task.outcome}\n\n## Acceptance criteria\n\n${state.task.acceptanceCriteria.map((x) => `- ${x}`).join("\n")}\n\n` +
    (recovery ? `## Recovery context\n\nOriginal failed stage: ${recovery.failedStage}\nRecovery phase: ${recovery.phase}\nAttempt: ${recovery.attempt}\nOriginal failures are preserved in state.json. Investigate before changing anything.\n\n` : "") +
    `## Constraints\n\n${(state.task.constraints || []).map((x) => `- ${x}`).join("\n") || "- none recorded"}\n\n` +
    `## Founder decisions\n\n${founderDecisions}\n\n` +
    `## Completed handoffs\n\n${completed}\n\n## Returned findings\n\n${returned}\n\n## Role instructions\n\n${prompt.trim()}\n\n` +
    knowledgeBlock +
    "## Execution boundary\n\nPerform all repository inspection, edits, and commands in the assigned Worktree above. Do not edit the source repository or another worktree. Do not merge, deploy, or push to main.\n\n" +
    "## Required completion\n\nKeep working through ordinary uncertainty. Record decision-deferred when the safe work is complete but the founder may want to choose between legitimate options later; it does not block the pipeline. Use decision-required only when no safe progress is possible or a real safety/authority gate must stop the work. Deferred decisions must be plain language, include 2 options plus Other, and include your recommendation. Record PASS or FAIL with a summary and evidence when no founder input is needed.\n" + resultInstructions;
  const path = join(dirname(statePath), `handoff-${stage}.md`);
  writeFileSync(path, body, "utf8");
  return path;
}
