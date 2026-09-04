import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { assembleContextPack } from "./intel/assemble.mjs";
import { buildKnowledgeBlock } from "./learning/handoff-inject.mjs";

export function writeHandoff({ hqRoot, statePath, state, resultPath = null, dispatchId = null }) {
  if (!state.currentStage) throw new Error("Task has no pending handoff; it is merge-ready.");
  const stage = state.currentStage;
  const prompt = readFileSync(join(hqRoot, "factory", "prompts", `${stage === "builder" ? "builder" : stage}.md`), "utf8");
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
      `Schema: {"version":1,"dispatchId":"${dispatchId}","stage":"${stage}","actor":"${state.assignments[stage]}","outcome":"pass|fail|decision-required","summary":"...","evidence":["relative/path"]}\n\n` +
    "Evidence paths must be relative, non-empty files inside the assigned worktree. Do not report PASS unless the evidence exists. You must write this result file even when returning FAIL or decision-required.\n"
    : "";
  let contextBlock;
  try {
    contextBlock = `${assembleContextPack({ hqRoot, state }).text}\n\n`;
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
  const body = `# Factory handoff: ${state.task.id} -> ${stage}\n\n` +
    `Assigned harness: ${state.assignments[stage]}\n\nRepository: ${state.repo}\nWorktree: ${state.worktree}\nBranch: ${state.branch}\nIssue: ${state.task.issue}\n\n` +
    contextBlock +
    `## Outcome\n\n${state.task.outcome}\n\n## Acceptance criteria\n\n${state.task.acceptanceCriteria.map((x) => `- ${x}`).join("\n")}\n\n` +
    `## Constraints\n\n${(state.task.constraints || []).map((x) => `- ${x}`).join("\n") || "- none recorded"}\n\n` +
    `## Founder decisions\n\n${founderDecisions}\n\n` +
    `## Completed handoffs\n\n${completed}\n\n## Returned findings\n\n${returned}\n\n## Role instructions\n\n${prompt.trim()}\n\n` +
    knowledgeBlock +
    "## Execution boundary\n\nPerform all repository inspection, edits, and commands in the assigned Worktree above. Do not edit the source repository or another worktree. Do not merge, deploy, or push to main.\n\n" +
    "## Required completion\n\nRecord PASS, FAIL, or decision-required with a summary and one or more evidence paths inside the worktree. A failure is routed according to factory policy.\n" + resultInstructions;
  const path = join(dirname(statePath), `handoff-${stage}.md`);
  writeFileSync(path, body, "utf8");
  return path;
}
