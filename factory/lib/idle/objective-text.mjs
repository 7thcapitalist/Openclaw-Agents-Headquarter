function evidencePath(entry) {
  return typeof entry === "string" ? entry : entry?.path;
}

export function buildIdleObjectiveText(finding) {
  const evidence = (finding?.evidence || []).map(evidencePath).filter(Boolean);
  return [
    "Start an objective on the openclaw-factory project.",
    "origin: learning-agent",
    `finding: ${finding.id}`,
    "",
    "WHAT IS WASTEFUL",
    finding.observation || finding.title,
    "",
    "EVIDENCE (canonical factory state)",
    ...evidence.map((path) => `- ${path}`),
    "",
    "FIX MUST ACHIEVE",
    finding.recommendation || `Remove the recurring waste described by ${finding.id} without weakening factory gates.`,
    "",
    "HOW TO MEASURE",
    `Add a regression test and show that the signal tracked by ${finding.id} no longer occurs for the affected path.`,
    "",
    "CONSTRAINTS",
    "Use the normal seven-stage factory workflow and all five gates. End in a PR for the founder to review and merge; never auto-merge.",
  ].join("\n");
}
