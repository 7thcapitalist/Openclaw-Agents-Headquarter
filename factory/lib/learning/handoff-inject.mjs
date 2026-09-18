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
import { clampSection, SECTION_BUDGETS } from "../intel/assemble.mjs";
import { KNOWLEDGE_DIR, KNOWLEDGE_FILES } from "./knowledge.mjs";
import { readState, writeState } from "../task-workflow.mjs";

export function learningInjectionEnabled(hqRoot, env = process.env) {
  if (env.FACTORY_LEARNING_IN_HANDOFF === "1" || env.FACTORY_LEARNING_IN_HANDOFF === "true") return true;
  try {
    const cfg = JSON.parse(readFileSync(join(resolve(hqRoot), "factory", "factory.config.json"), "utf8"));
    return cfg?.learning?.injectIntoHandoff === true;
  } catch {
    return false;
  }
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

// Returns { text: "", sources: [] } when disabled, when nothing relevant
// exists, or on any error. `sources` names only the dossier files that
// actually rendered content this call — never a static list of every file
// that could in principle contribute, so a recorded fact is always literally
// true of that dispatch.
export function buildKnowledgeBlock({ hqRoot, role, env = process.env, maxPerFile = 4 } = {}) {
  try {
    if (!learningInjectionEnabled(hqRoot, env)) return { text: "", sources: [] };
    const root = resolve(hqRoot);
    const parts = [];
    const sources = [];

    const roleNote = join(root, "factory", "knowledge", "agents", `${role}.md`);
    if (role && existsSync(roleNote)) {
      const body = readFileSync(roleNote, "utf8").trim();
      const useful = body.split("\n").filter((l) => /^[-*]\s/.test(l.trim())).slice(0, 6);
      if (useful.length) {
        parts.push(`### For the ${role} role\n\n${useful.join("\n")}`);
        sources.push(`${KNOWLEDGE_DIR}/agents/${role}.md`);
      }
    }

    for (const key of ["lessons", "process"]) {
      const path = join(root, "factory", "knowledge", KNOWLEDGE_FILES[key].file);
      if (!existsSync(path)) continue;
      const items = acceptedEntries(readFileSync(path, "utf8"), maxPerFile);
      if (items.length) {
        parts.push(`### ${KNOWLEDGE_FILES[key].title} (accepted)\n\n${items.join("\n")}`);
        sources.push(`${KNOWLEDGE_DIR}/${KNOWLEDGE_FILES[key].file}`);
      }
    }

    if (!parts.length) return { text: "", sources: [] };
    const block = [
      "## Company knowledge",
      "",
      "Accepted lessons from prior tasks across the company. Apply them; if one is wrong for this task, say so in your summary.",
      "",
      parts.join("\n\n"),
      "",
    ].join("\n");
    const text = clampSection(block, SECTION_BUDGETS.knowledge, "factory/knowledge/agents/", { boundary: "line" });
    return { text, sources };
  } catch {
    return { text: "", sources: [] };
  }
}

// Records, on the dispatch this handoff is for, whether a knowledge block
// was injected and which dossier files fed it. Best-effort and guarded, same
// pattern as every other learning/* helper: never block a dispatch.
//
// This is a side-write against `state.json` outside the transaction that
// created the dispatch (that transaction lives in openclaw-protocol.mjs /
// task-workflow.mjs, out of scope here), so it re-reads current state and
// only writes when `state.currentDispatch` still identity-matches the
// dispatch this call is for. In the normal flow this runs synchronously,
// single-process, immediately after the dispatch-creation transaction
// commits and before any agent is invoked, so the compare-and-swap race this
// leaves open is the same accepted, narrow window task-initializer.mjs's own
// read-modify-write of state.json already lives with.
export function recordKnowledgeInjection({ statePath, stage, dispatchId, injected, sources = [] }) {
  if (!statePath || !dispatchId) return; // nothing committed yet to attach the fact to
  try {
    const current = readState(statePath);
    const dispatch = current.currentDispatch;
    if (!dispatch || dispatch.stage !== stage || (dispatch.id || dispatch.dispatchId) !== dispatchId) return;
    writeState(statePath, {
      ...current,
      currentDispatch: {
        ...dispatch,
        knowledgeInjection: { injected: Boolean(injected), sources: injected ? sources : [] },
      },
    });
  } catch {
    // best-effort — never block a dispatch over an evidence-trail write
  }
}
