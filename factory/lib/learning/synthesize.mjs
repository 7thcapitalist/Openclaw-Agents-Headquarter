// Synthesis for the Company Learning System.
//
// Turns the reconciled findings queue + the latest analysis into:
//   - a set of proposed knowledge-file entries (drafts, not applied)
//   - the founder digest markdown
//
// Pure. The adapter decides whether to publish the proposals as a learning/*
// branch PR (founder-chosen path) and where to write the digest.

import { entryFromFinding, renderEntry, KNOWLEDGE_FILES, targetFileForFinding, renderDigest } from "./knowledge.mjs";

// Findings worth proposing as durable knowledge:
//  - every open pattern (recurring, cross-task)
//  - every open agent-improvement
//  - open high-confidence standalone failures/successes not already covered by a
//    pattern sharing their fingerprint
export function selectProposable(store) {
  const open = store.findings.filter((f) => f.status === "open");
  const patternFps = new Set(open.filter((f) => f.kind === "pattern").map((f) => f.fingerprint));
  return open.filter((f) => {
    if (f.kind === "pattern" || f.kind === "agent-improvement") return true;
    if (patternFps.has(f.fingerprint)) return false;
    return f.confidence === "high";
  });
}

export function buildProposals(store, { now = new Date().toISOString() } = {}) {
  const proposable = selectProposable(store);
  const proposals = proposable.map((finding) => {
    const entry = entryFromFinding(finding, { now });
    return {
      findingId: finding.id,
      fileKey: entry.fileKey,
      file: `${KNOWLEDGE_FILES[entry.fileKey].file}`,
      entry,
      preview: renderEntry(entry, `${KNOWLEDGE_FILES[entry.fileKey].idPrefix}-${entry.year}-NNN`),
    };
  });
  proposals.sort((a, b) => a.fileKey.localeCompare(b.fileKey) || a.findingId.localeCompare(b.findingId));
  return proposals;
}

export function synthesize({ store, analysis = {}, now = new Date().toISOString() }) {
  const proposals = buildProposals(store, { now });
  const digest = renderDigest({ store, analysis, now });
  const byFile = {};
  for (const p of proposals) {
    (byFile[p.fileKey] ||= []).push(p);
  }
  return { proposals, byFile, digest, generatedAt: now };
}

// The commit body for a learning/* proposals branch.
export function renderProposalsCommitBody(proposals, { now }) {
  const lines = [`Learning proposals — ${now.slice(0, 10)}`, ""];
  for (const [key, meta] of Object.entries(KNOWLEDGE_FILES)) {
    const forFile = proposals.filter((p) => p.fileKey === key);
    if (!forFile.length) continue;
    lines.push(`## ${meta.file}`);
    for (const p of forFile) lines.push(`- from ${p.findingId}: ${p.entry.title}`);
    lines.push("");
  }
  lines.push("Every entry is marked `Status: proposed`. Review and set to `accepted` on merge.");
  lines.push("Prompt / routing / gate changes are handled as separate low-risk factory tasks.");
  return lines.join("\n");
}
