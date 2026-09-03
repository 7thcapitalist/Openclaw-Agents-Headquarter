import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export function writeHandoff({ hqRoot, statePath, state, resultPath = null, dispatchId = null }) {
  if (!state.currentStage) throw new Error("Task has no pending handoff; it is merge-ready.");
  const stage = state.currentStage;
  const prompt = readFileSync(join(hqRoot, "factory", "prompts", `${stage === "builder" ? "builder" : stage}.md`), "utf8");
  const completed = Object.entries(state.stages)
    .filter(([, result]) => result.status === "pass")
    .map(([name, result]) => `- ${name}: ${result.summary} (${result.evidence.map((e) => e.path).join(", ")})`)
    .join("\n") || "- none";
  const resultInstructions = resultPath
    ? `\n## Machine result contract\n\nBefore ending, write exactly one JSON object to:\n\n${resultPath}\n\n` +
      `Schema: {"version":1,"dispatchId":"${dispatchId}","stage":"${stage}","actor":"${state.assignments[stage]}","outcome":"pass|fail|decision-required","summary":"...","evidence":["relative/path"]}\n\n` +
      "Evidence paths must be non-empty files inside the assigned worktree. Do not report PASS unless the evidence exists.\n"
    : "";
  const body = `# Factory handoff: ${state.task.id} -> ${stage}\n\n` +
    `Assigned harness: ${state.assignments[stage]}\n\nRepository: ${state.repo}\nWorktree: ${state.worktree}\nBranch: ${state.branch}\nIssue: ${state.task.issue}\n\n` +
    `## Outcome\n\n${state.task.outcome}\n\n## Acceptance criteria\n\n${state.task.acceptanceCriteria.map((x) => `- ${x}`).join("\n")}\n\n` +
    `## Constraints\n\n${(state.task.constraints || []).map((x) => `- ${x}`).join("\n") || "- none recorded"}\n\n` +
    `## Completed handoffs\n\n${completed}\n\n## Role instructions\n\n${prompt.trim()}\n\n` +
    "## Required completion\n\nRecord PASS, FAIL, or decision-required with a summary and one or more evidence paths inside the worktree. A failure blocks the pipeline.\n" + resultInstructions;
  const path = join(dirname(statePath), `handoff-${stage}.md`);
  writeFileSync(path, body, "utf8");
  return path;
}
