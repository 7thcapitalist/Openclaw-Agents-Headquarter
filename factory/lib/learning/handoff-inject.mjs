// Phase 3: close the loop — surface accepted company knowledge to agents.
//
// `buildKnowledgeBlock` returns a small markdown section that factory/lib/handoff.mjs
// appends after the role instructions. It is OFF by default and only produced
// when explicitly enabled, so the workflow engine's behaviour is unchanged
// unless the founder opts in.
//
// Enable with either:
//   - env  FACTORY_LEARNING_IN_HANDOFF=1
//   - factory.config.json  { "learning": { "injectIntoHandoff": true } }
//
// Fully guarded: any read error yields "" and never blocks a dispatch.

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { KNOWLEDGE_FILES } from "./knowledge.mjs";

export function learningInjectionEnabled(hqRoot, env = process.env) {
  if (env.FACTORY_LEARNING_IN_HANDOFF === "1" || env.FACTORY_LEARNING_IN_HANDOFF === "true") return true;
  try {
    const cfg = JSON.parse(readFileSync(join(resolve(hqRoot), "factory", "factory.config.json"), "utf8"));
    return cfg?.learning?.injectIntoHandoff === true;
  } catch {
    return false;
  }
}

// Character budget for the whole rendered knowledge block, following the same
// budget-then-clamp convention factory/lib/intel/assemble.mjs uses for its
// context-pack sections (SECTION_BUDGETS + clampSection): a fixed character
// cap with a pointer back to the full source. That helper is unexported and
// only word-boundary safe. Every line this module renders (a role-note bullet
// or a "- ID → recommendation" entry) is one complete markdown line, so this
// clamp cuts on the last full line instead — a truncated dossier never lands
// mid-bullet.
export const KNOWLEDGE_BLOCK_BUDGET = 2000;

export function clampKnowledgeBlock(text, budget = KNOWLEDGE_BLOCK_BUDGET, pointer = "factory/knowledge/agents/") {
  if (text.length <= budget) return text;
  const marker = `\n… (truncated — see ${pointer})`;
  const room = Math.max(0, budget - marker.length);
  const cut = text.slice(0, room);
  const lastBreak = cut.lastIndexOf("\n");
  const safe = lastBreak > 0 ? cut.slice(0, lastBreak) : cut;
  return `${safe}${marker}`;
}

function acceptedEntries(text, limit) {
  // "## <ID> — <title>" blocks whose Status line is "accepted".
  const re = /## ([A-Z]{2}-\d{4}-\d{3,}) — ([^\n]+)\n([\s\S]*?)(?=\n## [A-Z]{2}-\d{4}-\d{3,} — |$)/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const body = m[3];
    if (!/^-?\s*Status:\s*accepted/im.test(body)) continue;
    const rec = (body.match(/\*\*Recommendation:\*\*\s*([^\n]+)/) || [])[1];
    out.push(`- ${m[2].trim()}${rec ? ` → ${rec.trim()}` : ""}`);
  }
  return out.slice(-limit);
}

// Returns "" when disabled, when nothing relevant exists, or on any error.
export function buildKnowledgeBlock({ hqRoot, role, env = process.env, maxPerFile = 4 } = {}) {
  try {
    if (!learningInjectionEnabled(hqRoot, env)) return "";
    const root = resolve(hqRoot);
    const parts = [];

    const roleNote = join(root, "factory", "knowledge", "agents", `${role}.md`);
    if (role && existsSync(roleNote)) {
      const body = readFileSync(roleNote, "utf8").trim();
      const useful = body.split("\n").filter((l) => /^[-*]\s/.test(l.trim())).slice(0, 6);
      if (useful.length) parts.push(`### For the ${role} role\n\n${useful.join("\n")}`);
    }

    for (const key of ["lessons", "process"]) {
      const path = join(root, "factory", "knowledge", KNOWLEDGE_FILES[key].file);
      if (!existsSync(path)) continue;
      const items = acceptedEntries(readFileSync(path, "utf8"), maxPerFile);
      if (items.length) parts.push(`### ${KNOWLEDGE_FILES[key].title} (accepted)\n\n${items.join("\n")}`);
    }

    if (!parts.length) return "";
    const block = [
      "## Company knowledge",
      "",
      "Accepted lessons from prior tasks across the company. Apply them; if one is wrong for this task, say so in your summary.",
      "",
      parts.join("\n\n"),
      "",
    ].join("\n");
    return clampKnowledgeBlock(block);
  } catch {
    return "";
  }
}
